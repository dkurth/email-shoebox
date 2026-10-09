// Notes on a thread (gmail2sqlite schema v3: thread_notes; triggers keep notes_fts current).
// Times are Unix milliseconds: autosave can save twice in one second, and the conflict check
// must tell those saves apart.
import type { NoteInfo, NoteSaveResult } from "../shared/types.ts";
import type { DB } from "./db.ts";
import { InputError } from "./mutations.ts";

export const MAX_NOTE = 100_000;

export class NotFound extends Error {}

/** The note changed since the client last saw it (e.g. in another tab). Carries the stored note. */
export class NoteConflict extends Error {
  note: NoteInfo | null;
  constructor(note: NoteInfo | null) {
    super("This note was changed in another window.");
    this.note = note;
  }
}

interface Row {
  body: string;
  created_at: number;
  updated_at: number;
}

const toInfo = (r: Row): NoteInfo => ({ body: r.body, createdAt: r.created_at, updatedAt: r.updated_at });

export function getNote(db: DB, threadId: string): NoteInfo | null {
  const r = db.prepare("SELECT body, created_at, updated_at FROM thread_notes WHERE thread_id = ?").get(threadId) as Row | undefined;
  return r ? toInfo(r) : null;
}

/**
 * Save (or, for empty text, delete) a thread's note.
 * expectedUpdatedAt: the updatedAt the client last saw (null = it thinks there is no note).
 * force: skip that check ("Keep mine").
 */
export function saveNote(db: DB, threadId: string, body: unknown, expectedUpdatedAt: unknown, force = false): NoteSaveResult {
  if (typeof body !== "string") throw new InputError("body must be a string");
  if (expectedUpdatedAt !== null && !Number.isInteger(expectedUpdatedAt)) throw new InputError("expectedUpdatedAt must be a number or null");
  const text = body.replace(/\r\n?/g, "\n");
  if (text.length > MAX_NOTE) throw new InputError(`A note can have at most ${MAX_NOTE.toLocaleString("en-US")} characters.`);
  return db.transaction((): NoteSaveResult => {
    if (!db.prepare("SELECT 1 FROM messages WHERE thread_id = ? LIMIT 1").get(threadId)) throw new NotFound("No such thread");
    const current = db.prepare("SELECT body, created_at, updated_at FROM thread_notes WHERE thread_id = ?").get(threadId) as Row | undefined;
    if (!force && (current?.updated_at ?? null) !== expectedUpdatedAt) {
      throw new NoteConflict(current ? toInfo(current) : null);
    }
    if (!text.trim()) {
      db.prepare("DELETE FROM thread_notes WHERE thread_id = ?").run(threadId);
      return { deleted: true, note: null };
    }
    // Always move forward, even if two saves land in the same millisecond.
    const now = Math.max(Date.now(), (current?.updated_at ?? 0) + 1);
    db.prepare(
      `INSERT INTO thread_notes(thread_id, body, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
    ).run(threadId, text, now, now);
    return { deleted: false, note: getNote(db, threadId) };
  })();
}

/** First non-empty line of each thread's note, for the given threads. */
export function noteFirstLines(db: DB, threadIds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < threadIds.length; i += 500) {
    const chunk = threadIds.slice(i, i + 500);
    const rows = db
      .prepare(`SELECT thread_id, body FROM thread_notes WHERE thread_id IN (${chunk.map(() => "?").join(",")})`)
      .all(...chunk) as { thread_id: string; body: string }[];
    for (const r of rows) out.set(r.thread_id, firstLine(r.body));
  }
  return out;
}

export function firstLine(body: string): string {
  const line = body.split("\n").find((l) => l.trim()) ?? "";
  return line.trim().slice(0, 200);
}

/** Rule 7: delete the notes of these threads if no message of the thread is left. */
export function deleteOrphanNotes(db: DB, threadIds: string[]): number {
  let n = 0;
  const del = db.prepare(
    "DELETE FROM thread_notes WHERE thread_id = ? AND NOT EXISTS (SELECT 1 FROM messages WHERE thread_id = ?)",
  );
  for (const t of new Set(threadIds)) n += del.run(t, t).changes;
  return n;
}
