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
