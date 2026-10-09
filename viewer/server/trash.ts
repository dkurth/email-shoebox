// Permanent deletion: "Empty Trash now" and "Delete forever".
// Follows gmail2sqlite's rule 4 (SCHEMA.md): tombstone, FTS row, messages row (labels and
// attachment rows cascade) in one transaction; attachment folders are removed after the commit.
import fs from "node:fs";
import path from "node:path";
import type { TrashSummary } from "../shared/types.ts";
import type { Archive, DB } from "./db.ts";
import { refreshThreads } from "./mutations.ts";
import { labelId } from "./views.ts";

export class ConflictError extends Error {}

interface Doomed {
  id: number;
  gmail_id: string;
  thread_id: string;
}

/** Messages that currently have the Trash label (optionally only in some threads). */
function trashedMessages(db: DB, threadIds?: string[]): Doomed[] {
  const trash = labelId(db, "Trash");
  if (trash === undefined) return [];
  const rows = db
    .prepare(
      `SELECT m.id, m.gmail_id, m.thread_id FROM message_labels ml CROSS JOIN messages m ON m.id = ml.message_id
       WHERE ml.label_id = ?`,
    )
    .all(trash) as Doomed[];
  if (!threadIds) return rows;
  const wanted = new Set(threadIds);
  return rows.filter((r) => wanted.has(r.thread_id));
}

export function trashSummary(db: DB, threadIds?: string[]): TrashSummary {
  const msgs = trashedMessages(db, threadIds);
  let attachments = 0;
  let attachmentBytes = 0;
  const q = db.prepare("SELECT count(*) AS n, coalesce(sum(size_bytes), 0) AS b FROM attachments WHERE message_id = ?");
  for (const m of msgs) {
    const r = q.get(m.id) as { n: number; b: number };
    attachments += r.n;
    attachmentBytes += r.b;
  }
  return { messages: msgs.length, threads: new Set(msgs.map((m) => m.thread_id)).size, attachments, attachmentBytes };
}

export interface DeleteResult {
  messages: number;
  threads: number;
  folderErrors: string[];
}

export function deleteForever(archive: Archive, opts: { threadIds?: string[]; confirmCount: unknown }): DeleteResult {
  const { db } = archive;
  if (!Number.isInteger(opts.confirmCount)) throw new ConflictError("confirmCount is required");
  if (opts.threadIds && (!Array.isArray(opts.threadIds) || opts.threadIds.some((t) => typeof t !== "string"))) {
    throw new ConflictError("threadIds must be a list of strings");
  }
  const now = Math.floor(Date.now() / 1000);
  const folders: string[] = [];
  let doomed: Doomed[] = [];

  db.transaction(() => {
    // Re-checked inside the transaction: a stale page can't delete more than its dialog said,
    // or anything moved out of the Trash meanwhile.
    doomed = trashedMessages(db, opts.threadIds);
    if (doomed.length !== opts.confirmCount) {
      throw new ConflictError(`The Trash changed: ${doomed.length} messages would be deleted, not ${opts.confirmCount}. Reload and try again.`);
    }
    const tomb = db.prepare("INSERT OR IGNORE INTO deleted_messages(gmail_id, deleted_at) VALUES (?, ?)");
    const fts = db.prepare("DELETE FROM messages_fts WHERE rowid = ?");
    const paths = db.prepare("SELECT path FROM attachments WHERE message_id = ?").pluck();
    const del = db.prepare("DELETE FROM messages WHERE id = ?");
    for (const m of doomed) {
      for (const p of paths.all(m.id) as string[]) folders.push(path.dirname(p));
      tomb.run(m.gmail_id, now);
      fts.run(m.id);
      del.run(m.id);
    }
    refreshThreads(db, doomed.map((m) => m.thread_id));
  })();

  // After the commit: remove each message's attachment folder. Failures are reported, not fatal;
  // a leftover file is harmless.
  const root = path.join(archive.dir, "attachments") + path.sep;
  const gmailIds = new Set(doomed.map((m) => m.gmail_id));
  const folderErrors: string[] = [];
  for (const rel of new Set(folders)) {
    const abs = path.resolve(archive.dir, rel);
    if (!abs.startsWith(root) || !gmailIds.has(path.basename(abs))) {
      folderErrors.push(`skipped unexpected folder ${rel}`);
      continue;
    }
    try {
      fs.rmSync(abs, { recursive: true, force: true });
      try {
        fs.rmdirSync(path.dirname(abs)); // the bucket folder, only if now empty
      } catch {
        /* not empty */
      }
    } catch (e) {
      folderErrors.push(`${rel}: ${(e as Error).message}`);
    }
  }
  if (folderErrors.length) console.warn("Some attachment folders were not removed:\n  " + folderErrors.join("\n  "));
  return { messages: doomed.length, threads: new Set(doomed.map((m) => m.thread_id)).size, folderErrors };
}
