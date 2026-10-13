import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Collection } from "../src/shared/api.ts";
import { ViewerServer } from "../src/main/server.ts";
import { APP_DIR, tempDir } from "./helpers.ts";

const FIXTURE = path.join(APP_DIR, "..", "viewer", "test", "fixtures", "archive");

function collection(id: string, name: string): Collection {
  const dir = path.join(tempDir(), id);
  fs.cpSync(FIXTURE, dir, { recursive: true, filter: (src) => !/\.db-(wal|shm)$/.test(src) });
  return { id, name, path: dir, createdAt: 0, lastOpenedAt: null, incomplete: null };
}

let server: ViewerServer | null = null;
afterEach(() => server?.stop());

describe("viewer server", () => {
  it("serves nothing until a collection is open, then needs the token", async () => {
    server = new ViewerServer({ staticDir: tempDir() });
    const port = await server.start();
    expect(port).toBeGreaterThan(0);
    expect((await fetch(`${server.origin}/api/session`)).status).toBe(503);

    server.open(collection("a", "First"));
    expect((await fetch(`${server.origin}/api/session`)).status).toBe(403);
    const res = await fetch(`${server.origin}/api/session`, { headers: { cookie: `shoebox_token=${server.token}` } });
    expect(await res.json()).toMatchObject({ desktop: true, collectionName: "First" });
  });

  it("switches collections", async () => {
    server = new ViewerServer({ staticDir: tempDir() });
    await server.start();
    const a = collection("a", "First");
    server.open(a);
    server.open(collection("b", "Second"));
    expect(server.currentId).toBe("b");
    const res = await fetch(`${server.origin}/api/session`, { headers: { cookie: `shoebox_token=${server.token}` } });
    expect(await res.json()).toMatchObject({ collectionName: "Second" });
  });

  it("keeps the old collection when the new one can't be opened", async () => {
    server = new ViewerServer({ staticDir: tempDir() });
    await server.start();
    server.open(collection("a", "First"));
    expect(() => server!.open({ ...collection("b", "Broken"), path: tempDir() })).toThrow(/No mail\.db/);
    expect(server.currentId).toBe("a");
  });
});
