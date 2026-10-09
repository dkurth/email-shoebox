import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/app.ts";
import { accountAddresses, openArchive, type Archive } from "../server/db.ts";

export const FIXTURE = path.join(import.meta.dirname, "fixtures", "archive");
export const PORT = 5178;
export const ORIGIN = `http://127.0.0.1:${PORT}`;

/** A fresh copy of the committed test archive, so tests can change it freely. */
export function tempArchive(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-viewer-test-"));
  fs.cpSync(FIXTURE, dir, { recursive: true, filter: (src) => !/\.db-(wal|shm)$/.test(src) });
  return dir;
}

export function setup(opts: { readOnly?: boolean } = {}) {
  const dir = tempArchive();
  const archive: Archive = openArchive(dir, opts);
  const app = createApp({ archive, me: accountAddresses(archive), getPort: () => PORT });
  const get = async (url: string) => {
    const res = await app.request(url, { headers: { host: `127.0.0.1:${PORT}` } });
    return { status: res.status, body: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text(), res };
  };
  const post = async (url: string, data: unknown, method = "POST") => {
    const res = await app.request(url, {
      method,
      headers: { host: `127.0.0.1:${PORT}`, origin: ORIGIN, "x-gmail-viewer": "1", "content-type": "application/json" },
      body: JSON.stringify(data),
    });
    return { status: res.status, body: await res.json() };
  };
  return { dir, archive, app, get, post, db: archive.db };
}
