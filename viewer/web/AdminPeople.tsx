// The admin page's People tab: who you sent to, who you received from, and mailing lists.
// Plus the page for one person (#/admin/person?addr=…).
import { useEffect, useState } from "react";
import type { AdminList, AdminPerson, AdminPersonDetail } from "../shared/types.ts";
import { q as query } from "./api.ts";
import { fullDate, size } from "./format.ts";
import { go } from "./route.ts";
import { PersonLink, SortHeader, search, useAdminData, type AdminProps } from "./AdminPage.tsx";

const num = (n: number) => n.toLocaleString();
const day = (epoch: number | null) => (epoch ? new Date(epoch * 1000).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" }) : "—");
const PAGE = 100;

function Pager({ page, total, onPage }: { page: number; total: number; onPage: (p: number) => void }) {
  const start = (page - 1) * PAGE;
  if (total <= PAGE) return <span className="pager">{total ? `${num(total)}` : ""}</span>;
  return (
    <span className="pager">
      {num(start + 1)}–{num(Math.min(total, start + PAGE))} of {num(total)}
      <button className="icon-button" title="Previous" disabled={page <= 1} onClick={() => onPage(page - 1)}>‹</button>
      <button className="icon-button" title="Next" disabled={start + PAGE >= total} onClick={() => onPage(page + 1)}>›</button>
    </span>
  );
}

const personPage = (addr: string) => go({ view: "admin", admin: `person?addr=${encodeURIComponent(addr)}` });

function PeopleTable({ dir, chats, byDomain }: { dir: "sent" | "received"; chats: boolean; byDomain: boolean }) {
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ key: string; desc: boolean }>({ key: "count", desc: true });
  const [page, setPage] = useState(1);
  const url =
    "/api/admin/people" +
    query({ dir, q: filter, sort: sort.key, desc: sort.desc ? 1 : 0, page, chats: chats ? 1 : 0, domain: byDomain ? 1 : 0 });
  const { data, error } = useAdminData<{ rows: AdminPerson[]; total: number }>(url);
  const header = (key: string, label: string, numeric = false) => (
    <SortHeader
      label={label}
      numeric={numeric}
      active={sort.key === key}
      desc={sort.desc}
      onClick={() => {
        setPage(1);
        setSort((s) => ({ key, desc: s.key === key ? !s.desc : numeric || key === "last" }));
      }}
    />
  );
  const domainSearch = (d: string) => search(dir === "sent" ? `in:sent to:@${d}` : `from:@${d}`);
  return (
    <section className="people-table">
      <h2 className="table-head">
        <input
          className="table-filter"
          placeholder={byDomain ? "Filter domains" : "Filter by address or name"}
          aria-label={`Filter ${dir === "sent" ? "people I sent to" : "people I received from"}`}
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setPage(1);
          }}
        />
        {data && <Pager page={page} total={data.total} onPage={setPage} />}
      </h2>
      {error && <div className="error-banner">{error}</div>}
      {!data ? (
        <div className="loading">Loading…</div>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              {header("addr", byDomain ? "Domain" : "Address")}
              {header("name", byDomain ? "Most common name" : "Name")}
              {header("count", dir === "sent" ? "Total" : "Messages", true)}
              {dir === "sent" && header("to", "To", true)}
              {dir === "sent" && header("cc", "Cc", true)}
              {dir === "sent" && header("bcc", "Bcc", true)}
              {header("last", "Last")}
              {dir === "received" && header("attachmentBytes", "Attachments", true)}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.addr}>
                <td>
                  {byDomain ? (
                    <a href="#" onClick={(e) => { e.preventDefault(); domainSearch(r.addr); }}>@{r.addr}</a>
                  ) : (
                    <PersonLink addr={r.addr} dir={dir} />
                  )}
                  {byDomain && <span className="muted-small"> {num(r.addresses)} address{r.addresses === 1 ? "" : "es"}</span>}
                </td>
                <td>
                  {byDomain || !r.name ? (
                    r.name
                  ) : (
                    <a href="#" title="About this person" onClick={(e) => { e.preventDefault(); personPage(r.addr); }}>{r.name}</a>
                  )}
                </td>
                <td className="num">{num(r.count)}</td>
                {dir === "sent" && (
                  <>
                    <td className="num">{r.to ? num(r.to) : ""}</td>
                    <td className="num">{r.cc ? num(r.cc) : ""}</td>
                    <td className="num">{r.bcc ? num(r.bcc) : ""}</td>
                  </>
                )}
                <td>{day(r.last)}</td>
                {dir === "received" && <td className="num">{r.attachments ? `${num(r.attachments)} · ${size(r.attachmentBytes)}` : ""}</td>}
              </tr>
            ))}
            {!data.rows.length && (
              <tr><td colSpan={dir === "sent" ? 7 : 5} className="muted-small">Nothing matches.</td></tr>
            )}
          </tbody>
        </table>
      )}
    </section>
  );
}

function ListsTable() {
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ key: string; desc: boolean }>({ key: "messages", desc: true });
  const [page, setPage] = useState(1);
  const { data, error } = useAdminData<{ rows: AdminList[]; total: number }>(
    "/api/admin/lists" + query({ q: filter, sort: sort.key, desc: sort.desc ? 1 : 0, page }),
  );
  const header = (key: string, label: string, numeric = false) => (
    <SortHeader
      label={label}
      numeric={numeric}
      active={sort.key === key}
      desc={sort.desc}
      onClick={() => {
        setPage(1);
        setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== "name" }));
      }}
    />
  );
  return (
    <section>
      <h2>
        Mailing lists
        <input className="table-filter" placeholder="Filter lists" aria-label="Filter mailing lists" value={filter} onChange={(e) => { setFilter(e.target.value); setPage(1); }} />
        {data && <Pager page={page} total={data.total} onPage={setPage} />}
      </h2>
      {error && <div className="error-banner">{error}</div>}
      {!data ? (
        <div className="loading">Loading…</div>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              {header("name", "List")}
              {header("messages", "Messages", true)}
              {header("unread", "Unread", true)}
              {header("first", "First")}
              {header("last", "Last")}
              {header("bytes", "Size", true)}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.listId}>
                <td>
                  <a href="#" onClick={(e) => { e.preventDefault(); search(`list:${r.listId}`); }}>{r.name || r.listId}</a>
                  {r.name && <div className="muted-small">{r.listId}</div>}
                </td>
                <td className="num">{num(r.messages)}</td>
                <td className="num">{r.unread ? num(r.unread) : ""}</td>
                <td>{day(r.first)}</td>
                <td>{day(r.last)}</td>
                <td className="num">{size(r.bytes)}</td>
              </tr>
            ))}
            {!data.rows.length && (
              <tr><td colSpan={6} className="muted-small">No mailing lists{filter ? " match" : ""}.</td></tr>
            )}
          </tbody>
        </table>
      )}
    </section>
  );
}

const DIR_KEY = "admin.people.dir";

function savedDir(): "sent" | "received" {
  try {
    return localStorage.getItem(DIR_KEY) === "received" ? "received" : "sent";
  } catch {
    return "sent"; // storage blocked (private window): the default
  }
}

export function PeopleTab({ params, setParams }: AdminProps) {
  const chats = params.get("chats") === "1";
  const byDomain = params.get("domain") === "1";
  // The URL wins (links such as "See all" set it); else the tab you used last time.
  const fromUrl = params.get("dir");
  const dir = fromUrl === "sent" || fromUrl === "received" ? fromUrl : savedDir();
  useEffect(() => {
    try {
      localStorage.setItem(DIR_KEY, dir);
    } catch {
      /* not remembered: fine */
    }
  }, [dir]);
  const tab = (d: "sent" | "received", label: string) => (
    <button role="tab" aria-selected={dir === d} className={dir === d ? "active" : undefined} onClick={() => setParams({ dir: d })}>
      {label}
    </button>
  );
  return (
    <div className="admin-people">
      <div className="people-tabs" role="tablist" aria-label="People">
        {tab("sent", "People I sent to")}
        {tab("received", "People I received from")}
      </div>
      <div className="admin-options">
        <label>
          <input type="checkbox" checked={byDomain} onChange={(e) => setParams({ domain: e.target.checked ? 1 : null })} /> Group by domain
        </label>
        <label>
          <input type="checkbox" checked={chats} onChange={(e) => setParams({ chats: e.target.checked ? 1 : null })} /> Include chats
        </label>
      </div>
      <PeopleTable key={`${dir}${chats}${byDomain}`} dir={dir} chats={chats} byDomain={byDomain} />
      <ListsTable />
    </div>
  );
}

export function PersonPage({ params }: AdminProps) {
  const addr = params.get("addr") ?? "";
  const { data: p, error } = useAdminData<AdminPersonDetail>("/api/admin/person" + query({ addr }));
  if (error) return <div className="error-banner">{error}</div>;
  if (!p) return <div className="loading">Loading…</div>;
  const name = p.names[0]?.name ?? p.addr;
  return (
    <div className="person-page">
      <a href="#/admin/people" className="back-link">← People</a>
      <h1>{name}</h1>
      <div className="muted">{p.addr}</div>
      {p.names.length > 1 && <div className="muted-small">Also written as: {p.names.slice(1).map((n) => n.name).join(", ")}</div>}
      <div className="person-links">
        <button className="text-button" onClick={() => search(`from:${p.addr}`)}>Mail from them</button>
        <button className="text-button" onClick={() => search(`in:sent to:${p.addr}`)}>Mail you sent them</button>
        <button className="text-button" onClick={() => search(`from:${p.addr} OR to:${p.addr}`)}>All mail with them</button>
      </div>
      <div className="stats">
        <div className="stat"><div className="stat-label">Messages</div><div className="stat-value">{num(p.messages)}</div></div>
        <div className="stat"><div className="stat-label">First contact</div><div className="stat-value">{day(p.first)}</div></div>
        <div className="stat"><div className="stat-label">Last contact</div><div className="stat-value">{day(p.last)}</div></div>
      </div>
      <div className="person-columns">
        <section>
          <h2>Per year</h2>
          <table className="admin-table">
            <thead><tr><th>Year</th><th className="num">Received</th><th className="num">Sent</th></tr></thead>
            <tbody>
              {p.years.map((y) => (
                <tr key={y.year}><td>{y.year}</td><td className="num">{y.received ? num(y.received) : ""}</td><td className="num">{y.sent ? num(y.sent) : ""}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
        <section>
          <h2>Their labels</h2>
          {p.labels.length ? (
            <table className="admin-table">
              <thead><tr><th>Label</th><th className="num">Messages</th></tr></thead>
              <tbody>
                {p.labels.map((l) => (
                  <tr key={l.name}>
                    <td><a href="#" onClick={(e) => { e.preventDefault(); search(`label:"${l.name}" (from:${p.addr} OR to:${p.addr})`); }}>{l.name}</a></td>
                    <td className="num">{num(l.n)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="muted-small">None of their mail has one of your labels.</div>
          )}
        </section>
      </div>
      <section>
        <h2>Their biggest attachments</h2>
        {p.attachments.length ? (
          <table className="admin-table">
            <thead><tr><th>File</th><th className="num">Size</th><th>Date</th><th>Subject</th><th /></tr></thead>
            <tbody>
              {p.attachments.map((x) => (
                <tr key={x.id}>
                  <td>{x.filename || "(no name)"}</td>
                  <td className="num">{size(x.size)}</td>
                  <td>{fullDate(x.date)}</td>
                  <td>{x.subject || "(no subject)"}</td>
                  <td className="row-actions">
                    <a href="#" onClick={(e) => { e.preventDefault(); go({ view: "all", threadId: x.threadId }); }}>Open email</a>
                    <a href={`/api/attachments/${x.id}/download`} download={x.filename ?? ""}>Download</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="muted-small">No attachments from them.</div>
        )}
      </section>
    </div>
  );
}
