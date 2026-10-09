// `npm run dev -- ARCHIVE_DIR`: API server (restarts on change) + Vite dev server (hot reload).
import { spawn } from "node:child_process";
import path from "node:path";

const repo = path.join(import.meta.dirname, "..");
const archive = process.argv[2] ?? "./gmail-archive";
const API_PORT = "5179";
const WEB_ORIGIN = "http://localhost:5173";

const procs = [
  spawn(
    process.execPath,
    ["--watch-path=server", "server/main.ts", archive, "--port", API_PORT, "--no-open", "--dev-origin", WEB_ORIGIN],
    { cwd: repo, stdio: "inherit" },
  ),
  spawn(process.execPath, [path.join(repo, "node_modules", "vite", "bin", "vite.js"), "--open"], {
    cwd: repo,
    stdio: "inherit",
    env: { ...process.env, API_PORT },
  }),
];
const stop = () => procs.forEach((p) => p.kill());
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
