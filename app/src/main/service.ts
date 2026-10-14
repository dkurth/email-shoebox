// Collections, imports, scans and upgrades. No Electron here (main.ts adds windows and dialogs),
// so tests can run it with the real importer.
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { collectionName, readSchemaVersion, setCollectionName, SUPPORTED_SCHEMA_VERSIONS } from "../../../viewer/server/db.ts";
import type {
  Collection,
  CollectionInfo,
  ImportProgress,
  ImportRequest,
  ImportState,
  QuickLook,
  ScanEvent,
  ScanResult,
  StorageInfo,
  UpgradeState,
} from "../shared/api.ts";
import { runImporter, type PythonSetup, type Running } from "./importer.ts";
import { defaultName, nameFromPaths } from "./naming.ts";
import {
  addCollection,
  addMissingFromFolder,
  findCollection,
  isViewHash,
  loadRegistry,
  markIncomplete,
  namesInUse,
  newCollectionDir,
  newId,
  removeCollection,
  saveRegistry,
  uniqueName,
  updateCollection,
  type Registry,
} from "./registry.ts";

export type SchemaStatus = "ok" | "older" | "newer" | "missing";

export class ServiceError extends Error {}

export interface ServiceOptions {
  dataDir: string; // collections.json, collections/, logs/
  python: PythonSetup;
  now?: () => number;
}

export class Service {
  readonly dataDir: string;
  readonly collectionsDir: string;
  readonly registryFile: string;
  readonly logFile: string;
  reg: Registry;
  private python: PythonSetup;
  private now: () => number;

  private importRun: Running | null = null;
  private importStateValue: ImportState | null = null;
  private importListeners = new Set<(s: ImportState) => void>();

  private scanRun: Running | null = null;
  private scanId = 0;

  private saveTimer: NodeJS.Timeout | null = null;

  constructor(opts: ServiceOptions) {
    this.dataDir = opts.dataDir;
    this.collectionsDir = path.join(opts.dataDir, "collections");
    this.registryFile = path.join(opts.dataDir, "collections.json");
    this.logFile = path.join(opts.dataDir, "logs", "importer.log");
    this.python = opts.python;
    this.now = opts.now ?? Date.now;
    this.reg = loadRegistry(this.registryFile);
    // Archive folders in the app data folder that the list doesn't know (the list was lost, or folders were copied in).
    if (addMissingFromFolder(this.reg, this.collectionsDir, readNameFromArchive)) this.save();
  }

  save(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    saveRegistry(this.registryFile, this.reg);
  }

  /** Save a change made with rememberView now, instead of a moment later (the app is quitting). */
  flush(): void {
    if (!this.saveTimer) return;
    try {
      this.save();
    } catch {
      /* only the place in the mail is lost */
    }
  }

  get(id: string): Collection {
    const c = findCollection(this.reg, id);
    if (!c) throw new ServiceError("That collection is no longer in the list.");
    return c;
  }

  // ---------------------------------------------------------------- listing

  list(currentId: string | null, withSizes = false): CollectionInfo[] {
    return this.reg.collections.map((c) => {
      const missing = !fs.existsSync(path.join(c.path, "mail.db"));
      return {
        ...c,
        current: c.id === currentId,
        missing,
        messages: missing ? null : messageCount(c.path),
        sizeBytes: withSizes && !missing ? collectionSize(c.path) : null,
      };
    });
  }

  schemaStatus(id: string): SchemaStatus {
    const v = readSchemaVersion(this.get(id).path);
    if (v === null) return "missing";
    if (SUPPORTED_SCHEMA_VERSIONS.includes(v)) return "ok";
    return v < Math.min(...SUPPORTED_SCHEMA_VERSIONS) ? "older" : "newer";
  }

  // ---------------------------------------------------------------- changing the list

  rename(id: string, name: string): Collection {
    const clean = name.trim().replace(/\s+/g, " ");
    if (!clean) throw new ServiceError("A collection needs a name.");
    if (namesInUse(this.reg, id).some((n) => n.toLowerCase() === clean.toLowerCase())) {
      throw new ServiceError(`There is already a collection named "${clean}".`);
    }
    const c = updateCollection(this.reg, id, { name: clean });
    this.save();
    writeNameToArchive(c.path, clean);
    return c;
  }

  /** Forget a collection. Its files stay where they are. */
  remove(id: string): void {
    this.assertNotImporting(id);
    removeCollection(this.reg, id);
    this.save();
  }

  /** Delete a collection's folder from disk, and forget it. */
  async deleteFromDisk(id: string): Promise<void> {
    this.assertNotImporting(id);
    const c = this.get(id);
    await fs.promises.rm(c.path, { recursive: true, force: true });
    removeCollection(this.reg, id);
    this.save();
  }

  /** Point a collection whose folder moved at its new place. */
  locate(id: string, dir: string): void {
    if (!fs.existsSync(path.join(dir, "mail.db"))) throw new ServiceError(`There is no mail.db in ${dir}.`);
    updateCollection(this.reg, id, { path: path.resolve(dir) });
    this.save();
  }

  markOpened(id: string): void {
    updateCollection(this.reg, id, { lastOpenedAt: this.now() });
    this.reg.lastOpenedId = id;
    this.save();
  }

  /**
   * Remember where the viewer is in a collection (its URL hash), to go back there at the next start. Saved a
   * moment later, so going through the mail with j and k doesn't write the file at each step.
   */
  rememberView(id: string, hash: string): void {
    const c = findCollection(this.reg, id);
    if (!c || !isViewHash(hash) || c.lastView === hash) return;
    c.lastView = hash;
    this.saveTimer ??= setTimeout(() => this.flush(), 1000).unref();
  }

  private assertNotImporting(id: string): void {
    const s = this.importStateValue;
    if (s && s.collectionId === id && (s.phase === "running" || s.phase === "stopping")) {
      throw new ServiceError("An import into this collection is running. Stop it first.");
    }
  }

  // ---------------------------------------------------------------- storage

  storageInfo(parent: string | null): StorageInfo {
    const dir = parent ?? this.collectionsDir;
    return { parent: dir, isDefault: parent === null, freeBytes: freeSpace(dir) };
  }

  // ---------------------------------------------------------------- scan

  /** Start a scan; a newer scan stops an older one. Events carry the scan's id. */
  scan(paths: string[], onEvent: (e: ScanEvent) => void): number {
    this.scanRun?.kill();
    const scanId = ++this.scanId;
    let sawResult = false;
    let error: string | null = null;
    const run = runImporter(this.python, ["scan", ...paths, "--json"], {
      onJson: (obj) => {
        if (obj.type === "files") {
          onEvent({ scanId, type: "files", look: obj as unknown as QuickLook, fallbackName: this.uniqueDefault(nameFromPaths(paths)) });
        }
        else if (obj.type === "progress") onEvent({ scanId, type: "progress", done: Number(obj.bytes_done), total: Number(obj.bytes_total) });
        else if (obj.type === "result") {
          sawResult = true;
          const result = obj as unknown as ScanResult;
          onEvent({ scanId, type: "result", result, defaultName: this.uniqueDefault(defaultName(result, paths)) });
        }
      },
      onError: (e) => (error = e.message),
      onLog: (line) => this.log(line),
    });
    this.scanRun = run;
    run.done.then(({ code, signal }) => {
      if (this.scanRun === run) this.scanRun = null;
      if (!sawResult && scanId === this.scanId && !signal) {
        onEvent({ scanId, type: "error", message: error ?? `The scan stopped unexpectedly (exit code ${code}).` });
      }
    });
    return scanId;
  }

  cancelScan(): void {
    this.scanRun?.kill();
    this.scanRun = null;
  }

  uniqueDefault(name: string): string {
    return uniqueName(name, namesInUse(this.reg));
  }

  // ---------------------------------------------------------------- import

  importState(): ImportState | null {
    return this.importStateValue;
  }

  onImport(cb: (s: ImportState) => void): () => void {
    this.importListeners.add(cb);
    return () => this.importListeners.delete(cb);
  }

  private setImport(s: ImportState): void {
    this.importStateValue = s;
    for (const cb of this.importListeners) cb(s);
  }

  isImporting(): boolean {
    const p = this.importStateValue?.phase;
    return p === "running" || p === "stopping";
  }

  startImport(req: ImportRequest): ImportState {
    if (this.isImporting()) throw new ServiceError("An import is already running.");
    this.cancelScan(); // it would compete with the import for the disk
    let c: Collection;
    let createdDir = false;
    let paths = req.paths;
    let skip = req.skipSpamTrash;
    if (req.mode === "new") {
      if (!paths.length) throw new ServiceError("Choose a backup to import.");
      const name = uniqueName((req.name ?? "").trim() || "Mail", namesInUse(this.reg));
      const parent = req.storageParent ?? this.collectionsDir;
      const dir = newCollectionDir(parent, name);
      fs.mkdirSync(dir, { recursive: true });
      createdDir = true;
      c = { id: newId(), name, path: dir, createdAt: this.now(), lastOpenedAt: null, incomplete: null };
      addCollection(this.reg, c);
    } else {
      c = this.get(req.collectionId ?? "");
      if (req.mode === "continue") {
        if (!c.incomplete) throw new ServiceError("This collection has no unfinished import.");
        paths = c.incomplete.paths;
        skip = c.incomplete.skipSpamTrash;
      }
      if (!paths.length) throw new ServiceError("Choose a backup to import.");
    }
    markIncomplete(this.reg, c.id, { paths, skipSpamTrash: skip });
    this.save();

    const started = this.now();
    let lastError: string | null = null;
    // The importer's "done" line comes before it exits. Keep it until the exit, so "finished" is announced only
    // after the list is saved (and a new import can't start while this process still runs).
    let final: { phase: ImportState["phase"]; counts: Record<string, number> } | null = null;
    const state: ImportState = { phase: "running", collectionId: c.id, collectionName: c.name, progress: null, counts: null, error: null };
    this.setImport(state);
    const args = ["import", ...paths, "--out", c.path, "--progress=json", "--cancel-on-stdin"];
    if (skip) args.push("--skip-spam-trash");
    this.log(`--- import into "${c.name}" (${new Date(started).toISOString()})`);

    const run = runImporter(this.python, args, {
      onJson: (obj) => {
        if (obj.type === "progress") {
          this.setImport({ ...this.importStateValue!, progress: progressFrom(obj, req.mboxCount ?? null, started, this.now()) });
        } else if (obj.type === "done") {
          const phase = obj.status === "finished" ? "finished" : obj.status === "interrupted" ? "interrupted" : "failed";
          final = { phase, counts: obj.counts as Record<string, number> };
        }
      },
      onError: (e) => (lastError = e.message),
      onLog: (line) => this.log(line),
    });
    this.importRun = run;

    run.done.then(({ code }) => {
      this.importRun = null;
      let s = this.importStateValue!;
      if (final) s = { ...s, ...final };
      else {
        // No "done" line: it was killed, or it failed before it started (a bad input, a schema it can't read).
        s = { ...s, phase: s.phase === "stopping" ? "interrupted" : "failed" };
      }
      if (s.phase === "failed") s = { ...s, error: lastError ?? `The importer stopped unexpectedly (exit code ${code}). See the log for details.` };
      const archiveMade = fs.existsSync(path.join(c.path, "mail.db"));
      if (s.phase === "failed" && createdDir && !archiveMade) {
        // Nothing was imported; don't leave an empty collection behind.
        removeCollection(this.reg, c.id);
        fs.rmSync(c.path, { recursive: true, force: true });
      } else {
        if (s.phase === "finished") updateCollection(this.reg, c.id, { incomplete: null });
        if (archiveMade) writeNameToArchive(c.path, c.name);
      }
      this.save();
      this.setImport(s);
    });
    return state;
  }

  cancelImport(): void {
    if (!this.importRun || !this.isImporting()) return;
    this.setImport({ ...this.importStateValue!, phase: "stopping" });
    this.importRun.cancel();
  }

  /** Stop the importer at once (the app is quitting). It saves what it can when it gets SIGTERM. */
  killImport(): void {
    this.importRun?.kill();
    this.scanRun?.kill();
  }

  // ---------------------------------------------------------------- upgrade

  upgrade(id: string, onState: (s: UpgradeState) => void): Promise<UpgradeState> {
    const c = this.get(id);
    const state: UpgradeState = { phase: "running", error: null, log: [] };
    let error: string | null = null;
    onState({ ...state });
    const run = runImporter(this.python, ["upgrade", "--out", c.path, "--json"], {
      onError: (e) => (error = e.message),
      onLog: (line) => {
        this.log(line);
        state.log = [...state.log.slice(-50), line];
        onState({ ...state });
      },
    });
    return run.done.then(({ code }) => {
      const done: UpgradeState =
        code === 0
          ? { ...state, phase: "finished" }
          : { ...state, phase: "failed", error: error ?? `The upgrade stopped unexpectedly (exit code ${code}).` };
      onState(done);
      return done;
    });
  }

  // ---------------------------------------------------------------- log

  log(line: string): void {
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      fs.appendFileSync(this.logFile, line + "\n");
    } catch {
      /* the log is a help, not a must */
    }
  }
}

function progressFrom(obj: Record<string, unknown>, mboxCount: number | null, started: number, now: number): ImportProgress {
  const done = Number(obj.bytes_done) || 0;
  const total = Number(obj.bytes_total) || 0;
  const elapsed = (now - started) / 1000;
  // Wait a few seconds before guessing: the first seconds include start-up and aren't typical.
  const secondsLeft = done > 0 && elapsed >= 3 && total > done ? Math.round((elapsed * (total - done)) / done) : null;
  return {
    bytesDone: done,
    bytesTotal: total,
    messages: Number(obj.messages) || 0,
    inserted: Number(obj.inserted) || 0,
    errors: Number(obj.errors) || 0,
    mbox: String(obj.mbox ?? ""),
    mboxIndex: Number(obj.mbox_index) || 0,
    mboxCount,
    secondsLeft,
  };
}

function withDb<T>(dir: string, fn: (db: Database.Database) => T): T | undefined {
  const file = path.join(dir, "mail.db");
  if (!fs.existsSync(file)) return undefined;
  let db: Database.Database | undefined;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 2000");
    return fn(db);
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

export function messageCount(dir: string): number | null {
  return withDb(dir, (db) => db.prepare("SELECT count(*) FROM messages").pluck().get() as number) ?? null;
}

function readNameFromArchive(dir: string): string | undefined {
  return withDb(dir, (db) => collectionName(db));
}

function writeNameToArchive(dir: string, name: string): void {
  let db: Database.Database | undefined;
  try {
    db = new Database(path.join(dir, "mail.db"), { fileMustExist: true });
    db.pragma("busy_timeout = 5000");
    setCollectionName(db, name);
  } catch {
    /* an older or broken archive: the registry still has the name */
  } finally {
    db?.close();
  }
}

/**
 * The disk space of a collection, from the database: mail.db (with its -wal file) plus the attachment files it
 * lists that aren't deleted. Other files someone put in the folder (such as old database backups) don't count. Fast: walking a folder of 40,000 attachments takes seconds, this takes milliseconds.
 * A file that "Merge duplicate files" turned into a hard link counts at full size each time (folderSize does too).
 */
export function collectionSize(dir: string): number {
  let total = 0;
  for (const name of ["mail.db", "mail.db-wal"]) {
    try {
      total += fs.statSync(path.join(dir, name)).size;
    } catch {
      /* no WAL file: nothing to add */
    }
  }
  const attachments =
    withDb(dir, (db) => db.prepare("SELECT coalesce(sum(size_bytes), 0) FROM attachments WHERE deleted_at IS NULL").pluck().get() as number) ??
    // Schema version 2 has no deleted_at (and no way to delete attachment files).
    withDb(dir, (db) => db.prepare("SELECT coalesce(sum(size_bytes), 0) FROM attachments").pluck().get() as number);
  return total + (attachments ?? 0);
}

/** The bytes of every file in a folder: what deleting it frees. Slow for a large collection (it stats every file); for the list, see collectionSize. */
export function folderSize(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try {
          total += fs.statSync(p).size;
        } catch {
          /* gone */
        }
      }
    }
  };
  walk(dir);
  return total;
}

/** Free bytes on the disk that holds `dir` (or the nearest folder above it that exists). */
export function freeSpace(dir: string): number | null {
  let d = path.resolve(dir);
  for (;;) {
    try {
      const st = fs.statfsSync(d);
      return st.bavail * st.bsize;
    } catch {
      const parent = path.dirname(d);
      if (parent === d) return null;
      d = parent;
    }
  }
}
