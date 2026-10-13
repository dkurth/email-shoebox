// Command line entry: open the archive, start the server on 127.0.0.1, open a browser tab.
import { serve } from "@hono/node-server";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { parseArgs } from "node:util";
import { createApp } from "./app.ts";
import { ArchiveError, accountAddresses, openArchive } from "./db.ts";

const USAGE = `Usage: email-shoebox [ARCHIVE_DIR] [options]

ARCHIVE_DIR   folder made by gmail2sqlite (holds mail.db and attachments/); default ./gmail-archive

Options:
  --port N      port to listen on (default 5178; the next free port is used if taken)
  --no-open     don't open a browser tab
  --read-only   open the archive read-only: no label changes, no deletes
  --me ADDR     your email address, shown as "me" (repeatable; remembered in the archive)
  -h, --help    show this help`;

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
}

export async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: "string", default: "5178" },
      "no-open": { type: "boolean", default: false },
      "read-only": { type: "boolean", default: false },
      me: { type: "string", multiple: true },
      "dev-origin": { type: "string" }, // used by `npm run dev`
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const dir = positionals[0] ?? "./gmail-archive";

  let archive;
  try {
    archive = openArchive(dir, { readOnly: values["read-only"] });
  } catch (e) {
    if (e instanceof ArchiveError) {
      console.error(`error: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }

  let port = Number(values.port);
  const first = port;
  while (!(await portFree(port))) {
    if (port - first > 20) {
      console.error(`error: no free port between ${first} and ${port}`);
      process.exit(2);
    }
    port++;
  }

  const app = createApp({
    archive,
    me: accountAddresses(archive, values.me),
    getPort: () => port,
    staticDir: path.join(import.meta.dirname, "..", "dist", "web"),
    extraOrigins: values["dev-origin"] ? [values["dev-origin"]] : [],
  });
  serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`Email Shoebox: ${url}  (archive: ${archive.dir}${archive.readOnly ? ", read-only" : ""})`);
    console.log("Press Ctrl-C to stop.");
    if (!values["no-open"]) openBrowser(url);
  });

  const stop = () => {
    archive.db.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
