// Compact the database (VACUUM) in a worker thread, with its own connection, so the server keeps
// answering. Reads still work meanwhile (WAL mode).
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type { CompactProgress } from "../shared/types.ts";

const file = path.join(workerData.archiveDir as string, "mail.db");
const sizeOf = () => fs.statSync(file).size + (fs.existsSync(file + "-wal") ? fs.statSync(file + "-wal").size : 0);
const progress: CompactProgress = { before: sizeOf(), after: null };
parentPort!.postMessage({ type: "progress", progress });
try {
  const db = new Database(file, { fileMustExist: true });
  db.pragma("busy_timeout = 10000"); // an import may hold the lock; wait, then fail clearly
  db.exec("VACUUM");
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  progress.after = sizeOf();
  parentPort!.postMessage({ type: "done", progress });
} catch (e) {
  const msg = (e as Error).message;
  parentPort!.postMessage({ type: "error", error: /busy|locked/i.test(msg) ? `The database is busy (is an import running?): ${msg}` : msg, progress });
}
