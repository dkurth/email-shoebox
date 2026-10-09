// The admin page's Attachments tab: totals by type and sender, then every attachment, biggest first.
// The filters live in the URL (#/admin/attachments?type=Video&min=10485760), so Back works.
import { useState, type ReactNode } from "react";
import { TYPE_GROUPS } from "../shared/fileTypes.ts";
import { previewKind } from "../shared/preview.ts";
import type { AttachmentRow, AttachmentSummary } from "../shared/types.ts";
import { q as query } from "./api.ts";
import { fullDate, size } from "./format.ts";
import { Lightbox } from "./Lightbox.tsx";
import { go } from "./route.ts";
import { SortHeader, useAdminData, type AdminProps } from "./AdminPage.tsx";

const num = (n: number) => n.toLocaleString();
const PAGE = 100;
const MB = 1024 * 1024;

export interface ReportExtras {
  /** Extra controls for each row (delete, select), added by later parts of the page. */
  rowStart?: (r: AttachmentRow) => ReactNode;
  rowEnd?: (r: AttachmentRow) => ReactNode;
}

function Summary({ inline, setParams }: { inline: boolean; setParams: AdminProps["setParams"] }) {
  const { data: s, error } = useAdminData<AttachmentSummary>("/api/admin/attachments/summary" + query({ inline: inline ? 1 : 0 }));
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (error) return <div className="error-banner">{error}</div>;
  if (!s) return <div className="loading">Loading…</div>;
  return (
    <div className="attachment-summary">
      <div className="summary-total">
        <span className="stat-value">{num(s.count)} attachments · {size(s.bytes)}</span>
        <label className="admin-options">
          <input type="checkbox" checked={inline} onChange={(e) => setParams({ inline: e.target.checked ? 1 : null, page: null })} />
          Include images inside email text (logos, signatures)
        </label>
      </div>
      <div className="summary-columns">
        <section>
          <h2>By type</h2>
          <table className="admin-table">
            <thead><tr><th>Type</th><th className="num">Files</th><th className="num">Size</th></tr></thead>
            {s.groups.map((g) => (
              <tbody key={g.group}>
                <tr>
                  <td>
                    <button className="tree-toggle" aria-label={open.has(g.group) ? "Hide types" : "Show types"} onClick={() => setOpen((o) => { const n = new Set(o); if (n.has(g.group)) n.delete(g.group); else n.add(g.group); return n; })}>
                      {open.has(g.group) ? "▾" : "▸"}
                    </button>
                    <a href="#" onClick={(e) => { e.preventDefault(); setParams({ type: g.group, page: null }); }}>{g.group}</a>
                  </td>
                  <td className="num">{num(g.count)}</td>
                  <td className="num">{size(g.bytes)}</td>
                </tr>
                {open.has(g.group) &&
                  g.types.map((t) => (
                    <tr key={t.type} className="sub-row">
                      <td className="mono">{t.type}</td>
                      <td className="num">{num(t.count)}</td>
                      <td className="num">{size(t.bytes)}</td>
                    </tr>
                  ))}
              </tbody>
            ))}
          </table>
        </section>
        <section>
          <h2>By sender (top 20)</h2>
          <table className="admin-table">
            <thead><tr><th>Sender</th><th className="num">Files</th><th className="num">Size</th></tr></thead>
            <tbody>
              {s.senders.map((p) => (
                <tr key={p.addr}>
                  <td>
                    <a href="#" title={p.name} onClick={(e) => { e.preventDefault(); setParams({ from: p.addr, page: null }); }}>{p.addr}</a>
                  </td>
                  <td className="num">{num(p.count)}</td>
                  <td className="num">{size(p.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

function Filters({ params, setParams }: AdminProps) {
  const [minText, setMinText] = useState(params.get("min") ? String(Number(params.get("min")) / MB) : "");
  const from = params.get("from");
  return (
    <div className="report-filters">
      <label>
        Type{" "}
        <select value={params.get("type") ?? ""} onChange={(e) => setParams({ type: e.target.value || null, page: null })}>
          <option value="">All</option>
          {TYPE_GROUPS.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
      </label>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const mb = Number(minText);
          setParams({ min: minText && mb > 0 ? Math.round(mb * MB) : null, page: null });
        }}
      >
        <label>
          Larger than <input className="min-input" inputMode="decimal" value={minText} onChange={(e) => setMinText(e.target.value)} onBlur={(e) => e.currentTarget.form?.requestSubmit()} aria-label="Larger than (MB)" /> MB
        </label>
      </form>
      {from && (
        <span className="filter-chip">
          From {from}
          <button aria-label="Clear the sender filter" onClick={() => setParams({ from: null, page: null })}>✕</button>
        </span>
      )}
      <label>
        <input type="checkbox" checked={params.get("deleted") === "1"} onChange={(e) => setParams({ deleted: e.target.checked ? 1 : null, page: null })} /> Show deleted
      </label>
    </div>
  );
}

function Preview({ r, onImage }: { r: AttachmentRow; onImage: () => void }) {
  const [playing, setPlaying] = useState(false);
  if (r.deletedAt) return null;
  const kind = previewKind(r.contentType, r.filename);
  const src = `/api/attachments/${r.id}/inline`;
  if (kind === "image") return <button className="link-button" onClick={onImage}>Preview</button>;
  if (kind === "pdf" || kind === "text") return <a href={src} target="_blank" rel="noopener noreferrer">Open</a>;
  if (kind === "audio" || kind === "video") {
    return playing ? (
      kind === "audio" ? <audio controls autoPlay src={src} className="report-player" /> : <video controls autoPlay src={src} className="report-player" />
    ) : (
      <button className="link-button" onClick={() => setPlaying(true)}>Play</button>
    );
  }
  return null;
}

export function reportUrl(params: URLSearchParams): string {
  const p: Record<string, string> = {};
  for (const k of ["sort", "desc", "type", "from", "min", "deleted", "inline", "page", "dupes"]) {
    const v = params.get(k);
    if (v) p[k] = v;
  }
  return "/api/admin/attachments" + (Object.keys(p).length ? query(p) : "");
}

export function AttachmentList(props: AdminProps & ReportExtras & { version?: number }) {
  const { params, setParams } = props;
  const { data, error } = useAdminData<{ rows: AttachmentRow[]; total: number }>(reportUrl(params) + `${params.toString() ? "&" : "?"}v=${props.version ?? 0}`);
  const [viewing, setViewing] = useState<number | null>(null);
  const page = Number(params.get("page") ?? 1);
  const sort = params.get("sort") ?? "size";
  const desc = params.get("desc") !== "0";
  const header = (key: string, label: string, numeric = false) => (
    <SortHeader
      label={label}
      numeric={numeric}
      active={sort === key}
      desc={desc}
      onClick={() => setParams({ sort: key === "size" ? null : key, desc: sort === key ? (desc ? 0 : null) : key === "name" || key === "sender" ? 0 : null, page: null })}
    />
  );
  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return <div className="loading">Loading…</div>;
  const images = data.rows.filter((r) => !r.deletedAt && previewKind(r.contentType, r.filename) === "image");
  const start = (page - 1) * PAGE;
  return (
    <>
      <div className="report-bar">
        <span className="pager">
          {data.total ? `${num(start + 1)}–${num(Math.min(data.total, start + PAGE))} of ${num(data.total)}` : "No attachments match."}
          <button className="icon-button" title="Previous" disabled={page <= 1} onClick={() => setParams({ page: page - 1 > 1 ? page - 1 : null })}>‹</button>
          <button className="icon-button" title="Next" disabled={start + PAGE >= data.total} onClick={() => setParams({ page: page + 1 })}>›</button>
        </span>
      </div>
      <table className="admin-table report">
        <thead>
          <tr>
            {props.rowStart && <th className="check" />}
            {header("name", "File name")}
            {header("size", "Size", true)}
            <th>Type</th>
            {header("date", "Date")}
            {header("sender", "From")}
            <th>Subject</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.id} className={r.deletedAt ? "deleted-row" : undefined}>
              {props.rowStart && <td className="check">{props.rowStart(r)}</td>}
              <td className="file-cell">
                {r.filename || "(no name)"}
                {r.deletedAt ? <span className="deleted-mark"> (deleted)</span> : null}
              </td>
              <td className="num">{size(r.size)}</td>
              <td title={r.contentType ?? ""}>{r.typeGroup}</td>
              <td>{fullDate(r.date)}</td>
              <td title={r.fromName ?? ""}>{r.fromAddr}</td>
              <td className="subject-cell">{r.subject || "(no subject)"}</td>
              <td className="row-actions">
                <a href="#" onClick={(e) => { e.preventDefault(); go({ view: "all", threadId: r.threadId }); }}>Open email</a>
                {!r.deletedAt && <a href={`/api/attachments/${r.id}/download`} download={r.filename ?? ""}>Download</a>}
                <Preview r={r} onImage={() => setViewing(images.findIndex((i) => i.id === r.id))} />
                {props.rowEnd?.(r)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {viewing !== null && viewing >= 0 && (
        <Lightbox
          items={images.map((i) => ({
            id: i.id,
            name: i.filename || "(no name)",
            size: i.size,
            details: <>{fullDate(i.date)} · {i.fromName || i.fromAddr} · {i.subject || "(no subject)"}</>,
          }))}
          index={viewing}
          onIndex={setViewing}
          onClose={() => setViewing(null)}
        />
      )}
    </>
  );
}

export function AttachmentsTab(props: AdminProps) {
  const { params, setParams } = props;
  return (
    <div className="admin-attachments">
      <Summary inline={params.get("inline") === "1"} setParams={setParams} />
      <section>
        <h2>All attachments</h2>
        <Filters {...props} />
        <AttachmentList {...props} />
      </section>
    </div>
  );
}
