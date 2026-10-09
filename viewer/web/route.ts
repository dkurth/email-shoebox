// URL hash <-> route. Examples: #/inbox  #/inbox/p2  #/label/Work%2FProjects/t/1790000000000000001
// The admin page: #/admin, #/admin/people?dir=sent&page=2 (view "admin", the rest in `admin`).
export interface Route {
  view: string; // folder id, "label:<name>", "search:<query>" or "admin"
  page: number;
  threadId: string | null;
  admin?: string; // the admin page's tab and options, e.g. "people?dir=sent"
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  if (raw === "admin" || raw.startsWith("admin/") || raw.startsWith("admin?")) {
    return { view: "admin", page: 1, threadId: null, admin: raw.slice("admin".length).replace(/^\//, "") };
  }
  const parts = raw.split("/").filter(Boolean);
  let view = "inbox";
  if (parts[0] === "label" && parts[1]) {
    view = "label:" + decodeURIComponent(parts[1]);
    parts.splice(0, 2);
  } else if (parts[0] === "search" && parts[1]) {
    view = "search:" + decodeURIComponent(parts[1]);
    parts.splice(0, 2);
  } else if (parts[0]) {
    view = parts.shift()!;
  }
  let page = 1;
  if (parts[0] && /^p\d+$/.test(parts[0])) page = Math.max(1, Number(parts.shift()!.slice(1)));
  const threadId = parts[0] === "t" && parts[1] ? decodeURIComponent(parts[1]) : null;
  return { view, page, threadId };
}

export function toHash(r: Partial<Route> & { view: string }): string {
  if (r.view === "admin") return `#/admin${r.admin ? `/${r.admin}` : ""}`;
  const v = r.view.startsWith("label:")
    ? `label/${encodeURIComponent(r.view.slice(6))}`
    : r.view.startsWith("search:")
      ? `search/${encodeURIComponent(r.view.slice(7))}`
      : r.view;
  return `#/${v}${r.page && r.page > 1 ? `/p${r.page}` : ""}${r.threadId ? `/t/${encodeURIComponent(r.threadId)}` : ""}`;
}

export function go(r: Partial<Route> & { view: string }): void {
  location.hash = toHash(r);
}
