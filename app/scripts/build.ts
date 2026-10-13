// Build everything the app runs into dist/:
//   main.js               the main process, with the viewer server bundled in (src/main, ../viewer/server)
//   workers/*.js          the viewer's job workers (Compact database, Merge duplicate files)
//   preload-*.cjs         the preload scripts
//   ui/                   the app's own pages (welcome, import, manage, upgrade)
//   viewer-web/           the viewer's front end (../viewer/web)
//   build-info.json       { macSigned } (see src/main/updater.ts)
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const appDir = path.join(import.meta.dirname, "..");
const viewerDir = path.join(appDir, "..", "viewer");
const dist = path.join(appDir, "dist");

function run(cmd: string, args: string[], cwd: string): void {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (in ${cwd})`);
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const common = { bundle: true, platform: "node" as const, target: "node24", sourcemap: "linked" as const, logLevel: "warning" as const };
// Some bundled packages call require(); give the ES module output one.
const requireShim = { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' };

await build({
  ...common,
  entryPoints: [path.join(appDir, "src", "main", "main.ts")],
  outfile: path.join(dist, "main.js"),
  format: "esm",
  banner: requireShim,
  external: ["electron", "better-sqlite3", "electron-updater"],
});
await build({
  ...common,
  entryPoints: ["compactWorker", "dedupeWorker"].map((n) => path.join(viewerDir, "server", `${n}.ts`)),
  outdir: path.join(dist, "workers"),
  format: "esm",
  banner: requireShim,
  external: ["better-sqlite3"],
});
for (const name of ["viewer", "app"]) {
  await build({
    ...common,
    entryPoints: [path.join(appDir, "src", "preload", `${name}.ts`)],
    outfile: path.join(dist, `preload-${name}.cjs`),
    format: "cjs",
    external: ["electron"],
  });
}

const vite = (dir: string) => path.join(dir, "node_modules", "vite", "bin", "vite.js");
run(process.execPath, [vite(appDir), "build", "--logLevel", "warn"], appDir);
run(process.execPath, [vite(viewerDir), "build", "--logLevel", "warn"], viewerDir);
fs.cpSync(path.join(viewerDir, "dist", "web"), path.join(dist, "viewer-web"), { recursive: true });

fs.writeFileSync(path.join(dist, "build-info.json"), JSON.stringify({ macSigned: process.env.SHOEBOX_MAC_SIGNED === "1" }) + "\n");
console.log("Built app/dist.");
