import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ThreadDetail } from "../shared/types.ts";
import { setup } from "./helpers.ts";

const att = (ctx: ReturnType<typeof setup>, name: string) =>
  ctx.db.prepare("SELECT id, path, size_bytes, message_id FROM attachments WHERE filename = ? ORDER BY id LIMIT 1").get(name) as {
    id: number;
    path: string;
    size_bytes: number;
    message_id: number;
  };

describe("deleting attachments", () => {
  it("removes the file, keeps the row (marked deleted), the email and its other attachments", async () => {
    const ctx = setup();
    const pdf = att(ctx, "minutes.pdf");
    const file = path.join(ctx.dir, pdf.path);
    expect(fs.existsSync(file)).toBe(true);
    const r = await ctx.post("/api/attachments/delete", { ids: [pdf.id], confirmCount: 1, confirmBytes: pdf.size_bytes });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ deleted: 1, bytes: pdf.size_bytes, fileErrors: [] });
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.dirname(file))).toBe(true); // the other attachments of that message are still there
    expect(ctx.db.prepare("SELECT deleted_at FROM attachments WHERE id = ?").pluck().get(pdf.id)).toBeGreaterThan(0);
    expect(ctx.db.prepare("SELECT count(*) FROM attachments WHERE message_id = ? AND deleted_at IS NULL").pluck().get(pdf.message_id)).toBe(7);
    expect(ctx.db.prepare("SELECT count(*) FROM messages WHERE id = ?").pluck().get(pdf.message_id)).toBe(1);
  });

  it("removes the message's folder (and an empty bucket) with its last file", async () => {
    const ctx = setup();
    const pdf = att(ctx, "itinerary.pdf"); // the only attachment of its message
    const folder = path.dirname(path.join(ctx.dir, pdf.path));
    await ctx.post("/api/attachments/delete", { ids: [pdf.id], confirmCount: 1, confirmBytes: pdf.size_bytes });
    expect(fs.existsSync(folder)).toBe(false);
  });

  it("refuses a stale confirmation and changes nothing", async () => {
    const ctx = setup();
    const pdf = att(ctx, "minutes.pdf");
    expect((await ctx.post("/api/attachments/delete", { ids: [pdf.id], confirmCount: 1, confirmBytes: pdf.size_bytes + 1 })).status).toBe(409);
    expect((await ctx.post("/api/attachments/delete", { ids: [pdf.id], confirmCount: 2, confirmBytes: pdf.size_bytes })).status).toBe(409);
    expect((await ctx.post("/api/attachments/delete", { ids: [pdf.id] })).status).toBe(409);
    expect((await ctx.post("/api/attachments/delete", { ids: "x", confirmCount: 0, confirmBytes: 0 })).status).toBe(400);
    expect(ctx.db.prepare("SELECT deleted_at FROM attachments WHERE id = ?").pluck().get(pdf.id)).toBeNull();
    expect(fs.existsSync(path.join(ctx.dir, pdf.path))).toBe(true);
  });

  it("does nothing for an attachment that is already deleted", async () => {
    const ctx = setup();
    const pdf = att(ctx, "minutes.pdf");
    await ctx.post("/api/attachments/delete", { ids: [pdf.id], confirmCount: 1, confirmBytes: pdf.size_bytes });
    expect((await ctx.post("/api/attachments/delete-summary", { ids: [pdf.id] })).body).toEqual({ count: 0, bytes: 0, names: [] });
    expect((await ctx.post("/api/attachments/delete", { ids: [pdf.id], confirmCount: 0, confirmBytes: 0 })).body.deleted).toBe(0);
  });

  it("answers 410 for a deleted file, with the message", async () => {
    const ctx = setup();
    const pdf = att(ctx, "minutes.pdf");
    await ctx.post("/api/attachments/delete", { ids: [pdf.id], confirmCount: 1, confirmBytes: pdf.size_bytes });
    for (const kind of ["download", "inline"]) {
      const r = await ctx.get(`/api/attachments/${pdf.id}/${kind}`);
      expect(r.status).toBe(410);
      expect(r.body).toContain("The attached file was deleted from the archive, but the email thread was preserved.");
    }
  });

  it("shows deleted attachments in the thread and in Show original", async () => {
    const ctx = setup();
    const pdf = att(ctx, "minutes.pdf");
    await ctx.post("/api/attachments/delete", { ids: [pdf.id], confirmCount: 1, confirmBytes: pdf.size_bytes });
    const thread = ctx.db.prepare("SELECT thread_id FROM messages WHERE id = ?").pluck().get(pdf.message_id);
    const t = (await ctx.get(`/api/threads/${thread}?view=all`)).body as ThreadDetail;
    const a = t.messages[0].attachments.find((x) => x.filename === "minutes.pdf")!;
    expect(a.deletedAt).toBeGreaterThan(0);
    expect(t.messages[0].attachments.filter((x) => x.deletedAt === null)).toHaveLength(7);
    const orig = (await ctx.get(`/api/messages/${pdf.message_id}/original`)).body as string;
    expect(orig).toMatch(/minutes\.pdf .* \(deleted\)/);
  });

  it("deletes everything a report filter matches", async () => {
    const ctx = setup();
    const filter = { type: "Images", from: "carol@example.com" };
    const s = (await ctx.post("/api/attachments/delete-summary", { filter })).body as { count: number; bytes: number; names: string[] };
    expect(s.count).toBe(4); // sunset.jpg, beach.png, photo.png, drawing.svg
    expect(s.names[0]).toBe("sunset.jpg"); // biggest first
    const r = await ctx.post("/api/attachments/delete", { filter, confirmCount: s.count, confirmBytes: s.bytes });
    expect(r.body.deleted).toBe(4);
    expect(ctx.db.prepare("SELECT count(*) FROM attachments WHERE deleted_at IS NOT NULL").pluck().get()).toBe(4);
  });

  it("is refused in read-only mode", async () => {
    const ro = setup({ readOnly: true });
    const pdf = att(ro, "minutes.pdf");
    expect((await ro.post("/api/attachments/delete", { ids: [pdf.id], confirmCount: 1, confirmBytes: pdf.size_bytes })).status).toBe(403);
  });

  it("Delete forever still works for a message with a deleted attachment", async () => {
    const ctx = setup();
    const coupon = att(ctx, "coupon.png");
    await ctx.post("/api/attachments/delete", { ids: [coupon.id], confirmCount: 1, confirmBytes: coupon.size_bytes });
    const s = (await ctx.post("/api/trash/summary", {})).body as { messages: number };
    const r = await ctx.post("/api/trash/empty", { confirmCount: s.messages });
    expect(r.status).toBe(200);
    expect(ctx.db.prepare("SELECT count(*) FROM attachments WHERE id = ?").pluck().get(coupon.id)).toBe(0);
  });
});
