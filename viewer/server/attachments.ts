// Serve attachment files from the archive folder, safely.
import type { Context } from "hono";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { preview } from "../shared/preview.ts";
import type { Archive } from "./db.ts";

interface AttachmentRow {
  deleted_at: number | null;
  path: string;
  filename: string | null;
  content_type: string | null;
  size_bytes: number;
}

/** Resolve a stored path, refusing anything outside <archive>/attachments/. */
export function resolveAttachmentPath(archiveDir: string, rel: string): string | null {
  const root = path.join(archiveDir, "attachments") + path.sep;
  const abs = path.resolve(archiveDir, rel);
  if (!abs.startsWith(root)) return null;
  return abs;
}

/** RFC 6266 Content-Disposition with a UTF-8 filename and an ASCII fallback. */
export function contentDisposition(kind: "attachment" | "inline", filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase());
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Parse one "bytes=a-b" range. Returns null for no header, "bad" for one we can't satisfy. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | "bad" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "bad";
  let start: number;
  let end: number;
  if (m[1] === "") {
    // "bytes=-500": the last 500 bytes
    const n = Number(m[2]);
    if (n === 0) return "bad";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return "bad";
  return { start, end };
}

export const DELETED_MESSAGE = "The attached file was deleted from the archive, but the email thread was preserved.";
const DELETED_PAGE = `<!doctype html><meta charset="utf-8"><title>Attachment deleted</title><body style="font:16px system-ui,sans-serif;margin:48px;color:#333"><p>${DELETED_MESSAGE}</p>`;

// Even if a browser renders a file directly (e.g. an SVG), it can't run scripts.
const SANDBOX_CSP = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox";
// Chrome's PDF viewer does not load under a sandbox CSP; PDFs get a strict policy without it.
const PDF_CSP = "default-src 'none'; object-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'";

export function serveAttachment(c: Context, archive: Archive, id: number, mode: "download" | "inline") {
  const row = archive.db.prepare("SELECT path, filename, content_type, size_bytes, deleted_at FROM attachments WHERE id = ?").get(id) as AttachmentRow | undefined;
  if (!row) return c.json({ error: "No such attachment" }, 404);
  if (row.deleted_at) {
    // 410 Gone, with the same sentence the viewer shows.
    return c.html(DELETED_PAGE, 410, { "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" });
  }
  const file = resolveAttachmentPath(archive.dir, row.path);
  if (!file) return c.json({ error: "Unsafe attachment path" }, 400);
  if (!fs.existsSync(file)) return c.json({ error: "Attachment file is missing from the archive folder" }, 404);

  let type = row.content_type || "application/octet-stream";
  let csp = SANDBOX_CSP;
  if (mode === "inline") {
    const p = preview(row.content_type, row.filename);
    if (!p) return c.json({ error: "This file type can't be shown in the browser" }, 415);
    type = p.type;
    if (p.kind === "pdf") csp = PDF_CSP;
  }
  const name = row.filename || path.basename(file).replace(/^\d+-/, "");
  const total = fs.statSync(file).size;
  const headers: Record<string, string> = {
    "Content-Type": type,
    "Content-Disposition": contentDisposition(mode === "download" ? "attachment" : "inline", name),
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": csp,
    "Cache-Control": "private, max-age=3600",
    "Accept-Ranges": "bytes",
  };
  const range = parseRange(c.req.header("range"), total);
  if (range === "bad") {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
  }
  const { start, end } = range ?? { start: 0, end: total - 1 };
  headers["Content-Length"] = String(total ? end - start + 1 : 0);
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
  const stream = total ? (Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream) : null;
  return new Response(stream, { status: range ? 206 : 200, headers });
}
