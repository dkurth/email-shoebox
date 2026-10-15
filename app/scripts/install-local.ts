// Build the app from this checkout and install it in /Applications (macOS), replacing the installed copy.
//
//   ./update.sh            (from the repo root)   or   npm run update   (in app/)
//   ./update.sh --open     also start it when done
//
// Your collections aren't touched: they are in ~/Library/Application Support/Email Shoebox, not in the app.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const appDir = path.join(import.meta.dirname, "..");
const repo = path.join(appDir, "..");
const APP_NAME = "Email Shoebox";
const installDir = process.env.SHOEBOX_INSTALL_DIR ?? "/Applications"; // another folder: for trying this script
const target = path.join(installDir, `${APP_NAME}.app`);
const built = path.join(appDir, "release", process.arch === "arm64" ? "mac-arm64" : "mac", `${APP_NAME}.app`);

if (process.platform !== "darwin") {
  console.error("This script installs the macOS app. On Windows or Linux, run `npm run dist` and install the file in app/release.");
  process.exit(1);
}

function run(cmd: string, args: string[], cwd = appDir): void {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`\nFailed: ${cmd} ${args.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}

/** Is this copy of the app running? (Not some other copy, such as one started from app/release.) */
function running(app = target): boolean {
  return spawnSync("pgrep", ["-f", `${app}/Contents/MacOS/${APP_NAME}`]).status === 0;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// 1. Packages, if they aren't installed yet.
for (const dir of [path.join(repo, "viewer"), appDir]) {
  if (!fs.existsSync(path.join(dir, "node_modules"))) {
    console.log(`Installing packages in ${path.relative(repo, dir)}/…`);
    run("npm", ["install"], dir);
  }
}

// 2. Build (fetches the bundled Python the first time).
console.log("Building the app…");
run(process.execPath, [path.join("scripts", "dist.ts")]);
if (!fs.existsSync(built)) {
  console.error(`The build didn't make ${built}.`);
  process.exit(1);
}

// 3. Quit the installed app. If an import is running, it asks first.
if (running()) {
  console.log(`Quitting ${APP_NAME}…`);
  spawnSync("osascript", ["-e", `tell application ${JSON.stringify(target)} to quit`], { stdio: "ignore" }); // this copy, by its path
  for (let i = 0; i < 120 && running(); i++) sleep(500);
  if (running()) {
    console.error(`${APP_NAME} is still running. Quit it, then run this again.`);
    process.exit(1);
  }
}

// 4. Replace the app. ditto keeps the code signature intact.
console.log(`Installing ${target}…`);
fs.rmSync(target, { recursive: true, force: true });
run("ditto", [built, target]);

// 5. Remove the build's copy, so Spotlight and Launchpad find only the installed one. Not while it's running.
if (!running(built)) fs.rmSync(built, { recursive: true, force: true });

const version = JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8")).version;
const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
console.log(`\nInstalled ${APP_NAME} ${version} (commit ${commit}) in ${installDir}.`);
if (process.argv.includes("--open")) spawnSync("open", [target]);
