// The HTTP app: JSON API under /api, and the built web front end for everything else.
import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import { viewLabel, type View } from "../shared/labels.ts";
import { contentDisposition, serveAttachment } from "./attachments.ts";
import type { Archive } from "./db.ts";
import { InputError, createLabel, deleteLabel, modifyThreads, setLabelColor, setStar, undoChanges } from "./mutations.ts";
import { guard } from "./security.ts";
import { ConflictError, deleteForever, trashSummary } from "./trash.ts";
import { listThreads, original, sidebar, threadDetail } from "./views.ts";
import { searchThreads } from "./search.ts";
import { isSearchView, searchQuery } from "../shared/labels.ts";
import { NoteConflict, NotFound, saveNote } from "./notes.ts";
import { imports, labels as adminLabels, lists, overview, people, person } from "./admin.ts";
import { collectNotes, exportFilename, toCsv, toMarkdown } from "./exportNotes.ts";

export class BadRequest extends Error {}

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
    if (err instanceof BadRequest || err instanceof InputError || err instanceof SyntaxError || err.message.startsWith("unknown view")) {
      return c.json({ error: err.message }, 400);
    }
    if (err instanceof ConflictError) return c.json({ error: err.message }, 409);
    if (err instanceof NoteConflict) return c.json({ error: err.message, note: err.note }, 409);
    if (err instanceof NotFound) return c.json({ error: err.message }, 404);
    console.error(err);
    return c.json({ error: err.message }, 500);
  });

  app.use("*", guard(opts.getPort, archive.readOnly, opts.extraOrigins ?? []));

  app.get("/api/session", (c) => {
    const version = archive.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").pluck().get();
    return c.json({ me: opts.me, schemaVersion: Number(version), readOnly: archive.readOnly, archiveDir: archive.dir });
  });

  const db = archive.db;
  const viewParam = (raw: string | undefined): View => {
    const view = raw ?? "inbox";
    viewLabel(view); // throws on unknown views
    return view;
  };
  const intParam = (raw: string | undefined, fallback?: number): number => {
    const n = raw === undefined && fallback !== undefined ? fallback : Number(raw);
    if (!Number.isInteger(n) || n < 1) throw new BadRequest(`bad number: ${raw}`);
    return n;
  };

  app.get("/api/sidebar", (c) => c.json(sidebar(db)));

  app.get("/api/threads", (c) => {
    const view = viewParam(c.req.query("view"));
    const page = intParam(c.req.query("page"), 1);
    if (isSearchView(view)) return c.json(searchThreads(db, searchQuery(view), page, opts.me));
    return c.json(listThreads(db, view, page, opts.me));
  });

  app.get("/api/search", (c) => c.json(searchThreads(db, c.req.query("q") ?? "", intParam(c.req.query("page"), 1), opts.me)));

  app.get("/api/threads/:threadId", (c) => {
    const t = threadDetail(db, c.req.param("threadId"), viewParam(c.req.query("view")));
    return t ? c.json(t) : c.json({ error: "No such thread" }, 404);
  });

  app.get("/api/messages/:id/original", (c) => {
    const text = original(db, intParam(c.req.param("id")));
    return text === null ? c.json({ error: "No such message" }, 404) : c.text(text, 200, { "X-Content-Type-Options": "nosniff" });
  });

  app.get("/api/admin/overview", (c) => c.json(overview(archive, opts.me)));
  app.get("/api/admin/labels", (c) => c.json(adminLabels(db)));
  app.get("/api/admin/imports", (c) => c.json(imports(db)));
  const flag = (v: string | undefined) => v === "1" || v === "true";
  app.get("/api/admin/people", (c) => {
    const dir = c.req.query("dir");
    if (dir !== "sent" && dir !== "received") throw new BadRequest("dir must be sent or received");
    const sort = c.req.query("sort") as "count" | "addr" | "name" | "last" | "attachmentBytes" | undefined;
    if (sort && !["count", "addr", "name", "last", "attachmentBytes"].includes(sort)) throw new BadRequest(`bad sort: ${sort}`);
    return c.json(
      people(db, opts.me, {
        dir,
        q: c.req.query("q"),
        sort,
        desc: c.req.query("desc") !== "0",
        page: intParam(c.req.query("page"), 1),
        chats: flag(c.req.query("chats")),
        byDomain: flag(c.req.query("domain")),
      }),
    );
  });
  app.get("/api/admin/lists", (c) => {
    const sort = c.req.query("sort") as "messages" | "unread" | "first" | "last" | "bytes" | "name" | undefined;
    if (sort && !["messages", "unread", "first", "last", "bytes", "name"].includes(sort)) throw new BadRequest(`bad sort: ${sort}`);
    return c.json(lists(db, { q: c.req.query("q"), sort, desc: c.req.query("desc") !== "0", page: intParam(c.req.query("page"), 1) }));
  });
  app.get("/api/admin/person", (c) => {
    const addr = c.req.query("addr");
    if (!addr) throw new BadRequest("addr is required");
    return c.json(person(db, addr));
  });

  app.get("/api/admin/notes/export", (c) => {
    const format = c.req.query("format") ?? "md";
    if (format !== "md" && format !== "csv") throw new BadRequest("format must be md or csv");
    const notes = collectNotes(db, opts.me);
    const text = format === "md" ? toMarkdown(notes) : toCsv(notes);
    return c.body(text, 200, {
      "Content-Type": format === "md" ? "text/markdown; charset=utf-8" : "text/csv; charset=utf-8",
      "Content-Disposition": contentDisposition("attachment", exportFilename(format)),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    });
  });

  app.get("/api/attachments/:id/download", (c) => serveAttachment(c, archive, intParam(c.req.param("id")), "download"));
  app.get("/api/attachments/:id/inline", (c) => serveAttachment(c, archive, intParam(c.req.param("id")), "inline"));

  // ---- writes (the guard already refused them in read-only mode)
  app.post("/api/threads/modify", async (c) => {
    const body = await c.req.json();
    return c.json(modifyThreads(db, { ...body, view: viewParam(body.view), me: opts.me }));
  });
  app.post("/api/threads/star", async (c) => {
    const body = await c.req.json();
    if (!Array.isArray(body.threadIds)) throw new BadRequest("threadIds must be a list");
    return c.json(setStar(db, viewParam(body.view), body.threadIds, !!body.starred));
  });
  app.post("/api/undo", async (c) => {
    const body = await c.req.json();
    return c.json({ undone: undoChanges(db, body.changes) });
  });
  app.post("/api/trash/summary", async (c) => {
    const body = await c.req.json();
    return c.json(trashSummary(db, Array.isArray(body.threadIds) ? body.threadIds : undefined));
  });
  app.post("/api/trash/empty", async (c) => {
    const body = await c.req.json();
    return c.json(deleteForever(archive, { confirmCount: body.confirmCount }));
  });
  app.post("/api/threads/delete-forever", async (c) => {
    const body = await c.req.json();
    if (!Array.isArray(body.threadIds)) throw new BadRequest("threadIds must be a list");
    return c.json(deleteForever(archive, { threadIds: body.threadIds, confirmCount: body.confirmCount }));
  });
  app.put("/api/threads/:threadId/note", async (c) => {
    const body = await c.req.json();
    return c.json(saveNote(db, c.req.param("threadId"), body.body, body.expectedUpdatedAt ?? null, body.force === true));
  });
  app.post("/api/labels", async (c) => c.json(createLabel(db, (await c.req.json()).name)));
  app.delete("/api/labels/:id", (c) => c.json(deleteLabel(db, intParam(c.req.param("id")))));
  app.post("/api/labels/:id/color", async (c) => c.json(setLabelColor(db, intParam(c.req.param("id")), (await c.req.json()).color)));

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
