// The attachment report on the admin page: totals by type and sender, and the list, biggest first.
// It reads the attachments table (narrow), the sender rows and the thread index; message rows only
// for the subjects of the 100 rows on the page.
import { TYPE_RULES, TYPE_GROUPS, type TypeGroup } from "../shared/fileTypes.ts";
import type { AttachmentRow, AttachmentSummary, DupeGroup } from "../shared/types.ts";
import type { DB } from "./db.ts";

export const REPORT_PAGE = 100;

const q = (s: string) => `'${s.replace(/'/g, "''")}'`; // our own fixed strings only

// The file extension in SQL: everything after the last "." (or "" when there is none).
const EXT = `lower(CASE WHEN instr(x.filename, '.') > 0 THEN replace(x.filename, rtrim(x.filename, replace(x.filename, '.', '')), '') ELSE '' END)`;

/** The TYPE_RULES of shared/fileTypes.ts as a SQL CASE over attachments x. */
export const GROUP_SQL = (() => {
  const ct = "lower(coalesce(x.content_type, ''))";
  const byType = TYPE_RULES.map((r) => {
    const tests = [...(r.prefixes ?? []).map((p) => `${ct} LIKE ${q(p + "%")}`), ...(r.contains ?? []).map((c) => `instr(${ct}, ${q(c)}) > 0`)];
    return `WHEN ${tests.join(" OR ")} THEN ${q(r.group)}`;
  });
  const byExt = TYPE_RULES.map((r) => `WHEN ${EXT} IN (${r.exts.map(q).join(", ")}) THEN ${q(r.group)}`);
  return `(CASE ${byType.join(" ")} ${byExt.join(" ")} ELSE 'Other' END)`;
})();

export function summary(db: DB, inline: boolean): AttachmentSummary {
  const where = `x.deleted_at IS NULL${inline ? "" : " AND x.is_inline = 0"}`;
  const total = db.prepare(`SELECT count(*) AS n, coalesce(sum(size_bytes), 0) AS bytes FROM attachments x WHERE ${where}`).get() as { n: number; bytes: number };
  const rows = db
    .prepare(
      `SELECT ${GROUP_SQL} AS grp, lower(coalesce(x.content_type, '')) AS type, count(*) AS n, sum(x.size_bytes) AS bytes
       FROM attachments x WHERE ${where} GROUP BY grp, type ORDER BY bytes DESC`,
    )
    .all() as { grp: TypeGroup; type: string; n: number; bytes: number }[];
  const groups = TYPE_GROUPS.map((g) => {
    const types = rows.filter((r) => r.grp === g).map((r) => ({ type: r.type || "(none)", count: r.n, bytes: r.bytes }));
    return { group: g, count: types.reduce((s, t) => s + t.count, 0), bytes: types.reduce((s, t) => s + t.bytes, 0), types };
  })
    .filter((g) => g.count > 0)
    .sort((a, b) => b.bytes - a.bytes);
  const senders = db
    .prepare(
      `SELECT a.addr, max(a.name) AS name, count(*) AS n, sum(x.size_bytes) AS bytes
       FROM attachments x JOIN message_addresses a ON a.message_id = x.message_id AND a.role = 'from'
       WHERE ${where} GROUP BY a.addr ORDER BY bytes DESC LIMIT 20`,
    )
    .all() as { addr: string; name: string; n: number; bytes: number }[];
  return {
    count: total.n,
    bytes: total.bytes,
    groups,
    senders: senders.map((s) => ({ addr: s.addr, name: s.name ?? "", count: s.n, bytes: s.bytes })),
  };
}

export interface ReportQuery {
  sort?: "size" | "date" | "name" | "sender";
  desc?: boolean;
  type?: string; // a type group
  from?: string; // sender address
  min?: number; // bytes
  deleted?: boolean; // also show deleted ones
  inline?: boolean; // also show images inside email text
  dupes?: boolean; // only files stored more than once
  sha256?: string; // only the copies of one file
  page: number;
}

/** Files (by content) stored more than once, not counting deleted copies. */
const DUPE_SHAS = "SELECT sha256 FROM attachments WHERE deleted_at IS NULL GROUP BY sha256 HAVING count(*) > 1";

/** The WHERE clause and params for a report filter (also used to delete "all that match"). */
export function reportWhere(rq: Omit<ReportQuery, "sort" | "desc" | "page">): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!rq.deleted) where.push("x.deleted_at IS NULL");
  if (!rq.inline) where.push("x.is_inline = 0");
  if (rq.type) {
    if (!(TYPE_GROUPS as readonly string[]).includes(rq.type)) throw new Error(`unknown type group: ${rq.type}`);
    where.push(`${GROUP_SQL} = ?`);
    params.push(rq.type);
  }
  if (rq.from) {
    where.push("x.message_id IN (SELECT message_id FROM message_addresses WHERE role = 'from' AND addr = ?)");
    params.push(rq.from.toLowerCase());
  }
  if (rq.min) {
    where.push("x.size_bytes > ?");
    params.push(rq.min);
  }
  if (rq.dupes) where.push(`x.sha256 IN (${DUPE_SHAS})`);
  if (rq.sha256) {
    where.push("x.sha256 = ?");
    params.push(rq.sha256);
  }
  return { sql: where.length ? where.join(" AND ") : "1", params };
}

export function report(db: DB, rq: ReportQuery): { rows: AttachmentRow[]; total: number } {
  const w = reportWhere(rq);
  const dir = rq.desc === false ? "ASC" : "DESC";
  const order = {
    size: `x.size_bytes ${dir}`,
    date: `md.d ${dir}`,
    name: `lower(coalesce(x.filename, '')) ${dir}`,
    sender: `snd.addr ${dir}`,
  }[rq.sort ?? "size"];
  const rows = db
    .prepare(
      `WITH md AS MATERIALIZED (SELECT id, thread_id, coalesce(received_utc, date_utc) AS d FROM messages INDEXED BY messages_thread_date)
       SELECT x.id, x.filename, x.size_bytes AS size, x.content_type AS contentType, x.deleted_at AS deletedAt, x.is_inline AS isInline,
              x.sha256, x.message_id AS messageId, md.thread_id AS threadId, md.d AS date, snd.addr AS fromAddr, snd.name AS fromName,
              ${GROUP_SQL} AS typeGroup, coalesce(d.copies, 1) AS copies, count(*) OVER () AS total
       FROM attachments x JOIN md ON md.id = x.message_id
       LEFT JOIN message_addresses snd ON snd.message_id = x.message_id AND snd.role = 'from'
       LEFT JOIN (SELECT sha256, count(*) AS copies FROM attachments WHERE deleted_at IS NULL GROUP BY sha256 HAVING count(*) > 1) d ON d.sha256 = x.sha256
       WHERE ${w.sql}
       ORDER BY ${order}, x.id LIMIT ? OFFSET ?`,
    )
    .all(...w.params, REPORT_PAGE, (rq.page - 1) * REPORT_PAGE) as (Omit<AttachmentRow, "isInline" | "subject"> & { total: number; isInline: number })[];
  const subjects = new Map<number, string | null>();
  const subj = db.prepare("SELECT subject FROM messages WHERE id = ?").pluck();
  for (const r of rows) if (!subjects.has(r.messageId)) subjects.set(r.messageId, subj.get(r.messageId) as string | null);
  let total = rows[0]?.total ?? 0;
  if (!rows.length && rq.page > 1) total = db.prepare(`SELECT count(*) FROM attachments x WHERE ${w.sql}`).pluck().get(...w.params) as number;
  return {
    rows: rows.map(({ total: _t, isInline, ...r }) => ({ ...r, isInline: !!isInline, subject: subjects.get(r.messageId) ?? null })),
    total,
  };
}

// ------------------------------------------------------------------ duplicates

export interface DupeSummary {
  groups: number; // files stored more than once
  extraCopies: number; // copies beyond the first
  extraBytes: number; // the space those copies use
}

export function dupeSummary(db: DB): DupeSummary {
  return db
    .prepare(
      `SELECT count(*) AS groups, coalesce(sum(n - 1), 0) AS extraCopies, coalesce(sum((n - 1) * size), 0) AS extraBytes
       FROM (SELECT count(*) AS n, max(size_bytes) AS size FROM attachments WHERE deleted_at IS NULL GROUP BY sha256 HAVING count(*) > 1)`,
    )
    .get() as DupeSummary;
}

/** "Duplicates only": one row per group of identical files, most space used by the extra copies first. */
export function dupeGroups(db: DB, rq: ReportQuery): { rows: DupeGroup[]; total: number } {
  const w = reportWhere({ ...rq, dupes: true, deleted: false });
  const dir = rq.desc === false ? "ASC" : "DESC";
  const order = { size: `extra ${dir}`, name: `lower(name) ${dir}`, date: `newest ${dir}`, sender: `extra ${dir}` }[rq.sort ?? "size"];
  const rows = db
    .prepare(
      `WITH c AS MATERIALIZED (SELECT x.id, x.sha256, coalesce(x.filename, '(no name)') AS filename, x.size_bytes, x.message_id FROM attachments x WHERE ${w.sql}),
       g AS (SELECT sha256, count(*) AS copies, max(size_bytes) AS size, max(message_id) AS newest
             FROM c GROUP BY sha256 HAVING count(*) > 1)
       SELECT g.sha256, g.copies, g.size, (g.copies - 1) * g.size AS extra, g.newest,
              (SELECT group_concat(n, char(31)) FROM (SELECT DISTINCT c.filename AS n FROM c WHERE c.sha256 = g.sha256)) AS names,
              (SELECT c.filename FROM c WHERE c.sha256 = g.sha256 ORDER BY c.message_id DESC LIMIT 1) AS name,
              count(*) OVER () AS total
       FROM g ORDER BY ${order}, g.sha256 LIMIT ? OFFSET ?`,
    )
    .all(...w.params, REPORT_PAGE, (rq.page - 1) * REPORT_PAGE) as { sha256: string; copies: number; size: number; extra: number; names: string; name: string; total: number }[];
  return {
    rows: rows.map((r) => ({
      sha256: r.sha256,
      name: r.name,
      otherNames: r.names.split("\x1f").filter((n) => n !== r.name),
      size: r.size,
      copies: r.copies,
      extraBytes: r.extra,
    })),
    total: rows[0]?.total ?? 0,
  };
}
