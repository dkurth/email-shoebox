// Serve attachment files from the archive folder, safely.
import type { Context } from "hono";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { Archive } from "./db.ts";

interface AttachmentRow {
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

export function serveAttachment(c: Context, archive: Archive, id: number, mode: "download" | "inline") {
  const row = archive.db.prepare("SELECT path, filename, content_type, size_bytes FROM attachments WHERE id = ?").get(id) as AttachmentRow | undefined;
  if (!row) return c.json({ error: "No such attachment" }, 404);
  const file = resolveAttachmentPath(archive.dir, row.path);
  if (!file) return c.json({ error: "Unsafe attachment path" }, 400);
  if (!fs.existsSync(file)) return c.json({ error: "Attachment file is missing from the archive folder" }, 404);

  const type = row.content_type || "application/octet-stream";
  if (mode === "inline" && !type.startsWith("image/")) {
    return c.json({ error: "Only images can be shown inline" }, 415);
  }
  const name = row.filename || path.basename(file).replace(/^\d+-/, "");
  const headers: Record<string, string> = {
    "Content-Type": type,
    "Content-Length": String(fs.statSync(file).size),
    "Content-Disposition": contentDisposition(mode === "download" ? "attachment" : "inline", name),
    "X-Content-Type-Options": "nosniff",
    // Even if a browser renders this file directly (e.g. an SVG), it can't run scripts.
    "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
    "Cache-Control": "private, max-age=3600",
  };
  const stream = Readable.toWeb(fs.createReadStream(file)) as ReadableStream;
  return new Response(stream, { status: 200, headers });
}
