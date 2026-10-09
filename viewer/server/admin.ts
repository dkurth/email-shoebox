// The admin page: archive statistics. Every query reads narrow tables or indexes, never every
// message row (each holds a full body).
import fs from "node:fs";
import path from "node:path";
import type { AdminImport, AdminLabel, AdminOverview, AdminPerson } from "../shared/types.ts";
import type { Archive, DB } from "./db.ts";
import { labelId } from "./views.ts";

const one = (db: DB, sql: string, ...params: unknown[]) => db.prepare(sql).pluck().get(...params) as number | null;

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function labelCount(db: DB, name: string): number {
  const id = labelId(db, name);
  return id === undefined ? 0 : (one(db, "SELECT count(*) FROM message_labels WHERE label_id = ?", id) ?? 0);
}

export function overview(archive: Archive, me: string[]): AdminOverview {
  const { db } = archive;
  const minMax = (fn: "min" | "max") =>
    // Separate queries, so each one is a single index lookup.
    [one(db, `SELECT ${fn}(received_utc) FROM messages`), one(db, `SELECT ${fn}(date_utc) FROM messages WHERE received_utc IS NULL`)].filter(
      (x): x is number => x !== null,
    );
  const firsts = minMax("min");
  const lasts = minMax("max");
  const att = db
    .prepare(
      `SELECT
         count(*) FILTER (WHERE deleted_at IS NULL AND is_inline = 0) AS n,
         coalesce(sum(size_bytes) FILTER (WHERE deleted_at IS NULL AND is_inline = 0), 0) AS bytes,
         count(*) FILTER (WHERE deleted_at IS NULL AND is_inline = 1) AS inlineN,
         coalesce(sum(size_bytes) FILTER (WHERE deleted_at IS NULL AND is_inline = 1), 0) AS inlineBytes,
         count(*) FILTER (WHERE deleted_at IS NOT NULL) AS deletedN,
         coalesce(sum(size_bytes) FILTER (WHERE deleted_at IS NOT NULL), 0) AS deletedBytes
       FROM attachments`,
    )
    .get() as { n: number; bytes: number; inlineN: number; inlineBytes: number; deletedN: number; deletedBytes: number };
  const pageSize = db.pragma("page_size", { simple: true }) as number;
  const freePages = db.pragma("freelist_count", { simple: true }) as number;
  const dbFile = path.join(archive.dir, "mail.db");
  const parseErrors = db
    .prepare(
      `SELECT id, coalesce(received_utc, date_utc) AS date, from_name AS fromName, from_addr AS fromAddr, subject, thread_id AS threadId, parse_error AS error
       FROM messages WHERE parse_error IS NOT NULL ORDER BY id LIMIT 200`,
    )
    .all() as AdminOverview["parseErrors"];
  return {
    messages: one(db, "SELECT count(*) FROM messages") ?? 0,
    messageBytes: one(db, "SELECT coalesce(sum(size_bytes), 0) FROM messages INDEXED BY messages_size") ?? 0,
    threads: one(db, "SELECT count(*) FROM threads") ?? 0,
    unread: labelCount(db, "Unread"),
    starred: labelCount(db, "Starred"),
    firstDate: firsts.length ? Math.min(...firsts) : null,
    lastDate: lasts.length ? Math.max(...lasts) : null,
    attachments: att.n,
    attachmentBytes: att.bytes,
    inlineImages: att.inlineN,
    inlineBytes: att.inlineBytes,
    deletedAttachments: att.deletedN,
    deletedBytes: att.deletedBytes,
    dbBytes: fileSize(dbFile),
    walBytes: fileSize(dbFile + "-wal"),
    freeBytes: pageSize * freePages,
    parseErrorCount: one(db, "SELECT count(*) FROM messages WHERE parse_error IS NOT NULL") ?? 0,
    parseErrors,
    notes: one(db, "SELECT count(*) FROM thread_notes") ?? 0,
    topSenders: people(db, me, { dir: "received", page: 1, pageSize: 10 }).rows,
  };
}

/** Every label: messages, threads and unread messages. */
export function labels(db: DB): AdminLabel[] {
  const unreadId = labelId(db, "Unread") ?? -1;
  const rows = db
    .prepare(
      `SELECT l.id, l.name,
         (SELECT count(*) FROM message_labels ml WHERE ml.label_id = l.id) AS messages
       FROM labels l`,
    )
    .all() as { id: number; name: string; messages: number }[];
  // Threads per label from the threads table's label lists (narrow; no message rows).
  const threads = new Map(
    (db.prepare("SELECT j.value AS name, count(*) AS n FROM threads t, json_each(t.labels_json) j GROUP BY j.value").all() as { name: string; n: number }[]).map(
      (r) => [r.name, r.n],
    ),
  );
  const unread = new Map(
    (
      db
        .prepare(
          `SELECT ml.label_id AS id, count(*) AS n FROM message_labels u JOIN message_labels ml ON ml.message_id = u.message_id
           WHERE u.label_id = ? GROUP BY ml.label_id`,
        )
        .all(unreadId) as { id: number; n: number }[]
    ).map((r) => [r.id, r.n]),
  );
  return rows
    .filter((r) => r.messages > 0)
    .map((r) => ({ id: r.id, name: r.name, messages: r.messages, threads: threads.get(r.name) ?? 0, unread: unread.get(r.id) ?? 0 }));
}

export function imports(db: DB): AdminImport[] {
  const rows = db.prepare("SELECT * FROM imports ORDER BY id DESC").all() as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as number,
    startedAt: r.started_at as number,
    finishedAt: (r.finished_at as number | null) ?? null,
    status: r.status as string,
    sources: (() => {
      try {
        return (JSON.parse((r.sources_json as string) ?? "[]") as string[]).map((s) => path.basename(s));
      } catch {
        return [];
      }
    })(),
    toolVersion: (r.tool_version as string | null) ?? null,
    counts: {
      seen: r.messages_seen as number,
      inserted: r.inserted as number,
      labelsChanged: r.labels_changed as number,
      unchanged: r.unchanged as number,
      skipped: r.skipped as number,
      errors: r.errors as number,
      keptLocal: (r.kept_local as number) ?? 0,
      deletedSkipped: (r.deleted_skipped as number) ?? 0,
    },
  }));
}

// ------------------------------------------------------------------ people

export interface PeopleQuery {
  dir: "sent" | "received";
  q?: string; // filter: part of the address or name
  sort?: "count" | "addr" | "name" | "last" | "attachmentBytes";
  desc?: boolean;
  page: number;
  pageSize?: number;
  chats?: boolean; // include Chat messages (default: no)
  byDomain?: boolean;
}

export const PEOPLE_PAGE = 100;

/**
 * "People I sent to": the To/Cc/Bcc addresses of messages with the Sent label.
 * "People I received from": the senders of messages without it (your own addresses left out).
 */
export function people(db: DB, me: string[], pq: PeopleQuery): { rows: AdminPerson[]; total: number } {
  const sent = labelId(db, "Sent") ?? -1;
  const chat = labelId(db, "Chat") ?? -1;
  const where: string[] = [];
  const params: unknown[] = [];
  if (pq.dir === "sent") {
    where.push("a.role IN ('to', 'cc', 'bcc')", "a.message_id IN (SELECT message_id FROM message_labels WHERE label_id = ?)");
    params.push(sent);
  } else {
    where.push("a.role = 'from'", "a.message_id NOT IN (SELECT message_id FROM message_labels WHERE label_id = ?)");
    params.push(sent);
    if (me.length) {
      where.push(`a.addr NOT IN (${me.map(() => "?").join(",")})`);
      params.push(...me);
    }
  }
  if (!pq.chats) {
    where.push("a.message_id NOT IN (SELECT message_id FROM message_labels WHERE label_id = ?)");
    params.push(chat);
  }
  const key = pq.byDomain ? "lower(substr(a.addr, instr(a.addr, '@') + 1))" : "a.addr";
  if (pq.q?.trim()) {
    const like = `%${pq.q.trim().toLowerCase().replace(/[\\%_]/g, (c) => "\\" + c)}%`;
    where.push(pq.byDomain ? `${key} LIKE ? ESCAPE '\\'` : "(a.addr LIKE ? ESCAPE '\\' OR a.name LIKE ? ESCAPE '\\')");
    params.push(like, ...(pq.byDomain ? [] : [like]));
  }
  const sortCol = { count: "n", addr: "g.k", name: "name", last: "last", attachmentBytes: "attBytes" }[pq.sort ?? "count"] ?? "n";
  const dir = pq.desc === false ? "ASC" : "DESC";
  const size = pq.pageSize ?? PEOPLE_PAGE;
  // Everything is grouped from narrow sets: the address rows (g2), each message's date from the
  // thread index (md), and attachment sizes. No message row is read.
  const sql = `
    WITH g2 AS MATERIALIZED (SELECT ${key} AS k, a.addr, a.name, a.role, a.message_id FROM message_addresses a WHERE ${where.join(" AND ")}),
    g AS (SELECT k, count(DISTINCT message_id) AS n, count(DISTINCT addr) AS addrs,
                 count(*) FILTER (WHERE role = 'to') AS toN, count(*) FILTER (WHERE role = 'cc') AS ccN,
                 count(*) FILTER (WHERE role = 'bcc') AS bccN
          FROM g2 GROUP BY k),
    names AS (SELECT k, name FROM (
                SELECT k, name, row_number() OVER (PARTITION BY k ORDER BY count(*) DESC, name) AS rn
                FROM g2 WHERE name != '' GROUP BY k, name) WHERE rn = 1),
    md AS MATERIALIZED (SELECT id, coalesce(received_utc, date_utc) AS d FROM messages INDEXED BY messages_thread_date),
    dates AS (SELECT g2.k, max(md.d) AS last FROM g2 JOIN md ON md.id = g2.message_id GROUP BY g2.k),
    att AS (SELECT g2.k, count(*) AS attN, sum(x.size_bytes) AS attBytes
            FROM (SELECT DISTINCT k, message_id FROM g2) g2 JOIN attachments x ON x.message_id = g2.message_id
            WHERE x.is_inline = 0 GROUP BY g2.k)
    SELECT g.k AS addr, g.n, g.addrs, g.toN, g.ccN, g.bccN, coalesce(names.name, '') AS name, dates.last,
           coalesce(att.attN, 0) AS attN, coalesce(att.attBytes, 0) AS attBytes, count(*) OVER () AS total
    FROM g LEFT JOIN names ON names.k = g.k LEFT JOIN dates ON dates.k = g.k LEFT JOIN att ON att.k = g.k
    ORDER BY ${sortCol} ${dir}, g.k LIMIT ? OFFSET ?`;
  const all = db.prepare(sql).all(...params, size, (pq.page - 1) * size) as Record<string, unknown>[];
  const rows = all.map((r) => ({
    addr: r.addr as string,
    name: (r.name as string | null) ?? "",
    count: r.n as number,
    addresses: r.addrs as number,
    to: r.toN as number,
    cc: r.ccN as number,
    bcc: r.bccN as number,
    last: (r.last as number | null) ?? null,
    attachments: r.attN as number,
    attachmentBytes: r.attBytes as number,
  }));
  let total = (all[0]?.total as number | undefined) ?? 0;
  if (!all.length && pq.page > 1) {
    total = db.prepare(`SELECT count(DISTINCT ${key}) FROM message_addresses a WHERE ${where.join(" AND ")}`).pluck().get(...params) as number;
  }
  return { rows, total };
}
