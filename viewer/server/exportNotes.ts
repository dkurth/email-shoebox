// Export every note as one Markdown or CSV file: a readable backup (notes exist only in mail.db).
import { isUserLabel } from "../shared/labels.ts";
import type { DB } from "./db.ts";

export interface ExportedNote {
  threadId: string;
  subject: string;
  firstDate: number | null; // epoch seconds
  lastDate: number | null;
  messageCount: number;
  people: string[]; // "Alice Adams <alice@example.com>", or "me"
  labels: string[]; // user labels
  where: "Trash" | "Spam" | null; // every message of the thread is in Trash (or Spam)
  created: number; // ms
  updated: number; // ms
  body: string;
}

const MAX_PEOPLE = 10;

export function collectNotes(db: DB, me: string[]): ExportedNote[] {
  const notes = db.prepare("SELECT thread_id, body, created_at, updated_at FROM thread_notes ORDER BY updated_at DESC, id DESC").all() as {
    thread_id: string;
    body: string;
    created_at: number;
    updated_at: number;
  }[];
  const msgs = db.prepare(
    `SELECT m.id, m.subject, coalesce(m.received_utc, m.date_utc) AS d FROM messages m WHERE m.thread_id = ?
     ORDER BY d, m.id`,
  );
  const people = db.prepare(
    `SELECT a.addr, max(a.name) AS name, min(m.id) AS first FROM messages m JOIN message_addresses a ON a.message_id = m.id
     WHERE m.thread_id = ? GROUP BY a.addr ORDER BY first, a.addr`,
  );
  const labels = db.prepare(
    `SELECT DISTINCT l.name FROM messages m JOIN message_labels ml ON ml.message_id = m.id JOIN labels l ON l.id = ml.label_id
     WHERE m.thread_id = ?`,
  ).pluck();
  const outside = db.prepare(
    `SELECT count(*) FROM messages m WHERE m.thread_id = ? AND NOT EXISTS (
       SELECT 1 FROM message_labels ml JOIN labels l ON l.id = ml.label_id WHERE ml.message_id = m.id AND l.name IN ('Trash', 'Spam'))`,
  ).pluck();
  const inLabel = db.prepare(
    `SELECT count(*) FROM messages m JOIN message_labels ml ON ml.message_id = m.id JOIN labels l ON l.id = ml.label_id
     WHERE m.thread_id = ? AND l.name = ?`,
  ).pluck();
  const meSet = new Set(me);

  return notes.map((n) => {
    const ms = msgs.all(n.thread_id) as { id: number; subject: string | null; d: number | null }[];
    const ps = (people.all(n.thread_id) as { addr: string; name: string }[]).map((p) =>
      meSet.has(p.addr) ? "me" : p.name ? `${p.name} <${p.addr}>` : p.addr,
    );
    const uniquePeople = [...new Set(ps)];
    const shown = uniquePeople.slice(0, MAX_PEOPLE);
    if (uniquePeople.length > MAX_PEOPLE) shown.push(`+${uniquePeople.length - MAX_PEOPLE} more`);
    let where: ExportedNote["where"] = null;
    if (ms.length && outside.get(n.thread_id) === 0) where = (inLabel.get(n.thread_id, "Trash") as number) > 0 ? "Trash" : "Spam";
    const dates = ms.map((m) => m.d).filter((d): d is number => d !== null);
    return {
      threadId: n.thread_id,
      subject: ms.find((m) => m.subject)?.subject ?? "",
      firstDate: dates.length ? Math.min(...dates) : null,
      lastDate: dates.length ? Math.max(...dates) : null,
      messageCount: ms.length,
      people: shown,
      labels: (labels.all(n.thread_id) as string[]).filter(isUserLabel).sort((a, b) => a.localeCompare(b)),
      where,
      created: n.created_at,
      updated: n.updated_at,
      body: n.body,
    };
  });
}

const pad = (n: number) => String(n).padStart(2, "0");

/** ISO 8601 in the computer's own time zone, e.g. 2026-10-09T09:41:00-07:00. */
export function localIso(ms: number): string {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  );
}

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

export function toMarkdown(notes: ExportedNote[], exportedAt = Date.now()): string {
  const out = [`# Notes`, "", `Exported ${dateTimeFmt.format(exportedAt)}. ${notes.length} note${notes.length === 1 ? "" : "s"}, newest first.`, ""];
  for (const n of notes) {
    const range =
      n.firstDate === null ? "no date" :
      n.firstDate === n.lastDate || n.lastDate === null ? dateFmt.format(n.firstDate * 1000) :
      `${dateFmt.format(n.firstDate * 1000)} – ${dateFmt.format(n.lastDate * 1000)}`;
    out.push(`## ${(n.subject || "(no subject)").replace(/\n/g, " ")}`);
    out.push(`- Thread: ${n.threadId} · ${n.messageCount} message${n.messageCount === 1 ? "" : "s"} · ${range}${n.where ? ` · in ${n.where}` : ""}`);
    if (n.people.length) out.push(`- People: ${n.people.join(", ")}`);
    if (n.labels.length) out.push(`- Labels: ${n.labels.join(", ")}`);
    out.push(`- Note written: ${dateTimeFmt.format(n.created)} · last changed: ${dateTimeFmt.format(n.updated)}`);
    out.push("");
    // A line that starts with # would become a heading in the file.
    out.push(n.body.split("\n").map((l) => (/^\s*#/.test(l) ? l.replace("#", "\\#") : l)).join("\n"));
    out.push("");
  }
  return out.join("\n");
}

function csvField(v: string | number | null): string {
  const s = v === null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_COLUMNS = [
  "thread_id", "subject", "first_date", "last_date", "message_count", "people", "labels",
  "in_trash_or_spam", "note_created", "note_updated", "note",
];

/** RFC 4180, with a UTF-8 BOM so Excel reads the text correctly. */
export function toCsv(notes: ExportedNote[]): string {
  const rows = [CSV_COLUMNS.join(",")];
  for (const n of notes) {
    rows.push(
      [
        n.threadId,
        n.subject,
        n.firstDate === null ? null : localIso(n.firstDate * 1000),
        n.lastDate === null ? null : localIso(n.lastDate * 1000),
        n.messageCount,
        n.people.join("; "),
        n.labels.join("; "),
        n.where ?? "",
        localIso(n.created),
        localIso(n.updated),
        n.body,
      ].map(csvField).join(","),
    );
  }
  return "﻿" + rows.join("\r\n") + "\r\n";
}

export function exportFilename(format: "md" | "csv", now = new Date()): string {
  return `notes-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.${format}`;
}
