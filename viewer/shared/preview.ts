// Which attachments the browser can show, and the content type to serve them with.
// Shared by the server (which files /inline serves) and the web front end (which preview to show).

export type PreviewKind = "image" | "audio" | "video" | "pdf" | "text";

// Never SVG (it can hold script), HTML, XML or message/rfc822.
const TYPES: Record<string, [PreviewKind, string]> = {
  "image/jpeg": ["image", "image/jpeg"],
  "image/jpg": ["image", "image/jpeg"],
  "image/pjpeg": ["image", "image/jpeg"],
  "image/png": ["image", "image/png"],
  "image/x-png": ["image", "image/png"],
  "image/gif": ["image", "image/gif"],
  "image/webp": ["image", "image/webp"],
  "image/bmp": ["image", "image/bmp"],
  "image/x-ms-bmp": ["image", "image/bmp"],
  "image/avif": ["image", "image/avif"],
  "audio/mpeg": ["audio", "audio/mpeg"],
  "audio/mp3": ["audio", "audio/mpeg"],
  "audio/mpeg3": ["audio", "audio/mpeg"],
  "audio/x-mpeg-3": ["audio", "audio/mpeg"],
  "audio/mp4": ["audio", "audio/mp4"],
  "audio/x-m4a": ["audio", "audio/mp4"],
  "audio/m4a": ["audio", "audio/mp4"],
  "audio/aac": ["audio", "audio/aac"],
  "audio/wav": ["audio", "audio/wav"],
  "audio/x-wav": ["audio", "audio/wav"],
  "audio/wave": ["audio", "audio/wav"],
  "audio/ogg": ["audio", "audio/ogg"],
  "audio/webm": ["audio", "audio/webm"],
  "audio/flac": ["audio", "audio/flac"],
  "audio/x-flac": ["audio", "audio/flac"],
  "video/mp4": ["video", "video/mp4"],
  "video/webm": ["video", "video/webm"],
  "video/quicktime": ["video", "video/quicktime"],
  "application/pdf": ["pdf", "application/pdf"],
  "text/plain": ["text", "text/plain; charset=utf-8"],
  "text/csv": ["text", "text/plain; charset=utf-8"],
  "text/markdown": ["text", "text/plain; charset=utf-8"],
};

// For files sent without a useful type (application/octet-stream or none).
const EXTENSIONS: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", jpe: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
  bmp: "image/bmp", avif: "image/avif",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg",
  flac: "audio/flac", weba: "audio/webm",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  pdf: "application/pdf",
  txt: "text/plain", text: "text/plain", log: "text/plain", csv: "text/csv", md: "text/markdown",
};

function extension(filename: string | null | undefined): string {
  const m = /\.([a-z0-9]{1,5})$/i.exec(filename ?? "");
  return m ? m[1].toLowerCase() : "";
}

/** The preview kind and the safe content type to serve, or null if the browser should only download it. */
export function preview(contentType: string | null | undefined, filename: string | null | undefined): { kind: PreviewKind; type: string } | null {
  let type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (!type || type === "application/octet-stream" || type === "binary/octet-stream" || type === "application/x-download") {
    type = EXTENSIONS[extension(filename)] ?? "";
  }
  const hit = TYPES[type];
  return hit ? { kind: hit[0], type: hit[1] } : null;
}

export function previewKind(contentType: string | null | undefined, filename: string | null | undefined): PreviewKind | null {
  return preview(contentType, filename)?.kind ?? null;
}
