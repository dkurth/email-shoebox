// The admin page's Images tab: a grid of every image attachment, newest first, with the lightbox.
import { useState } from "react";
import type { GalleryPage } from "../shared/types.ts";
import { q as query } from "./api.ts";
import { fullDate, size } from "./format.ts";
import { Lightbox } from "./Lightbox.tsx";
import { go } from "./route.ts";
import { useAdminData, type AdminProps } from "./AdminPage.tsx";
import { useAttachmentDelete } from "./AdminAttachments.tsx";

const num = (n: number) => n.toLocaleString();
const PAGE = 100;

export function ImagesTab({ params, setParams, readOnly }: AdminProps) {
  const [version, setVersion] = useState(0);
  const [viewing, setViewing] = useState<number | null>(null);
  const del = useAttachmentDelete(() => setVersion((v) => v + 1));
  const page = Number(params.get("page") ?? 1);
  // Two filters are on by default: hide images inside the email text, and images under 20 KB.
  const inline = params.get("inline") === "1";
  const small = params.get("small") === "1";
  const from = params.get("from") ?? "";
  const year = params.get("year") ?? "";
  const { data, error } = useAdminData<GalleryPage>(
    "/api/admin/images" + query({ from, year, inline: inline ? 1 : 0, small: small ? 1 : 0, page, v: version }),
  );
  const [fromText, setFromText] = useState(from);
  if (error) return <div className="error-banner">{error}</div>;
  const images = data?.images ?? [];
  const start = (page - 1) * PAGE;
  const index = viewing === null ? null : Math.min(viewing, images.length - 1);
  const toPage = (p: number) => {
    setParams({ page: p > 1 ? p : null });
    document.querySelector(".admin-body")?.scrollTo(0, 0); // a new page starts at the top
  };
  // The same pager above and below the grid.
  const pager = data && (
    <span className="pager">
      {data.total ? `${num(start + 1)}–${num(Math.min(data.total, start + PAGE))} of ${num(data.total)}` : "No images match."}
      <button className="icon-button" title="Newer" disabled={page <= 1} onClick={() => toPage(page - 1)}>‹</button>
      <button className="icon-button" title="Older" disabled={start + PAGE >= data.total} onClick={() => toPage(page + 1)}>›</button>
    </span>
  );
  return (
    <div className="admin-images">
      {del.ui}
      <div className="report-filters">
        <form onSubmit={(e) => { e.preventDefault(); setParams({ from: fromText.trim() || null, page: null }); }}>
          <label>
            Sender{" "}
            <input className="table-filter" list="gallery-senders" value={fromText} placeholder="any" aria-label="Sender"
              onChange={(e) => setFromText(e.target.value)} onBlur={(e) => e.currentTarget.form?.requestSubmit()} />
          </label>
          <datalist id="gallery-senders">{data?.senders.map((s) => <option key={s} value={s} />)}</datalist>
        </form>
        <label>
          Year{" "}
          <select value={year} onChange={(e) => setParams({ year: e.target.value || null, page: null })}>
            <option value="">All</option>
            {data?.years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={!inline} onChange={(e) => setParams({ inline: e.target.checked ? null : 1, page: null })} /> Hide images inside the email text
        </label>
        <label>
          <input type="checkbox" checked={!small} onChange={(e) => setParams({ small: e.target.checked ? null : 1, page: null })} /> Hide images under 20 KB
        </label>
        {pager}
      </div>
      {!data ? (
        <div className="loading">Loading…</div>
      ) : (
        <ul className="gallery">
          {images.map((im, i) => (
            <li key={im.id}>
              <button className="tile" title={`${im.filename ?? ""} · ${im.fromName || im.fromAddr || ""}`} onClick={() => setViewing(i)}>
                <img src={`/api/attachments/${im.id}/inline`} alt={im.filename ?? "image"} loading="lazy" decoding="async" />
              </button>
              <div className="tile-date">{im.date ? new Date(im.date * 1000).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" }) : ""}</div>
            </li>
          ))}
        </ul>
      )}
      {data && data.total > 0 && <div className="gallery-footer">{pager}</div>}
      {index !== null && index >= 0 && images[index] && (
        <Lightbox
          items={images.map((im) => ({
            id: im.id,
            name: im.filename || "(no name)",
            size: im.size,
            details: (
              <>
                {fullDate(im.date)} · {im.fromName || im.fromAddr} · {im.subject || "(no subject)"} · {im.filename} ({size(im.size)})
              </>
            ),
          }))}
          index={index}
          onIndex={setViewing}
          onClose={() => setViewing(null)}
          actions={(item) => {
            const im = images.find((x) => x.id === item.id)!;
            return (
              <>
                <button className="text-button" onClick={() => go({ view: "all", threadId: im.threadId })}>Open email</button>
                {!readOnly && (
                  <button className="text-button" onClick={() => del.ask({ ids: [im.id] })}>Delete</button>
                )}
              </>
            );
          }}
        />
      )}
    </div>
  );
}
