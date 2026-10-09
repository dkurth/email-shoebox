import { beforeAll, describe, expect, it } from "vitest";
import type { ThreadDetail, ThreadList } from "../shared/types.ts";
import { OPERATORS } from "../shared/search.ts";
import { hitsSql, parseAgo, parseDate, parseSize, type SearchResult } from "../server/search.ts";
import { setup } from "./helpers.ts";

beforeAll(() => {
  process.env.TZ = "America/Los_Angeles"; // dates are local midnight; test a zone that isn't UTC
});

const ctx = setup();
const search = async (q: string, page = 1) => (await ctx.get(`/api/search?q=${encodeURIComponent(q)}&page=${page}`)).body as SearchResult;
const subjects = async (q: string) => (await search(q)).threads.map((t) => t.subject).sort();

describe("search operators", () => {
  const cases: [string, string[]][] = [
    ["invoice", ["Question about the invoice"]],
    ["INVOICE", ["Question about the invoice"]],
    ["koln", ["Grüße aus Köln ☕"]], // accents don't matter
    ['"count me in"', ["Trip planning"]],
    ['"me count"', []],
    ["quarter*", ["Quarterly report"]],
    ["from:alice", ["Mixed thread", "Quarterly report", "Trip planning", "Welcome to the archive"]],
    ["from:alice@example.com", ["Mixed thread", "Quarterly report", "Trip planning", "Welcome to the archive"]],
    ["from:Adams", ["Mixed thread", "Quarterly report", "Trip planning", "Welcome to the archive"]],
    ["from:@hikers.example", ["Saturday hike", "Trail report"]],
    ["from:me", ["Draft idea", "Quarterly report", "Question about the invoice", "Trip planning"]],
    ["to:alice", ["Quarterly report", "Trip planning"]], // includes Cc
    ["cc:alice", ["Trip planning"]],
    ["bcc:alice", []],
    ["subject:pancake", ["Pancake recipe"]],
    ["subject:quarter*", ["Quarterly report"]],
    ["subject:(trip planning)", ["Trip planning"]],
    ["label:travel-2024", ["Trip planning"]],
    ["label:TRAVEL/2024", ["Trip planning"]],
    ["label:work-projects", ["Project kickoff"]],
    ["in:starred", ["Pancake recipe"]],
    ["in:chats", ["Chat with Dana"]],
    ["in:family", ["Grüße aus Köln ☕"]],
    ["is:starred", ["Pancake recipe"]],
    ["is:unread", ["Trail report", "Trip planning", "Welcome to the archive"]],
    ["is:important", ["Trip planning", "Welcome to the archive"]],
    ["has:attachment", ["Fwd: Holiday media", "Holiday media", "Quarterly report", "Trip planning"]],
    ["filename:pdf", ["Holiday media", "Trip planning"]],
    ["filename:notes.txt", ["Quarterly report"]],
    ["list:announce.hikers.example", ["Saturday hike", "Trail report"]],
    ["list:announce@hikers.example", ["Saturday hike", "Trail report"]],
    ["list:hike", ["Saturday hike", "Trail report"]],
    ["list:nothing.example", []],
    ["larger:2K", ["Holiday media"]],
    ["category:personal", ["Trip planning", "Welcome to the archive"]],
    ["pancake OR lisbon", ["Pancake recipe", "Trip planning"]],
    ["{pancake lisbon}", ["Pancake recipe", "Trip planning"]],
    ["category:promotions -weekly", ["Big sale"]],
    ["from:alice -in:inbox", ["Quarterly report"]], // per message: Alice's Trip planning message is in the Inbox
    ["has:userlabels from:alice", ["Quarterly report", "Trip planning"]],
    ["has:nouserlabels from:alice", ["Mixed thread", "Welcome to the archive"]],
    ["in:trash coupon", ["Old coupon"]],
    ["in:spam", ["You won!!!"]],
    ["in:anywhere claim", ["You won!!!"]],
    ["foo:bar", []],
    ["is:nonsense", []], // an unknown value is searched as text
  ];
  it.each(cases)("%s", async (q, expected) => {
    expect(await subjects(q)).toEqual(expected);
  });

  it("leaves out Trash and Spam, and says when they had matches", async () => {
    const r = await search("coupon");
    expect(r.total).toBe(0);
    expect(r.hiddenInTrashOrSpam).toBe(1);
    expect((await search("trashed")).hiddenInTrashOrSpam).toBe(1); // the trashed message of "Mixed thread"
    expect((await search("pancake")).hiddenInTrashOrSpam).toBe(0); // not counted when something matched
  });

  it("counts and pages threads, newest first", async () => {
    const r = await search("category:promotions");
    expect(r.total).toBe(56);
    expect(r.threads).toHaveLength(50);
    expect(r.threads[0].subject).toBe("Big sale");
    expect((await search("category:promotions", 2)).threads).toHaveLength(6);
    expect((await search("category:promotions", 9))).toMatchObject({ total: 56, threads: [] });
  });

  it("shows the newest matching message's snippet and date", async () => {
    const r = await search("lisbon");
    expect(r.threads[0].snippet).toBe("Lisbon?");
    const all = (await ctx.get("/api/threads?view=all")).body as ThreadList;
    const trip = all.threads.find((t) => t.subject === "Trip planning")!;
    expect(r.threads[0].date).toBeLessThan(trip.date!);
  });

  it("returns the words to highlight", async () => {
    expect((await search('dinner "tax return" -movie invoic*')).highlight).toEqual([
      { text: "dinner", prefix: false },
      { text: "tax return", prefix: false },
      { text: "invoic", prefix: true },
    ]);
  });

  it("searches notes: plain words match notes too, note: matches only notes", async () => {
    const c = setup();
    const t = c.db.prepare("SELECT thread_id FROM messages WHERE subject = 'Pancake recipe'").pluck().get() as string;
    await c.post(`/api/threads/${t}/note`, { body: "ask grandma about the syrup", expectedUpdatedAt: null }, "PUT");
    const s = async (q: string) => ((await c.get(`/api/search?q=${encodeURIComponent(q)}`)).body as SearchResult).threads.map((x) => x.subject);
    expect(await s("grandma")).toEqual(["Pancake recipe"]);
    expect(await s("grandma flour")).toEqual(["Pancake recipe"]); // one word in the note, one in the message
    expect(await s('note:"about the syrup"')).toEqual(["Pancake recipe"]);
    expect(await s("note:flour")).toEqual([]); // only in the message
    expect(await s("note:gran*")).toEqual(["Pancake recipe"]);
    expect(await s("has:note")).toEqual(["Pancake recipe"]);
    expect(await s("-has:note pancake")).toEqual([]);
  });

  it("finds a Message-ID with or without <>", async () => {
    const id = ctx.db.prepare("SELECT message_id FROM messages WHERE subject = 'Pancake recipe'").pluck().get() as string;
    expect(await subjects(`rfc822msgid:${id}`)).toEqual(["Pancake recipe"]);
    expect(await subjects(`rfc822msgid:${id.slice(1, -1)}`)).toEqual(["Pancake recipe"]);
  });

  it("dates are midnight in the computer's time zone", async () => {
    const first = ctx.db.prepare("SELECT min(received_utc) FROM messages").pluck().get() as number;
    const d = new Date(first * 1000);
    const day = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    const nextDay = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
    const before = await search(`before:${nextDay}`);
    const after = await search(`after:${nextDay}`);
    const total = ((await ctx.get("/api/threads?view=all")).body as ThreadList).total;
    expect(before.total).toBeGreaterThan(0);
    expect(before.total + after.total).toBeGreaterThanOrEqual(total);
    expect((await search(`after:${day}`)).total).toBe(total);
    expect((await search("older_than:1d")).total).toBe(total); // the test mail is from 2024
    expect((await search("newer_than:1d")).total).toBe(0);
  });
});

describe("search safety", () => {
  it.each(["NEAR(a b)", "^foo", "fo*o", "*", '"', 'a"b', "subject:", '"subject:report"', "a:b:c", "(((", "-", "OR", "x' OR '1'='1", "%", "_", "\\"])(
    "%s runs without an error",
    async (q) => {
      const r = await ctx.get(`/api/search?q=${encodeURIComponent(q)}`);
      expect(r.status).toBe(200);
    },
  );

  it("% and _ in a partial match are literal", async () => {
    expect(await subjects("from:%")).toEqual([]);
    expect(await subjects("filename:_")).toEqual([]);
  });
});

describe("search speed rule", () => {
  // Every operator reads indexes or narrow tables, never the wide message rows in a full scan.
  const queries = [
    "word", '"two words"', "pre*", "-word", ...OPERATORS.map((o) => `${o}:${o === "after" || o === "before" || o === "newer" || o === "older" ? "2024/01/02" : o.endsWith("_than") ? "3d" : ["larger", "smaller", "size"].includes(o) ? "1M" : "x"}`),
    "is:read", "has:attachment", "has:nouserlabels", "in:anywhere", "from:me", "list:a.b",
  ];
  it.each(queries)("%s", (q) => {
    const h = hitsSql(q, { db: ctx.db, me: ["me@example.com"] });
    const plan = (ctx.db.prepare(`EXPLAIN QUERY PLAN ${h.sql}`).all(...h.params) as { detail: string }[]).map((r) => r.detail);
    const fullScans = plan.filter((d) => /^SCAN (messages|m)\b/.test(d) && !/COVERING INDEX/.test(d));
    expect(fullScans, plan.join("\n")).toEqual([]);
  });
});

describe("search helpers", () => {
  it("parses dates, ages and sizes", () => {
    expect(parseDate("2024/03/01")).toBe(new Date(2024, 2, 1).getTime() / 1000);
    expect(parseDate("2024-3-1")).toBe(new Date(2024, 2, 1).getTime() / 1000);
    expect(parseDate("3/1/2024")).toBe(new Date(2024, 2, 1).getTime() / 1000);
    expect(parseDate("1700000000")).toBe(1700000000);
    expect(parseDate("2024/13/01")).toBeNull();
    expect(parseDate("soon")).toBeNull();
    const now = new Date(2026, 9, 9, 12);
    expect(parseAgo("3d", now)).toBe(new Date(2026, 9, 6, 12).getTime() / 1000);
    expect(parseAgo("2m", now)).toBe(new Date(2026, 7, 9, 12).getTime() / 1000);
    expect(parseAgo("1y", now)).toBe(new Date(2025, 9, 9, 12).getTime() / 1000);
    expect(parseAgo("1w", now)).toBeNull();
    expect(parseSize("10M")).toBe(10 * 1024 * 1024);
    expect(parseSize("500k")).toBe(500 * 1024);
    expect(parseSize("2000")).toBe(2000);
    expect(parseSize("1.5MB")).toBe(1.5 * 1024 * 1024);
    expect(parseSize("big")).toBeNull();
  });
});

describe("actions on search results", () => {
  it("opens a thread from a search in the search's context", async () => {
    const c = setup();
    const coupon = c.db.prepare("SELECT thread_id FROM messages WHERE subject = 'Old coupon'").pluck().get() as string;
    const view = encodeURIComponent("search:in:trash coupon");
    const t = (await c.get(`/api/threads/${coupon}?view=${view}`)).body as ThreadDetail;
    expect(t.messages[0].inContext).toBe(true);
    const plain = (await c.get(`/api/threads/${coupon}?view=${encodeURIComponent("search:coupon")}`)).body as ThreadDetail;
    expect(plain.messages[0].inContext).toBe(false);
  });

  it("select all acts on every matching thread", async () => {
    const c = setup();
    const r = await c.post("/api/threads/modify", { view: "search:category:promotions", all: true, add: ["Work"], remove: [] });
    expect(r.body.threads).toBe(56);
    const mine = await c.post("/api/threads/modify", { view: "search:from:me", all: true, add: ["Work"], remove: [] });
    expect(mine.body.threads).toBe(4);
  });
});
