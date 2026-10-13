// Download a standalone Python for the app to bundle, and prepare the importer next to it.
//
//   node scripts/fetch-python.ts                 # this computer's platform and CPU
//   node scripts/fetch-python.ts darwin-x64 ...  # others (for a cross build)
//
// Puts Python in build/python/<platform>-<arch>/python and the importer in build/importer.
// electron-builder copies both into the app's resources (electron-builder.yml, extraResources).
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// python-build-standalone (https://github.com/astral-sh/python-build-standalone), the build that uv uses.
const RELEASE = "20260924";
const VERSION = "3.14.7";
const TRIPLES: Record<string, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
};
const BASE = `https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE}`;

const appDir = path.join(import.meta.dirname, "..");
const buildDir = path.join(appDir, "build");
const cacheDir = path.join(buildDir, "python", "cache");

// Parts of the standard library the importer never uses (it needs email, sqlite3, zipfile, tarfile, gzip...).
const UNUSED_LIB = ["test", "idlelib", "tkinter", "turtledemo", "ensurepip", "pydoc_data", "venv", "turtle.py", "__phello__"];

async function download(url: string, file: string): Promise<void> {
  if (fs.existsSync(file)) return;
  console.log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".part", Buffer.from(await res.arrayBuffer()));
  fs.renameSync(file + ".part", file);
}

function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function rm(...parts: string[]): void {
  fs.rmSync(path.join(...parts), { recursive: true, force: true });
}

function prune(pythonDir: string, windows: boolean, darwin: boolean): void {
  if (windows) {
    const lib = path.join(pythonDir, "Lib");
    for (const name of UNUSED_LIB) rm(lib, name);
    for (const name of fs.readdirSync(path.join(lib, "site-packages"))) rm(lib, "site-packages", name); // pip
    for (const name of ["tcl", "include", "libs", "Scripts"]) rm(pythonDir, name);
    for (const name of fs.readdirSync(path.join(pythonDir, "DLLs"))) if (/^(_tkinter|tcl|tk)/i.test(name)) rm(pythonDir, "DLLs", name);
    return;
  }
  const lib = path.join(pythonDir, "lib", `python${VERSION.split(".").slice(0, 2).join(".")}`);
  for (const name of UNUSED_LIB) rm(lib, name);
  for (const name of fs.readdirSync(path.join(lib, "site-packages"))) rm(lib, "site-packages", name); // pip
  for (const name of fs.readdirSync(lib)) if (name.startsWith("config-")) rm(lib, name); // static library, for building C extensions
  for (const name of fs.readdirSync(path.join(lib, "lib-dynload"))) if (name.startsWith("_tkinter")) rm(lib, "lib-dynload", name);
  for (const name of fs.readdirSync(path.join(pythonDir, "lib"))) if (/^(libtcl|libtk|tcl|tk|itcl|thread|pkgconfig)/.test(name)) rm(pythonDir, "lib", name);
  for (const name of ["include", "share"]) rm(pythonDir, name);
  // On macOS, bin/python3 is linked statically; the shared library is only for embedding Python elsewhere.
  if (darwin) for (const name of fs.readdirSync(path.join(pythonDir, "lib"))) if (/^libpython.*\.dylib$/.test(name)) rm(pythonDir, "lib", name);
  for (const name of fs.readdirSync(path.join(pythonDir, "bin"))) if (!/^python3(\.\d+)?$/.test(name)) rm(pythonDir, "bin", name);
}

function pythonExe(pythonDir: string, windows: boolean): string {
  return windows ? path.join(pythonDir, "python.exe") : path.join(pythonDir, "bin", "python3");
}

/** Copy the importer package, and compile it with the bundled Python when that Python runs here. */
function prepareImporter(python: string | null): void {
  const dest = path.join(buildDir, "importer");
  rm(dest);
  fs.cpSync(path.join(appDir, "..", "importer", "src", "gmail2sqlite"), path.join(dest, "gmail2sqlite"), {
    recursive: true,
    filter: (src) => !src.includes("__pycache__"),
  });
  if (python) {
    const r = spawnSync(python, ["-I", "-m", "compileall", "-q", dest], { stdio: "inherit" });
    if (r.status !== 0) console.warn("note: could not compile the importer; Python compiles it in memory at each start instead.");
  }
}

function smokeTest(python: string): void {
  const boot = "import sys; sys.path.insert(0, sys.argv.pop(1)); from gmail2sqlite.cli import main; sys.exit(main(sys.argv[1:]))";
  const r = spawnSync(python, ["-I", "-B", "-X", "utf8", "-c", boot, path.join(buildDir, "importer"), "--version"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`The bundled Python doesn't run the importer:\n${r.stdout}${r.stderr}`);
  console.log(`OK: ${r.stdout.trim()} on Python ${VERSION}`);
}

const targets = process.argv.slice(2).length ? process.argv.slice(2) : [`${process.platform}-${process.arch}`];
const sums = new Map<string, string>();
let runnable: string | null = null;

for (const target of targets) {
  const triple = TRIPLES[target];
  if (!triple) throw new Error(`Unknown target ${target}. Use one of: ${Object.keys(TRIPLES).join(", ")}`);
  const file = `cpython-${VERSION}+${RELEASE}-${triple}-install_only_stripped.tar.gz`;
  const archive = path.join(cacheDir, file);
  await download(`${BASE}/${file}`, archive);
  if (!sums.size) {
    const sumsFile = path.join(cacheDir, `SHA256SUMS-${RELEASE}`);
    await download(`${BASE}/SHA256SUMS`, sumsFile);
    for (const line of fs.readFileSync(sumsFile, "utf8").split("\n")) {
      const [hash, name] = line.trim().split(/\s+/);
      if (hash && name) sums.set(name, hash);
    }
  }
  if (sums.get(file) !== sha256(archive)) {
    fs.rmSync(archive);
    throw new Error(`${file}: the SHA-256 doesn't match SHA256SUMS. The download was removed; try again.`);
  }

  const outDir = path.join(buildDir, "python", target);
  rm(outDir);
  fs.mkdirSync(outDir, { recursive: true });
  // On Windows, use Windows' own tar: GNU tar (from Git) reads "C:\..." as a remote host.
  const tar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  const r = spawnSync(tar, ["-xzf", archive, "-C", outDir], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`tar failed for ${file}`);
  const windows = target.startsWith("win32");
  prune(path.join(outDir, "python"), windows, target.startsWith("darwin"));
  console.log(`Python ${VERSION} for ${target} is in ${path.relative(appDir, outDir)}/python`);
  if (target === `${process.platform}-${process.arch}` || (target === "darwin-x64" && process.platform === "darwin")) {
    runnable ??= pythonExe(path.join(outDir, "python"), windows); // macOS runs x64 Python with Rosetta
  }
}

prepareImporter(runnable);
if (runnable) smokeTest(runnable);
