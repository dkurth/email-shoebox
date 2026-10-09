// The app shell: header, sidebar, toolbar, and either the thread list or one thread.
import { useCallback, useEffect, useRef, useState } from "react";
import { viewTitle } from "../shared/labels.ts";
import type { Session, Sidebar as SidebarData, ThreadDetail, ThreadList as ThreadListData } from "../shared/types.ts";
import { get, q } from "./api.ts";
import { useKeyboard } from "./keyboard.ts";
import { go, parseHash, type Route } from "./route.ts";
import { ShortcutHelp } from "./ShortcutHelp.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { ThreadList } from "./ThreadList.tsx";
import { ThreadView } from "./ThreadView.tsx";

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [sidebar, setSidebar] = useState<SidebarData | null>(null);
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  const [list, setList] = useState<ThreadListData | null>(null);
  const [thread, setThread] = useState<ThreadDetail | null>(null);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [listVersion, setListVersion] = useState(0); // bump to reload the list
  const lastOpened = useRef<string | null>(null);
  const [help, setHelp] = useState(false);

  useEffect(() => {
    if (!location.hash) history.replaceState(null, "", "#/inbox");
    const onHash = () => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", onHash);
    get<Session>("/api/session").then(setSession, (e) => setError(e.message));
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const refreshSidebar = useCallback(() => {
    get<SidebarData>("/api/sidebar").then(setSidebar, (e) => setError(e.message));
  }, []);
  useEffect(refreshSidebar, [refreshSidebar]);

  // Changing folders clears the selection, as in Gmail.
  useEffect(() => setSelected(new Set()), [route.view]);

  useEffect(() => {
    let stale = false;
    get<ThreadListData>("/api/threads" + q({ view: route.view, page: route.page })).then(
      (data) => {
        if (stale) return;
        setList(data);
        setError(null);
        const back = lastOpened.current ? data.threads.findIndex((t) => t.threadId === lastOpened.current) : -1;
        setCursor((c) => (back >= 0 ? back : Math.min(c, Math.max(0, data.threads.length - 1))));
      },
      (e) => !stale && setError(e.message),
    );
    return () => {
      stale = true;
    };
  }, [route.view, route.page, listVersion]);

  useEffect(() => {
    if (!route.threadId) {
      setThread(null);
      return;
    }
    let stale = false;
    lastOpened.current = route.threadId;
    get<ThreadDetail>(`/api/threads/${encodeURIComponent(route.threadId)}` + q({ view: route.view })).then(
      (t) => !stale && (setThread(t), setError(null)),
      (e) => !stale && setError(e.message),
    );
    return () => {
      stale = true;
    };
  }, [route.threadId, route.view]);

  // Keep the list cursor on the open thread (also when it was opened from a URL).
  useEffect(() => {
    if (!route.threadId || !list) return;
    const i = list.threads.findIndex((t) => t.threadId === route.threadId);
    if (i >= 0) setCursor(i);
  }, [route.threadId, list]);

  useEffect(() => {
    const unread = sidebar?.folders.find((f) => f.view === route.view)?.count;
    document.title = `${viewTitle(route.view)}${unread ? ` (${unread})` : ""} - Mail archive`;
  }, [route.view, sidebar]);

  const me = session?.me ?? [];
  const pageStart = list ? (list.page - 1) * list.pageSize : 0;
  const allSelected = !!list?.threads.length && list.threads.every((t) => selected.has(t.threadId));

  const toggleSelect = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const threads = list?.threads ?? [];
  const open = (i: number) => {
    const t = threads[i];
    if (t) go({ view: route.view, page: route.page, threadId: t.threadId });
  };
  const backToList = () => go({ view: route.view, page: route.page });
  // In a thread, j/k open the older/newer conversation from the list.
  const step = (delta: number) => {
    const i = Math.max(0, Math.min(threads.length - 1, cursor + delta));
    setCursor(i);
    if (route.threadId && i !== cursor) open(i);
  };

  useKeyboard(
    {
      j: () => step(1),
      k: () => step(-1),
      x: () => !route.threadId && threads[cursor] && toggleSelect(threads[cursor].threadId),
      Enter: () => !route.threadId && open(cursor),
      o: () => !route.threadId && open(cursor),
      u: () => route.threadId && backToList(),
      Escape: () => (help ? setHelp(false) : route.threadId ? backToList() : setSelected(new Set())),
      "?": () => setHelp((h) => !h),
      "g i": () => go({ view: "inbox" }),
      "g s": () => go({ view: "starred" }),
      "g t": () => go({ view: "sent" }),
      "g a": () => go({ view: "all" }),
      "g d": () => go({ view: "drafts" }),
    },
  );

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/inbox">
          <span aria-hidden>✉️</span> Mail archive
        </a>
        {session && <span className="archive-path" title={session.archiveDir}>{session.archiveDir}</span>}
        {session?.readOnly && <span className="badge">read-only</span>}
      </header>
      <Sidebar data={sidebar} view={route.view} />
      <main className="main">
        <div className="toolbar">
          {route.threadId ? (
            <button className="icon-button" title="Back to list (u)" onClick={() => go({ view: route.view, page: route.page })}>
              ←
            </button>
          ) : (
            <input
              type="checkbox"
              className="select-all"
              aria-label="Select all"
              checked={allSelected}
              onChange={() => setSelected(allSelected ? new Set() : new Set(list?.threads.map((t) => t.threadId)))}
            />
          )}
          <button className="icon-button" title="Refresh" onClick={() => { setListVersion((v) => v + 1); refreshSidebar(); }}>
            ⟳
          </button>
          <span className="spacer" />
          {list && !route.threadId && (
            <span className="pager">
              {list.total ? `${(pageStart + 1).toLocaleString()}–${(pageStart + list.threads.length).toLocaleString()} of ${list.total.toLocaleString()}` : ""}
              <button className="icon-button" title="Newer" disabled={list.page <= 1} onClick={() => go({ view: route.view, page: list.page - 1 })}>
                ‹
              </button>
              <button className="icon-button" title="Older" disabled={pageStart + list.threads.length >= list.total} onClick={() => go({ view: route.view, page: list.page + 1 })}>
                ›
              </button>
            </span>
          )}
        </div>
        {error && <div className="error-banner">{error}</div>}
        {route.threadId ? (
          thread ? <ThreadView key={thread.threadId} thread={thread} me={me} view={route.view} /> : <div className="loading">Loading…</div>
        ) : list ? (
          <ThreadList
            key={`${route.view}/${route.page}`}
            data={list}
            cursor={cursor}
            selected={selected}
            onToggleSelect={toggleSelect}
            onCursor={setCursor}
            onOpen={(t) => go({ view: route.view, page: route.page, threadId: t.threadId })}
          />
        ) : (
          <div className="loading">Loading…</div>
        )}
      </main>
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
    </div>
  );
}
