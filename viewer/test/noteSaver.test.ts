import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteSaveResult } from "../shared/types.ts";
import { ConflictResponse, NoteSaver, release, resetSavers, saverFor, type SendFn } from "../web/noteSaver.ts";

interface Call {
  body: string;
  expectedUpdatedAt: number | null;
  force?: boolean;
  keepalive: boolean;
  resolve: (r: NoteSaveResult) => void;
  reject: (e: unknown) => void;
}

/** A fake server: records each request; the test decides when and how it answers. */
function fakeSend() {
  const calls: Call[] = [];
  let clock = 1_000_000;
  const send: SendFn = (_threadId, body, opts) =>
    new Promise<NoteSaveResult>((resolve, reject) => calls.push({ ...body, keepalive: !!opts.keepalive, resolve, reject }));
  const ok = (c: Call) => {
    const at = ++clock;
    c.resolve(c.body.trim() ? { deleted: false, note: { body: c.body, createdAt: at, updatedAt: at } } : { deleted: true, note: null });
  };
  return { calls, send, ok };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  resetSavers();
});
afterEach(() => vi.useRealTimers());

describe("NoteSaver", () => {
  it("saves once, 1 s after the last change", async () => {
    const f = fakeSend();
    const s = new NoteSaver("t", null, f.send);
    s.update("a");
    await vi.advanceTimersByTimeAsync(600);
    s.update("ab");
    await vi.advanceTimersByTimeAsync(600);
    s.update("abc");
    expect(s.status.kind).toBe("pending");
    await vi.advanceTimersByTimeAsync(999);
    expect(f.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.calls.map((c) => c.body)).toEqual(["abc"]);
    expect(s.status.kind).toBe("saving");
    f.ok(f.calls[0]);
    await settle();
    expect(s.status).toEqual({ kind: "saved", at: 1_000_001 });
    expect(s.dirty).toBe(false);
    expect(s.hasSavedNote).toBe(true);
  });

  it("flush() sends at once, and does nothing when nothing changed", async () => {
    const f = fakeSend();
    const s = new NoteSaver("t", { body: "old", createdAt: 5, updatedAt: 5 }, f.send);
    await s.flush();
    expect(f.calls).toHaveLength(0);
    s.update("new");
    const done = s.flush();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ body: "new", expectedUpdatedAt: 5 });
    f.ok(f.calls[0]);
    await done;
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.calls).toHaveLength(1); // the 1 s timer was cancelled
  });

  it("sends one save at a time, then the newest text", async () => {
    const f = fakeSend();
    const s = new NoteSaver("t", null, f.send);
    s.update("first");
    void s.flush();
    s.update("second");
    void s.flush();
    s.update("third");
    const last = s.flush();
    expect(f.calls.map((c) => c.body)).toEqual(["first"]);
    f.ok(f.calls[0]);
    await settle();
    expect(f.calls.map((c) => c.body)).toEqual(["first", "third"]);
    expect(f.calls[1].expectedUpdatedAt).toBe(1_000_001); // from the first answer
    f.ok(f.calls[1]);
    await last;
    expect(s.dirty).toBe(false);
  });

  it("retries a failed save", async () => {
    const f = fakeSend();
    const s = new NoteSaver("t", null, f.send);
    s.update("x");
    void s.flush();
    f.calls[0].reject(new Error("server stopped"));
    await settle();
    expect(s.status).toEqual({ kind: "error", message: "server stopped" });
    expect(s.text).toBe("x");
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.calls).toHaveLength(2);
    f.calls[1].reject(new Error("still down"));
    await settle();
    await vi.advanceTimersByTimeAsync(4999);
    expect(f.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.calls).toHaveLength(3);
    f.ok(f.calls[2]);
    await settle();
    expect(s.status.kind).toBe("saved");
  });

  it("stops on a conflict until the user picks a side", async () => {
    const f = fakeSend();
    const s = new NoteSaver("t", null, f.send);
    s.update("mine");
    void s.flush();
    f.calls[0].reject(new ConflictResponse({ body: "theirs", createdAt: 1, updatedAt: 7 }));
    await settle();
    expect(s.status.kind).toBe("conflict");
    s.update("mine, more");
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.calls).toHaveLength(1); // no autosave while in conflict

    s.keepMine();
    expect(f.calls[1]).toMatchObject({ body: "mine, more", force: true });
    f.ok(f.calls[1]);
    await settle();
    expect(s.status.kind).toBe("saved");
  });

  it("Use theirs takes the other text", async () => {
    const f = fakeSend();
    const s = new NoteSaver("t", null, f.send);
    s.update("mine");
    void s.flush();
    f.calls[0].reject(new ConflictResponse({ body: "theirs", createdAt: 1, updatedAt: 7 }));
    await settle();
    s.useTheirs();
    expect(s.text).toBe("theirs");
    expect(s.status).toEqual({ kind: "saved", at: 7 });
    expect(s.dirty).toBe(false);
  });

  it("sends a keepalive save when the page closes, once", () => {
    const f = fakeSend();
    const s = new NoteSaver("t", null, f.send);
    s.update("typed just now");
    expect(s.flushOnUnload()).toBe(true);
    expect(s.flushOnUnload()).toBe(true); // visibilitychange, then pagehide
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ body: "typed just now", keepalive: true });
    s.update("x".repeat(70_000));
    expect(s.flushOnUnload()).toBe(false); // too big for keepalive: the page asks "Leave site?"
  });

  it("the registry keeps a saver with unsaved text, and drops a settled one", async () => {
    const f = fakeSend();
    const a = saverFor("t", null, f.send);
    a.update("draft");
    f.calls.length = 0;
    release(a); // leave the thread: save at once
    expect(f.calls).toHaveLength(1);
    expect(saverFor("t", null, f.send)).toBe(a); // still saving: same saver, same text
    f.ok(f.calls[0]);
    await settle();
    const b = saverFor("t", { body: "draft", createdAt: 1, updatedAt: 1_000_001 }, f.send);
    expect(b).not.toBe(a);
    expect(b.text).toBe("draft");
  });
});
