// Read queries: sidebar, thread list, thread detail.
// A thread appears in a view if ANY of its messages does (Gmail's conversation view).
import {
  FOLDERS,
  categoryName,
  isCategory,
  isNotesView,
  isUserLabel,
  viewContext,
  viewLabel,
  type View,
} from "../shared/labels.ts";
import type {
  Address,
  AttachmentInfo,
  MessageDetail,
  Participant,
  Sidebar,
  SidebarItem,
  ThreadDetail,
  ThreadList,
  ThreadSummary,
} from "../shared/types.ts";
import { chosenColors, type DB } from "./db.ts";
import { getNote, noteFirstLines } from "./notes.ts";

export const PAGE_SIZE = 50;
const DATE = "coalesce(m.received_utc, m.date_utc, 0)";

export function labelId(db: DB, name: string): number | undefined {
  return db.prepare("SELECT id FROM labels WHERE name = ?").pluck().get(name) as number | undefined;
}

interface Sql {
  sql: string;
  params: unknown[];
}

/** Messages a view's context allows: Trash and Spam hide mail everywhere else. Alias: m. */
export function contextSql(db: DB, view: View): Sql {
  const ctx = viewContext(view);
  if (ctx === "all") return { sql: "1", params: [] };
  if (ctx === "trash" || ctx === "spam") {
    return { sql: "EXISTS (SELECT 1 FROM message_labels x WHERE x.message_id = m.id AND x.label_id = ?)", params: [labelId(db, ctx === "trash" ? "Trash" : "Spam") ?? -1] };
  }
  return {
    sql: "NOT EXISTS (SELECT 1 FROM message_labels x WHERE x.message_id = m.id AND x.label_id IN (?, ?))",
    params: [labelId(db, "Trash") ?? -1, labelId(db, "Spam") ?? -1],
  };
}

interface FromSql extends Sql {
  from: string;
}

/**
 * Messages that are in a view: FROM + WHERE. Alias: m.
 * Label views start from the message_labels index (CROSS JOIN fixes the join order); letting
 * SQLite choose can make it scan every message, which reads every stored body.
 */
export function viewSql(db: DB, view: View): FromSql {
  const label = viewLabel(view);
  if (isNotesView(view)) return { from: "thread_notes n CROSS JOIN messages m ON m.thread_id = n.thread_id", ...contextSql(db, view) };
  if (label === null) return { from: "messages m", ...contextSql(db, view) };
  const from = "message_labels vl CROSS JOIN messages m ON m.id = vl.message_id";
  if (label === "Trash" || label === "Spam") return { from, sql: "vl.label_id = ?", params: [labelId(db, label) ?? -1] };
  const ctx = contextSql(db, view);
  return { from, sql: `vl.label_id = ? AND ${ctx.sql}`, params: [labelId(db, label) ?? -1, ...ctx.params] };
}

function placeholders(n: number): string {
  return Array(n).fill("?").join(", ");
}

function labelsByMessage(db: DB, ids: number[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  if (!ids.length) return out;
  // Chunk to stay under SQLite's parameter limit on huge threads.
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = db
      .prepare(`SELECT ml.message_id AS id, l.name FROM message_labels ml JOIN labels l ON l.id = ml.label_id WHERE ml.message_id IN (${placeholders(chunk.length)})`)
      .all(...chunk) as { id: number; name: string }[];
    for (const r of rows) {
      if (!out.has(r.id)) out.set(r.id, []);
      out.get(r.id)!.push(r.name);
    }
  }
  return out;
}

/** "Alice Adams" -> "Alice"; "Doe, Jane" -> "Jane"; "" + "bob@x.com" -> "bob". */
export function firstName(name: string | null, addr: string | null): string {
  let n = (name ?? "").trim().replace(/^["']|["']$/g, "");
  if (!n || n.includes("@")) return (addr ?? n).split("@")[0] || "(unknown)";
  if (n.includes(",")) n = n.split(",")[1].trim() || n;
  return n.split(/\s+/)[0];
}

/** User-label chips for a set of messages; "Inbox" too when not viewing the Inbox. */
function chips(labelSets: string[][], view: View): string[] {
  const current = viewLabel(view);
  const all = new Set(labelSets.flat());
  const out = [...all].filter((l) => isUserLabel(l) && l !== current).sort((a, b) => a.localeCompare(b));
  if (view !== "inbox" && all.has("Inbox")) out.unshift("Inbox");
  return out;
}

// ------------------------------------------------------------------ sidebar

const CATEGORY_ORDER = ["Personal", "Social", "Promotions", "Updates", "Forums", "Purchases", "Travel"];

export function sidebar(db: DB): Sidebar {
  const labels = db.prepare("SELECT id, name FROM labels").all() as { id: number; name: string }[];
  const messages = new Map(
    (db.prepare("SELECT label_id AS id, count(*) AS n FROM message_labels GROUP BY label_id").all() as { id: number; n: number }[]).map((r) => [r.id, r.n]),
  );
  const byName = new Map(labels.map((l) => [l.name, l.id]));
  const unreadId = byName.get("Unread") ?? -1;
  // Filter through the Unread label's index, never the is_unread column: scanning `messages`
  // reads every stored body (gigabytes on a real archive).
  const ctx = contextSql(db, "inbox");
  const unread = new Map(
    (
      db
        .prepare(
          `SELECT ml.label_id AS id, count(DISTINCT m.thread_id) AS n
           FROM message_labels u CROSS JOIN messages m ON m.id = u.message_id
           JOIN message_labels ml ON ml.message_id = m.id
           WHERE u.label_id = ? AND ${ctx.sql} GROUP BY ml.label_id`,
        )
        .all(unreadId, ...ctx.params) as { id: number; n: number }[]
    ).map((r) => [r.id, r.n]),
  );
  const threadsWith = (label: string, unreadOnly: boolean) => {
    const id = byName.get(label);
    if (id === undefined) return 0;
    const c = label === "Spam" ? { sql: "1", params: [] } : contextSql(db, "inbox");
    const unreadSql = "EXISTS (SELECT 1 FROM message_labels u WHERE u.message_id = m.id AND u.label_id = ?)";
    return db
      .prepare(
        `SELECT count(DISTINCT m.thread_id) FROM message_labels vl CROSS JOIN messages m ON m.id = vl.message_id
         WHERE vl.label_id = ? ${unreadOnly ? `AND ${unreadSql}` : ""} AND ${c.sql}`,
      )
      .pluck()
      .get(id, ...(unreadOnly ? [unreadId] : []), ...c.params) as number;
  };

  const folders: SidebarItem[] = [];
  for (const f of FOLDERS) {
    if (f.notes) {
      const n = viewPage(db, f.id, 1).total;
      if (n) folders.push({ view: f.id, name: f.name, count: n });
      continue;
    }
    const id = f.label ? byName.get(f.label) : undefined;
    if (f.hideIfEmpty && (id === undefined || !messages.get(id))) continue;
    let count: number | null = null;
    if (f.count === "unread") count = f.id === "spam" ? threadsWith("Spam", true) : (id !== undefined ? unread.get(id) ?? 0 : 0);
    if (f.count === "total") count = threadsWith(f.label!, false);
    folders.push({ view: f.id, name: f.name, count: count || null });
  }

  const categories = labels
    .filter((l) => isCategory(l.name) && messages.get(l.id))
    .sort((a, b) => {
      const ia = CATEGORY_ORDER.indexOf(categoryName(a.name));
      const ib = CATEGORY_ORDER.indexOf(categoryName(b.name));
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.name.localeCompare(b.name);
    })
    .map((l) => ({ view: `label:${l.name}`, name: categoryName(l.name), count: unread.get(l.id) || null, labelId: l.id }));

  const user = labels
    .filter((l) => isUserLabel(l.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    .map((l) => ({ view: `label:${l.name}`, name: l.name, count: unread.get(l.id) || null, messages: messages.get(l.id) ?? 0, labelId: l.id }));

  return { folders, categories, labels: user, labelColors: chosenColors(db) };
}

// ------------------------------------------------------------------ thread list

interface ListRow {
  id: number;
  thread_id: string;
  subject: string | null;
  snippet: string | null;
  from_name: string | null;
  from_addr: string | null;
  to_json: string | null;
  cc_json: string | null;
  is_unread: number;
  is_starred: number;
  is_important: number;
  d: number;
  has_att: number;
  in_view: number;
}

/** One page of a thread list: which threads, in what order, and how many in all. */
export interface PageRows {
  rows: { thread_id: string; last: number | null }[]; // last: the date to show; null = the newest message's
  total: number;
}

/** The threads of a folder or label view, newest first (the Notes folder: newest note first). */
export function viewPage(db: DB, view: View, page: number): PageRows {
  const offset = (page - 1) * PAGE_SIZE;
  if (isNotesView(view)) {
    // Threads with a note that have a message outside Trash and Spam.
    const ctx = contextSql(db, view);
    const where = `EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = n.thread_id AND ${ctx.sql})`;
    const rows = db
      .prepare(
        `SELECT n.thread_id, NULL AS last, count(*) OVER () AS total FROM thread_notes n WHERE ${where}
         ORDER BY n.updated_at DESC, n.thread_id DESC LIMIT ? OFFSET ?`,
      )
      .all(...ctx.params, PAGE_SIZE, offset) as { thread_id: string; last: null; total: number }[];
    const total = rows[0]?.total ?? (db.prepare(`SELECT count(*) FROM thread_notes n WHERE ${where}`).pluck().get(...ctx.params) as number);
    return { rows, total };
  }
  const v = viewSql(db, view);
  const rows = db
    .prepare(
      `WITH t AS (SELECT m.thread_id, max(${DATE}) AS last FROM ${v.from} WHERE ${v.sql} GROUP BY m.thread_id)
       SELECT thread_id, last, count(*) OVER () AS total FROM t ORDER BY last DESC, thread_id DESC LIMIT ? OFFSET ?`,
    )
    .all(...v.params, PAGE_SIZE, offset) as { thread_id: string; last: number; total: number }[];
  let total = rows[0]?.total ?? 0;
  if (!rows.length && page > 1) {
    total = db.prepare(`SELECT count(DISTINCT m.thread_id) FROM ${v.from} WHERE ${v.sql}`).pluck().get(...v.params) as number;
  }
  return { rows, total };
}

export function listThreads(db: DB, view: View, page: number, me: string[]): ThreadList {
  return summarizeThreads(db, view, page, viewPage(db, view, page), me);
}

/**
 * The rows of one page: participants, snippet, chips… for the 50 threads only.
 * inView: which messages count as "in the view" (the snippet and date come from the newest of them);
 * default: messages with the view's label.
 */
export function summarizeThreads(
  db: DB,
  view: View,
  page: number,
  p: PageRows,
  me: string[],
  opts: { inView?: Sql; snippet?: (messageId: number, threadId: string) => string | null } = {},
): ThreadList {
  const { rows: pageRows, total } = p;
  const ids = pageRows.map((r) => r.thread_id);
  if (!ids.length) return { view, page, pageSize: PAGE_SIZE, total, threads: [] };

  const ctx = contextSql(db, view);
  const label = viewLabel(view);
  const inView = opts.inView ??
    (label && label !== "Trash" && label !== "Spam"
      ? // Correlated EXISTS: one primary-key probe per message (an IN list would gather every message with the label).
        { sql: "EXISTS (SELECT 1 FROM message_labels il WHERE il.message_id = m.id AND il.label_id = ?)", params: [labelId(db, label) ?? -1] }
      : { sql: "1", params: [] });
  const rows = db
    .prepare(
      `SELECT m.id, m.thread_id, m.subject, m.snippet, m.from_name, m.from_addr, m.to_json, m.cc_json,
              m.is_unread, m.is_starred, m.is_important, ${DATE} AS d,
              EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.is_inline = 0) AS has_att,
              (${inView.sql}) AS in_view
       FROM messages m
       WHERE m.thread_id IN (${placeholders(ids.length)}) AND ${ctx.sql}
       ORDER BY d, m.id`,
    )
    .all(...inView.params, ...ids, ...ctx.params) as ListRow[];
  const labels = labelsByMessage(db, rows.map((r) => r.id));
  const meSet = new Set(me);
  const byThread = new Map<string, ListRow[]>();
  for (const r of rows) {
    if (!byThread.has(r.thread_id)) byThread.set(r.thread_id, []);
    byThread.get(r.thread_id)!.push(r);
  }

  const toPrefix = view === "sent" || view === "drafts";
  const notes = noteFirstLines(db, ids);
  const threads: ThreadSummary[] = pageRows.map(({ thread_id, last }) => {
    const msgs = byThread.get(thread_id) ?? [];
    const visible = msgs.filter((m) => m.in_view);
    const newest = visible[visible.length - 1] ?? msgs[msgs.length - 1];
    let participants: Participant[];
    if (toPrefix && newest) {
      const rcpts: Address[] = [...JSON.parse(newest.to_json ?? "[]"), ...JSON.parse(newest.cc_json ?? "[]")];
      participants = rcpts.map((a) => ({ name: meSet.has(a.addr) ? "me" : firstName(a.name, a.addr), unread: false }));
    } else {
      const seen = new Map<string, Participant>();
      for (const m of msgs) {
        const key = m.from_addr ?? m.from_name ?? "?";
        const p = seen.get(key) ?? { name: meSet.has(m.from_addr ?? "") ? "me" : firstName(m.from_name, m.from_addr), unread: false };
        p.unread ||= !!m.is_unread;
        seen.set(key, p);
      }
      participants = [...seen.values()];
    }
    return {
      threadId: thread_id,
      subject: msgs.find((m) => m.subject)?.subject ?? "",
      snippet: isNotesView(view) ? notes.get(thread_id) ?? "" : (newest && opts.snippet?.(newest.id, thread_id)) ?? newest?.snippet ?? "",
      date: (last ?? newest?.d) || null,
      participants,
      toPrefix,
      messageCount: msgs.length,
      unread: msgs.some((m) => m.is_unread),
      starred: msgs.some((m) => m.is_starred),
      important: msgs.some((m) => m.is_important),
      hasAttachments: msgs.some((m) => m.has_att),
      labels: chips(msgs.map((m) => labels.get(m.id) ?? []), view),
      hasNote: notes.has(thread_id),
      noteFirstLine: notes.get(thread_id) ?? null,
    };
  });
  return { view, page, pageSize: PAGE_SIZE, total, threads };
}

// ------------------------------------------------------------------ thread detail

interface MessageRow {
  id: number;
  gmail_id: string;
  subject: string | null;
  snippet: string | null;
  from_name: string | null;
  from_addr: string | null;
  to_json: string | null;
  cc_json: string | null;
  bcc_json: string | null;
  reply_to_json: string | null;
  body_text: string | null;
  body_html: string | null;
  is_unread: number;
  is_starred: number;
  d: number;
}

export function threadDetail(db: DB, threadId: string, view: View): ThreadDetail | null {
  const rows = db
    .prepare(
      `SELECT m.id, m.gmail_id, m.subject, m.snippet, m.from_name, m.from_addr, m.to_json, m.cc_json, m.bcc_json,
              m.reply_to_json, m.body_text, m.body_html, m.is_unread, m.is_starred, ${DATE} AS d
       FROM messages m WHERE m.thread_id = ? ORDER BY d, m.id`,
    )
    .all(threadId) as MessageRow[];
  if (!rows.length) return null;
  const ids = rows.map((r) => r.id);
  const labels = labelsByMessage(db, ids);
  const atts = new Map<number, AttachmentInfo[]>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const arows = db
      .prepare(
        `SELECT id, message_id, filename, content_type, size_bytes, content_id, is_inline FROM attachments
         WHERE message_id IN (${placeholders(chunk.length)}) ORDER BY message_id, part_index`,
      )
      .all(...chunk) as { id: number; message_id: number; filename: string | null; content_type: string; size_bytes: number; content_id: string | null; is_inline: number }[];
    for (const a of arows) {
      if (!atts.has(a.message_id)) atts.set(a.message_id, []);
      atts.get(a.message_id)!.push({ id: a.id, filename: a.filename, contentType: a.content_type, size: a.size_bytes, contentId: a.content_id, isInline: !!a.is_inline });
    }
  }
  const ctx = viewContext(view);
  const addrs = (json: string | null): Address[] => (json ? JSON.parse(json) : []);
  const messages: MessageDetail[] = rows.map((r) => {
    const ls = labels.get(r.id) ?? [];
    const inContext =
      ctx === "all" ? true : ctx === "trash" ? ls.includes("Trash") : ctx === "spam" ? ls.includes("Spam") : !ls.includes("Trash") && !ls.includes("Spam");
    return {
      id: r.id,
      gmailId: r.gmail_id,
      from: r.from_name || r.from_addr ? { name: r.from_name ?? "", addr: r.from_addr ?? "" } : null,
      to: addrs(r.to_json),
      cc: addrs(r.cc_json),
      bcc: addrs(r.bcc_json),
      replyTo: addrs(r.reply_to_json),
      date: r.d || null,
      subject: r.subject ?? "",
      snippet: r.snippet ?? "",
      bodyText: r.body_text,
      bodyHtml: r.body_html,
      unread: !!r.is_unread,
      starred: !!r.is_starred,
      labels: ls,
      inContext,
      attachments: atts.get(r.id) ?? [],
    };
  });
  const shown = messages.filter((m) => m.inContext);
  return {
    threadId,
    subject: (shown.find((m) => m.subject) ?? messages.find((m) => m.subject))?.subject ?? "",
    labels: chips(shown.map((m) => m.labels), view),
    messages,
    note: getNote(db, threadId),
  };
}

/** "Show original": what the archive has of the source (headers + decoded text). */
export function original(db: DB, messageId: number): string | null {
  const r = db.prepare("SELECT headers_raw, body_text, body_html FROM messages WHERE id = ?").get(messageId) as
    | { headers_raw: string | null; body_text: string | null; body_html: string | null }
    | undefined;
  if (!r) return null;
  const atts = db
    .prepare("SELECT part_index, filename, content_type, size_bytes FROM attachments WHERE message_id = ? ORDER BY part_index")
    .all(messageId) as { part_index: number; filename: string | null; content_type: string; size_bytes: number }[];
  const parts = [
    r.headers_raw ?? "",
    "",
    "----- text/plain (decoded) -----",
    r.body_text ?? "(none)",
    "",
    "----- text/html (decoded) -----",
    r.body_html ?? "(none)",
  ];
  if (atts.length) {
    parts.push("", "----- attachments -----", ...atts.map((a) => `${a.part_index}. ${a.filename ?? "(no name)"}  ${a.content_type}  ${a.size_bytes} bytes`));
  }
  return parts.join("\n");
}

