// The list of collections (collections.json in the app data folder). Plain data and file I/O, no Electron,
// so it can be tested on its own.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Collection, ImportRequest } from "../shared/api.ts";

export interface Registry {
  version: 1;
  collections: Collection[];
  lastOpenedId: string | null;
}

export const EMPTY: Registry = { version: 1, collections: [], lastOpenedId: null };

export function loadRegistry(file: string): Registry {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data?.version === 1 && Array.isArray(data.collections)) {
      return { version: 1, collections: data.collections, lastOpenedId: data.lastOpenedId ?? null };
    }
  } catch {
    /* missing or broken: start empty (the caller can rebuild it from the folders) */
  }
  return structuredClone(EMPTY);
}

/** Write to a temporary file first, so a crash never leaves half a file. */
export function saveRegistry(file: string, reg: Registry): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export function newId(): string {
  return crypto.randomUUID();
}

export function findCollection(reg: Registry, id: string): Collection | undefined {
  return reg.collections.find((c) => c.id === id);
}

/** The names in use, except one collection's own (when renaming it). */
export function namesInUse(reg: Registry, exceptId?: string): string[] {
  return reg.collections.filter((c) => c.id !== exceptId).map((c) => c.name);
}

/** "Name", or "Name 2", "Name 3"... if the name is already used (ignoring case). */
export function uniqueName(name: string, taken: string[]): string {
  const used = new Set(taken.map((n) => n.toLowerCase()));
  const base = name.trim() || "Mail";
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/** A folder name made from a collection name: "Personal 2024" -> "personal-2024". */
export function slug(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/@/g, "-at-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return s || "mail";
}

/** A new, unused folder for a collection inside `parent`. */
export function newCollectionDir(parent: string, name: string): string {
  const base = slug(name);
  let dir = path.join(parent, base);
  for (let i = 2; fs.existsSync(dir); i++) dir = path.join(parent, `${base}-${i}`);
  return dir;
}

export function addCollection(reg: Registry, c: Collection): void {
  reg.collections.push(c);
}

export function updateCollection(reg: Registry, id: string, change: Partial<Collection>): Collection {
  const c = findCollection(reg, id);
  if (!c) throw new Error(`No such collection: ${id}`);
  Object.assign(c, change);
  return c;
}

export function removeCollection(reg: Registry, id: string): void {
  reg.collections = reg.collections.filter((c) => c.id !== id);
  if (reg.lastOpenedId === id) reg.lastOpenedId = null;
}

export function markOpened(reg: Registry, id: string, now = Date.now()): void {
  updateCollection(reg, id, { lastOpenedAt: now });
  reg.lastOpenedId = id;
}

/** The collection to open at start-up: the last one opened, else the most recent one, else none. */
export function startupCollection(reg: Registry): Collection | undefined {
  return (
    (reg.lastOpenedId ? findCollection(reg, reg.lastOpenedId) : undefined) ??
    [...reg.collections].sort((a, b) => (b.lastOpenedAt ?? b.createdAt) - (a.lastOpenedAt ?? a.createdAt))[0]
  );
}

/** Remember what an unfinished import was reading, so "Continue import" can run it again. */
export function markIncomplete(reg: Registry, id: string, req: Pick<ImportRequest, "paths" | "skipSpamTrash">): void {
  updateCollection(reg, id, { incomplete: { paths: req.paths, skipSpamTrash: req.skipSpamTrash } });
}

/**
 * Add archive folders found in `collectionsDir` that the registry doesn't list (the registry was lost, or
 * the folders were copied in). `readName` returns the name saved in the archive, if any.
 */
export function addMissingFromFolder(reg: Registry, collectionsDir: string, readName: (dir: string) => string | undefined): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(collectionsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const known = new Set(reg.collections.map((c) => path.resolve(c.path)));
  let added = 0;
  for (const e of entries) {
    const dir = path.resolve(collectionsDir, e.name);
    if (!e.isDirectory() || known.has(dir) || !fs.existsSync(path.join(dir, "mail.db"))) continue;
    const name = uniqueName(readName(dir) ?? e.name, namesInUse(reg));
    const created = Math.floor(fs.statSync(dir).birthtimeMs || Date.now());
    reg.collections.push({ id: newId(), name, path: dir, createdAt: created, lastOpenedAt: null, incomplete: null });
    added++;
  }
  return added;
}
