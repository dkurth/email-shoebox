// One conversation, as in Gmail: subject, then one card per message (read ones collapsed).
import { useEffect, useMemo, useState } from "react";
import type { Address, MessageDetail, ThreadDetail } from "../shared/types.ts";
import { EmailBody } from "./EmailBody.tsx";
import { displayName, fullDate, recipientsLine, relative, size } from "./format.ts";
import { Chip } from "./ThreadList.tsx";

function AddressList({ list, me }: { list: Address[]; me: string[] }) {
  return (
    <>
      {list.map((a, i) => (
        <span key={i}>
          {i > 0 && ", "}
          {me.includes(a.addr) ? "me" : a.name || a.addr}
          {a.name && a.addr && <span className="addr"> &lt;{a.addr}&gt;</span>}
        </span>
      ))}
    </>
  );
}

function Details({ m, me }: { m: MessageDetail; me: string[] }) {
  const rows: [string, React.ReactNode][] = [
    ["from:", m.from ? <AddressList list={[m.from]} me={[]} /> : "(unknown)"],
    ["to:", <AddressList list={m.to} me={me} />],
  ];
  if (m.cc.length) rows.push(["cc:", <AddressList list={m.cc} me={me} />]);
  if (m.bcc.length) rows.push(["bcc:", <AddressList list={m.bcc} me={me} />]);
  if (m.replyTo.length) rows.push(["reply-to:", <AddressList list={m.replyTo} me={me} />]);
  rows.push(["date:", fullDate(m.date)], ["subject:", m.subject || "(no subject)"]);
  return (
    <table className="msg-details">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <th>{k}</th>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function fileIcon(type: string): string {
  if (type.startsWith("image/")) return "🖼️";
  if (type.startsWith("audio/")) return "🎵";
  if (type.startsWith("video/")) return "🎞️";
  if (type === "application/pdf") return "📕";
  if (type.includes("zip") || type.includes("compressed")) return "🗜️";
  if (type.startsWith("text/") || type.includes("word") || type.includes("document")) return "📄";
  if (type.includes("sheet") || type.includes("excel")) return "📊";
  if (type === "message/rfc822") return "✉️";
  return "📎";
}

function Attachments({ m }: { m: MessageDetail }) {
  // Inline images the HTML shows itself aren't listed again.
  const html = m.bodyHtml?.toLowerCase() ?? "";
  const list = m.attachments.filter((a) => !(a.isInline && a.contentId && html.includes(`cid:${a.contentId.toLowerCase()}`)));
  if (!list.length) return null;
  return (
    <div className="attachments">
      <div className="attachments-title">
        {list.length} attachment{list.length > 1 ? "s" : ""}
      </div>
      <ul>
        {list.map((a) => (
          <li key={a.id}>
            <a href={`/api/attachments/${a.id}/download`} download={a.filename ?? undefined} title={`Download ${a.filename ?? "attachment"}`}>
              <span className="file-icon" aria-hidden>{fileIcon(a.contentType)}</span>
              <span className="file-name">{a.filename || "(no name)"}</span>
              <span className="file-size">{size(a.size)}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MessageCard({ m, me, expanded, onToggle }: { m: MessageDetail; me: string[]; expanded: boolean; onToggle: () => void }) {
  const [showDetails, setShowDetails] = useState(false);
  const sender = m.from ? displayName(m.from, me) : "(unknown sender)";
  if (!expanded) {
    return (
      <article className={`msg collapsed${m.unread ? " unread" : ""}`} onClick={onToggle}>
        <span className="msg-from">{sender}</span>
        <span className="msg-snippet">{m.snippet}</span>
        <span className="msg-date">{fullDate(m.date)}</span>
      </article>
    );
  }
  return (
    <article className="msg expanded">
      <header className="msg-header" onClick={onToggle}>
        <div className="msg-sender">
          <span className="msg-from">{m.from?.name || m.from?.addr || "(unknown sender)"}</span>
          {m.from?.name && m.from.addr && <span className="addr"> &lt;{m.from.addr}&gt;</span>}
          <div className="msg-to">
            {recipientsLine(m.to, m.cc, m.bcc, me)}
            <button
              className="details-toggle"
              aria-label="Show details"
              aria-expanded={showDetails}
              onClick={(e) => { e.stopPropagation(); setShowDetails(!showDetails); }}
            >
              ▾
            </button>
          </div>
        </div>
        <div className="msg-meta">
          <span className="msg-date" title={fullDate(m.date)}>
            {fullDate(m.date)} ({relative(m.date)})
          </span>
          <a className="original-link" href={`/api/messages/${m.id}/original`} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}>
            Show original
          </a>
        </div>
      </header>
      {showDetails && <Details m={m} me={me} />}
      <EmailBody bodyHtml={m.bodyHtml} bodyText={m.bodyText} attachments={m.attachments} />
      <Attachments m={m} />
    </article>
  );
}

export function ThreadView({ thread, me, view, onToggleStar }: {
  thread: ThreadDetail;
  me: string[];
  view: string;
  onToggleStar?: () => void; // omitted in read-only mode
}) {
  const starred = thread.messages.some((m) => m.starred);
  const [showHidden, setShowHidden] = useState(false);
  const shown = thread.messages.filter((m) => m.inContext || showHidden);
  const hidden = thread.messages.filter((m) => !m.inContext).length;

  // Gmail expands unread messages and the last one; the rest are one-line summaries.
  const initial = useMemo(() => {
    const visible = thread.messages.filter((m) => m.inContext);
    const s = new Set(visible.filter((m) => m.unread).map((m) => m.id));
    if (visible.length) s.add(visible[visible.length - 1].id);
    return s;
  }, [thread]);
  const [expanded, setExpanded] = useState(initial);
  useEffect(() => setExpanded(initial), [initial]);

  const toggle = (id: number) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="thread-view">
      <div className="thread-title">
        <h1>{thread.subject || "(no subject)"}</h1>
        <button
          className={`star${starred ? " on" : ""}`}
          aria-label={starred ? "Starred" : "Not starred"}
          aria-pressed={starred}
          title={onToggleStar ? (starred ? "Unstar (s)" : "Star (s)") : undefined}
          disabled={!onToggleStar}
          onClick={onToggleStar}
        >
          {starred ? "★" : "☆"}
        </button>
        {thread.labels.map((l) => <Chip key={l} name={l} />)}
        {shown.some((m) => !expanded.has(m.id)) && (
          <button className="link-button expand-all" onClick={() => setExpanded(new Set(shown.map((m) => m.id)))}>
            Expand all
          </button>
        )}
      </div>
      {hidden > 0 && (
        <div className="hidden-note">
          {hidden} {view === "trash" ? "message not in Trash" : "deleted message"}{hidden > 1 ? "s" : ""} in this conversation.{" "}
          <button className="link-button" onClick={() => setShowHidden(!showHidden)}>
            {showHidden ? "Hide" : hidden > 1 ? "View messages" : "View message"}
          </button>
        </div>
      )}
      {shown.length === 0 && <div className="empty-list">No messages in this conversation are in this view.</div>}
      {shown.map((m) => (
        <MessageCard key={m.id} m={m} me={me} expanded={expanded.has(m.id)} onToggle={() => toggle(m.id)} />
      ))}
    </div>
  );
}
