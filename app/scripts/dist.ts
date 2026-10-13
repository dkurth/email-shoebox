// Make the installers: fetch Python, build, then run electron-builder.
//
//   node scripts/dist.ts                    # this computer's platform and CPU
//   node scripts/dist.ts --mac --x64 --arm64
//   node scripts/dist.ts --win | --linux
//   node scripts/dist.ts ... --publish      # upload to a draft GitHub release (needs GH_TOKEN)
//
// macOS signing: with a Developer ID certificate (CSC_LINK + CSC_KEY_PASSWORD, or CSC_NAME) the app is signed
// with the hardened runtime, and notarized when APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID are
// set too. Without a certificate, it gets an ad-hoc signature: it runs, but Gatekeeper asks the user to allow it
// once (System Settings > Privacy & Security > Open Anyway), and it can't update itself.
import { spawnSync } from "node:child_process";
import path from "node:path";

const appDir = path.join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);

const FLAGS = { darwin: "--mac", win32: "--win", linux: "--linux" } as const;
type Platform = keyof typeof FLAGS;
const platform: Platform = has("--mac") ? "darwin" : has("--win") ? "win32" : has("--linux") ? "linux" : (process.platform as Platform);
if (!(platform in FLAGS)) throw new Error(`Can't make installers on ${process.platform}.`);
const archs = ["x64", "arm64"].filter((a) => has(`--${a}`));
if (!archs.length) archs.push(process.arch);

function run(cmd: string, cmdArgs: string[], env: NodeJS.ProcessEnv = {}): void {
  const r = spawnSync(cmd, cmdArgs, { cwd: appDir, stdio: "inherit", env: { ...process.env, ...env } });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// CI passes unset secrets as empty strings; electron-builder would read an empty CSC_LINK as a file path.
for (const name of ["CSC_LINK", "CSC_KEY_PASSWORD", "CSC_NAME", "WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]) {
  if (process.env[name] === "") delete process.env[name];
}

const macSigned = platform === "darwin" && !!(process.env.CSC_LINK || process.env.CSC_NAME);
const notarize = macSigned && !!(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID);

run(process.execPath, [path.join("scripts", "fetch-python.ts"), ...archs.map((a) => `${platform}-${a}`)]);
run(process.execPath, [path.join("scripts", "build.ts")], { SHOEBOX_MAC_SIGNED: macSigned ? "1" : "0" });

const builderArgs: string[] = [FLAGS[platform], ...archs.map((a) => `--${a}`)];
builderArgs.push("--publish", has("--publish") ? "always" : "never");
if (platform === "darwin") {
  if (macSigned) builderArgs.push("-c.mac.hardenedRuntime=true", `-c.mac.notarize=${notarize}`);
  else builderArgs.push("-c.mac.identity=-"); // ad-hoc
}
const env: NodeJS.ProcessEnv = macSigned ? {} : { CSC_IDENTITY_AUTO_DISCOVERY: "false" };
// Run electron-builder's own script with Node (on Windows, Node can't start the .cmd wrapper without a shell).
run(process.execPath, [path.join(appDir, "node_modules", "electron-builder", "cli.js"), ...builderArgs], env);
console.log(`Installers are in ${path.join("app", "release")}.`);
