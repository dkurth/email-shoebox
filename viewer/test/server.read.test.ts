import { describe, expect, it } from "vitest";
import { applyChange, removeAction } from "../shared/labels.ts";
import type { Sidebar, ThreadDetail, ThreadList } from "../shared/types.ts";
import { firstName } from "../server/views.ts";
import { PORT, setup } from "./helpers.ts";

const subjects = (l: ThreadList) => l.threads.map((t) => t.subject);

describe("sidebar", () => {
  it("lists folders, categories and user labels with unread counts", async () => {
    const { get } = setup();
    const s = (await get("/api/sidebar")).body as Sidebar;
    expect(s.folders.map((f) => f.name)).toEqual(["Inbox", "Starred", "Important", "Sent", "Drafts", "Chats", "All Mail", "Spam", "Trash"]);
    expect(s.folders.find((f) => f.view === "inbox")!.count).toBe(2); // two inbox threads have unread mail
    expect(s.folders.find((f) => f.view === "spam")!.count).toBe(1);
    expect(s.folders.find((f) => f.view === "drafts")!.count).toBe(1);
    expect(s.categories.map((c) => c.name)).toEqual(["Personal", "Promotions"]);
    expect(s.labels.map((l) => l.name)).toEqual(["Family", "Media", "Newsletters", "Travel/2024", "Work", "Work/Projects"]);
    expect(s.labels.find((l) => l.name === "Travel/2024")!.count).toBe(1);
  });
});

describe("thread list", () => {
  it("shows the Inbox as threads, newest first, with Gmail-style rows", async () => {
    const { get } = setup();
    const l = (await get("/api/threads?view=inbox")).body as ThreadList;
    expect(subjects(l)).toEqual(["Welcome to the archive", "Trip planning", "Big sale", "Grüße aus Köln ☕", "Mixed thread"]);
    const trip = l.threads[1];
    expect(trip.participants).toEqual([
      { name: "Alice", unread: false },
      { name: "me", unread: false },
      { name: "Bob", unread: true },
    ]);
    expect(trip).toMatchObject({ messageCount: 3, unread: true, important: true, hasAttachments: true, labels: ["Travel/2024"] });
    expect(trip.snippet).toBe("Count me in. From Bob");
  });

  it("hides trashed messages outside Trash, and shows them in Trash", async () => {
    const { get } = setup();
    const inbox = (await get("/api/threads?view=inbox")).body as ThreadList;
    expect(inbox.threads.find((t) => t.subject === "Mixed thread")!.messageCount).toBe(1);
    const trash = (await get("/api/threads?view=trash")).body as ThreadList;
    expect(subjects(trash)).toEqual(["Re: Mixed thread", "Old coupon"]);
    const all = (await get("/api/threads?view=all")).body as ThreadList;
    expect(subjects(all)).not.toContain("Old coupon");
    expect(subjects(all)).not.toContain("You won!!!");
  });

  it("filters by user label, nested label and category", async () => {
    const { get } = setup();
    expect(subjects((await get("/api/threads?view=label:Work")).body)).toEqual(["Quarterly report"]);
    expect(subjects((await get("/api/threads?view=" + encodeURIComponent("label:Work/Projects"))).body)).toEqual(["Project kickoff"]);
    const personal = (await get("/api/threads?view=" + encodeURIComponent("label:Category Personal"))).body as ThreadList;
    expect(subjects(personal)).toEqual(["Welcome to the archive", "Trip planning"]);
    expect(personal.threads[1].labels).toEqual(["Inbox", "Travel/2024"]); // Inbox chip outside the Inbox
  });

  it("shows recipients in Sent", async () => {
    const { get } = setup();
    const sent = (await get("/api/threads?view=sent")).body as ThreadList;
    const q = sent.threads.find((t) => t.subject === "Question about the invoice")!;
    expect(q.toPrefix).toBe(true);
    expect(q.participants.map((p) => p.name)).toEqual(["Carol"]);
  });

  it("pages 50 threads at a time", async () => {
    const { get } = setup();
    const p1 = (await get("/api/threads?view=all")).body as ThreadList;
    const p2 = (await get("/api/threads?view=all&page=2")).body as ThreadList;
    expect(p1.total).toBe(70); // 72 threads minus the Spam thread and the Trash-only thread
    expect(p1.threads).toHaveLength(50);
    expect(p2.threads).toHaveLength(20);
    const p9 = (await get("/api/threads?view=all&page=9")).body as ThreadList;
    expect(p9).toMatchObject({ total: 70, threads: [] });
  });

  it("rejects unknown views and bad pages", async () => {
    const { get } = setup();
    expect((await get("/api/threads?view=nope")).status).toBe(400);
    expect((await get("/api/threads?view=inbox&page=0")).status).toBe(400);
  });
});

describe("thread detail", () => {
  it("returns every message with people, bodies, labels and attachments", async () => {
    const { get } = setup();
    const inbox = (await get("/api/threads?view=inbox")).body as ThreadList;
    const id = inbox.threads[1].threadId;
    const t = (await get(`/api/threads/${id}?view=inbox`)).body as ThreadDetail;
    expect(t.subject).toBe("Trip planning");
    expect(t.messages).toHaveLength(3);
    const [m1, , m3] = t.messages;
    expect(m1.from).toEqual({ name: "Alice Adams", addr: "alice@example.com" });
    expect(m1.attachments.map((a) => a.filename)).toEqual(["itinerary.pdf"]);
    expect(m3.cc).toEqual([{ name: "Alice Adams", addr: "alice@example.com" }]);
    expect(m3.bodyText).toBe("Count me in.\nFrom Bob\n");
    expect(m3.unread).toBe(true);
  });

  it("marks trashed messages as out of context outside Trash", async () => {
    const { get } = setup();
    const inbox = (await get("/api/threads?view=inbox")).body as ThreadList;
    const id = inbox.threads.find((t) => t.subject === "Mixed thread")!.threadId;
    const t = (await get(`/api/threads/${id}?view=inbox`)).body as ThreadDetail;
    expect(t.messages.map((m) => m.inContext)).toEqual([true, false]);
    const tt = (await get(`/api/threads/${id}?view=trash`)).body as ThreadDetail;
    expect(tt.messages.map((m) => m.inContext)).toEqual([false, true]);
  });

  it("404s unknown threads", async () => {
    const { get } = setup();
    expect((await get("/api/threads/nope?view=inbox")).status).toBe(404);
  });
});

describe("attachments", () => {
  it("downloads with the original name", async () => {
    const { get, db } = setup();
    const pdf = db.prepare("SELECT id FROM attachments WHERE filename = 'itinerary.pdf'").pluck().get();
    const r = await get(`/api/attachments/${pdf}/download`);
    expect(r.status).toBe(200);
    expect(r.res.headers.get("content-disposition")).toBe(`attachment; filename="itinerary.pdf"; filename*=UTF-8''itinerary.pdf`);
    expect(r.body).toBe("%PDF-1.4 fake");
    const png = db.prepare("SELECT id FROM attachments WHERE filename = 'logo.png'").pluck().get();
    const img = await get(`/api/attachments/${png}/inline`);
    expect(img.status).toBe(200);
    expect(img.res.headers.get("content-type")).toBe("image/png");
  });

  it("inlines only files the browser can show, with a safe type", async () => {
    const { get, db } = setup();
    const id = (name: string) => db.prepare("SELECT id FROM attachments WHERE filename = ?").pluck().get(name);
    const inline = (name: string) => get(`/api/attachments/${id(name)}/inline`);
    const cases: [string, number, string | null][] = [
      ["voice-memo.mp3", 200, "audio/mpeg"],
      ["clip.mp4", 200, "video/mp4"],
      ["photo.png", 200, "image/png"], // sent as application/octet-stream
      ["minutes.pdf", 200, "application/pdf"],
      ["server.log", 200, "text/plain; charset=utf-8"],
      ["drawing.svg", 415, null],
      ["report.xlsx", 415, null],
    ];
    for (const [name, status, type] of cases) {
      const r = await inline(name);
      expect([name, r.status]).toEqual([name, status]);
      if (type) {
        expect(r.res.headers.get("content-type")).toBe(type);
        expect(r.res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(r.res.headers.get("content-disposition")).toMatch(/^inline;/);
      }
    }
    // PDFs: no sandbox (Chrome's viewer needs that), but still no scripts or remote loads.
    const pdfCsp = (await inline("minutes.pdf")).res.headers.get("content-security-policy")!;
    expect(pdfCsp).not.toContain("sandbox");
    expect(pdfCsp).toContain("default-src 'none'");
    expect((await inline("voice-memo.mp3")).res.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("serves byte ranges", async () => {
    const { app, db } = setup();
    const mp3 = db.prepare("SELECT id, size_bytes FROM attachments WHERE filename = 'voice-memo.mp3'").get() as { id: number; size_bytes: number };
    const req = (range: string) => app.request(`/api/attachments/${mp3.id}/inline`, { headers: { host: `127.0.0.1:${PORT}`, range } });
    const r = await req("bytes=0-99");
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe(`bytes 0-99/${mp3.size_bytes}`);
    expect(r.headers.get("content-length")).toBe("100");
    expect((await r.arrayBuffer()).byteLength).toBe(100);
    const tail = await req("bytes=-10");
    expect(tail.headers.get("content-range")).toBe(`bytes ${mp3.size_bytes - 10}-${mp3.size_bytes - 1}/${mp3.size_bytes}`);
    const open = await req("bytes=100-");
    expect((await open.arrayBuffer()).byteLength).toBe(mp3.size_bytes - 100);
    expect((await req(`bytes=${mp3.size_bytes}-`)).status).toBe(416);
    expect((await req("bytes=abc")).status).toBe(416);
  });

  it("refuses paths outside the attachments folder", async () => {
    const { get, db } = setup();
    db.prepare("UPDATE attachments SET path = '../../etc/passwd' WHERE filename = 'itinerary.pdf'").run();
    const id = db.prepare("SELECT id FROM attachments WHERE filename = 'itinerary.pdf'").pluck().get();
    expect((await get(`/api/attachments/${id}/download`)).status).toBe(400);
  });

  it("shows the original headers and decoded parts", async () => {
    const { get, db } = setup();
    const id = db.prepare("SELECT id FROM messages WHERE subject = 'Pancake recipe'").pluck().get();
    const r = await get(`/api/messages/${id}/original`);
    expect(r.body).toContain("Subject: Pancake recipe");
    expect(r.body).toContain("Flour, eggs, milk.");
  });
});

describe("label rules", () => {
  it("keeps pseudo-label pairs consistent", () => {
    expect([...applyChange(new Set(["Inbox", "Unread"]), { add: [], remove: ["Inbox", "Unread"] })].sort()).toEqual(["Archived", "Opened"]);
    expect([...applyChange(new Set(["Archived", "Trash"]), { add: ["Inbox"], remove: ["Trash"] })]).toEqual(["Inbox"]);
    expect([...applyChange(new Set(["Sent"]), { add: ["Work"], remove: [] })].sort()).toEqual(["Sent", "Work"]);
  });

  it("y depends on the view, as in Gmail", () => {
    expect(removeAction("inbox")).toMatchObject({ remove: ["Inbox"], add: [] });
    expect(removeAction("label:Work")).toMatchObject({ remove: ["Work"], button: 'Remove label "Work"' });
    expect(removeAction("trash")).toMatchObject({ remove: ["Trash"], add: ["Inbox"] });
    expect(removeAction("starred")).toMatchObject({ remove: ["Starred"] });
    expect(removeAction("all")).toBeNull();
    expect(removeAction("sent")).toBeNull();
    expect(removeAction("label:Category Social")!.done(2)).toBe("2 conversations removed from Social.");
  });

  it("finds first names", () => {
    expect(firstName("Alice Adams", "a@x")).toBe("Alice");
    expect(firstName("Doe, Jane", "j@x")).toBe("Jane");
    expect(firstName("", "bob@x.com")).toBe("bob");
    expect(firstName("bob@x.com", "bob@x.com")).toBe("bob");
  });
});
