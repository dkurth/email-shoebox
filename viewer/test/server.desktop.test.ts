// What the desktop app relies on: the token cookie, the collection name, schema checks and job state.
import { describe, expect, it } from "vitest";
import { createApp } from "../server/app.ts";
import { accountAddresses, collectionName, openArchive, readSchemaVersion, setCollectionName } from "../server/db.ts";
import { runningJob } from "../server/jobs.ts";
import { ORIGIN, PORT, tempArchive } from "./helpers.ts";

function desktopApp(token = "s3cret") {
  const archive = openArchive(tempArchive());
  const app = createApp({ archive, me: accountAddresses(archive), getPort: () => PORT, token, collectionName: "Personal 2024" });
  return { archive, app };
}

const host = { host: `127.0.0.1:${PORT}` };

describe("desktop token", () => {
  it("rejects reads and writes without the cookie", async () => {
    const { app } = desktopApp();
    expect((await app.request("/api/session", { headers: host })).status).toBe(403);
    expect((await app.request("/", { headers: host })).status).toBe(403);
    const res = await app.request("/api/threads/modify", {
      method: "POST",
      headers: { ...host, origin: ORIGIN, "x-email-shoebox": "1", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("rejects a wrong token", async () => {
    const { app } = desktopApp();
    const res = await app.request("/api/session", { headers: { ...host, cookie: "shoebox_token=wrong" } });
    expect(res.status).toBe(403);
  });

  it("accepts the right token and reports the collection", async () => {
    const { app } = desktopApp();
    const res = await app.request("/api/session", { headers: { ...host, cookie: "other=1; shoebox_token=s3cret" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ desktop: true, collectionName: "Personal 2024", readOnly: false });
  });

  it("the command-line viewer has no token and no collection", async () => {
    const archive = openArchive(tempArchive());
    const app = createApp({ archive, me: [], getPort: () => PORT });
    const res = await app.request("/api/session", { headers: host });
    expect(await res.json()).toMatchObject({ desktop: false, collectionName: null });
  });
});

describe("archive helpers", () => {
  it("reads the schema version without opening the archive for use", () => {
    const dir = tempArchive();
    expect(readSchemaVersion(dir)).toBe(3);
    const { db } = openArchive(dir);
    db.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
    db.close();
    expect(readSchemaVersion(dir)).toBe(2);
    expect(readSchemaVersion(dir + "-missing")).toBeNull();
  });

  it("stores the collection name in the archive", () => {
    const { db } = openArchive(tempArchive());
    expect(collectionName(db)).toBeUndefined();
    setCollectionName(db, "Firebrand");
    expect(collectionName(db)).toBe("Firebrand");
  });

  it("no job is running at the start", () => {
    expect(runningJob()).toBeNull();
  });
});
