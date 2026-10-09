#!/usr/bin/env node
// `npm start` / `gmail-viewer`: build the web front end if it's missing or stale, then run the server.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { main } from "../server/main.ts";

const repo = path.join(import.meta.dirname, "..");
const built = path.join(repo, "dist", "web", "index.html");

function newestMtime(p: string): number {
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.mtimeMs;
  return Math.max(st.mtimeMs, ...fs.readdirSync(p).map((f) => newestMtime(path.join(p, f))));
}

const sources = [path.join(repo, "web"), path.join(repo, "vite.config.ts"), path.join(repo, "package.json")];
const stale = !fs.existsSync(built) || Math.max(...sources.map(newestMtime)) > fs.statSync(built).mtimeMs;
if (stale) {
  console.log("Building the web front end...");
  const vite = path.join(repo, "node_modules", "vite", "bin", "vite.js");
  const r = spawnSync(process.execPath, [vite, "build", "--logLevel", "warn"], { cwd: repo, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

await main(process.argv.slice(2));
