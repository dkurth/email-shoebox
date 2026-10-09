// Notes on a thread: the toolbar's note button and the panel on the right of the thread view.
// Saving is automatic (web/noteSaver.ts); there is no Save button.
import { useEffect, useState } from "react";
import { NotepadText } from "lucide-react";
import { findMatches } from "../shared/search.ts";
import { highlightText, useHighlight } from "./highlight.tsx";
import type { NoteInfo, NoteSaveResult, ThreadDetail } from "../shared/types.ts";
import { WRITE_HEADER } from "./api.ts";
import { ConflictResponse, firstLine, release, saverFor, type NoteSaver, type NoteStatus, type SendFn } from "./noteSaver.ts";

export const sendNote: SendFn = async (threadId, body, opts) => {
  const res = await fetch(`/api/threads/${encodeURIComponent(threadId)}/note`, {
    method: "PUT",
    headers: { "content-type": "application/json", [WRITE_HEADER]: "1" },
    body: JSON.stringify(body),
    keepalive: !!opts.keepalive,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 409) throw new ConflictResponse((data.note as NoteInfo | undefined) ?? null);
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data as NoteSaveResult;
};

/** The saver for the open thread. Leaving the thread saves at once. */
export function useNoteSaver(thread: ThreadDetail | null, routeThreadId: string | null): NoteSaver | null {
  const [saver, setSaver] = useState<NoteSaver | null>(null);
  const threadId = thread?.threadId ?? null;
  useEffect(() => {
    if (!thread) {
      setSaver(null);
      return;
    }
    const s = saverFor(thread.threadId, thread.note, sendNote);
    setSaver(s);
    return () => release(s);
    // A reload of the same thread (after an action) keeps the saver.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);
  // The route moved away (j/k, u, a sidebar click): save now, before the next thread has loaded.
  useEffect(() => {
    if (saver && routeThreadId !== saver.threadId) void saver.flush();
  }, [routeThreadId, saver]);
  return saver;
}

/** Re-render on every status change of a saver. */
export function useNoteStatus(saver: NoteSaver | null): NoteStatus | null {
  const [status, setStatus] = useState<NoteStatus | null>(saver?.status ?? null);
  useEffect(() => {
    setStatus(saver?.status ?? null);
    return saver?.subscribe(setStatus);
  }, [saver]);
  return status;
}

export function NoteIcon({ filled, size = 20 }: { filled: boolean; size?: number }) {
  return <NotepadText size={size} aria-hidden className={`note-icon${filled ? " filled" : ""}`} />;
}

export function NoteButton({ saver, open, onToggle }: { saver: NoteSaver; open: boolean; onToggle: () => void }) {
  useNoteStatus(saver);
  const has = saver.hasSavedNote;
  const line = firstLine(saver.text);
  return (
    <button
      className={`icon-button note-button${has ? " has-note" : ""}`}
      aria-label={open ? "Hide note" : "Show note"}
      aria-pressed={open}
      title={has && line ? `Note: ${line}` : open ? "Hide note" : "Add a note"}
      onClick={onToggle}
    >
      <NoteIcon filled={has} />
    </button>
  );
}

function when(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}, ${time}`;
}

function StatusLine({ status, saver }: { status: NoteStatus; saver: NoteSaver }) {
  switch (status.kind) {
    case "pending":
      return <span className="note-status">Not saved yet</span>;
    case "saving":
      return <span className="note-status">Saving…</span>;
    case "saved": {
      if (!status.at) return <span className="note-status">{saver.text.trim() ? "" : "Notes are saved automatically."}</span>;
      const today = new Date(status.at).toDateString() === new Date().toDateString();
      return <span className="note-status">{today ? "Saved" : "Last saved"} {when(status.at)}</span>;
    }
    case "error":
      return <span className="note-status warn" title={status.message}>Not saved. Retrying…</span>;
    case "conflict":
      return null;
  }
}

/** When a search matched the note: where, with the words marked (a text box can't show marks). */
function NoteMatch({ text }: { text: string }) {
  const terms = useHighlight();
  const ranges = findMatches(text, terms);
  if (!ranges.length) return null;
  const [s, e] = ranges[0];
  const from = Math.max(0, text.lastIndexOf(" ", Math.max(0, s - 40)) + 1);
  const to = Math.min(text.length, e + 80);
  const excerpt = (from > 0 ? "…" : "") + text.slice(from, to).replace(/\s+/g, " ") + (to < text.length ? "…" : "");
  return (
    <div className="note-match">
      Your search matches this note: <span>{highlightText(excerpt, terms)}</span>
    </div>
  );
}

export function NotePanel({ saver, readOnly }: { saver: NoteSaver; readOnly: boolean }) {
  const status = useNoteStatus(saver) ?? saver.status;
  const [text, setText] = useState(saver.text);
  // "Use theirs" replaces the text from outside the text box.
  useEffect(() => {
    if (status.kind === "saved" && saver.text !== text) setText(saver.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);
  useEffect(() => setText(saver.text), [saver]);

  return (
    <aside className="note-panel" aria-label="Note">
      <div className="note-panel-title">Note</div>
      {status.kind === "conflict" && (
        <div className="note-conflict" role="alert">
          This note was changed in another window.
          <div className="note-conflict-buttons">
            <button className="text-button" onClick={() => saver.keepMine()}>Keep mine</button>
            <button className="text-button" onClick={() => saver.useTheirs()}>Use theirs</button>
          </div>
        </div>
      )}
      <NoteMatch text={text} />
      <textarea
        className="note-text"
        value={text}
        readOnly={readOnly}
        placeholder={readOnly ? "No note. (This viewer is read-only.)" : "Write a note about this conversation…"}
        aria-label="Note text"
        onChange={(e) => {
          setText(e.target.value);
          saver.update(e.target.value);
        }}
      />
      {!readOnly && <StatusLine status={status} saver={saver} />}
    </aside>
  );
}
