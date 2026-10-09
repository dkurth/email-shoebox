import { describe, expect, it } from "vitest";
import type { AdminImport, AdminLabel, AdminOverview } from "../shared/types.ts";
import { setup } from "./helpers.ts";

describe("admin overview", () => {
  it("matches the archive", async () => {
    const ctx = setup();
    const o = (await ctx.get("/api/admin/overview")).body as AdminOverview;
    const q = (sql: string) => ctx.db.prepare(sql).pluck().get() as number;
    expect(o.messages).toBe(q("SELECT count(*) FROM messages"));
    expect(o.messageBytes).toBe(q("SELECT sum(size_bytes) FROM messages"));
    expect(o.threads).toBe(q("SELECT count(*) FROM threads"));
    expect(o.unread).toBe(q("SELECT count(*) FROM messages WHERE is_unread = 1"));
    expect(o.starred).toBe(1);
    expect(o.firstDate).toBe(q("SELECT min(coalesce(received_utc, date_utc)) FROM messages"));
    expect(o.lastDate).toBe(q("SELECT max(coalesce(received_utc, date_utc)) FROM messages"));
    expect(o.attachments + o.inlineImages).toBe(q("SELECT count(*) FROM attachments"));
    expect(o.inlineImages).toBe(1); // the shop logo
    expect(o.deletedAttachments).toBe(0);
    expect(o.dbBytes).toBeGreaterThan(0);
    expect(o.parseErrorCount).toBe(0);
    expect(o.notes).toBe(0);
    expect(o.topSenders[0]).toMatchObject({ addr: "news@shop.example", name: "Deals", count: 57 });
    expect(o.topSenders.map((p) => p.addr)).not.toContain("me@example.com");
    expect(o.topSenders.map((p) => p.addr)).toEqual(["news@shop.example", "alice@example.com", "bob@example.com", "carol@example.com", "club@hikers.example", "oma@example.de", "win@spam.example"]); // your own mail and the chat are left out
  });

  it("lists parse errors and deleted attachments", async () => {
    const ctx = setup();
    ctx.db.prepare("UPDATE messages SET parse_error = 'attachment 1: bad base64' WHERE subject = 'Pancake recipe'").run();
    ctx.db.prepare("UPDATE attachments SET deleted_at = 1 WHERE filename = 'itinerary.pdf'").run();
    const o = (await ctx.get("/api/admin/overview")).body as AdminOverview;
    expect(o.parseErrorCount).toBe(1);
    expect(o.parseErrors[0]).toMatchObject({ subject: "Pancake recipe", error: "attachment 1: bad base64", fromAddr: "bob@example.com" });
    expect(o.deletedAttachments).toBe(1);
    expect(o.deletedBytes).toBe(13);
  });
});

describe("admin labels and imports", () => {
  it("counts messages, threads and unread messages per label", async () => {
    const ctx = setup();
    const ls = (await ctx.get("/api/admin/labels")).body as AdminLabel[];
    const travel = ls.find((l) => l.name === "Travel/2024")!;
    expect(travel).toMatchObject({ messages: 3, threads: 1, unread: 1 });
    expect(ls.find((l) => l.name === "Newsletters")).toMatchObject({ messages: 55, threads: 55, unread: 0 });
    expect(ls.find((l) => l.name === "Work")).toMatchObject({ messages: 2, threads: 1 });
  });

  it("lists imports, newest first", async () => {
    const ctx = setup();
    const im = (await ctx.get("/api/admin/imports")).body as AdminImport[];
    expect(im).toHaveLength(1);
    expect(im[0]).toMatchObject({ status: "finished", sources: ["sample.mbox"] });
    expect(im[0].counts.inserted).toBe(ctx.db.prepare("SELECT count(*) FROM messages").pluck().get());
  });
});

describe("admin people", () => {
  type People = { rows: import("../shared/types.ts").AdminPerson[]; total: number };
  const people = async (ctx: ReturnType<typeof setup>, qs: string) => (await ctx.get(`/api/admin/people?${qs}`)).body as People;

  it("lists people I sent to, with To/Cc/Bcc counts", async () => {
    const ctx = setup();
    const r = await people(ctx, "dir=sent");
    expect(r.rows.map((p) => [p.addr, p.count])).toEqual([
      ["alice@example.com", 2],
      ["carol@example.com", 1],
    ]);
    expect(r.rows[0]).toMatchObject({ name: "Alice Adams", to: 2, cc: 0, bcc: 0 });
    expect(r.rows[0].last).toBeGreaterThan(0);
  });

  it("lists people I received from, with attachments, without me or chats", async () => {
    const ctx = setup();
    const r = await people(ctx, "dir=received");
    expect(r.total).toBe(7);
    const carol = r.rows.find((p) => p.addr === "carol@example.com")!;
    expect(carol).toMatchObject({ count: 3, name: "Carol Chen", attachments: 8 });
    expect(r.rows.map((p) => p.addr)).not.toContain("dana@example.com");
    expect((await people(ctx, "dir=received&chats=1")).rows.map((p) => p.addr)).toContain("dana@example.com");
  });

  it("filters, sorts, pages and groups by domain", async () => {
    const ctx = setup();
    expect((await people(ctx, "dir=received&q=CHEN")).rows.map((p) => p.addr)).toEqual(["carol@example.com"]);
    expect((await people(ctx, "dir=received&q=%25")).rows).toEqual([]); // % is literal
    const byName = await people(ctx, "dir=received&sort=addr&desc=0");
    expect(byName.rows[0].addr).toBe("alice@example.com");
    const byBytes = await people(ctx, "dir=received&sort=attachmentBytes");
    expect(byBytes.rows[0].addr).toBe("carol@example.com");
    const domains = await people(ctx, "dir=received&domain=1");
    expect(domains.rows.find((p) => p.addr === "example.com")).toMatchObject({ addresses: 3, count: 11 });
    expect((await people(ctx, "dir=received&page=2")).rows).toEqual([]);
    expect((await ctx.get("/api/admin/people?dir=both")).status).toBe(400);
    expect((await ctx.get("/api/admin/people?dir=sent&sort=evil")).status).toBe(400);
  });

  it("lists mailing lists", async () => {
    const ctx = setup();
    const r = (await ctx.get("/api/admin/lists")).body as { rows: import("../shared/types.ts").AdminList[]; total: number };
    expect(r.total).toBe(1);
    expect(r.rows[0]).toMatchObject({ listId: "announce.hikers.example", name: "Hike Club Announcements", messages: 2, unread: 1 });
    expect(((await ctx.get("/api/admin/lists?q=nothing")).body as { total: number }).total).toBe(0);
  });

  it("describes one person", async () => {
    const ctx = setup();
    const p = (await ctx.get("/api/admin/person?addr=Carol@Example.com")).body as import("../shared/types.ts").AdminPersonDetail;
    expect(p.addr).toBe("carol@example.com");
    expect(p.names[0].name).toBe("Carol Chen");
    expect(p.messages).toBe(4); // three from Carol, one to her
    expect(p.years).toEqual([{ year: 2024, received: 3, sent: 1 }]);
    expect(p.labels.map((l) => l.name)).toEqual(["Media", "Work/Projects"]);
    expect(p.attachments[0]).toMatchObject({ filename: "voice-memo.mp3", subject: "Holiday media" }); // the biggest first
    expect(p.attachments).toHaveLength(8);
  });
});

describe("attachment report", () => {
  type Report = { rows: import("../shared/types.ts").AttachmentRow[]; total: number };
  const rep = async (ctx: ReturnType<typeof setup>, qs = "") => (await ctx.get(`/api/admin/attachments${qs}`)).body as Report;

  it("sums by type group and by sender", async () => {
    const ctx = setup();
    const s = (await ctx.get("/api/admin/attachments/summary")).body as import("../shared/types.ts").AttachmentSummary;
    expect(s.count).toBe(14); // without the inline logo
    const groups = Object.fromEntries(s.groups.map((g) => [g.group, g.count]));
    expect(groups).toEqual({ Images: 6, Audio: 1, Video: 1, PDF: 2, Documents: 3, Spreadsheets: 1 });
    expect(s.groups.find((g) => g.group === "Images")!.types.map((t) => t.type).sort()).toEqual(["application/octet-stream", "image/jpeg", "image/png", "image/svg+xml"]);
    expect(s.senders[0]).toMatchObject({ addr: "carol@example.com", count: 8 });
    const withInline = (await ctx.get("/api/admin/attachments/summary?inline=1")).body as import("../shared/types.ts").AttachmentSummary;
    expect(withInline.count).toBe(15);
  });

  it("lists every attachment, biggest first, with its email", async () => {
    const ctx = setup();
    const r = await rep(ctx);
    expect(r.total).toBe(14);
    expect(r.rows[0]).toMatchObject({ filename: "voice-memo.mp3", typeGroup: "Audio", fromAddr: "carol@example.com", subject: "Holiday media" });
    expect(r.rows.map((x) => x.size)).toEqual([...r.rows.map((x) => x.size)].sort((a, b) => b - a));
  });

  it("filters and sorts", async () => {
    const ctx = setup();
    expect((await rep(ctx, "?type=Images")).rows.map((x) => x.filename).sort()).toEqual(["beach.png", "coupon.png", "drawing.svg", "photo.png", "sunset.jpg", "sunset.jpg"]);
    expect((await rep(ctx, "?from=alice@example.com")).rows.map((x) => x.filename).sort()).toEqual(["itinerary.pdf", "notes.txt", "notes.txt", "report.xlsx"]);
    expect((await rep(ctx, "?min=1000")).rows.map((x) => x.filename)).toEqual(["voice-memo.mp3", "clip.mp4"]);
    expect((await rep(ctx, "?sort=name&desc=0")).rows[0].filename).toBe("beach.png");
    expect((await rep(ctx, "?sort=date&desc=0")).rows[0].subject).toBe("Holiday media");
    expect((await rep(ctx, "?inline=1")).total).toBe(15);
    expect((await ctx.get("/api/admin/attachments?type=Nope")).status).toBe(400);
    expect((await ctx.get("/api/admin/attachments?min=abc")).status).toBe(400);
  });

  it("hides deleted attachments unless asked", async () => {
    const ctx = setup();
    ctx.db.prepare("UPDATE attachments SET deleted_at = 1 WHERE filename = 'clip.mp4'").run();
    expect((await rep(ctx)).total).toBe(13);
    const all = await rep(ctx, "?deleted=1");
    expect(all.total).toBe(14);
    expect(all.rows.find((x) => x.filename === "clip.mp4")!.deletedAt).toBe(1);
  });
});
