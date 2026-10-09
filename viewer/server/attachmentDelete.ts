// Delete attachment files and keep the emails (gmail2sqlite SCHEMA.md, rule 6): set
// attachments.deleted_at in one transaction, then delete the files after the commit.
// The rows stay, so the name, size and type can still be shown as "(deleted)".
import fs from "node:fs";
import path from "node:path";
import { resolveAttachmentPath } from "./attachments.ts";
import { reportWhere, type ReportQuery } from "./attachmentReport.ts";
import type { Archive, DB } from "./db.ts";
import { InputError } from "./mutations.ts";
import { ConflictError } from "./trash.ts";

export type DeleteFilter = Omit<ReportQuery, "sort" | "desc" | "page">;

export interface DeleteTarget {
  ids?: unknown; // attachment ids
  sha256s?: unknown; // or: every copy of these files
  filter?: DeleteFilter; // or: everything the report filter matches
}

interface Doomed {
  id: number;
  path: string;
  size_bytes: number;
  filename: string | null;
}

/** The attachments a request would delete (not already deleted). */
function doomed(db: DB, t: DeleteTarget): Doomed[] {
  if (t.filter) {
    const w = reportWhere({ ...t.filter, deleted: false });
    return db.prepare(`SELECT x.id, x.path, x.size_bytes, x.filename FROM attachments x WHERE ${w.sql} ORDER BY x.size_bytes DESC`).all(...w.params) as Doomed[];
  }
  if (t.sha256s !== undefined) {
    if (!Array.isArray(t.sha256s) || !t.sha256s.length || t.sha256s.some((h) => typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h))) {
      throw new InputError("sha256s must be a list of SHA-256 hashes");
    }
    const hs = [...new Set(t.sha256s as string[])];
    const out: Doomed[] = [];
    for (let i = 0; i < hs.length; i += 500) {
      const chunk = hs.slice(i, i + 500);
      out.push(
        ...(db
          .prepare(`SELECT id, path, size_bytes, filename FROM attachments WHERE sha256 IN (${chunk.map(() => "?").join(",")}) AND deleted_at IS NULL`)
          .all(...chunk) as Doomed[]),
      );
    }
    return out.sort((a, b) => b.size_bytes - a.size_bytes);
  }
  if (!Array.isArray(t.ids) || !t.ids.length || t.ids.some((i) => !Number.isInteger(i))) throw new InputError("ids must be a list of attachment ids");
  const out: Doomed[] = [];
  const ids = [...new Set(t.ids as number[])];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    out.push(
      ...(db
        .prepare(`SELECT id, path, size_bytes, filename FROM attachments WHERE id IN (${chunk.map(() => "?").join(",")}) AND deleted_at IS NULL`)
        .all(...chunk) as Doomed[]),
    );
  }
  return out.sort((a, b) => b.size_bytes - a.size_bytes);
}

export interface DeleteSummary {
  count: number;
  bytes: number;
  names: string[]; // the first 10 file names, biggest first
}

export function deleteSummary(db: DB, t: DeleteTarget): DeleteSummary {
  const d = doomed(db, t);
  return { count: d.length, bytes: d.reduce((s, x) => s + x.size_bytes, 0), names: d.slice(0, 10).map((x) => x.filename || "(no name)") };
}

export interface DeleteAttachmentsResult {
  deleted: number;
  bytes: number;
  fileErrors: string[];
}

export function deleteAttachments(archive: Archive, t: DeleteTarget & { confirmCount: unknown; confirmBytes: unknown }): DeleteAttachmentsResult {
  const { db } = archive;
  if (!Number.isInteger(t.confirmCount) || !Number.isInteger(t.confirmBytes)) throw new ConflictError("confirmCount and confirmBytes are required");
  const now = Math.floor(Date.now() / 1000);
  let rows: Doomed[] = [];
  db.transaction(() => {
    // Checked again inside the transaction: a stale page can't delete more than its dialog said.
    rows = doomed(db, t);
    const bytes = rows.reduce((s, x) => s + x.size_bytes, 0);
    if (rows.length !== t.confirmCount || bytes !== t.confirmBytes) {
      throw new ConflictError(`The attachments changed: ${rows.length} files (${bytes} bytes) would be deleted, not ${t.confirmCount}. Reload and try again.`);
    }
    const mark = db.prepare("UPDATE attachments SET deleted_at = ? WHERE id = ?");
    for (const r of rows) mark.run(now, r.id);
  })();

  // After the commit: delete the files. A failure is reported, not fatal; the row says deleted.
  const fileErrors: string[] = [];
  const folders = new Set<string>();
  for (const r of rows) {
    const file = resolveAttachmentPath(archive.dir, r.path);
    if (!file) {
      fileErrors.push(`skipped unsafe path ${r.path}`);
      continue;
    }
    try {
      fs.rmSync(file, { force: true }); // a file that is already missing is fine
      folders.add(path.dirname(file));
    } catch (e) {
      fileErrors.push(`${r.path}: ${(e as Error).message}`);
    }
  }
  for (const dir of folders) {
    // The message's folder, then its bucket folder, only if now empty.
    for (const d of [dir, path.dirname(dir)]) {
      try {
        fs.rmdirSync(d);
      } catch {
        break; // not empty
      }
    }
  }
  if (fileErrors.length) console.warn("Some attachment files were not removed:\n  " + fileErrors.join("\n  "));
  return { deleted: rows.length, bytes: rows.reduce((s, x) => s + x.size_bytes, 0), fileErrors };
}
