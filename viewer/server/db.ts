// Open a gmail2sqlite archive and check that we understand its format.
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { ChosenColors } from "../shared/labelColors.ts";

export const SUPPORTED_SCHEMA_VERSIONS = [3];

export type DB = Database.Database;

export class ArchiveError extends Error {}

export interface Archive {
  db: DB;
  dir: string; // absolute path of the archive folder (holds mail.db and attachments/)
  readOnly: boolean;
}

export function openArchive(dir: string, opts: { readOnly?: boolean } = {}): Archive {
  const abs = path.resolve(dir);
  const file = path.join(abs, "mail.db");
  if (!fs.existsSync(file)) {
    throw new ArchiveError(`No mail.db in ${abs}. Create one with: gmail2sqlite import <takeout> --out ${dir}`);
  }
  const readOnly = !!opts.readOnly;
  const db = new Database(file, { readonly: readOnly, fileMustExist: true });
  db.pragma("busy_timeout = 5000"); // an import may be running
  db.pragma("foreign_keys = ON"); // needed for ON DELETE CASCADE
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  const version = row ? Number(row.value) : NaN;
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(version)) {
    db.close();
    const hint =
      version < Math.min(...SUPPORTED_SCHEMA_VERSIONS)
        ? "Upgrade it by running `gmail2sqlite import` (version 0.3.0 or later) on it again."
        : "Update Email Shoebox.";
    throw new ArchiveError(
      `${file} has schema version ${row?.value ?? "unknown"}; this viewer supports ${SUPPORTED_SCHEMA_VERSIONS.join(", ")}. ${hint}`,
    );
  }
  const indexed = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'messages_thread_date'").get();
  if (!indexed) {
    console.warn("note: this archive lacks an index that makes All Mail fast. Run `gmail2sqlite import` (0.2.1 or later) on it again to add it.");
  }
  return { db, dir: abs, readOnly };
}

export function getMeta(db: DB, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(db: DB, key: string, value: string): void {
  db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}

/** Label colors chosen in the viewer (label name -> color id). A viewer-owned meta key. */
export function chosenColors(db: DB): ChosenColors {
  try {
    const v = JSON.parse(getMeta(db, "viewer_label_colors") ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function saveChosenColors(db: DB, colors: ChosenColors): void {
  setMeta(db, "viewer_label_colors", JSON.stringify(colors));
}

/**
 * The archive owner's own address(es), shown as "me".
 * Order: --me option, then meta.account_addresses, then the most common sender of Sent mail.
 */
export function accountAddresses(archive: Archive, override?: string[]): string[] {
  const { db } = archive;
  if (override && override.length) {
    const addrs = override.map((a) => a.trim().toLowerCase()).filter(Boolean);
    if (!archive.readOnly) setMeta(db, "account_addresses", JSON.stringify(addrs));
    return addrs;
  }
  const stored = getMeta(db, "account_addresses");
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch {
      /* recompute below */
    }
  }
  const top = db
    .prepare(
      `SELECT m.from_addr AS addr FROM messages m
       JOIN message_labels ml ON ml.message_id = m.id
       JOIN labels l ON l.id = ml.label_id AND l.name = 'Sent'
       WHERE m.from_addr IS NOT NULL
       GROUP BY m.from_addr ORDER BY count(*) DESC LIMIT 1`,
    )
    .get() as { addr: string } | undefined;
  const addrs = top ? [top.addr] : [];
  if (addrs.length && !archive.readOnly) setMeta(db, "account_addresses", JSON.stringify(addrs));
  return addrs;
}
