// Start a viewer server on a fresh copy of the test archive, for one test.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repo = path.join(import.meta.dirname, "..", "..");
let built = false;

export interface Server {
  url: string;
  dir: string;
  stop: () => void;
}

export async function startServer(opts: { readOnly?: boolean } = {}): Promise<Server> {
  if (!built) {
    const r = spawnSync(process.execPath, [path.join(repo, "node_modules/vite/bin/vite.js"), "build", "--logLevel", "error"], { cwd: repo });
    if (r.status !== 0) throw new Error("vite build failed: " + r.stderr);
    built = true;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "email-shoebox-e2e-"));
  fs.cpSync(path.join(repo, "test/fixtures/archive"), dir, { recursive: true, filter: (s) => !/\.db-(wal|shm)$/.test(s) });
  const port = 5200 + Math.floor(Math.random() * 700);
  const args = [path.join(repo, "server/main.ts"), dir, "--no-open", "--port", String(port), ...(opts.readOnly ? ["--read-only"] : [])];
  const child: ChildProcess = spawn(process.execPath, args, { cwd: repo, stdio: ["ignore", "pipe", "inherit"] });
  const url = await new Promise<string>((resolve, reject) => {
    child.stdout!.on("data", (d: Buffer) => {
      const m = /http:\/\/127\.0\.0\.1:\d+\//.exec(d.toString());
      if (m) resolve(m[0]);
    });
    child.on("exit", (code) => reject(new Error(`server exited with ${code}`)));
  });
  return { url, dir, stop: () => child.kill() };
}
