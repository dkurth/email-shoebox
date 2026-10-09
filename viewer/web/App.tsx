// The app shell: header, sidebar, toolbar, and either the thread list or one thread.
// Owns routing, data loading, the list cursor and selection, and every action.
import { useCallback, useEffect, useRef, useState } from "react";
import { isUserLabel, removeAction, viewLabel, viewTitle } from "../shared/labels.ts";
import type {
  AppliedChange,
  ModifyResult,
  Session,
  Sidebar as SidebarData,
  SidebarItem,
  ThreadDetail,
  ThreadList as ThreadListData,
  ThreadSummary,
  TrashSummary,
} from "../shared/types.ts";
import { get, post, q } from "./api.ts";
import { size } from "./format.ts";
import { ConfirmDialog, type ConfirmData } from "./ConfirmDialog.tsx";
import { useKeyboard } from "./keyboard.ts";
import { LabelMenu } from "./LabelMenu.tsx";
import { go, parseHash, type Route } from "./route.ts";
import { ShortcutHelp } from "./ShortcutHelp.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { ThreadList } from "./ThreadList.tsx";
import { ThreadView } from "./ThreadView.tsx";
import { Toast, type ToastData } from "./Toast.tsx";

type After = "stay" | "list" | "next";

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [sidebar, setSidebar] = useState<SidebarData | null>(null);
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  const [list, setList] = useState<ThreadListData | null>(null);
  const [thread, setThread] = useState<ThreadDetail | null>(null);
  const [threadVersion, setThreadVersion] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allInView, setAllInView] = useState(false); // "Select all N conversations"
  const [error, setError] = useState<string | null>(null);
  const [listVersion, setListVersion] = useState(0); // bump to reload the list
  const returningFrom = useRef<string | null>(null);
  const [help, setHelp] = useState(false);
  const [labelMenu, setLabelMenu] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmData | null>(null);
  const [toast, setToast] = useState<ToastData | null>(null);
  const lastUndo = useRef<(() => void) | null>(null);

  const readOnly = session?.readOnly ?? true;

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
  useEffect(() => {
    setSelected(new Set());
    setAllInView(false);
  }, [route.view, route.page]);

  useEffect(() => {
    let stale = false;
    get<ThreadListData>("/api/threads" + q({ view: route.view, page: route.page })).then(
      (data) => {
        if (stale) return;
        setList(data);
        setError(null);
        // Coming back from a thread: put the cursor on it. Otherwise keep the position (Gmail moves to the next row).
        const back = returningFrom.current ? data.threads.findIndex((t) => t.threadId === returningFrom.current) : -1;
        returningFrom.current = null;
        setCursor((c) => (back >= 0 ? back : Math.min(c, Math.max(0, data.threads.length - 1))));
      },
      (e) => !stale && setError(e.message),
    );
    return () => {
      stale = true;
    };
  }, [route.view, route.page, listVersion]);

  const showToast = useCallback((text: string, onUndo?: () => void) => {
    lastUndo.current = onUndo ?? null;
    setToast({ id: Date.now(), text, onUndo });
  }, []);

  const reload = useCallback(() => {
    setListVersion((v) => v + 1);
    refreshSidebar();
  }, [refreshSidebar]);

  useEffect(() => {
    if (!route.threadId) {
      if (thread) returningFrom.current = thread.threadId;
      setThread(null);
      return;
    }
    let stale = false;
    const view = route.view;
    get<ThreadDetail>(`/api/threads/${encodeURIComponent(route.threadId)}` + q({ view })).then(
      (t) => {
        if (stale) return;
        setThread(t);
        setError(null);
        // Opening a conversation marks it read, as in Gmail.
        if (session && !session.readOnly && t.messages.some((m) => m.inContext && m.unread)) {
          post<ModifyResult>("/api/threads/modify", { view, threadIds: [t.threadId], add: [], remove: ["Unread"] }).then(reload, (e) => setError(e.message));
        }
      },
      (e) => !stale && setError(e.message),
    );
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.threadId, route.view, threadVersion, session]);

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
  const threads = list?.threads ?? [];
  const pageStart = list ? (list.page - 1) * list.pageSize : 0;
  const allSelected = threads.length > 0 && threads.every((t) => selected.has(t.threadId));

  const toggleSelect = (id: string) => {
    setAllInView(false);
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

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

  // ------------------------------------------------------------ actions

  /** What an action applies to: the open thread, else the selection, else the cursor row. */
  const targetIds = (): string[] => {
    if (route.threadId) return [route.threadId];
    if (selected.size) return [...selected];
    return threads[cursor] ? [threads[cursor].threadId] : [];
  };
  const targetSummaries = (): ThreadSummary[] => {
    const ids = new Set(targetIds());
    return threads.filter((t) => ids.has(t.threadId));
  };

  const undo = (changes: AppliedChange[]) => async () => {
    try {
      await post("/api/undo", { changes });
      setToast(null);
      lastUndo.current = null;
      reload();
      setThreadVersion((v) => v + 1);
      showToast("Action undone.");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const afterAction = (after: After) => {
    const ids = targetIds();
    if (route.threadId) {
      if (after === "list") backToList();
      else if (after === "next") {
        const next = threads[cursor + 1] ?? threads[cursor - 1];
        if (next && next.threadId !== route.threadId) go({ view: route.view, page: route.page, threadId: next.threadId });
        else backToList();
      } else setThreadVersion((v) => v + 1);
    }
    if (ids.length) setSelected(new Set());
    setAllInView(false);
    reload();
  };

  const run = async (url: string, body: object, done: (n: number) => string, after: After, opts: { undo?: boolean } = {}) => {
    if (readOnly) return showToast("This viewer is read-only.");
    const ids = targetIds();
    if (!ids.length && !allInView) return;
    const payload = allInView && !route.threadId ? { ...body, view: route.view, all: true } : { ...body, view: route.view, threadIds: ids };
    try {
      const r = await post<ModifyResult>(url, payload);
      afterAction(after);
      showToast(done(r.threads), opts.undo !== false && r.changes.length ? undo(r.changes) : undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const conv = (n: number) => (n === 1 ? "Conversation" : `${n} conversations`);
  const remove = removeAction(route.view);

  const actions = {
    remove: () => remove && run("/api/threads/modify", { add: remove.add, remove: remove.remove }, remove.done, "list"),
    trash: () => {
      if (route.view === "trash") return deleteForever(allInView ? undefined : targetIds());
      run("/api/threads/modify", { add: ["Trash"], remove: [] }, (n) => `${conv(n)} moved to Trash.`, "next");
    },
    star: () => {
      const ts = route.threadId ? [thread] : targetSummaries();
      const starred = !(route.threadId ? thread?.messages.some((m) => m.starred) : ts[0] && (ts[0] as ThreadSummary).starred);
      // Starring is undone by starring again, so it offers no Undo.
      run("/api/threads/star", { starred }, (n) => `${conv(n)} ${starred ? "starred" : "unstarred"}.`, "stay", { undo: false });
    },
    read: () => run("/api/threads/modify", { add: [], remove: ["Unread"] }, (n) => `${conv(n)} marked as read.`, "stay"),
    unread: () => run("/api/threads/modify", { add: ["Unread"], remove: [], target: "newest" }, (n) => `${conv(n)} marked as unread.`, "list"),
    labels: () => {
      if (readOnly) return showToast("This viewer is read-only.");
      if (targetIds().length || allInView) setLabelMenu(true);
    },
  };

  /** Permanent delete, always confirmed with real numbers first. No threadIds = empty the whole Trash. */
  const deleteForever = async (threadIds?: string[]) => {
    if (readOnly) return showToast("This viewer is read-only.");
    if (threadIds && !threadIds.length) return;
    try {
      const s = await post<TrashSummary>("/api/trash/summary", threadIds ? { threadIds } : {});
      if (!s.messages) return showToast("Nothing to delete.");
      const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;
      setConfirm({
        title: threadIds ? "Delete forever?" : "Empty Trash?",
        body: (
          <p>
            Permanently delete {plural(s.messages, "message")} in {plural(s.threads, "conversation")}
            {s.attachments ? `, including ${plural(s.attachments, "attachment")} (${size(s.attachmentBytes)})` : ""}?{" "}
            <strong>This can't be undone.</strong>
          </p>
        ),
        confirmText: "Delete forever",
        danger: true,
        onConfirm: async () => {
          setConfirm(null);
          try {
            const r = await post<{ messages: number; folderErrors: string[] }>(
              threadIds ? "/api/threads/delete-forever" : "/api/trash/empty",
              threadIds ? { threadIds, confirmCount: s.messages } : { confirmCount: s.messages },
            );
            afterAction(route.threadId ? "list" : "stay");
            showToast(`${plural(r.messages, "message")} deleted forever.${r.folderErrors.length ? " Some attachment files could not be removed; see the server log." : ""}`);
          } catch (e) {
            setError((e as Error).message);
            reload();
          }
        },
      });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const applyLabels = async (add: string[], removeLabels: string[], create: string[]) => {
    setLabelMenu(false);
    try {
      for (const name of create) await post("/api/labels", { name });
      await run("/api/threads/modify", { add, remove: removeLabels }, (n) => `Labels changed on ${conv(n).toLowerCase()}.`, "stay");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const deleteLabel = (item: SidebarItem) =>
    setConfirm({
      title: `Delete the label "${item.name}"?`,
      body: `It will be removed from ${item.messages ?? 0} message${item.messages === 1 ? "" : "s"}. The messages themselves stay.`,
      confirmText: "Delete label",
      danger: true,
      onConfirm: async () => {
        setConfirm(null);
        try {
          await post(`/api/labels/${item.labelId}`, {}, "DELETE");
          if (route.view === item.view) go({ view: "inbox" });
          reload();
          showToast(`Label "${item.name}" deleted.`);
        } catch (e) {
          setError((e as Error).message);
        }
      },
    });

  /** User labels on each target thread, for the Labels menu's checkboxes. */
  const appliedLabels = (): string[][] => {
    const current = viewLabel(route.view);
    const withView = (ls: string[]) => (current && isUserLabel(current) ? [...ls, current] : ls);
    if (route.threadId && thread) return [withView(thread.labels.filter(isUserLabel))];
    return targetSummaries().map((t) => withView(t.labels.filter(isUserLabel)));
  };

  const dialogOpen = help || labelMenu || !!confirm;
  useKeyboard(
    {
      j: () => step(1),
      k: () => step(-1),
      x: () => !route.threadId && threads[cursor] && toggleSelect(threads[cursor].threadId),
      Enter: () => !route.threadId && open(cursor),
      o: () => !route.threadId && open(cursor),
      u: () => route.threadId && backToList(),
      Escape: () => (route.threadId ? backToList() : (setSelected(new Set()), setAllInView(false))),
      "?": () => setHelp(true),
      "#": actions.trash,
      y: actions.remove,
      s: actions.star,
      l: actions.labels,
      I: actions.read,
      U: actions.unread,
      z: () => lastUndo.current?.(),
      "g i": () => go({ view: "inbox" }),
      "g s": () => go({ view: "starred" }),
      "g t": () => go({ view: "sent" }),
      "g a": () => go({ view: "all" }),
      "g d": () => go({ view: "drafts" }),
    },
    !dialogOpen,
  );

  const hasTargets = !!route.threadId || selected.size > 0;

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/inbox">
          <span aria-hidden>✉️</span> Mail archive
        </a>
        {session && <span className="archive-path" title={session.archiveDir}>{session.archiveDir}</span>}
        {session?.readOnly && <span className="badge">read-only</span>}
        <span className="spacer" />
        <button className="icon-button" title="Keyboard shortcuts (?)" onClick={() => setHelp(true)}>
          ⌨️
        </button>
      </header>
      <Sidebar data={sidebar} view={route.view} onDeleteLabel={readOnly ? undefined : deleteLabel} />
      <main className="main">
        <div className="toolbar">
          {route.threadId ? (
            <button className="icon-button" title="Back to list (u)" onClick={backToList}>
              ←
            </button>
          ) : (
            <input
              type="checkbox"
              className="select-all"
              aria-label="Select all"
              checked={allSelected}
              onChange={() => {
                setAllInView(false);
                setSelected(allSelected ? new Set() : new Set(threads.map((t) => t.threadId)));
              }}
            />
          )}
          {hasTargets && !readOnly && (
            <span className="actions">
              {remove && <button className="text-button" title={`${remove.button} (y)`} onClick={actions.remove}>{remove.button}</button>}
              {route.view !== "trash" && <button className="text-button" title="Move to Trash (#)" onClick={actions.trash}>Move to Trash</button>}
              {route.view === "trash" && <button className="text-button danger" title="Delete forever (#)" onClick={actions.trash}>Delete forever</button>}
              <button className="text-button" title="Label as (l)" onClick={actions.labels}>Labels ▾</button>
              <button className="text-button" title="Mark as read (Shift-i)" onClick={actions.read}>Mark read</button>
              <button className="text-button" title="Mark as unread (Shift-u)" onClick={actions.unread}>Mark unread</button>
              <button className="text-button" title="Star (s)" onClick={actions.star}>Star</button>
            </span>
          )}
          <span className="spacer" />
          {list && !route.threadId && (
            <span className="pager">
              {list.total ? `${(pageStart + 1).toLocaleString()}–${(pageStart + threads.length).toLocaleString()} of ${list.total.toLocaleString()}` : ""}
              <button className="icon-button" title="Newer" disabled={list.page <= 1} onClick={() => go({ view: route.view, page: list.page - 1 })}>
                ‹
              </button>
              <button className="icon-button" title="Older" disabled={pageStart + threads.length >= list.total} onClick={() => go({ view: route.view, page: list.page + 1 })}>
                ›
              </button>
            </span>
          )}
        </div>
        {!route.threadId && allSelected && list && list.total > threads.length && (
          <div className="select-banner">
            {allInView ? (
              <>All {list.total.toLocaleString()} conversations in {viewTitle(route.view)} are selected. <button className="link-button" onClick={() => { setAllInView(false); setSelected(new Set()); }}>Clear selection</button></>
            ) : (
              <>All {threads.length} conversations on this page are selected. <button className="link-button" onClick={() => setAllInView(true)}>Select all {list.total.toLocaleString()} conversations in {viewTitle(route.view)}</button></>
            )}
          </div>
        )}
        {route.view === "trash" && !route.threadId && !readOnly && !!list?.total && (
          <div className="trash-bar">
            Conversations stay in Trash until you delete them.
            <button className="link-button" onClick={() => deleteForever()}>Empty Trash now</button>
          </div>
        )}
        {error && <div className="error-banner" onClick={() => setError(null)}>{error}</div>}
        {route.threadId ? (
          thread ? <ThreadView key={thread.threadId} thread={thread} me={me} view={route.view} /> : <div className="loading">Loading…</div>
        ) : list ? (
          <ThreadList
            key={`${route.view}/${route.page}`}
            data={list}
            cursor={cursor}
            selected={selected}
            onToggleSelect={toggleSelect}
            onToggleStar={readOnly ? undefined : (t) => run("/api/threads/star", { starred: !t.starred, threadIds: [t.threadId] }, (n) => `${conv(n)} ${t.starred ? "unstarred" : "starred"}.`, "stay", { undo: false })}
            onCursor={setCursor}
            onOpen={(t) => go({ view: route.view, page: route.page, threadId: t.threadId })}
          />
        ) : (
          <div className="loading">Loading…</div>
        )}
      </main>
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
      {labelMenu && sidebar && (
        <LabelMenu labels={sidebar.labels.map((l) => l.name)} applied={appliedLabels()} onApply={applyLabels} onClose={() => setLabelMenu(false)} />
      )}
      {confirm && <ConfirmDialog data={confirm} onCancel={() => setConfirm(null)} />}
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}
    </div>
  );
}
