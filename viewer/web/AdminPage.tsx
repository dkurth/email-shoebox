// The admin page (#/admin): archive statistics, in tabs. Each tab has its own URL.
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { FOLDERS, isCategory, categoryName } from "../shared/labels.ts";
import type { AdminImport, AdminLabel, AdminOverview, AdminPerson } from "../shared/types.ts";
import { get } from "./api.ts";
import { fullDate, size } from "./format.ts";
import { go } from "./route.ts";
import { PeopleTab, PersonPage } from "./AdminPeople.tsx";
import { AttachmentsTab } from "./AdminAttachments.tsx";
import { ImagesTab } from "./AdminImages.tsx";
import { MaintenanceTab } from "./AdminMaintenance.tsx";
import { useScrollMemory } from "./history.ts";

export interface AdminTab {
  id: string;
  name: string;
  render: (p: AdminProps) => ReactNode;
}

export interface AdminProps {
  params: URLSearchParams;
  me: string[];
  readOnly: boolean;
  setParams: (p: Record<string, string | number | boolean | null>) => void;
}

const num = (n: number) => n.toLocaleString();
const date = (epoch: number | null) => (epoch ? new Date(epoch * 1000).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" }) : "—");

export const search = (q: string) => go({ view: `search:${q}` });

/** Bumped when the page shows again after a thread opened from it: the thread may have changed the data. */
const RefreshContext = createContext(0);

/** Load JSON for a tab; reloads when `url` changes. A reload keeps the old data until the new arrives. */
export function useAdminData<T>(url: string): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const refresh = useContext(RefreshContext);
  useEffect(() => {
    let stale = false;
    get<T>(url).then(
      (d) => !stale && (setData(d), setError(null)),
      (e) => !stale && setError((e as Error).message),
    );
    return () => {
      stale = true;
    };
  }, [url, version, refresh]);
  return { data, error, reload: () => setVersion((v) => v + 1) };
}

// ------------------------------------------------------------------ a sortable table

export interface Column<T> {
  key: string;
  label: ReactNode;
  value?: (row: T) => string | number | null; // for sorting (client-side tables)
  render: (row: T) => ReactNode;
  numeric?: boolean;
  sortable?: boolean;
}

export function SortHeader({ label, active, desc, numeric, onClick }: { label: ReactNode; active: boolean; desc: boolean; numeric?: boolean; onClick?: () => void }) {
  return (
    <th className={numeric ? "num" : undefined} aria-sort={active ? (desc ? "descending" : "ascending") : undefined}>
      {onClick ? (
        <button className="sort-button" onClick={onClick}>
          {label}
          {active && (desc ? <ChevronDown size={14} /> : <ChevronUp size={14} />)}
        </button>
      ) : (
        label
      )}
    </th>
  );
}

/** A table sorted in the browser (for small lists: labels, imports). */
export function SortableTable<T>({ rows, columns, initial, rowKey }: { rows: T[]; columns: Column<T>[]; initial: { key: string; desc: boolean }; rowKey: (r: T) => string | number }) {
  const [sort, setSort] = useState(initial);
  const sorted = useMemo(() => {
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.value) return rows;
    const v = col.value;
    return [...rows].sort((a, b) => {
      const x = v(a) ?? "";
      const y = v(b) ?? "";
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { sensitivity: "base" });
      return sort.desc ? -c : c;
    });
  }, [rows, columns, sort]);
  return (
    <table className="admin-table">
      <thead>
        <tr>
          {columns.map((c) => (
            <SortHeader
              key={c.key}
              label={c.label}
              numeric={c.numeric}
              active={sort.key === c.key}
              desc={sort.desc}
              onClick={c.value ? () => setSort((s) => ({ key: c.key, desc: s.key === c.key ? !s.desc : !!c.numeric })) : undefined}
            />
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map((r) => (
          <tr key={rowKey(r)}>
            {columns.map((c) => (
              <td key={c.key} className={c.numeric ? "num" : undefined}>{c.render(r)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function labelView(name: string): string {
  const folder = FOLDERS.find((f) => f.label === name);
  return folder ? folder.id : `label:${name}`;
}

function LabelsTable() {
  const { data, error } = useAdminData<AdminLabel[]>("/api/admin/labels");
  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return <div className="loading">Loading…</div>;
  const columns: Column<AdminLabel>[] = [
    {
      key: "name",
      label: "Label",
      value: (r) => r.name,
      render: (r) => (
        <a href="#" onClick={(e) => { e.preventDefault(); go({ view: labelView(r.name) }); }}>
          {isCategory(r.name) ? `Category: ${categoryName(r.name)}` : r.name}
        </a>
      ),
    },
    { key: "messages", label: "Messages", numeric: true, value: (r) => r.messages, render: (r) => num(r.messages) },
    { key: "threads", label: "Threads", numeric: true, value: (r) => r.threads, render: (r) => num(r.threads) },
    { key: "unread", label: "Unread messages", numeric: true, value: (r) => r.unread, render: (r) => (r.unread ? num(r.unread) : "") },
  ];
  return <SortableTable rows={data} columns={columns} initial={{ key: "messages", desc: true }} rowKey={(r) => r.id} />;
}

export function PersonLink({ addr, dir }: { addr: string; dir: "sent" | "received" }) {
  const q = dir === "sent" ? `in:sent to:${addr}` : `from:${addr}`;
  return (
    <a href="#" title={`Search: ${q}`} onClick={(e) => { e.preventDefault(); search(q); }}>
      {addr}
    </a>
  );
}

function Overview({ setParams }: AdminProps) {
  const { data: o, error } = useAdminData<AdminOverview>("/api/admin/overview");
  if (error) return <div className="error-banner">{error}</div>;
  if (!o) return <div className="loading">Loading…</div>;
  const topColumns: Column<AdminPerson>[] = [
    { key: "addr", label: "Address", render: (r) => <PersonLink addr={r.addr} dir="received" /> },
    { key: "name", label: "Name", render: (r) => r.name },
    { key: "count", label: "Messages", numeric: true, render: (r) => num(r.count) },
  ];
  return (
    <div className="admin-overview">
      <div className="stats">
        <Stat label="Messages" value={num(o.messages)} sub={`${size(o.messageBytes)} as received`} />
        <Stat label="Conversations" value={num(o.threads)} sub={`${num(o.unread)} unread messages · ${num(o.starred)} starred`} />
        <Stat label="Date range" value={`${date(o.firstDate)} – ${date(o.lastDate)}`} />
        <Stat
          label="Attachments"
          value={`${num(o.attachments)} · ${size(o.attachmentBytes)}`}
          sub={
            <>
              {num(o.inlineImages)} images inside email text ({size(o.inlineBytes)})
              {o.deletedAttachments > 0 && <><br />{num(o.deletedAttachments)} deleted ({size(o.deletedBytes)} freed)</>}
            </>
          }
        />
        <Stat
          label="On disk"
          value={size(o.dbBytes + o.walBytes + o.attachmentBytes + o.inlineBytes)}
          sub={
            <>
              mail.db {size(o.dbBytes + o.walBytes)} · attachments {size(o.attachmentBytes + o.inlineBytes)}
              {o.freeBytes > 0 && (
                <>
                  <br />
                  {size(o.freeBytes)} free inside mail.db. Compact the database to recover it
                  {MAINTENANCE_TAB ? (
                    <> (<a href="#" onClick={(e) => { e.preventDefault(); go({ view: "admin", admin: "maintenance" }); }}>Maintenance</a>)</>
                  ) : null}
                  .
                </>
              )}
            </>
          }
        />
        <Stat
          label="Notes"
          value={num(o.notes)}
          sub={
            o.notes > 0 && (
              <>
                Export notes: <a href="/api/admin/notes/export?format=md" download>Markdown</a> · <a href="/api/admin/notes/export?format=csv" download>CSV</a>
              </>
            )
          }
        />
        <Stat label="Parse errors" value={num(o.parseErrorCount)} sub={o.parseErrorCount ? "Messages that could not be fully decoded (listed below)" : "Every message was decoded."} />
      </div>

      {o.parseErrors.length > 0 && (
        <section>
          <h2>Parse errors</h2>
          <table className="admin-table">
            <thead>
              <tr><th>Date</th><th>From</th><th>Subject</th><th>Error</th></tr>
            </thead>
            <tbody>
              {o.parseErrors.map((p) => (
                <tr key={p.id}>
                  <td>{fullDate(p.date)}</td>
                  <td>{p.fromName || p.fromAddr}</td>
                  <td><a href="#" onClick={(e) => { e.preventDefault(); go({ view: "all", threadId: p.threadId }); }}>{p.subject || "(no subject)"}</a></td>
                  <td className="mono">{p.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section>
        <h2>
          Top senders
          {PEOPLE_TAB && (
            <a className="see-all" href="#" onClick={(e) => { e.preventDefault(); setParams({ tab: "people", dir: "received" }); }}>See all</a>
          )}
        </h2>
        <SortableTable rows={o.topSenders} columns={topColumns} initial={{ key: "count", desc: true }} rowKey={(r) => r.addr} />
      </section>

      <section>
        <h2>Labels</h2>
        <LabelsTable />
      </section>
    </div>
  );
}

function duration(a: number, b: number | null): string {
  if (!b) return "—";
  const s = b - a;
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
}

function Imports() {
  const { data, error } = useAdminData<AdminImport[]>("/api/admin/imports");
  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return <div className="loading">Loading…</div>;
  return (
    <table className="admin-table">
      <thead>
        <tr>
          <th>Started</th><th>Took</th><th>Status</th><th>Sources</th><th>Version</th>
          <th className="num">Seen</th><th className="num">New</th><th className="num">Labels changed</th><th className="num">Unchanged</th>
          <th className="num">Skipped</th><th className="num">Errors</th><th className="num">Kept local edits</th><th className="num">Skipped as deleted</th>
        </tr>
      </thead>
      <tbody>
        {data.map((r) => (
          <tr key={r.id} className={r.status === "running" || r.status === "interrupted" || r.status === "failed" ? "warn-row" : undefined}>
            <td>{fullDate(r.startedAt)}</td>
            <td>{duration(r.startedAt, r.finishedAt)}</td>
            <td>{r.status}</td>
            <td title={r.sources.join("\n")}>{r.sources.length > 2 ? `${r.sources.slice(0, 2).join(", ")} +${r.sources.length - 2}` : r.sources.join(", ")}</td>
            <td>{r.toolVersion}</td>
            <td className="num">{num(r.counts.seen)}</td>
            <td className="num">{num(r.counts.inserted)}</td>
            <td className="num">{num(r.counts.labelsChanged)}</td>
            <td className="num">{num(r.counts.unchanged)}</td>
            <td className="num">{num(r.counts.skipped)}</td>
            <td className="num">{num(r.counts.errors)}</td>
            <td className="num">{num(r.counts.keptLocal)}</td>
            <td className="num">{num(r.counts.deletedSkipped)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Tabs that later steps add register here (set to true when the tab exists).
const PEOPLE_TAB = true;
const MAINTENANCE_TAB = true;

export const TABS: AdminTab[] = [
  { id: "overview", name: "Overview", render: (p) => <Overview {...p} /> },
  { id: "people", name: "People", render: (p) => <PeopleTab {...p} /> },
  { id: "attachments", name: "Attachments", render: (p) => <AttachmentsTab {...p} /> },
  { id: "images", name: "Images", render: (p) => <ImagesTab {...p} /> },
  { id: "imports", name: "Imports", render: () => <Imports /> },
  { id: "maintenance", name: "Maintenance", render: (p) => <MaintenanceTab {...p} /> },
];

// Pages under a tab, not shown as tabs themselves.
const PAGES: (AdminTab & { under: string })[] = [{ id: "person", name: "Person", under: "people", render: (p) => <PersonPage {...p} /> }];

/** "people?dir=sent&page=2" → tab "people" and its options. */
export function parseAdminPath(path: string): { tab: string; params: URLSearchParams } {
  const [tab, query] = path.split("?");
  return { tab: tab || "overview", params: new URLSearchParams(query ?? "") };
}

/**
 * hidden: mail is showing. The page stays mounted so going back finds it as it was.
 * scrollKey: this history entry (null while hidden), so Back and Forward return to the same scroll position.
 */
export function AdminPage({ path, me, readOnly, hidden = false, scrollKey }: { path: string; me: string[]; readOnly: boolean; hidden?: boolean; scrollKey: string | null }) {
  const { tab, params } = parseAdminPath(path);
  const body = useRef<HTMLDivElement>(null);
  const scrollTop = useRef(0);
  const [refresh, setRefresh] = useState(0);
  const [wasHidden, setWasHidden] = useState(hidden);
  if (hidden !== wasHidden) {
    setWasHidden(hidden);
    if (!hidden) setRefresh((r) => r + 1);
  }
  useLayoutEffect(() => {
    if (!hidden && body.current) body.current.scrollTop = scrollTop.current;
  }, [hidden]);
  useScrollMemory(body, scrollKey);
  const page = PAGES.find((p) => p.id === tab);
  const current = page ?? TABS.find((t) => t.id === tab) ?? TABS[0];
  const activeTab = page ? page.under : current.id;
  const setParams = (p: Record<string, string | number | boolean | null>) => {
    const next = new URLSearchParams(p.tab && p.tab !== current.id ? "" : params);
    let nextTab = current.id;
    for (const [k, v] of Object.entries(p)) {
      if (k === "tab") nextTab = String(v);
      else if (v === null || v === "" || v === false) next.delete(k);
      else next.set(k, String(v));
    }
    const q = next.toString();
    go({ view: "admin", admin: `${nextTab === "overview" && !q ? "" : nextTab}${q ? `?${q}` : ""}` });
  };
  return (
    <div className="admin-page" hidden={hidden}>
      <nav className="admin-tabs" role="tablist">
        {TABS.map((t) => (
          <a
            key={t.id}
            role="tab"
            aria-selected={t.id === activeTab}
            className={t.id === activeTab ? "active" : undefined}
            href={`#/admin${t.id === "overview" ? "" : `/${t.id}`}`}
          >
            {t.name}
          </a>
        ))}
      </nav>
      <div className="admin-body" ref={body} onScroll={(e) => (scrollTop.current = e.currentTarget.scrollTop)}>
        <RefreshContext.Provider value={refresh}>{current.render({ params, me, readOnly, setParams })}</RefreshContext.Provider>
      </div>
    </div>
  );
}
