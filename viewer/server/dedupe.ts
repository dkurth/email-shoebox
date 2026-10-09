// "Merge duplicate files": replace each extra copy of an identical attachment with a hard link
// to one copy. Every email keeps its attachment and the database does not change (the paths stay
// the same), so deleting one copy later removes only that link.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { resolveAttachmentPath } from "./attachments.ts";

import type { DedupeProgress } from "../shared/types.ts";

export type { DedupeProgress };

interface Copy {
  id: number;
  sha256: string;
  path: string;
  size_bytes: number;
}

function sha256File(file: string): string {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    for (let n = fs.readSync(fd, buf); n > 0; n = fs.readSync(fd, buf)) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

/** Run the merge. Reads the database (its own read-only connection); changes only files. */
export function mergeDuplicates(archiveDir: string, onProgress: (p: DedupeProgress) => void = () => {}): DedupeProgress {
  const db = new Database(path.join(archiveDir, "mail.db"), { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  let copies: Copy[];
  try {
    copies = db
      .prepare(
        `SELECT id, sha256, path, size_bytes FROM attachments WHERE deleted_at IS NULL AND sha256 IN (
           SELECT sha256 FROM attachments WHERE deleted_at IS NULL GROUP BY sha256 HAVING count(*) > 1)
         ORDER BY sha256, id`,
      )
      .all() as Copy[];
  } finally {
    db.close();
  }
  const groups = new Map<string, Copy[]>();
  for (const c of copies) {
    if (!groups.has(c.sha256)) groups.set(c.sha256, []);
    groups.get(c.sha256)!.push(c);
  }
  const p: DedupeProgress = { groupsDone: 0, groupsTotal: groups.size, filesLinked: 0, bytesFreed: 0, skipped: [] };
  const rootDev = fs.statSync(path.join(archiveDir, "attachments")).dev;
  let lastReport = 0;

  for (const [sha, group] of groups) {
    const files = group.map((c) => ({ ...c, abs: resolveAttachmentPath(archiveDir, c.path) }));
    // The copy to keep: the lowest id whose file exists and is what the database says it is.
    const keep = files.find((f) => f.abs && fs.existsSync(f.abs));
    if (!keep?.abs) {
      p.skipped.push(`${sha.slice(0, 12)}…: no copy of this file is on disk`);
    } else {
      const st = fs.statSync(keep.abs);
      if (st.size !== keep.size_bytes || sha256File(keep.abs) !== sha) {
        p.skipped.push(`${keep.path}: its content does not match the database; this file's copies were left alone`);
      } else if (st.dev !== rootDev) {
        p.skipped.push(`${keep.path}: on another file system`);
      } else {
        for (const f of files) {
          if (f === keep) continue;
          if (!f.abs) {
            p.skipped.push(`${f.path}: unsafe path`);
            continue;
          }
          let fst: fs.Stats;
          try {
            fst = fs.statSync(f.abs);
          } catch {
            p.skipped.push(`${f.path}: missing`);
            continue;
          }
          if (fst.dev === st.dev && fst.ino === st.ino) continue; // already merged
          if (fst.size !== keep.size_bytes) {
            p.skipped.push(`${f.path}: a different size than the database says`);
            continue;
          }
          if (fst.dev !== st.dev) {
            p.skipped.push(`${f.path}: on another file system`);
            continue;
          }
          // Link under a temporary name, then rename over the copy: one step, so a crash leaves
          // either the old file or the link, never no file.
          const tmp = `${f.abs}.merge-${process.pid}`;
          try {
            fs.rmSync(tmp, { force: true });
            fs.linkSync(keep.abs, tmp);
            fs.renameSync(tmp, f.abs);
            p.filesLinked++;
            if (fst.nlink === 1) p.bytesFreed += fst.size; // the old file had no other link: its space is free now
          } catch (e) {
            fs.rmSync(tmp, { force: true });
            p.skipped.push(`${f.path}: ${(e as Error).message}`);
          }
        }
      }
    }
    p.groupsDone++;
    if (Date.now() - lastReport > 250) {
      lastReport = Date.now();
      onProgress({ ...p, skipped: [...p.skipped] });
    }
  }
  onProgress({ ...p, skipped: [...p.skipped] });
  return p;
}
