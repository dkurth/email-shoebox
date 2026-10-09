import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { JobState } from "../shared/types.ts";
import { mergeDuplicates, type DedupeProgress } from "../server/dedupe.ts";
import { setup } from "./helpers.ts";

const sunsets = (ctx: ReturnType<typeof setup>) =>
  (ctx.db.prepare("SELECT id, path FROM attachments WHERE filename = 'sunset.jpg' ORDER BY id").all() as { id: number; path: string }[]).map((r) => ({
    ...r,
    abs: path.join(ctx.dir, r.path),
  }));

describe("Merge duplicate files", () => {
  it("hard-links the copies; every download is still right; deleting one copy leaves the other", async () => {
    const ctx = setup();
    const [a, b] = sunsets(ctx);
    const bytes = fs.readFileSync(a.abs);
    expect(fs.statSync(a.abs).ino).not.toBe(fs.statSync(b.abs).ino);
    const r = mergeDuplicates(ctx.dir);
    expect(r).toMatchObject({ groupsTotal: 2, groupsDone: 2, skipped: [] });
    expect(r.filesLinked).toBe(3); // one sunset.jpg, two copies of the 1×1 PNG
    expect(r.bytesFreed).toBe(242 + 2 * 70);
    expect(fs.statSync(a.abs).ino).toBe(fs.statSync(b.abs).ino);
    expect(fs.statSync(b.abs).nlink).toBe(2);
    for (const s of [a, b]) {
      const got = await ctx.app.request(`/api/attachments/${s.id}/download`, { headers: { host: "127.0.0.1:5178" } });
      expect(Buffer.from(await got.arrayBuffer()).equals(bytes)).toBe(true);
    }
    expect(fs.readdirSync(path.dirname(b.abs)).filter((f) => f.includes(".merge-"))).toEqual([]);

    // A second run changes nothing.
    expect(mergeDuplicates(ctx.dir)).toMatchObject({ filesLinked: 0, bytesFreed: 0, skipped: [] });

    // Deleting one copy removes only that link.
    await ctx.post("/api/attachments/delete", { ids: [b.id], confirmCount: 1, confirmBytes: 242 });
    expect(fs.existsSync(b.abs)).toBe(false);
    expect(fs.readFileSync(a.abs).equals(bytes)).toBe(true);
  });

  it("leaves a file alone when its content doesn't match the database", () => {
    const ctx = setup();
    const [a, b] = sunsets(ctx);
    fs.writeFileSync(a.abs, Buffer.alloc(242, 1)); // same size, different bytes
    const r = mergeDuplicates(ctx.dir);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]).toMatch(/sunset\.jpg: its content does not match the database/);
    expect(fs.statSync(a.abs).ino).not.toBe(fs.statSync(b.abs).ino);
  });

  it("skips a missing copy and keeps going", () => {
    const ctx = setup();
    const [, b] = sunsets(ctx);
    fs.rmSync(b.abs);
    const r = mergeDuplicates(ctx.dir);
    expect(r.skipped.some((s) => s.endsWith("sunset.jpg: missing"))).toBe(true);
    expect(r.filesLinked).toBe(2);
  });

  it("runs from the API in a worker, one at a time, and not in read-only mode", async () => {
    const ctx = setup();
    const start = await ctx.post("/api/admin/dedupe", {});
    expect(start.status).toBe(200);
    expect((start.body as JobState).running).toBe(true);
    let s: JobState = start.body;
    for (let i = 0; i < 100 && s.running; i++) {
      await new Promise((r) => setTimeout(r, 50));
      s = (await ctx.get("/api/admin/dedupe")).body as JobState;
    }
    expect(s.running).toBe(false);
    expect(s.error).toBeNull();
    expect((s.progress as DedupeProgress).filesLinked).toBe(3);
    const ro = setup({ readOnly: true });
    expect((await ro.post("/api/admin/dedupe", {})).status).toBe(403);
  });
});
