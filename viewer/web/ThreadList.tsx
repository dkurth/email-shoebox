// The Gmail-style list of threads: checkbox · star · participants · subject — snippet · chips · 📎 · date.
import { useEffect, useRef } from "react";
import { labelColor } from "../shared/labelColors.ts";
import { isCategory, categoryName, isUserLabel } from "../shared/labels.ts";
import type { ThreadList as ThreadListData, ThreadSummary } from "../shared/types.ts";
import { listDate, participantParts } from "./format.ts";
import { useChosenColors } from "./LabelOptions.tsx";

function Participants({ t }: { t: ThreadSummary }) {
  const parts = participantParts(t.participants);
  return (
    <span className="participants">
      {t.toPrefix && <span className="to-prefix">To: </span>}
      {parts.length === 0 && <span>(no one)</span>}
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && p !== ".." && parts[i - 1] !== ".." ? ", " : i > 0 ? " " : ""}
          {p === ".." ? ".." : <span className={p.unread ? "unread-name" : undefined}>{p.name}</span>}
        </span>
      ))}
      {t.messageCount > 1 && <span className="count"> {t.messageCount}</span>}
    </span>
  );
}

/** A label chip; user labels show their color, system labels and categories stay gray. */
export function Chip({ name }: { name: string }) {
  const chosen = useChosenColors();
  const color = isUserLabel(name) ? ` lc lc-${labelColor(name, chosen)}` : "";
  return <span className={`chip${color}`}>{isCategory(name) ? categoryName(name) : name}</span>;
}

export function ThreadList(props: {
  data: ThreadListData;
  cursor: number;
  selected: Set<string>;
  onToggleSelect: (threadId: string) => void;
  onToggleStar?: (t: ThreadSummary) => void;
  onOpen: (t: ThreadSummary) => void;
  onCursor: (i: number) => void;
}) {
  const { data, cursor, selected } = props;
  const list = useRef<HTMLUListElement>(null);

  // Keep the cursor row on screen when j/k moves it.
  useEffect(() => {
    const row = list.current?.children[cursor] as HTMLElement | undefined;
    row?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (!data.threads.length) {
    return <div className="empty-list">{data.page > 1 ? "No more conversations." : "No conversations here."}</div>;
  }
  return (
    <ul className="thread-list" ref={list} role="list">
      {data.threads.map((t, i) => (
        <li
          key={t.threadId}
          className={`thread-row${t.unread ? " unread" : ""}${i === cursor ? " cursor" : ""}${selected.has(t.threadId) ? " selected" : ""}`}
          onClick={() => props.onOpen(t)}
          onMouseDown={() => props.onCursor(i)}
          data-thread-id={t.threadId}
        >
          <span className="row-controls" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              aria-label="Select conversation"
              checked={selected.has(t.threadId)}
              onChange={() => props.onToggleSelect(t.threadId)}
            />
            <button
              className={`star${t.starred ? " on" : ""}`}
              aria-label={t.starred ? "Starred" : "Not starred"}
              aria-pressed={t.starred}
              disabled={!props.onToggleStar}
              onClick={() => props.onToggleStar?.(t)}
            >
              {t.starred ? "★" : "☆"}
            </button>
          </span>
          <Participants t={t} />
          <span className="subject-snippet">
            {t.labels.map((l) => <Chip key={l} name={l} />)}
            <span className="subject">{t.subject || "(no subject)"}</span>
            {t.snippet && <span className="snippet"> — {t.snippet}</span>}
          </span>
          <span className="row-end">
            {t.hasAttachments && <span className="clip" title="Has attachments">📎</span>}
            <span className="date">{listDate(t.date)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
