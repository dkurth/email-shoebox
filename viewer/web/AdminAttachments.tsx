// The admin page's Attachments tab: totals by type and sender, then every attachment, biggest first.
// The filters live in the URL (#/admin/attachments?type=Video&min=10485760), so Back works.
import { useState, type ReactNode } from "react";
import { TYPE_GROUPS } from "../shared/fileTypes.ts";
import { previewKind } from "../shared/preview.ts";
import type { AttachmentRow, AttachmentSummary } from "../shared/types.ts";
import { post, q as query } from "./api.ts";
import { ConfirmDialog, type ConfirmData } from "./ConfirmDialog.tsx";
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
  headStart?: (rows: AttachmentRow[]) => ReactNode; // the header cell above rowStart
  barStart?: (rows: AttachmentRow[], total: number) => ReactNode; // left of the pager
}

function Summary({ inline, setParams, version }: { inline: boolean; setParams: AdminProps["setParams"]; version: number }) {
  const { data: s, error } = useAdminData<AttachmentSummary>("/api/admin/attachments/summary" + query({ inline: inline ? 1 : 0, v: version }));
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
        {props.barStart?.(data.rows, data.total)}
        <span className="pager">
          {data.total ? `${num(start + 1)}–${num(Math.min(data.total, start + PAGE))} of ${num(data.total)}` : "No attachments match."}
          <button className="icon-button" title="Previous" disabled={page <= 1} onClick={() => setParams({ page: page - 1 > 1 ? page - 1 : null })}>‹</button>
          <button className="icon-button" title="Next" disabled={start + PAGE >= data.total} onClick={() => setParams({ page: page + 1 })}>›</button>
        </span>
      </div>
      <table className="admin-table report">
        <thead>
          <tr>
            {props.rowStart && <th className="check">{props.headStart?.(data.rows)}</th>}
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

/** Confirm, then delete attachment files (the emails stay). Shared by every delete button on the page. */
export function useAttachmentDelete(onDone: () => void) {
  const [confirm, setConfirm] = useState<ConfirmData | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  /** target: the ids to delete, or the report filter ("all that match"). */
  const ask = async (target: { ids: number[] } | { filter: Record<string, string> }, what?: ReactNode) => {
    try {
      const s = await post<{ count: number; bytes: number; names: string[] }>("/api/attachments/delete-summary", target);
      if (!s.count) return setMessage({ text: "Nothing to delete." });
      const files = s.count === 1 ? `"${s.names[0]}"` : `${num(s.count)} attachments`;
      setConfirm({
        title: s.count === 1 ? "Delete attachment?" : `Delete ${num(s.count)} attachments?`,
        body: (
          <>
            <p>
              Delete {files} ({size(s.bytes)}) from the archive? The email{s.count === 1 ? "" : "s"} will be kept. <strong>This can't be undone.</strong>
            </p>
            {what}
            {s.count > 1 && (
              <ul className="confirm-list">
                {s.names.map((n, i) => <li key={i}>{n}</li>)}
                {s.count > s.names.length && <li>…and {num(s.count - s.names.length)} more</li>}
              </ul>
            )}
          </>
        ),
        confirmText: s.count === 1 ? "Delete attachment" : `Delete ${num(s.count)} attachments`,
        danger: true,
        onConfirm: async () => {
          setConfirm(null);
          try {
            const r = await post<{ deleted: number; bytes: number; fileErrors: string[] }>("/api/attachments/delete", { ...target, confirmCount: s.count, confirmBytes: s.bytes });
            setMessage({
              text: `${r.deleted === 1 ? "1 attachment" : `${num(r.deleted)} attachments`} deleted (${size(r.bytes)}).${r.fileErrors.length ? " Some files could not be removed; see the server log." : ""}`,
            });
            onDone();
          } catch (e) {
            setMessage({ text: (e as Error).message, error: true });
            onDone();
          }
        },
      });
    } catch (e) {
      setMessage({ text: (e as Error).message, error: true });
    }
  };
  const ui = (
    <>
      {message && (
        <div className={message.error ? "error-banner" : "info-banner"} onClick={() => setMessage(null)}>
          {message.text}
        </div>
      )}
      {confirm && <ConfirmDialog data={confirm} onCancel={() => setConfirm(null)} />}
    </>
  );
  return { ask, ui };
}

/** The report's filter as the server's delete call takes it (the same names as the URL). */
function filterOf(params: URLSearchParams): Record<string, string> {
  const f: Record<string, string> = {};
  for (const k of ["type", "from", "min", "inline", "dupes"]) {
    const v = params.get(k);
    if (v) f[k] = v;
  }
  return f;
}

/** Checkboxes: pick rows, or every attachment that matches the filter. */
function useSelection(params: URLSearchParams) {
  const [picked, setPicked] = useState<Map<number, number>>(new Map()); // id -> size
  const [allMatching, setAllMatching] = useState<{ count: number; bytes: number } | null>(null);
  const key = params.toString();
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) {
    // A new filter, sort or page clears the selection.
    setLastKey(key);
    setPicked(new Map());
    setAllMatching(null);
  }
  const clear = () => {
    setPicked(new Map());
    setAllMatching(null);
  };
  return { picked, setPicked, allMatching, setAllMatching, clear };
}

export function AttachmentsTab(props: AdminProps) {
  const { params, setParams, readOnly } = props;
  const [version, setVersion] = useState(0);
  const sel = useSelection(params);
  const del = useAttachmentDelete(() => {
    sel.clear();
    setVersion((v) => v + 1);
  });
  const live = (rows: AttachmentRow[]) => rows.filter((r) => !r.deletedAt);
  const toggle = (r: AttachmentRow) =>
    sel.setPicked((m) => {
      const n = new Map(m);
      if (n.has(r.id)) n.delete(r.id);
      else n.set(r.id, r.size);
      return n;
    });
  const pickedBytes = [...sel.picked.values()].reduce((s, b) => s + b, 0);
  const selectAllMatching = async () => {
    const s = await post<{ count: number; bytes: number }>("/api/attachments/delete-summary", { filter: filterOf(params) });
    sel.setAllMatching(s);
  };
  const selection = readOnly
    ? {}
    : {
        rowStart: (r: AttachmentRow) =>
          r.deletedAt ? null : (
            <input type="checkbox" aria-label={`Select ${r.filename ?? "attachment"}`} checked={!!sel.allMatching || sel.picked.has(r.id)} disabled={!!sel.allMatching} onChange={() => toggle(r)} />
          ),
        headStart: (rows: AttachmentRow[]) => {
          const page = live(rows);
          const all = page.length > 0 && page.every((r) => sel.picked.has(r.id));
          return (
            <input
              type="checkbox"
              aria-label="Select every attachment on this page"
              checked={!!sel.allMatching || all}
              onChange={() => {
                sel.setAllMatching(null);
                sel.setPicked(all ? new Map() : new Map(page.map((r) => [r.id, r.size])));
              }}
            />
          );
        },
        barStart: (rows: AttachmentRow[], total: number) => {
          const page = live(rows);
          const pageAll = page.length > 0 && page.every((r) => sel.picked.has(r.id));
          if (sel.allMatching) {
            return (
              <span className="selection-bar">
                <button className="text-button danger filled" onClick={() => del.ask({ filter: filterOf(params) })}>
                  Delete all {num(sel.allMatching.count)} ({size(sel.allMatching.bytes)})
                </button>
                All {num(sel.allMatching.count)} attachments that match are selected.
                <button className="link-button" onClick={sel.clear}>Clear selection</button>
              </span>
            );
          }
          if (!sel.picked.size) return null;
          return (
            <span className="selection-bar">
              <button className="text-button danger filled" onClick={() => del.ask({ ids: [...sel.picked.keys()] })}>
                Delete selected ({num(sel.picked.size)} file{sel.picked.size === 1 ? "" : "s"}, {size(pickedBytes)})
              </button>
              {pageAll && total > page.length && (
                <button className="link-button" onClick={() => void selectAllMatching()}>
                  Select all {num(total)} attachments that match
                </button>
              )}
            </span>
          );
        },
      };
  return (
    <div className="admin-attachments">
      {del.ui}
      <Summary inline={params.get("inline") === "1"} setParams={setParams} version={version} />
      <section>
        <h2>All attachments</h2>
        <Filters {...props} />
        <AttachmentList
          {...props}
          {...selection}
          version={version}
          rowEnd={readOnly ? undefined : (r) => (r.deletedAt ? null : <button className="link-button danger-link" onClick={() => del.ask({ ids: [r.id] })}>Delete</button>)}
        />
      </section>
    </div>
  );
}
