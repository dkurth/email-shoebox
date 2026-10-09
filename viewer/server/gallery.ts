// The image gallery: every image attachment, newest first, one per file content (sha256).
import { EXTENSIONS, TYPES, UNTYPED } from "../shared/preview.ts";
import type { GalleryImage, GalleryPage } from "../shared/types.ts";
import type { DB } from "./db.ts";

export const GALLERY_PAGE = 100;
export const SMALL_IMAGE = 20 * 1024; // "Hide images under 20 KB": logos, icons, tracking pixels

const list = (xs: string[]) => xs.map((x) => `'${x.replace(/'/g, "''")}'`).join(", ");
const EXT = `lower(CASE WHEN instr(x.filename, '.') > 0 THEN replace(x.filename, rtrim(x.filename, replace(x.filename, '.', '')), '') ELSE '' END)`;
/** The same rule as previewKind() === "image" (never SVG), in SQL. */
const IS_IMAGE = (() => {
  const types = Object.entries(TYPES).filter(([, [k]]) => k === "image").map(([t]) => t);
  const exts = Object.entries(EXTENSIONS).filter(([, t]) => TYPES[t]?.[0] === "image").map(([e]) => e);
  const ct = "lower(trim(substr(coalesce(x.content_type, ''), 1, instr(coalesce(x.content_type, '') || ';', ';') - 1)))";
  return `(${ct} IN (${list(types)}) OR (${ct} IN ('', ${list(UNTYPED)}) AND ${EXT} IN (${list(exts)})))`;
})();

export interface GalleryQuery {
  from?: string;
  year?: number;
  inline?: boolean; // also images inside the email text
  small?: boolean; // also images under 20 KB
  page: number;
}

export function gallery(db: DB, gq: GalleryQuery): GalleryPage {
  const where = ["x.deleted_at IS NULL", IS_IMAGE];
  const params: unknown[] = [];
  if (!gq.inline) where.push("x.is_inline = 0");
  if (!gq.small) {
    where.push("x.size_bytes >= ?");
    params.push(SMALL_IMAGE);
  }
  const base = `
    WITH md AS MATERIALIZED (SELECT id, thread_id, coalesce(received_utc, date_utc) AS d FROM messages INDEXED BY messages_thread_date),
    c AS MATERIALIZED (
      SELECT x.id, x.sha256, x.message_id, md.d, md.thread_id, snd.addr FROM attachments x JOIN md ON md.id = x.message_id
      LEFT JOIN message_addresses snd ON snd.message_id = x.message_id AND snd.role = 'from'
      WHERE ${where.join(" AND ")})`;
  // Years and senders for the filters (before those filters apply).
  const years = (db.prepare(`${base} SELECT DISTINCT CAST(strftime('%Y', d, 'unixepoch', 'localtime') AS INTEGER) AS y FROM c WHERE d IS NOT NULL ORDER BY y DESC`).pluck().all(...params) as number[]);
  const senders = db.prepare(`${base} SELECT addr FROM c WHERE addr IS NOT NULL GROUP BY addr ORDER BY count(*) DESC LIMIT 50`).pluck().all(...params) as string[];

  const filters: string[] = [];
  const fparams: unknown[] = [];
  if (gq.from) {
    filters.push("addr = ?");
    fparams.push(gq.from.toLowerCase());
  }
  if (gq.year) {
    filters.push("d >= ? AND d < ?");
    fparams.push(new Date(gq.year, 0, 1).getTime() / 1000, new Date(gq.year + 1, 0, 1).getTime() / 1000);
  }
  const rows = db
    .prepare(
      `${base},
       f AS (SELECT * FROM c ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}),
       pick AS (SELECT * FROM (SELECT f.*, row_number() OVER (PARTITION BY sha256 ORDER BY d DESC, id DESC) AS rn FROM f) WHERE rn = 1)
       SELECT pick.id, pick.message_id AS messageId, pick.thread_id AS threadId, pick.d AS date, pick.addr AS fromAddr,
              x.filename, x.size_bytes AS size, count(*) OVER () AS total
       FROM pick JOIN attachments x ON x.id = pick.id
       ORDER BY pick.d DESC, pick.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, ...fparams, GALLERY_PAGE, (gq.page - 1) * GALLERY_PAGE) as (Omit<GalleryImage, "subject" | "fromName"> & { total: number })[];
  const msg = db.prepare("SELECT subject, from_name FROM messages WHERE id = ?");
  const images: GalleryImage[] = rows.map(({ total: _t, ...r }) => {
    const m = msg.get(r.messageId) as { subject: string | null; from_name: string | null } | undefined;
    return { ...r, subject: m?.subject ?? null, fromName: m?.from_name ?? null };
  });
  return { images, total: rows[0]?.total ?? 0, years, senders };
}
