import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ThreadList, TrashSummary } from "../shared/types.ts";
import { setup } from "./helpers.ts";

type Ctx = ReturnType<typeof setup>;
const count = (ctx: Ctx, sql: string, ...p: unknown[]) => ctx.db.prepare(sql).pluck().get(...p) as number;

describe("empty trash", () => {
  it("summarizes what would be deleted", async () => {
    const ctx = setup();
    const s = (await ctx.post("/api/trash/summary", {})).body as TrashSummary;
    expect(s).toEqual({ messages: 2, threads: 2, attachments: 1, attachmentBytes: 70, notes: 0 });
  });

  it("deletes rows, search entries and files, and records tombstones", async () => {
    const ctx = setup();
    const coupon = ctx.db.prepare("SELECT id, gmail_id, thread_id FROM messages WHERE subject = 'Old coupon'").get() as { id: number; gmail_id: string; thread_id: string };
    const attPath = ctx.db.prepare("SELECT path FROM attachments WHERE message_id = ?").pluck().get(coupon.id) as string;
    expect(fs.existsSync(path.join(ctx.dir, attPath))).toBe(true);
    const mixed = ctx.db.prepare("SELECT thread_id FROM messages WHERE subject = 'Mixed thread'").pluck().get() as string;
    const before = count(ctx, "SELECT count(*) FROM messages");

    const r = await ctx.post("/api/trash/empty", { confirmCount: 2 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ messages: 2, threads: 2, notes: 0, folderErrors: [] });

    expect(count(ctx, "SELECT count(*) FROM messages")).toBe(before - 2);
    expect(count(ctx, "SELECT count(*) FROM attachments WHERE message_id = ?", coupon.id)).toBe(0);
    expect(count(ctx, "SELECT count(*) FROM message_labels WHERE message_id = ?", coupon.id)).toBe(0);
    expect(count(ctx, "SELECT count(*) FROM messages_fts WHERE messages_fts MATCH 'coupon'")).toBe(0);
    expect(count(ctx, "SELECT count(*) FROM deleted_messages WHERE gmail_id = ?", coupon.gmail_id)).toBe(1);
    expect(fs.existsSync(path.join(ctx.dir, path.dirname(attPath)))).toBe(false);
    // The thread with only trashed mail is gone; the mixed thread keeps its other message.
    expect(count(ctx, "SELECT count(*) FROM threads WHERE thread_id = ?", coupon.thread_id)).toBe(0);
    expect(count(ctx, "SELECT message_count FROM threads WHERE thread_id = ?", mixed)).toBe(1);
    expect(((await ctx.get("/api/threads?view=trash")).body as ThreadList).total).toBe(0);
    expect(((await ctx.get("/api/threads?view=inbox")).body as ThreadList).threads.map((t) => t.subject)).toContain("Mixed thread");
  });

  it("refuses when the count doesn't match what the dialog showed", async () => {
    const ctx = setup();
    const r = await ctx.post("/api/trash/empty", { confirmCount: 1 });
    expect(r.status).toBe(409);
    expect(count(ctx, "SELECT count(*) FROM deleted_messages")).toBe(0);
    expect((await ctx.post("/api/trash/empty", {})).status).toBe(409);
  });

  it("deletes forever only the trashed messages of the selected threads", async () => {
    const ctx = setup();
    const mixed = ctx.db.prepare("SELECT thread_id FROM messages WHERE subject = 'Mixed thread'").pluck().get() as string;
    const s = (await ctx.post("/api/trash/summary", { threadIds: [mixed] })).body as TrashSummary;
    expect(s.messages).toBe(1);
    const r = await ctx.post("/api/threads/delete-forever", { threadIds: [mixed], confirmCount: 1 });
    expect(r.body).toMatchObject({ messages: 1, threads: 1 });
    expect(count(ctx, "SELECT count(*) FROM messages WHERE thread_id = ?", mixed)).toBe(1);
    expect(count(ctx, "SELECT count(*) FROM messages WHERE subject = 'Old coupon'")).toBe(1); // other trash untouched
  });

  it("is refused in read-only mode", async () => {
    const ctx = setup({ readOnly: true });
    expect((await ctx.post("/api/trash/empty", { confirmCount: 2 })).status).toBe(403);
  });
});
