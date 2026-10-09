// Autosave for one thread's note: 1 s after the last change, at once on flush() (leaving the
// thread), and with a keepalive request when the page closes. Saves for a thread go one at a
// time, so an older save never overwrites newer text. Savers live in a registry that outlives
// the panel, so a save keeps running (and retrying) after you move to another thread.
import type { NoteInfo, NoteSaveResult } from "../shared/types.ts";

export const SAVE_DELAY = 1000;
export const RETRY_DELAYS = [2000, 5000, 10000, 30000]; // then every 30 s
export const KEEPALIVE_LIMIT = 60_000; // bytes; browsers allow 64 KB for keepalive requests

export type NoteStatus =
  | { kind: "saved"; at: number | null } // at: updatedAt (ms), null = no note
  | { kind: "pending" } // changed, waiting for the 1 s pause
  | { kind: "saving" }
  | { kind: "error"; message: string } // retrying
  | { kind: "conflict"; theirs: NoteInfo | null };

export interface SendOptions {
  keepalive?: boolean;
}

/** Sends one save. Throws ConflictResponse on 409, any other error otherwise. */
export type SendFn = (threadId: string, body: { body: string; expectedUpdatedAt: number | null; force?: boolean }, opts: SendOptions) => Promise<NoteSaveResult>;

export class ConflictResponse extends Error {
  theirs: NoteInfo | null;
  constructor(theirs: NoteInfo | null) {
    super("conflict");
    this.theirs = theirs;
  }
}

export class NoteSaver {
  readonly threadId: string;
  text: string;
  private saved: string; // the text the server has
  private updatedAt: number | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private retries = 0;
  private forceNext = false;
  private sentOnUnload: string | null = null;
  status: NoteStatus;
  private listeners = new Set<(s: NoteStatus) => void>();

  private send: SendFn;

  constructor(threadId: string, note: NoteInfo | null, send: SendFn) {
    this.threadId = threadId;
    this.send = send;
    this.text = note?.body ?? "";
    this.saved = this.text;
    this.updatedAt = note?.updatedAt ?? null;
    this.status = { kind: "saved", at: this.updatedAt };
  }

  get dirty(): boolean {
    return this.text !== this.saved;
  }

  /** The server has a non-empty note (as far as this saver knows). */
  get hasSavedNote(): boolean {
    return this.saved.trim() !== "";
  }

  subscribe(fn: (s: NoteStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private setStatus(s: NoteStatus) {
    this.status = s;
    for (const fn of this.listeners) fn(s);
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** The text box changed. */
  update(text: string): void {
    this.text = text;
    if (this.status.kind === "conflict") return; // autosave stops until the user picks a side
    this.clearTimer();
    if (!this.dirty) {
      if (!this.inflight) this.setStatus({ kind: "saved", at: this.updatedAt });
      return;
    }
    if (this.status.kind !== "error") this.setStatus({ kind: "pending" });
    this.timer = setTimeout(() => void this.flush(), SAVE_DELAY);
  }

  /** Save now (leaving the thread). Resolves when the text that was current is saved or has failed. */
  async flush(): Promise<void> {
    this.clearTimer();
    if (this.status.kind === "conflict") return;
    while (this.inflight) await this.inflight; // one save at a time
    if (!this.dirty) return;
    const body = this.text;
    const force = this.forceNext;
    this.forceNext = false;
    this.setStatus({ kind: "saving" });
    this.inflight = this.send(this.threadId, { body, expectedUpdatedAt: this.updatedAt, ...(force ? { force: true } : {}) }, {})
      .then((r) => {
        this.saved = body; // (empty or only spaces: the server deleted the note)
        this.updatedAt = r.note?.updatedAt ?? null;
        this.retries = 0;
        this.setStatus({ kind: "saved", at: this.updatedAt });
      })
      .catch((e: unknown) => {
        if (e instanceof ConflictResponse) {
          this.setStatus({ kind: "conflict", theirs: e.theirs });
          return;
        }
        const delay = RETRY_DELAYS[Math.min(this.retries, RETRY_DELAYS.length - 1)];
        this.retries++;
        this.setStatus({ kind: "error", message: (e as Error).message });
        this.clearTimer();
        this.timer = setTimeout(() => void this.flush(), delay);
      })
      .finally(() => {
        this.inflight = null;
      });
    await this.inflight;
    // Typed more while that save was running: send the newest text too.
    if (this.dirty && this.status.kind === "saved") await this.flush();
  }

  /** The page is closing: send what isn't saved yet, with keepalive. Returns false if it was too big to send. */
  flushOnUnload(): boolean {
    if (!this.dirty || this.status.kind === "conflict") return true;
    const body = this.text;
    if (body === this.sentOnUnload) return true; // visibilitychange and then pagehide: send once
    if (new Blob([body]).size > KEEPALIVE_LIMIT) return false;
    this.sentOnUnload = body;
    this.clearTimer();
    void this.send(this.threadId, { body, expectedUpdatedAt: this.updatedAt }, { keepalive: true }).then(
      (r) => {
        // Only reached if the page stays open after all (e.g. it was only hidden).
        this.saved = body;
        this.updatedAt = r.note?.updatedAt ?? null;
        this.setStatus({ kind: "saved", at: this.updatedAt });
      },
      () => {
        /* the next flush() tries again */
      },
    );
    return true;
  }

  /** Conflict: overwrite the other window's text with ours. */
  keepMine(): void {
    this.forceNext = true;
    this.setStatus({ kind: "pending" });
    void this.flush();
  }

  /** Conflict: take the other window's text. */
  useTheirs(): void {
    const theirs = this.status.kind === "conflict" ? this.status.theirs : null;
    this.text = theirs?.body ?? "";
    this.saved = this.text;
    this.updatedAt = theirs?.updatedAt ?? null;
    this.setStatus({ kind: "saved", at: this.updatedAt });
  }

  /** Done with this saver: nothing pending, nothing running. */
  get settled(): boolean {
    return !this.dirty && !this.inflight && !this.timer && this.status.kind === "saved";
  }
}

// ------------------------------------------------------------------ registry

const savers = new Map<string, NoteSaver>();

/**
 * The saver for a thread. One that still has unsaved text (or a save running) is reused, so
 * coming back to a thread shows that text; otherwise a new one starts from the server's note.
 */
export function saverFor(threadId: string, note: NoteInfo | null, send: SendFn): NoteSaver {
  const old = savers.get(threadId);
  if (old && !old.settled) return old;
  const s = new NoteSaver(threadId, note, send);
  savers.set(threadId, s);
  return s;
}

/** Leaving a thread: save at once, then forget the saver once it is settled. */
export function release(saver: NoteSaver): void {
  void saver.flush().then(() => {
    if (saver.settled && savers.get(saver.threadId) === saver) savers.delete(saver.threadId);
  });
}

/** Page closing: keepalive-save every saver. Returns false if one was too big (ask the user). */
export function flushAllOnUnload(): boolean {
  let ok = true;
  for (const s of savers.values()) ok = s.flushOnUnload() && ok;
  return ok;
}

export function anyTooBigToSendOnUnload(): boolean {
  for (const s of savers.values()) if (s.dirty && new Blob([s.text]).size > KEEPALIVE_LIMIT) return true;
  return false;
}

/** For tests. */
export function resetSavers(): void {
  savers.clear();
}
