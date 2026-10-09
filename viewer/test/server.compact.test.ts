import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CompactProgress, JobState } from "../shared/types.ts";
import { setup } from "./helpers.ts";

async function waitFor(ctx: ReturnType<typeof setup>, url: string): Promise<JobState> {
  let s = (await ctx.get(url)).body as JobState;
  for (let i = 0; i < 200 && s.running; i++) {
    await new Promise((r) => setTimeout(r, 50));
    s = (await ctx.get(url)).body as JobState;
  }
  return s;
}

describe("Compact database", () => {
  it("makes the file smaller, and every row is still readable", async () => {
    const ctx = setup();
    // Make free pages inside the file: fill a table, then drop it.
    ctx.db.exec("CREATE TABLE junk(x); WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20) INSERT INTO junk SELECT randomblob(100000) FROM n; DROP TABLE junk;");
    ctx.db.pragma("wal_checkpoint(TRUNCATE)");
    const file = path.join(ctx.dir, "mail.db");
    const before = fs.statSync(file).size;
    expect((ctx.db.pragma("freelist_count", { simple: true }) as number)).toBeGreaterThan(0);
    const start = await ctx.post("/api/admin/compact", {});
    expect(start.status).toBe(200);
    expect((await ctx.post("/api/admin/compact", {})).status).toBe(409); // one at a time
    const s = await waitFor(ctx, "/api/admin/compact");
    expect(s.error).toBeNull();
    const p = s.progress as CompactProgress;
    expect(p.after).toBeLessThan(p.before);
    expect(fs.statSync(file).size).toBeLessThan(before);
    expect(ctx.db.prepare("SELECT count(*) FROM messages").pluck().get()).toBe(77);
    expect(ctx.db.prepare("PRAGMA quick_check").pluck().get()).toBe("ok");
  });

  it("is refused in read-only mode", async () => {
    const ro = setup({ readOnly: true });
    expect((await ro.post("/api/admin/compact", {})).status).toBe(403);
  });
});
