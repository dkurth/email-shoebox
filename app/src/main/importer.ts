// Run the bundled importer (gmail2sqlite) as a child process and read its JSON lines.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

export interface PythonSetup {
  python: string; // the interpreter
  importerDir: string; // the folder that holds the gmail2sqlite package
}

/**
 * Where the interpreter and the importer are.
 * Packaged: <resources>/python and <resources>/importer, both put there by scripts/fetch-python.ts.
 * From source: build/python/<platform>-<arch>/python if it was fetched, else python3 on the PATH, and ../importer/src.
 */
export function findPython(opts: { packaged: boolean; resourcesPath: string; appDir: string }): PythonSetup {
  const exe = process.platform === "win32" ? "python.exe" : path.join("bin", "python3");
  if (opts.packaged) {
    return { python: path.join(opts.resourcesPath, "python", exe), importerDir: path.join(opts.resourcesPath, "importer") };
  }
  const fetched = path.join(opts.appDir, "build", "python", `${process.platform}-${process.arch}`, "python", exe);
  const python = process.env.SHOEBOX_PYTHON ?? (fs.existsSync(fetched) ? fetched : process.platform === "win32" ? "python" : "python3");
  return { python, importerDir: path.join(opts.appDir, "..", "importer", "src") };
}

// -I: ignore PYTHON* variables and the user's site-packages. -B: don't write .pyc files (the app folder is
// read-only and signed). -X utf8: UTF-8 everywhere, also on Windows pipes.
// The importer's folder is passed as the first argument and put on sys.path.
const BOOT = "import sys; sys.path.insert(0, sys.argv.pop(1)); from gmail2sqlite.cli import main; sys.exit(main(sys.argv[1:]))";

export function importerCommand(setup: PythonSetup, args: string[]): { command: string; args: string[] } {
  return { command: setup.python, args: ["-I", "-B", "-X", "utf8", "-c", BOOT, setup.importerDir, ...args] };
}

export interface RunHandlers {
  onJson?: (obj: Record<string, unknown>) => void; // each JSON line on stdout
  onError?: (err: { kind: string; message: string }) => void; // JSON error lines on stderr
  onLog?: (line: string) => void; // everything else, for the log
}

export interface Running {
  child: ChildProcessWithoutNullStreams;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Ask it to stop cleanly (it saves its work); kill it if it hasn't stopped after `graceMs`. */
  cancel(graceMs?: number): void;
  kill(): void;
}

export function runImporter(setup: PythonSetup, args: string[], h: RunHandlers = {}): Running {
  const cmd = importerCommand(setup, args);
  const child = spawn(cmd.command, cmd.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  h.onLog?.(`$ ${[cmd.command, ...args].join(" ")}`);

  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      h.onJson?.(JSON.parse(line));
    } catch {
      h.onLog?.(line);
    }
  });
  readline.createInterface({ input: child.stderr }).on("line", (line) => {
    if (line.startsWith("{")) {
      try {
        const obj = JSON.parse(line);
        if (obj?.type === "error") {
          h.onError?.({ kind: String(obj.kind), message: String(obj.message) });
          h.onLog?.(`error (${obj.kind}): ${obj.message}`);
          return;
        }
      } catch {
        /* not JSON after all */
      }
    }
    h.onLog?.(line);
  });

  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("error", (e) => {
      h.onError?.({ kind: "start", message: `Could not start the importer (${cmd.command}): ${e.message}` });
      resolve({ code: -1, signal: null });
    });
    child.on("close", (code, signal) => resolve({ code, signal }));
  });

  let timer: NodeJS.Timeout | undefined;
  done.then(() => clearTimeout(timer));
  return {
    child,
    done,
    cancel(graceMs = 60_000) {
      if (child.exitCode !== null) return;
      try {
        child.stdin.write("cancel\n");
      } catch {
        /* already closed */
      }
      timer ??= setTimeout(() => child.kill(), graceMs);
    },
    kill() {
      child.kill();
    },
  };
}
