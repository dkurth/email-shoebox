// Label changes, following gmail2sqlite's "Rules for writers" (SCHEMA.md):
// keep is_unread/is_starred/is_important in sync, keep pseudo-label pairs consistent,
// set labels_edited_at (so re-imports keep the change), and refresh the affected threads rows.
import { SYSTEM_LABELS, applyChange, isCategory, type LabelChange, type View } from "../shared/labels.ts";
import type { AppliedChange, ModifyResult } from "../shared/types.ts";
import type { DB } from "./db.ts";
import { contextSql, viewSql } from "./views.ts";

export class InputError extends Error {}

const MAX_LABEL = 225; // Gmail's limit

function chunks<T>(xs: T[], n = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

function labelSets(db: DB, ids: number[]): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>(ids.map((id) => [id, new Set()]));
  for (const chunk of chunks(ids)) {
    const rows = db
      .prepare(`SELECT ml.message_id AS id, l.name FROM message_labels ml JOIN labels l ON l.id = ml.label_id WHERE ml.message_id IN (${chunk.map(() => "?").join(",")})`)
      .all(...chunk) as { id: number; name: string }[];
    for (const r of rows) out.get(r.id)!.add(r.name);
  }
  return out;
}

function ensureLabel(db: DB, name: string): number {
  db.prepare("INSERT OR IGNORE INTO labels(name) VALUES (?)").run(name);
  return db.prepare("SELECT id FROM labels WHERE name = ?").pluck().get(name) as number;
}

/** Recompute threads rows, with the same definitions gmail2sqlite uses. */
export function refreshThreads(db: DB, threadIds: string[]): void {
  for (const chunk of chunks([...new Set(threadIds)])) {
    const ph = chunk.map(() => "?").join(",");
    db.prepare(`DELETE FROM threads WHERE thread_id IN (${ph})`).run(...chunk);
    db.prepare(
      `INSERT INTO threads (thread_id, subject, first_date, last_date, message_count, participants_json, labels_json)
       SELECT m.thread_id,
         (SELECT m2.subject FROM messages m2 WHERE m2.thread_id = m.thread_id
           ORDER BY coalesce(m2.received_utc, m2.date_utc), m2.id LIMIT 1),
         min(coalesce(m.received_utc, m.date_utc)),
         max(coalesce(m.received_utc, m.date_utc)),
         count(*),
         json_group_array(DISTINCT m.from_addr) FILTER (WHERE m.from_addr IS NOT NULL),
         (SELECT json_group_array(DISTINCT l.name) FROM messages m3
            JOIN message_labels ml ON ml.message_id = m3.id JOIN labels l ON l.id = ml.label_id
           WHERE m3.thread_id = m.thread_id)
       FROM messages m WHERE m.thread_id IN (${ph}) GROUP BY m.thread_id`,
    ).run(...chunk);
  }
}

/** Write exact per-message label changes in one transaction. No pair rules applied here. */
export function writeChanges(db: DB, changes: AppliedChange[]): void {
  const now = Math.floor(Date.now() / 1000);
  const add = db.prepare("INSERT OR IGNORE INTO message_labels(message_id, label_id) VALUES (?, ?)");
  const del = db.prepare("DELETE FROM message_labels WHERE message_id = ? AND label_id = ?");
  const flags = db.prepare(
    `UPDATE messages SET labels_edited_at = ?,
       is_unread    = EXISTS (SELECT 1 FROM message_labels ml JOIN labels l ON l.id = ml.label_id WHERE ml.message_id = messages.id AND l.name = 'Unread'),
       is_starred   = EXISTS (SELECT 1 FROM message_labels ml JOIN labels l ON l.id = ml.label_id WHERE ml.message_id = messages.id AND l.name = 'Starred'),
       is_important = EXISTS (SELECT 1 FROM message_labels ml JOIN labels l ON l.id = ml.label_id WHERE ml.message_id = messages.id AND l.name = 'Important')
     WHERE id = ?`,
  );
  const threadOf = db.prepare("SELECT thread_id FROM messages WHERE id = ?").pluck();
  db.transaction(() => {
    const threads: string[] = [];
    for (const c of changes) {
      for (const name of c.added) add.run(c.messageId, ensureLabel(db, name));
      for (const name of c.removed) {
        const id = db.prepare("SELECT id FROM labels WHERE name = ?").pluck().get(name) as number | undefined;
        if (id !== undefined) del.run(c.messageId, id);
      }
      flags.run(now, c.messageId);
      threads.push(threadOf.get(c.messageId) as string);
    }
    refreshThreads(db, threads.filter(Boolean));
  })();
}

export interface ModifyRequest extends LabelChange {
  threadIds?: string[];
  all?: boolean; // every thread in the view (Gmail's "select all N conversations")
  view: View;
  target?: "all" | "newest"; // which messages of each thread; default all in the view's context
}

function validLabel(name: unknown): string {
  if (typeof name !== "string") throw new InputError("label names must be strings");
  const n = name.trim();
  if (!n || n.length > MAX_LABEL) throw new InputError(`bad label name: ${JSON.stringify(name)}`);
  return n;
}

function threadIdsFor(db: DB, req: ModifyRequest): string[] {
  if (req.all) {
    const v = viewSql(db, req.view);
    return db.prepare(`SELECT DISTINCT m.thread_id FROM ${v.from} WHERE ${v.sql}`).pluck().all(...v.params) as string[];
  }
  if (!Array.isArray(req.threadIds) || req.threadIds.some((t) => typeof t !== "string")) throw new InputError("threadIds must be a list of strings");
  return [...new Set(req.threadIds)];
}

/** The messages an action on these threads affects: those visible in the view's context (Trash/Spam rules). */
export function scopedMessages(db: DB, view: View, threadIds: string[], target: "all" | "newest" = "all"): number[] {
  const ctx = contextSql(db, view);
  const ids: number[] = [];
  for (const chunk of chunks(threadIds)) {
    const rows = db
      .prepare(
        `SELECT m.id, m.thread_id FROM messages m WHERE m.thread_id IN (${chunk.map(() => "?").join(",")}) AND ${ctx.sql}
         ORDER BY m.thread_id, coalesce(m.received_utc, m.date_utc, 0), m.id`,
      )
      .all(...chunk, ...ctx.params) as { id: number; thread_id: string }[];
    if (target === "newest") {
      const newest = new Map<string, number>();
      for (const r of rows) newest.set(r.thread_id, r.id);
      ids.push(...newest.values());
    } else {
      ids.push(...rows.map((r) => r.id));
    }
  }
  return ids;
}

export function modifyThreads(db: DB, req: ModifyRequest): ModifyResult {
  const change = { add: (req.add ?? []).map(validLabel), remove: (req.remove ?? []).map(validLabel) };
  const threadIds = threadIdsFor(db, req);
  const ids = scopedMessages(db, req.view, threadIds, req.target === "newest" ? "newest" : "all");
  const before = labelSets(db, ids);
  const changes: AppliedChange[] = [];
  for (const id of ids) {
    const old = before.get(id)!;
    const next = applyChange(old, change);
    const added = [...next].filter((l) => !old.has(l));
    const removed = [...old].filter((l) => !next.has(l));
    if (added.length || removed.length) changes.push({ messageId: id, added, removed });
  }
  if (changes.length) writeChanges(db, changes);
  return { changes, threads: threadIds.length };
}

/** Undo: reverse exactly what was applied. */
export function undoChanges(db: DB, changes: AppliedChange[]): number {
  if (!Array.isArray(changes)) throw new InputError("changes must be a list");
  const exists = db.prepare("SELECT 1 FROM messages WHERE id = ?").pluck();
  const reverse: AppliedChange[] = [];
  for (const c of changes) {
    if (!Number.isInteger(c?.messageId) || !Array.isArray(c.added) || !Array.isArray(c.removed)) throw new InputError("bad change");
    if (!exists.get(c.messageId)) continue; // deleted since
    reverse.push({ messageId: c.messageId, added: c.removed.map(validLabel), removed: c.added.map(validLabel) });
  }
  if (reverse.length) writeChanges(db, reverse);
  return reverse.length;
}

/** Star: the newest message of each thread (as Gmail does). Unstar: every starred message. */
export function setStar(db: DB, view: View, threadIds: string[], starred: boolean): ModifyResult {
  return starred
    ? modifyThreads(db, { view, threadIds, add: ["Starred"], remove: [], target: "newest" })
    : modifyThreads(db, { view, threadIds, add: [], remove: ["Starred"] });
}

export function createLabel(db: DB, raw: unknown): { id: number; name: string } {
  const name = validLabel(raw).replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
  if (!name || SYSTEM_LABELS.has(name) || isCategory(name)) throw new InputError(`"${name}" is a reserved name`);
  return { id: ensureLabel(db, name), name };
}

/** Delete a user label: remove it from every message (messages stay), then drop the label. */
export function deleteLabel(db: DB, id: number): { messages: number } {
  const name = db.prepare("SELECT name FROM labels WHERE id = ?").pluck().get(id) as string | undefined;
  if (name === undefined) throw new InputError("no such label");
  if (SYSTEM_LABELS.has(name) || isCategory(name)) throw new InputError("system labels can't be deleted");
  const ids = db.prepare("SELECT message_id FROM message_labels WHERE label_id = ?").pluck().all(id) as number[];
  db.transaction(() => {
    writeChanges(db, ids.map((messageId) => ({ messageId, added: [], removed: [name] })));
    db.prepare("DELETE FROM labels WHERE id = ?").run(id);
  })();
  return { messages: ids.length };
}
