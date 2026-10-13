import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ArchiveError, openArchive } from "../server/db.ts";
import { ORIGIN, PORT, setup, tempArchive } from "./helpers.ts";

describe("session and archive checks", () => {
  it("reports the owner's address found from Sent mail", async () => {
    const { get } = setup();
    const r = await get("/api/session");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ me: ["me@example.com"], schemaVersion: 3, readOnly: false });
  });

  it("refuses an archive with an unsupported schema version", () => {
    const dir = tempArchive();
    const { db } = openArchive(dir);
    db.prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();
    db.close();
    expect(() => openArchive(dir)).toThrow(/schema version 1.*gmail2sqlite import/);
  });

  it("refuses a folder without mail.db", () => {
    expect(() => openArchive(path.join(tempArchive(), "nope"))).toThrow(ArchiveError);
  });
});

describe("security", () => {
  it("rejects a foreign Host header (DNS rebinding)", async () => {
    const { app } = setup();
    const res = await app.request("/api/session", { headers: { host: "evil.example:5178" } });
    expect(res.status).toBe(403);
  });

  it("rejects writes from another origin or without the custom header", async () => {
    const { app } = setup();
    const base = { host: `127.0.0.1:${PORT}`, "content-type": "application/json" };
    let res = await app.request("/api/anything", { method: "POST", headers: { ...base, origin: "https://evil.example", "x-email-shoebox": "1" }, body: "{}" });
    expect(res.status).toBe(403);
    res = await app.request("/api/anything", { method: "POST", headers: { ...base, origin: ORIGIN }, body: "{}" });
    expect(res.status).toBe(403);
  });

  it("rejects all writes in read-only mode", async () => {
    const { post } = setup({ readOnly: true });
    const r = await post("/api/anything", {});
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/read-only/);
  });

  it("the fixture archive is committed and supported", () => {
    expect(fs.existsSync(path.join(import.meta.dirname, "fixtures", "archive", "mail.db"))).toBe(true);
  });
});
