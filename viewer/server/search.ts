// Search: compile a parsed Gmail query into SQL and list the matching threads.
//
// Each term becomes a set of message ids from a narrow table or an index (the FTS indexes,
// message_labels, message_addresses, attachments, or an index on messages). AND, OR and NOT
// become INTERSECT, UNION and EXCEPT. So no search ever reads the wide message rows; only the
// ids that match are looked up, to group them into threads.
import { isUserLabel } from "../shared/labels.ts";
import { contextSnippet, highlightTerms, isEmptyQuery, parseQuery, searchContext, type HighlightTerm, type Node } from "../shared/search.ts";
import { htmlToText } from "./text.ts";
import type { ThreadList } from "../shared/types.ts";
import type { DB } from "./db.ts";
import { PAGE_SIZE, summarizeThreads, type PageRows } from "./views.ts";

export interface Sql {
  sql: string;
  params: unknown[];
}

export interface CompileContext {
  db: DB;
  me: string[];
  now?: Date; // for newer_than: / older_than: (tests set it)
}

// Every message id, from a small index (a plain "SELECT id FROM messages" can make SQLite read the
// table itself in rowid order, which reads every stored body).
const ALL = "SELECT id FROM messages INDEXED BY messages_size";
const NONE = "SELECT 0 AS id WHERE 0";
const DATE = "coalesce(m.received_utc, m.date_utc, 0)";

/** Quote a term for FTS5, so user text is never read as FTS syntax. The prefix * goes outside. */
export function ftsString(text: string, prefix: boolean): string {
  return `"${text.replace(/"/g, '""')}"${prefix ? " *" : ""}`;
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);
const contains = (s: string) => `%${likeEscape(s)}%`;

/** label:my-label finds "My Label" and "My/Label": case, spaces, - and / don't matter. */
export const normalizeLabel = (s: string) => s.toLowerCase().replace(/[\s\-/_]+/g, "-").replace(/^-|-$/g, "");

function labelIds(db: DB, match: (name: string) => boolean): number[] {
  return (db.prepare("SELECT id, name FROM labels").all() as { id: number; name: string }[]).filter((l) => match(l.name)).map((l) => l.id);
}

function withLabels(ids: number[]): Sql {
  if (!ids.length) return { sql: NONE, params: [] };
  return { sql: `SELECT message_id AS id FROM message_labels WHERE label_id IN (${ids.map(() => "?").join(",")})`, params: ids };
}

function namedLabel(db: DB, name: string): Sql {
  return withLabels(labelIds(db, (n) => n === name));
}

/** Messages whose text matches, or whose thread's note matches. */
function textSql(text: string, phrase: boolean, prefix: boolean): Sql {
  const fts = ftsString(text, prefix);
  return {
    sql: `SELECT rowid AS id FROM messages_fts WHERE messages_fts MATCH ?
          UNION ALL SELECT m.id FROM notes_fts JOIN thread_notes n ON n.id = notes_fts.rowid
                JOIN messages m ON m.thread_id = n.thread_id WHERE notes_fts MATCH ?`,
    params: [fts, fts],
  };
  void phrase; // quoting makes a word and a phrase the same to FTS5
}

function noteSql(text: string, prefix: boolean): Sql {
  return {
    sql: `SELECT m.id FROM notes_fts JOIN thread_notes n ON n.id = notes_fts.rowid
          JOIN messages m ON m.thread_id = n.thread_id WHERE notes_fts MATCH ?`,
    params: [ftsString(text, prefix)],
  };
}

const FULL_ADDRESS = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function addressSql(roles: string[], value: string, me: string[]): Sql {
  const r = `role IN (${roles.map(() => "?").join(",")})`;
  const v = value.toLowerCase();
  if (v === "me") {
    if (!me.length) return { sql: NONE, params: [] };
    return { sql: `SELECT message_id AS id FROM message_addresses WHERE addr IN (${me.map(() => "?").join(",")}) AND ${r}`, params: [...me, ...roles] };
  }
  if (FULL_ADDRESS.test(v)) {
    return { sql: `SELECT message_id AS id FROM message_addresses WHERE addr = ? AND ${r}`, params: [v, ...roles] };
  }
  return {
    sql: `SELECT message_id AS id FROM message_addresses WHERE ${r} AND (addr LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')`,
    params: [...roles, contains(v), contains(v)],
  };
}

/** Local midnight of a date like 2024/03/01, 2024-03-01, 3/1/2024; or Unix seconds. */
export function parseDate(v: string): number | null {
  if (/^\d{9,}$/.test(v)) return Number(v);
  let y: number, mo: number, d: number;
  let m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(v);
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v))) [y, mo, d] = [Number(m[3]), Number(m[1]), Number(m[2])];
  else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return Math.floor(new Date(y, mo - 1, d).getTime() / 1000);
}

/** newer_than:3d → the time 3 days ago (d, m = months, y). */
export function parseAgo(v: string, now: Date): number | null {
  const m = /^(\d+)([dmy])$/i.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  const t = new Date(now);
  const unit = m[2].toLowerCase();
  if (unit === "d") t.setDate(t.getDate() - n);
  else if (unit === "m") t.setMonth(t.getMonth() - n);
  else t.setFullYear(t.getFullYear() - n);
  return Math.floor(t.getTime() / 1000);
}

/** 10M, 500K, 2000 → bytes. */
export function parseSize(v: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([kmg]?)b?$/i.exec(v);
  if (!m) return null;
  const mult = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase() as "" | "k" | "m" | "g"];
  return Math.round(Number(m[1]) * mult);
}

function dateSql(cmp: ">=" | "<", t: number): Sql {
  // Two index range scans; coalesce() itself can't use an index.
  return {
    sql: `SELECT id FROM messages WHERE received_utc ${cmp} ? UNION ALL SELECT id FROM messages WHERE received_utc IS NULL AND date_utc ${cmp} ?`,
    params: [t, t],
  };
}

const IN_FOLDERS: Record<string, string> = {
  inbox: "Inbox", sent: "Sent", drafts: "Drafts", draft: "Drafts", chats: "Chat", chat: "Chat",
  spam: "Spam", trash: "Trash", starred: "Starred", important: "Important",
};

/** One operator term, or null if its value makes no sense (it is then searched as text, as Gmail does). */
function opSql(n: Extract<Node, { op: string }>, cx: CompileContext): Sql | null {
  const { db } = cx;
  const v = n.value.trim();
  const lower = v.toLowerCase();
  switch (n.op) {
    case "from":
      return addressSql(["from"], v, cx.me);
    case "to":
      return addressSql(["to", "cc", "bcc"], v, cx.me);
    case "cc":
      return addressSql(["cc"], v, cx.me);
    case "bcc":
      return addressSql(["bcc"], v, cx.me);
    case "subject":
      return { sql: "SELECT rowid AS id FROM messages_fts WHERE messages_fts MATCH ?", params: [`subject : ${ftsString(v, n.prefix)}`] };
    case "note":
      return noteSql(v, n.prefix);
    case "label": {
      const want = normalizeLabel(v);
      return withLabels(labelIds(db, (name) => normalizeLabel(name) === want));
    }
    case "in": {
      if (lower === "anywhere") return { sql: ALL, params: [] };
      if (IN_FOLDERS[lower]) return namedLabel(db, IN_FOLDERS[lower]);
      const want = normalizeLabel(v);
      return withLabels(labelIds(db, (name) => normalizeLabel(name) === want));
    }
    case "category": {
      const want = normalizeLabel("Category " + v);
      return withLabels(labelIds(db, (name) => normalizeLabel(name) === want));
    }
    case "is":
      if (lower === "unread") return namedLabel(db, "Unread");
      if (lower === "read") return { sql: `${ALL} EXCEPT ${namedLabel(db, "Unread").sql}`, params: namedLabel(db, "Unread").params };
      if (lower === "starred") return namedLabel(db, "Starred");
      if (lower === "important") return namedLabel(db, "Important");
      return null;
    case "has":
      if (lower === "attachment" || lower === "attachments") return { sql: "SELECT message_id AS id FROM attachments WHERE is_inline = 0", params: [] };
      if (lower === "note" || lower === "notes") return { sql: "SELECT m.id FROM thread_notes n JOIN messages m ON m.thread_id = n.thread_id", params: [] };
      if (lower === "userlabels" || lower === "nouserlabels") {
        const user = withLabels(labelIds(db, isUserLabel));
        return lower === "userlabels" ? user : { sql: `${ALL} EXCEPT SELECT id FROM (${user.sql})`, params: user.params };
      }
      return null;
    case "filename":
      return { sql: "SELECT message_id AS id FROM attachments WHERE filename LIKE ? ESCAPE '\\'", params: [contains(v)] };
    case "after":
    case "newer":
    case "before":
    case "older": {
      const t = parseDate(v);
      if (t === null) return null;
      return dateSql(n.op === "after" || n.op === "newer" ? ">=" : "<", t);
    }
    case "newer_than":
    case "older_than": {
      const t = parseAgo(v, cx.now ?? new Date());
      if (t === null) return null;
      return dateSql(n.op === "newer_than" ? ">=" : "<", t);
    }
    case "larger":
    case "size":
    case "smaller": {
      const b = parseSize(v);
      if (b === null) return null;
      return { sql: `SELECT id FROM messages WHERE size_bytes ${n.op === "smaller" ? "<" : ">="} ?`, params: [b] };
    }
    case "rfc822msgid": {
      const bare = v.replace(/^<|>$/g, "");
      return { sql: "SELECT id FROM messages WHERE message_id IN (?, ?)", params: [`<${bare}>`, bare] };
    }
    case "list": {
      const id = lower.replace(/^<|>$/g, "");
      if (id.includes("@") || id.includes(".")) {
        // Gmail also takes the address form: announce@lists.example.org = announce.lists.example.org
        return { sql: "SELECT id FROM messages WHERE list_id IN (?, ?)", params: [id, id.replace("@", ".")] };
      }
      return {
        sql: "SELECT id FROM messages WHERE list_id IS NOT NULL AND (list_id LIKE ? ESCAPE '\\' OR list_name LIKE ? ESCAPE '\\')",
        params: [contains(id), contains(id)],
      };
    }
  }
  return null;
}

/**
 * Builds one query out of a tree. Every term becomes a MATERIALIZED common table expression, so
 * SQLite computes each set once from its own index, and INTERSECT/UNION/EXCEPT work on those small
 * sets. (Without this, SQLite may merge a term into the compound query and scan the messages table.)
 */
class SetBuilder {
  private ctes: string[] = [];
  private params: unknown[] = [];

  /** A term's ids as a named set; returns "SELECT id FROM cN". */
  term(q: Sql): string {
    const name = `c${this.ctes.length}`;
    this.ctes.push(`${name}(id) AS MATERIALIZED (${q.sql})`);
    this.params.push(...q.params);
    return `SELECT id FROM ${name}`;
  }

  /** The finished query: WITH c0 …, c1 … <body>. Params of the terms come first, in order. */
  build(body: string): Sql {
    return { sql: (this.ctes.length ? `WITH ${this.ctes.join(", ")} ` : "") + body, params: this.params };
  }
}

/** A set of message ids for a query tree: a compound SELECT over the builder's named sets. */
function compileNode(n: Node, cx: CompileContext, b: SetBuilder): string {
  if ("text" in n) return b.term(textSql(n.text, n.phrase, n.prefix));
  if ("op" in n) return b.term(opSql(n, cx) ?? textSql(`${n.op}:${n.value}`, n.phrase, false));
  if ("not" in n) {
    const inner = compileNode(n.not, cx, b);
    return `${b.term({ sql: ALL, params: [] })} EXCEPT SELECT id FROM (${inner})`;
  }
  if ("or" in n) return n.or.map((c) => `SELECT id FROM (${compileNode(c, cx, b)})`).join(" UNION ");
  // AND: intersect the positive terms, then take out the negative ones.
  const pos = n.and.filter((c) => !("not" in c)).map((c) => compileNode(c, cx, b));
  const neg = n.and.filter((c): c is { not: Node } => "not" in c).map((c) => compileNode(c.not, cx, b));
  if (!pos.length && !neg.length) return NONE;
  const base = pos.length ? pos : [b.term({ sql: ALL, params: [] })];
  return base.map((p) => `SELECT id FROM (${p})`).join(" INTERSECT ") + neg.map((p) => ` EXCEPT SELECT id FROM (${p})`).join("");
}

/** The message ids for a query tree, as one self-contained SELECT (it may start with WITH). */
export function compileSet(n: Node, cx: CompileContext): Sql {
  const b = new SetBuilder();
  return b.build(compileNode(n, cx, b));
}

/** The ids of Trash and Spam messages (left out unless the query has in:trash, in:spam or in:anywhere). */
function hiddenSql(db: DB): Sql {
  return withLabels(labelIds(db, (name) => name === "Trash" || name === "Spam"));
}

/** The matching message ids, in the query's context. */
export function hitsSql(q: string | Node, cx: CompileContext): Sql {
  const node = typeof q === "string" ? parseQuery(q) : q;
  if (isEmptyQuery(node)) return { sql: NONE, params: [] };
  const b = new SetBuilder();
  const set = compileNode(node, cx, b);
  if (searchContext(node) !== "normal") return b.build(set);
  const hidden = b.term(hiddenSql(cx.db));
  return b.build(`SELECT id FROM (${set}) EXCEPT ${hidden}`);
}

export interface SearchResult extends ThreadList {
  highlight: HighlightTerm[];
  hiddenInTrashOrSpam: number; // matches left out because they are in Trash or Spam (counted only when nothing else matched)
}

export function searchThreads(db: DB, query: string, page: number, me: string[]): SearchResult {
  const node = parseQuery(query);
  const cx = { db, me };
  const hits = hitsSql(node, cx);
  const rows = db
    .prepare(
      // Thread and date come from the thread index, not the message rows: on a big result
      // (e.g. "the": 100k messages) that is about twice as fast, and it is never slower.
      `WITH hits(id) AS MATERIALIZED (${hits.sql})
       SELECT m.thread_id, max(${DATE}) AS last, count(*) OVER () AS total
       FROM messages m INDEXED BY messages_thread_date WHERE m.id IN hits
       GROUP BY m.thread_id ORDER BY last DESC, m.thread_id DESC LIMIT ? OFFSET ?`,
    )
    .all(...hits.params, PAGE_SIZE, (page - 1) * PAGE_SIZE) as { thread_id: string; last: number; total: number }[];
  let total = rows[0]?.total ?? 0;
  if (!rows.length && page > 1) {
    total = db
      .prepare(`WITH hits(id) AS MATERIALIZED (${hits.sql}) SELECT count(DISTINCT m.thread_id) FROM messages m INDEXED BY messages_thread_date WHERE m.id IN hits`)
      .pluck()
      .get(...hits.params) as number;
  }
  const p: PageRows = { rows, total };
  const view = `search:${query}`;
  // The snippet and date come from the newest matching message of each thread.
  const terms = highlightTerms(node);
  const list = summarizeThreads(db, view, page, p, me, {
    inView: { sql: `m.id IN (${hits.sql})`, params: hits.params },
    snippet: terms.length ? matchSnippet(db, terms) : undefined,
  });
  let hiddenInTrashOrSpam = 0;
  if (!total && !isEmptyQuery(node) && searchContext(node) === "normal") {
    const b = new SetBuilder();
    const all = compileNode(node, cx, b);
    const hidden = b.term(hiddenSql(db));
    const q = b.build(`SELECT count(*) FROM (SELECT id FROM (${all}) INTERSECT ${hidden})`);
    hiddenInTrashOrSpam = db.prepare(q.sql).pluck().get(...q.params) as number;
  }
  return { ...list, highlight: terms, hiddenInTrashOrSpam };
}

const BODY_CAP = 500_000; // the same cap as the search index

/**
 * Context snippets: the text around the first match in the message body. A match only in the
 * thread's note gives "Note: …"; a match only in the subject or people keeps the normal snippet.
 * Reads the bodies of the (at most 50) messages on the page.
 */
function matchSnippet(db: DB, terms: HighlightTerm[]) {
  const body = db.prepare(`SELECT substr(body_text, 1, ${BODY_CAP}) AS text, substr(body_html, 1, ${BODY_CAP}) AS html FROM messages WHERE id = ?`);
  const note = db.prepare("SELECT body FROM thread_notes WHERE thread_id = ?").pluck();
  return (messageId: number, threadId: string): string | null => {
    const r = body.get(messageId) as { text: string | null; html: string | null } | undefined;
    const text = r?.text ?? (r?.html ? htmlToText(r.html) : "");
    const inBody = contextSnippet(text, terms);
    if (inBody) return inBody;
    const n = note.get(threadId) as string | undefined;
    const inNote = n ? contextSnippet(n, terms, 190) : null;
    return inNote ? `Note: ${inNote}` : null;
  };
}

/** Every thread that matches (for "select all N conversations" in search results). */
export function searchThreadIds(db: DB, query: string, me: string[]): string[] {
  const hits = hitsSql(query, { db, me });
  return db
    .prepare(`WITH hits(id) AS MATERIALIZED (${hits.sql}) SELECT DISTINCT m.thread_id FROM messages m INDEXED BY messages_thread_date WHERE m.id IN hits`)
    .pluck()
    .all(...hits.params) as string[];
}
