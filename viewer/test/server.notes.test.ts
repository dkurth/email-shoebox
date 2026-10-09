import { describe, expect, it } from "vitest";
import type { NoteSaveResult, Sidebar, ThreadDetail, ThreadList, TrashSummary } from "../shared/types.ts";
import { setup } from "./helpers.ts";

const threadOf = (ctx: ReturnType<typeof setup>, subject: string) =>
  ctx.db.prepare("SELECT thread_id FROM messages WHERE subject = ?").pluck().get(subject) as string;

const put = (ctx: ReturnType<typeof setup>, threadId: string, body: object) =>
  ctx.post(`/api/threads/${encodeURIComponent(threadId)}/note`, body, "PUT");

describe("notes", () => {
  it("saves, updates and deletes a note", async () => {
    const ctx = setup();
    const t = threadOf(ctx, "Pancake recipe");
    const r1 = await put(ctx, t, { body: "Try with\r\nbuttermilk", expectedUpdatedAt: null });
    expect(r1.status).toBe(200);
    const saved = (r1.body as NoteSaveResult).note!;
    expect(saved.body).toBe("Try with\nbuttermilk");
    expect(saved.createdAt).toBe(saved.updatedAt);
    expect(saved.updatedAt).toBeGreaterThan(1e12); // milliseconds

    const r2 = await put(ctx, t, { body: "Use buttermilk", expectedUpdatedAt: saved.updatedAt });
    const updated = (r2.body as NoteSaveResult).note!;
    expect(updated.updatedAt).toBeGreaterThan(saved.updatedAt); // even within the same millisecond
    expect(updated.createdAt).toBe(saved.createdAt);
    expect(ctx.db.prepare("SELECT count(*) FROM notes_fts WHERE notes_fts MATCH 'buttermilk'").pluck().get()).toBe(1);

    const detail = (await ctx.get(`/api/threads/${t}?view=starred`)).body as ThreadDetail;
    expect(detail.note).toMatchObject({ body: "Use buttermilk", updatedAt: updated.updatedAt });

    const r3 = await put(ctx, t, { body: "  \n ", expectedUpdatedAt: updated.updatedAt });
    expect(r3.body).toEqual({ deleted: true, note: null });
    expect(ctx.db.prepare("SELECT count(*) FROM thread_notes").pluck().get()).toBe(0);
    expect(ctx.db.prepare("SELECT count(*) FROM notes_fts WHERE notes_fts MATCH 'buttermilk'").pluck().get()).toBe(0);
  });

  it("refuses a stale save with 409 and the stored note, unless forced", async () => {
    const ctx = setup();
    const t = threadOf(ctx, "Pancake recipe");
    const first = ((await put(ctx, t, { body: "tab one", expectedUpdatedAt: null })).body as NoteSaveResult).note!;
    const stale = await put(ctx, t, { body: "tab two", expectedUpdatedAt: null });
    expect(stale.status).toBe(409);
    expect(stale.body.note).toMatchObject({ body: "tab one", updatedAt: first.updatedAt });
    expect((await put(ctx, t, { body: "tab two", expectedUpdatedAt: first.updatedAt - 5 })).status).toBe(409);
    const forced = await put(ctx, t, { body: "tab two", expectedUpdatedAt: null, force: true });
    expect(forced.status).toBe(200);
    expect((forced.body as NoteSaveResult).note!.body).toBe("tab two");
  });

  it("checks its input", async () => {
    const ctx = setup();
    const t = threadOf(ctx, "Pancake recipe");
    expect((await put(ctx, "no-such-thread", { body: "x", expectedUpdatedAt: null })).status).toBe(404);
    expect((await put(ctx, t, { body: "x".repeat(100_001), expectedUpdatedAt: null })).status).toBe(400);
    expect((await put(ctx, t, { body: 5, expectedUpdatedAt: null })).status).toBe(400);
    expect((await put(ctx, t, { body: "x", expectedUpdatedAt: "soon" })).status).toBe(400);
  });

  it("is refused in read-only mode and without the write header", async () => {
    const ro = setup({ readOnly: true });
    expect((await put(ro, threadOf(ro, "Pancake recipe"), { body: "x", expectedUpdatedAt: null })).status).toBe(403);
    const ctx = setup();
    const res = await ctx.app.request(`/api/threads/${threadOf(ctx, "Pancake recipe")}/note`, {
      method: "PUT",
      headers: { host: "127.0.0.1:5178", origin: "http://127.0.0.1:5178", "content-type": "application/json" },
      body: JSON.stringify({ body: "x", expectedUpdatedAt: null }),
    });
    expect(res.status).toBe(403);
  });

  it("shows hasNote and the first line in the thread list", async () => {
    const ctx = setup();
    const t = threadOf(ctx, "Pancake recipe");
    await put(ctx, t, { body: "\n  First line here \nsecond", expectedUpdatedAt: null });
    const list = (await ctx.get("/api/threads?view=starred")).body as ThreadList;
    expect(list.threads[0]).toMatchObject({ threadId: t, hasNote: true, noteFirstLine: "First line here" });
    const inbox = (await ctx.get("/api/threads?view=inbox")).body as ThreadList;
    expect(inbox.threads.every((x) => !x.hasNote && x.noteFirstLine === null)).toBe(true);
  });

  it("Delete forever removes a note only when the whole thread is gone", async () => {
    const ctx = setup();
    const mixed = threadOf(ctx, "Mixed thread"); // one message in Trash, one in the Inbox
    const coupon = threadOf(ctx, "Old coupon"); // only message is in Trash
    await put(ctx, mixed, { body: "keep me", expectedUpdatedAt: null });
    await put(ctx, coupon, { body: "goes away", expectedUpdatedAt: null });
    const s = (await ctx.post("/api/trash/summary", {})).body as TrashSummary;
    expect(s.notes).toBe(1);
    const r = await ctx.post("/api/trash/empty", { confirmCount: s.messages });
    expect(r.body.notes).toBe(1);
    const left = ctx.db.prepare("SELECT thread_id FROM thread_notes").pluck().all();
    expect(left).toEqual([mixed]);
  });
});

describe("the Notes folder", () => {
  it("lists threads with a note, newest note first, with the note as the snippet", async () => {
    const ctx = setup();
    const sidebar = async () => ((await ctx.get("/api/sidebar")).body as Sidebar).folders.find((f) => f.view === "notes");
    expect(await sidebar()).toBeUndefined(); // hidden while there are no notes

    const pancake = threadOf(ctx, "Pancake recipe");
    const trip = threadOf(ctx, "Trip planning");
    const coupon = threadOf(ctx, "Old coupon"); // only in Trash: left out
    await put(ctx, trip, { body: "Book flights\nby Friday", expectedUpdatedAt: null });
    await put(ctx, coupon, { body: "trashed thread", expectedUpdatedAt: null });
    await put(ctx, pancake, { body: "Buttermilk", expectedUpdatedAt: null });

    const list = (await ctx.get("/api/threads?view=notes")).body as ThreadList;
    expect(list.total).toBe(2);
    expect(list.threads.map((t) => [t.subject, t.snippet])).toEqual([
      ["Pancake recipe", "Buttermilk"],
      ["Trip planning", "Book flights"],
    ]);
    expect(list.threads[1].date).toBeGreaterThan(0); // the newest message's date
    expect((await sidebar())?.count).toBe(2);

    // Changing an older note moves it to the top.
    const tripNote = ctx.db.prepare("SELECT updated_at FROM thread_notes WHERE thread_id = ?").pluck().get(trip) as number;
    await put(ctx, trip, { body: "Flights booked", expectedUpdatedAt: tripNote });
    const again = (await ctx.get("/api/threads?view=notes")).body as ThreadList;
    expect(again.threads.map((t) => t.subject)).toEqual(["Trip planning", "Pancake recipe"]);
  });

  it("y does nothing there, and select-all acts only on threads with a note", async () => {
    const ctx = setup();
    const pancake = threadOf(ctx, "Pancake recipe");
    await put(ctx, pancake, { body: "x", expectedUpdatedAt: null });
    const r = await ctx.post("/api/threads/modify", { view: "notes", all: true, add: ["Work"], remove: [] });
    expect(r.body.threads).toBe(1);
  });
});

describe("notes export", () => {
  async function threeNotes() {
    const ctx = setup();
    await put(ctx, threadOf(ctx, "Trip planning"), { body: 'Book flights, "cheap" ones\n# not a heading\nline 3', expectedUpdatedAt: null });
    await put(ctx, threadOf(ctx, "Old coupon"), { body: "in the trash", expectedUpdatedAt: null });
    await put(ctx, threadOf(ctx, "Pancake recipe"), { body: "Buttermilk", expectedUpdatedAt: null });
    return ctx;
  }

  it("writes Markdown, newest note first", async () => {
    const ctx = await threeNotes();
    const r = await ctx.get("/api/admin/notes/export?format=md");
    expect(r.status).toBe(200);
    expect(r.res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(r.res.headers.get("content-disposition")).toMatch(/^attachment; filename="notes-\d{4}-\d\d-\d\d\.md"/);
    const md = r.body as string;
    const headings = md.split("\n").filter((l) => l.startsWith("## "));
    expect(headings).toEqual(["## Pancake recipe", "## Old coupon", "## Trip planning"]);
    expect(md).toContain("\\# not a heading");
    expect(md).toMatch(/- Thread: \d+ · 3 messages · Jan \d+, 2024 – Jan \d+, 2024\n/);
    expect(md).toContain("- People: Alice Adams <alice@example.com>, me, Bob Brown <bob@example.com>");
    expect(md).toContain("- Labels: Travel/2024");
    expect(md).toMatch(/Old coupon\n- Thread: \d+ · 1 message · .* · in Trash/);
  });

  it("writes CSV with a BOM and RFC 4180 quoting", async () => {
    const ctx = await threeNotes();
    const res = await ctx.app.request("/api/admin/notes/export?format=csv", { headers: { host: "127.0.0.1:5178" } });
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // the BOM (text() would hide it)
    const csv = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    expect(csv.startsWith("\ufeffthread_id,subject,first_date,last_date,message_count,people,labels,in_trash_or_spam,note_created,note_updated,note\r\n")).toBe(true);
    expect(csv).toContain(`"Book flights, ""cheap"" ones\n# not a heading\nline 3"`);
    expect(csv).toMatch(/,Old coupon,[^\r]*,Trash,/);
    expect(csv).toMatch(/,\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d,/);
    expect(csv.trimEnd().split("\r\n")).toHaveLength(4); // header + 3 notes (one has new lines inside quotes)
  });

  it("works in read-only mode and refuses unknown formats", async () => {
    const ro = setup({ readOnly: true });
    expect((await ro.get("/api/admin/notes/export?format=md")).status).toBe(200);
    expect((await ro.get("/api/admin/notes/export?format=pdf")).status).toBe(400);
  });
});
