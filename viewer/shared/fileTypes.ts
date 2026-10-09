// Attachment type groups for the attachment report. The server turns the same rules into SQL.

export const TYPE_GROUPS = ["Images", "PDF", "Documents", "Spreadsheets", "Presentations", "Audio", "Video", "Archives", "Emails", "Other"] as const;
export type TypeGroup = (typeof TYPE_GROUPS)[number];

interface Rule {
  group: Exclude<TypeGroup, "Other">;
  prefixes?: string[]; // content type starts with
  contains?: string[]; // content type contains
  exts: string[]; // file extensions (for application/octet-stream and friends)
}

// The first rule that matches wins.
export const TYPE_RULES: Rule[] = [
  { group: "Emails", contains: ["message/rfc822"], exts: ["eml", "msg"] },
  { group: "PDF", contains: ["/pdf"], exts: ["pdf"] },
  { group: "Images", prefixes: ["image/"], exts: ["jpg", "jpeg", "jpe", "png", "gif", "bmp", "webp", "heic", "heif", "tif", "tiff", "svg", "avif", "ico"] },
  { group: "Audio", prefixes: ["audio/"], exts: ["mp3", "m4a", "wav", "ogg", "oga", "flac", "aac", "wma", "amr", "aif", "aiff"] },
  { group: "Video", prefixes: ["video/"], exts: ["mp4", "m4v", "mov", "avi", "wmv", "mkv", "webm", "3gp", "mpg", "mpeg"] },
  {
    group: "Spreadsheets",
    contains: ["ms-excel", "spreadsheetml", "opendocument.spreadsheet", "text/csv"],
    exts: ["xls", "xlsx", "xlsm", "ods", "csv", "numbers"],
  },
  {
    group: "Presentations",
    contains: ["ms-powerpoint", "presentationml", "opendocument.presentation"],
    exts: ["ppt", "pptx", "pps", "ppsx", "odp", "key"],
  },
  {
    group: "Documents",
    contains: ["msword", "wordprocessingml", "opendocument.text", "/rtf", "text/plain", "text/html", "ms-works"],
    exts: ["doc", "docx", "odt", "rtf", "txt", "pages", "wpd", "wps", "htm", "html", "md"],
  },
  {
    group: "Archives",
    contains: ["zip", "x-rar", "x-7z", "gzip", "x-tar", "compressed", "x-bzip"],
    exts: ["zip", "rar", "7z", "gz", "tgz", "tar", "bz2", "xz"],
  },
];

export function fileExtension(filename: string | null | undefined): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(filename ?? "");
  return m ? m[1].toLowerCase() : "";
}

export function typeGroup(contentType: string | null | undefined, filename: string | null | undefined): TypeGroup {
  const ct = (contentType ?? "").toLowerCase();
  const ext = fileExtension(filename);
  for (const r of TYPE_RULES) {
    if (r.prefixes?.some((p) => ct.startsWith(p)) || r.contains?.some((c) => ct.includes(c))) return r.group;
  }
  for (const r of TYPE_RULES) if (ext && r.exts.includes(ext)) return r.group;
  return "Other";
}
