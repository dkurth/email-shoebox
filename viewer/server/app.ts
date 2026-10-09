// The HTTP app: JSON API under /api, and the built web front end for everything else.
import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import type { Archive } from "./db.ts";
import { guard } from "./security.ts";

export interface AppOptions {
  archive: Archive;
  me: string[];
  getPort: () => number;
  staticDir?: string; // the built front end (dist/web); omitted in tests
  extraOrigins?: string[]; // dev server origin, e.g. http://localhost:5173
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

export function createApp(opts: AppOptions): Hono {
  const { archive } = opts;
  const app = new Hono();

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: err.message }, 500);
  });

  app.use("*", guard(opts.getPort, archive.readOnly, opts.extraOrigins ?? []));

  app.get("/api/session", (c) => {
    const version = archive.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").pluck().get();
    return c.json({ me: opts.me, schemaVersion: Number(version), readOnly: archive.readOnly, archiveDir: archive.dir });
  });

  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

  if (opts.staticDir) {
    const root = path.resolve(opts.staticDir);
    app.get("*", (c) => {
      const rel = decodeURIComponent(new URL(c.req.url).pathname);
      let file = path.resolve(root, "." + rel);
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(root, "index.html"); // single-page app: unknown paths get the app
      }
      const type = MIME[path.extname(file)] ?? "application/octet-stream";
      return c.body(fs.readFileSync(file), 200, {
        "Content-Type": type,
        "Cache-Control": file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
      });
    });
  }
  return app;
}
