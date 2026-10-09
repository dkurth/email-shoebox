import { describe, expect, it } from "vitest";
import { defaultColor, labelColor } from "../shared/labelColors.ts";
import { removeAction } from "../shared/labels.ts";
import type { ModifyResult, Sidebar, ThreadList } from "../shared/types.ts";
import { setup } from "./helpers.ts";

type Ctx = ReturnType<typeof setup>;

const threadOf = (ctx: Ctx, subject: string) =>
  ctx.db.prepare("SELECT thread_id FROM messages WHERE subject = ? LIMIT 1").pluck().get(subject) as string;

/** subject -> sorted label names, for every message in the thread. */
const labelsOf = (ctx: Ctx, threadId: string) =>
  (ctx.db
    .prepare(
      `SELECT m.id, group_concat(l.name, ',') AS names FROM messages m
       LEFT JOIN message_labels ml ON ml.message_id = m.id LEFT JOIN labels l ON l.id = ml.label_id
       WHERE m.thread_id = ? GROUP BY m.id ORDER BY m.id`,
    )
    .all(threadId) as { names: string | null }[]).map((r) => (r.names ?? "").split(",").filter(Boolean).sort());

const subjects = async (ctx: Ctx, view: string) => ((await ctx.get(`/api/threads?view=${encodeURIComponent(view)}`)).body as ThreadList).threads.map((t) => t.subject);

describe("archive, trash and undo", () => {
  it("archives from the Inbox: Inbox -> Archived, only on messages that had Inbox", async () => {
    const ctx = setup();
    const id = threadOf(ctx, "Trip planning");
    const before = labelsOf(ctx, id);
    const r = await ctx.post("/api/threads/modify", { view: "inbox", threadIds: [id], ...removeAction("inbox") });
    expect(r.status).toBe(200);
    const after = labelsOf(ctx, id);
    expect(after[0]).toEqual(["Archived", "Category Personal", "Opened", "Travel/2024"]);
    expect(after[1]).toEqual(before[1]); // the Sent message had no Inbox label
    expect(after[2]).toEqual(["Archived", "Category Personal", "Important", "Travel/2024", "Unread"]);
    expect(await subjects(ctx, "inbox")).not.toContain("Trip planning");
    expect(ctx.db.prepare("SELECT count(*) FROM messages WHERE thread_id = ? AND labels_edited_at IS NOT NULL").pluck().get(id)).toBe(2);

    const u = await ctx.post("/api/undo", { changes: (r.body as ModifyResult).changes });
    expect(u.body).toEqual({ undone: 2 });
    expect(labelsOf(ctx, id)).toEqual(before);
    expect(await subjects(ctx, "inbox")).toContain("Trip planning");
  });

  it("trashes only the messages visible in the view, and keeps their other labels", async () => {
    const ctx = setup();
    const id = threadOf(ctx, "Mixed thread");
    const r = await ctx.post("/api/threads/modify", { view: "inbox", threadIds: [id], add: ["Trash"], remove: [] });
    expect((r.body as ModifyResult).changes).toHaveLength(1); // the second message was already in Trash
    expect(labelsOf(ctx, id)).toEqual([["Inbox", "Opened", "Trash"], ["Opened", "Trash"]]);
    expect(await subjects(ctx, "inbox")).not.toContain("Mixed thread");
    expect(await subjects(ctx, "trash")).toContain("Mixed thread");
  });

  it("refreshes the threads table", async () => {
    const ctx = setup();
    const id = threadOf(ctx, "Pancake recipe");
    await ctx.post("/api/threads/modify", { view: "starred", threadIds: [id], add: ["Family"], remove: [] });
    const json = ctx.db.prepare("SELECT labels_json FROM threads WHERE thread_id = ?").pluck().get(id) as string;
    expect(JSON.parse(json)).toContain("Family");
  });
});

describe("y in each view (Gmail's 'remove from this view')", () => {
  const cases: [string, string, string[]][] = [
    ["label:Work", "Quarterly report", ["Archived", "Opened"]],
    ["starred", "Pancake recipe", ["Archived", "Opened"]],
    ["trash", "Old coupon", ["Category Promotions", "Inbox", "Opened"]],
    ["spam", "You won!!!", ["Inbox", "Unread"]],
    ["label:Category Promotions", "Big sale", ["Inbox", "Opened"]],
  ];
  for (const [view, subject, expected] of cases) {
    it(`${view}: ${removeAction(view)!.button}`, async () => {
      const ctx = setup();
      const id = threadOf(ctx, subject);
      const a = removeAction(view)!;
      await ctx.post("/api/threads/modify", { view, threadIds: [id], add: a.add, remove: a.remove });
      expect(labelsOf(ctx, id)[0]).toEqual(expected);
      expect(await subjects(ctx, view)).not.toContain(subject);
    });
  }
});

describe("read, unread and star", () => {
  it("marks read: Unread -> Opened, and the Inbox count drops", async () => {
    const ctx = setup();
    const id = threadOf(ctx, "Welcome to the archive");
    await ctx.post("/api/threads/modify", { view: "inbox", threadIds: [id], add: [], remove: ["Unread"] });
    expect(labelsOf(ctx, id)[0]).toEqual(["Category Personal", "Important", "Inbox", "Opened"]);
    expect(ctx.db.prepare("SELECT is_unread FROM messages WHERE thread_id = ?").pluck().get(id)).toBe(0);
    const s = (await ctx.get("/api/sidebar")).body as Sidebar;
    expect(s.folders.find((f) => f.view === "inbox")!.count).toBe(1);
  });

  it("marks unread on the newest message only", async () => {
    const ctx = setup();
    const id = threadOf(ctx, "Quarterly report");
    await ctx.post("/api/threads/modify", { view: "all", threadIds: [id], add: ["Unread"], remove: [], target: "newest" });
    expect(labelsOf(ctx, id).map((ls) => ls.includes("Unread"))).toEqual([false, true]);
  });

  it("stars the newest message and unstars all", async () => {
    const ctx = setup();
    const id = threadOf(ctx, "Trip planning");
    await ctx.post("/api/threads/star", { view: "inbox", threadIds: [id], starred: true });
    expect(labelsOf(ctx, id).map((ls) => ls.includes("Starred"))).toEqual([false, false, true]);
    expect(await subjects(ctx, "starred")).toContain("Trip planning");
    await ctx.post("/api/threads/star", { view: "starred", threadIds: [id], starred: false });
    expect(labelsOf(ctx, id).some((ls) => ls.includes("Starred"))).toBe(false);
  });
});

describe("labels", () => {
  it("creates, applies and deletes a label", async () => {
    const ctx = setup();
    const c = await ctx.post("/api/labels", { name: " Receipts/2024/ " });
    expect(c.body).toMatchObject({ name: "Receipts/2024" });
    const id = threadOf(ctx, "Pancake recipe");
    await ctx.post("/api/threads/modify", { view: "starred", threadIds: [id], add: ["Receipts/2024"], remove: [] });
    expect(await subjects(ctx, "label:Receipts/2024")).toEqual(["Pancake recipe"]);
    const d = await ctx.post(`/api/labels/${(c.body as { id: number }).id}`, {}, "DELETE");
    expect(d.body).toEqual({ messages: 1 });
    expect(labelsOf(ctx, id)[0]).toEqual(["Archived", "Opened", "Starred"]);
  });

  it("refuses reserved names and system label deletion", async () => {
    const ctx = setup();
    expect((await ctx.post("/api/labels", { name: "Inbox" })).status).toBe(400);
    expect((await ctx.post("/api/labels", { name: "Category Fun" })).status).toBe(400);
    const inbox = ctx.db.prepare("SELECT id FROM labels WHERE name = 'Inbox'").pluck().get();
    expect((await ctx.post(`/api/labels/${inbox}`, {}, "DELETE")).status).toBe(400);
  });

  it("applies to every thread in a view with all: true", async () => {
    const ctx = setup();
    const r = await ctx.post("/api/threads/modify", { view: "label:Newsletters", all: true, add: [], remove: ["Newsletters"] });
    expect(r.body).toMatchObject({ threads: 55 });
    expect((r.body as ModifyResult).changes).toHaveLength(55);
    expect(await subjects(ctx, "label:Newsletters")).toEqual([]);
  });

  it("rejects bad input", async () => {
    const ctx = setup();
    expect((await ctx.post("/api/threads/modify", { view: "inbox", threadIds: "x", add: [], remove: [] })).status).toBe(400);
    expect((await ctx.post("/api/threads/modify", { view: "nope", threadIds: [], add: [], remove: [] })).status).toBe(400);
    expect((await ctx.post("/api/threads/modify", { view: "inbox", threadIds: [], add: [""], remove: [] })).status).toBe(400);
    expect((await ctx.post("/api/undo", { changes: [{ messageId: "1" }] })).status).toBe(400);
  });
});

describe("label colors", () => {
  const idOf = (ctx: Ctx, name: string) => ctx.db.prepare("SELECT id FROM labels WHERE name = ?").pluck().get(name) as number;
  const stored = (ctx: Ctx) => JSON.parse((ctx.db.prepare("SELECT value FROM meta WHERE key = 'viewer_label_colors'").pluck().get() as string) ?? "{}");
  const chosen = async (ctx: Ctx) => ((await ctx.get("/api/sidebar")).body as Sidebar).labelColors;

  it("picks a stable default, never gray, and children follow their parent", () => {
    expect(defaultColor("Travel")).toBe(defaultColor("Travel"));
    const names = Array.from({ length: 200 }, (_, i) => `label ${i}`);
    expect(names.map(defaultColor)).not.toContain("gray");
    expect(new Set(names.map(defaultColor)).size).toBe(11);
    expect(labelColor("Travel/2024", {})).toBe(defaultColor("Travel"));
    expect(labelColor("Travel/2024", { Travel: "pink" })).toBe("pink");
    expect(labelColor("Travel/2024", { Travel: "pink", "Travel/2024": "teal" })).toBe("teal");
    expect(labelColor("Work", { Work: "not-a-color" })).toBe(defaultColor("Work"));
  });

  it("sets, resets, and forgets the color when the label is deleted", async () => {
    const ctx = setup();
    expect(await chosen(ctx)).toEqual({});
    const id = idOf(ctx, "Travel/2024");
    expect((await ctx.post(`/api/labels/${id}/color`, { color: "green" })).body).toEqual({ name: "Travel/2024", color: "green" });
    await ctx.post(`/api/labels/${idOf(ctx, "Work")}/color`, { color: "red" });
    expect(await chosen(ctx)).toEqual({ "Travel/2024": "green", Work: "red" });
    await ctx.post(`/api/labels/${idOf(ctx, "Work")}/color`, { color: null });
    expect(stored(ctx)).toEqual({ "Travel/2024": "green" });
    await ctx.post(`/api/labels/${id}`, {}, "DELETE");
    expect(stored(ctx)).toEqual({});
  });

  it("refuses unknown colors, system labels, categories and unknown labels", async () => {
    const ctx = setup();
    expect((await ctx.post(`/api/labels/${idOf(ctx, "Work")}/color`, { color: "chartreuse" })).status).toBe(400);
    expect((await ctx.post(`/api/labels/${idOf(ctx, "Inbox")}/color`, { color: "red" })).status).toBe(400);
    expect((await ctx.post(`/api/labels/${idOf(ctx, "Category Promotions")}/color`, { color: "red" })).status).toBe(400);
    expect((await ctx.post("/api/labels/99999/color", { color: "red" })).status).toBe(400);
    expect(await chosen(ctx)).toEqual({});
  });

  it("is refused in read-only mode", async () => {
    const ctx = setup({ readOnly: true });
    expect((await ctx.post(`/api/labels/${idOf(ctx, "Work")}/color`, { color: "red" })).status).toBe(403);
  });
});
