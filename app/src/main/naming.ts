// The default name for a new collection.
import os from "node:os";
import path from "node:path";
import type { ScanResult } from "../shared/api.ts";

const EXTENSIONS = /\.(mbox\.gz|tar\.gz|tgz|tar|zip|mbox)$/i;
// Names that say nothing about whose mail it is: common folders, and the files Takeout names after labels.
const GENERIC = new Set([
  ...["mail", "takeout", "downloads", "download", "desktop", "documents", "mbox", "gmail", "export", "backup"],
  ...["inbox", "sent", "starred", "important", "drafts", "spam", "trash", "archived", "chat", "opened", "unread"],
]);

function cleanName(raw: string): string {
  return raw.replace(EXTENSIONS, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function isGeneric(name: string): boolean {
  const n = name.toLowerCase();
  return !n || GENERIC.has(n) || n.startsWith("all mail including spam and trash") || n.startsWith("category ");
}

/**
 * A name from the chosen file or folder: "Firebrand-takeout-small-20261008" -> "Firebrand takeout small 20261008".
 * Takeout names mbox files after labels ("Inbox.mbox"), which says nothing about whose mail it is, so then use
 * the first folder above it whose name isn't generic ("Mail", "Takeout", "Downloads"...). Never the home folder.
 */
export function nameFromPaths(paths: string[], pathApi: typeof path = path, home: string = os.homedir()): string {
  if (paths.length === 0) return "Mail";
  const first = pathApi.resolve(paths[0]);
  let candidate = paths.length === 1 ? cleanName(pathApi.basename(first)) : "";
  let dir = pathApi.dirname(first);
  while (isGeneric(candidate)) {
    if (dir === home || pathApi.dirname(dir) === dir) return "Mail";
    candidate = cleanName(pathApi.basename(dir));
    dir = pathApi.dirname(dir);
  }
  return candidate;
}

function year(epochSeconds: number): number {
  return new Date(epochSeconds * 1000).getUTCFullYear();
}

/** "me@example.com (2004–2024)" from the scan, or a name from the chosen paths when the scan found no owner. */
export function defaultName(scan: Pick<ScanResult, "owner" | "first_date" | "last_date"> | null, paths: string[]): string {
  if (scan?.owner) {
    if (scan.first_date !== null && scan.last_date !== null) {
      const a = year(scan.first_date);
      const b = year(scan.last_date);
      return `${scan.owner} (${a === b ? a : `${a}–${b}`})`;
    }
    return scan.owner;
  }
  return nameFromPaths(paths);
}
