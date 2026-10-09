// The app shell: header, sidebar, toolbar, and either the thread list or one thread.
// Owns routing, data loading, the list cursor and selection, and every action.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isSearchView, isUserLabel, removeAction, searchQuery, viewLabel, viewTitle } from "../shared/labels.ts";
import { highlightTerms, parseQuery } from "../shared/search.ts";
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
import { ChosenColorsContext, LabelOptions } from "./LabelOptions.tsx";
import { useTheme } from "./theme.ts";
import { NoteButton, NotePanel, useNoteSaver } from "./NotePanel.tsx";
import { SearchBox } from "./SearchBox.tsx";
import { SearchHelp } from "./SearchHelp.tsx";
import { HighlightContext } from "./highlight.tsx";
import { AdminPage } from "./AdminPage.tsx";
import { AttachmentActionsContext } from "./attachmentActions.ts";
import type { AttachmentInfo } from "../shared/types.ts";
import { anyTooBigToSendOnUnload, flushAllOnUnload, onNoteSaved } from "./noteSaver.ts";

function loadFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function saveFlag(key: string, v: boolean) {
  try {
    localStorage.setItem(key, v ? "1" : "0");
  } catch {
    /* private window: just don't remember */
  }
}

type After = "stay" | "list" | "next";

const NO_COLORS = {};

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
  const [labelOptions, setLabelOptions] = useState<{ item: SidebarItem; anchor: DOMRect } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmData | null>(null);
  const [toast, setToast] = useState<ToastData | null>(null);
  const lastUndo = useRef<(() => void) | null>(null);
  const [dark, toggleDark] = useTheme();
  const [noteOpen, setNoteOpen] = useState(() => loadFlag("noteOpen"));
  const [searchHelp, setSearchHelp] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);

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

  const admin = route.view === "admin";

  useEffect(() => {
    if (admin) return;
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
    document.title = `${admin ? "Archive stats" : viewTitle(route.view)}${unread ? ` (${unread})` : ""} - Mail archive`;
  }, [route.view, sidebar, admin]);

  const noteSaver = useNoteSaver(route.threadId ? thread : null, route.threadId);
  const toggleNote = () =>
    setNoteOpen((o) => {
      saveFlag("noteOpen", !o);
      return !o;
    });

  // A note was added, removed or its first line changed: the list icons and the Notes folder change.
  useEffect(() => onNoteSaved(reload), [reload]);

  // Closing or reloading the page: send unsaved notes with keepalive.
  useEffect(() => {
    const onHide = () => flushAllOnUnload();
    const onVisibility = () => document.visibilityState === "hidden" && flushAllOnUnload();
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (anyTooBigToSendOnUnload()) {
        e.preventDefault();
        e.returnValue = ""; // the browser asks "Leave site?"
      }
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, []);

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

  /** keepSelection: the action named its own threads (a row's star), so the checkboxes stay. */
  const afterAction = (after: After, keepSelection = false) => {
    const ids = targetIds();
    if (route.threadId) {
      if (after === "list") backToList();
      else if (after === "next") {
        const next = threads[cursor + 1] ?? threads[cursor - 1];
        if (next && next.threadId !== route.threadId) go({ view: route.view, page: route.page, threadId: next.threadId });
        else backToList();
      } else setThreadVersion((v) => v + 1);
    }
    if (!keepSelection) {
      if (ids.length) setSelected(new Set());
      setAllInView(false);
    }
    reload();
  };

  /** Apply an action to `threadIds`, else the targets. `done` = the message to show, with Undo; null = no message. */
  const run = async (url: string, body: object, done: ((n: number) => string) | null, after: After, threadIds?: string[]) => {
    if (readOnly) return showToast("This viewer is read-only.");
    const ids = threadIds ?? targetIds();
    const all = !threadIds && allInView && !route.threadId;
    if (!ids.length && !all) return;
    const payload = all ? { ...body, view: route.view, all: true } : { ...body, view: route.view, threadIds: ids };
    try {
      const r = await post<ModifyResult>(url, payload);
      afterAction(after, !!threadIds);
      if (done) showToast(done(r.threads), r.changes.length ? undo(r.changes) : undefined);
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
      // No message: the star icon shows the change.
      run("/api/threads/star", { starred }, null, "stay");
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
            {s.attachments ? `, including ${plural(s.attachments, "attachment")} (${size(s.attachmentBytes)})` : ""}
            {s.notes ? `, and ${s.notes === 1 ? "1 note" : `${s.notes} notes`}` : ""}?{" "}
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

  const setLabelColor = async (item: SidebarItem, color: string | null) => {
    setLabelOptions(null);
    try {
      await post(`/api/labels/${item.labelId}/color`, { color });
      refreshSidebar(); // chips get their colors from the sidebar data
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** User labels on each target thread, for the Labels menu's checkboxes. */
  const appliedLabels = (): string[][] => {
    const current = viewLabel(route.view);
    const withView = (ls: string[]) => (current && isUserLabel(current) ? [...ls, current] : ls);
    if (route.threadId && thread) return [withView(thread.labels.filter(isUserLabel))];
    return targetSummaries().map((t) => withView(t.labels.filter(isUserLabel)));
  };

  const query = isSearchView(route.view) ? searchQuery(route.view) : "";
  const terms = useMemo(() => (query ? highlightTerms(parseQuery(query)) : []), [query]);
  const search = (q: string) => go({ view: `search:${q}` });
  const hiddenInTrashOrSpam = (list as { hiddenInTrashOrSpam?: number } | null)?.hiddenInTrashOrSpam ?? 0;

  const DELETED_TEXT = "The attached file was deleted from the archive, but the email thread was preserved.";
  const attachmentActions = {
    onDeletedClick: () =>
      setConfirm({ title: "Attachment deleted", body: <p>{DELETED_TEXT}</p>, confirmText: "OK", noCancel: true, onConfirm: () => setConfirm(null) }),
    onDelete: readOnly
      ? undefined
      : (a: AttachmentInfo) =>
          setConfirm({
            title: "Delete attachment?",
            body: (
              <p>
                Delete "{a.filename || "(no name)"}" ({size(a.size)}) from the archive? The email will be kept. <strong>This can't be undone.</strong>
              </p>
            ),
            confirmText: "Delete attachment",
            danger: true,
            onConfirm: async () => {
              setConfirm(null);
              try {
                const r = await post<{ deleted: number; fileErrors: string[] }>("/api/attachments/delete", { ids: [a.id], confirmCount: 1, confirmBytes: a.size });
                setThreadVersion((v) => v + 1);
                showToast(`Attachment deleted.${r.fileErrors.length ? " The file could not be removed; see the server log." : ""}`);
              } catch (e) {
                setError((e as Error).message);
              }
            },
          }),
  };

  const dialogOpen = help || labelMenu || !!confirm || !!labelOptions || searchHelp;
  const goKeys = {
    "g i": () => go({ view: "inbox" }),
    "g s": () => go({ view: "starred" }),
    "g t": () => go({ view: "sent" }),
    "g a": () => go({ view: "all" }),
    "g d": () => go({ view: "drafts" }),
    "g z": () => go({ view: "admin" }),
  };
  useKeyboard(
    admin
      ? { "?": () => setHelp(true), "/": () => searchInput.current?.focus(), ...goKeys }
      : {
      j: () => step(1),
      k: () => step(-1),
      x: () => !route.threadId && threads[cursor] && toggleSelect(threads[cursor].threadId),
      Enter: () => !route.threadId && open(cursor),
      o: () => !route.threadId && open(cursor),
      u: () => route.threadId && backToList(),
      Escape: () => (route.threadId ? backToList() : (setSelected(new Set()), setAllInView(false))),
      "?": () => setHelp(true),
      "/": () => searchInput.current?.focus(),
      "#": actions.trash,
      y: actions.remove,
      s: actions.star,
      l: actions.labels,
      I: actions.read,
      U: actions.unread,
      z: () => lastUndo.current?.(),
      ...goKeys,
    },
    !dialogOpen,
  );

  const hasTargets = !!route.threadId || selected.size > 0;

  return (
    <ChosenColorsContext.Provider value={sidebar?.labelColors ?? NO_COLORS}>
      <div className="app">
        <header className="topbar">
          <a className="brand" href="#/inbox">
            <span aria-hidden>✉️</span> Mail archive
          </a>
          {session && <span className="archive-path" title={session.archiveDir}>{session.archiveDir}</span>}
          {session?.readOnly && <span className="badge">read-only</span>}
          <SearchBox ref={searchInput} query={query} onSearch={search} onHelp={() => setSearchHelp(true)} />
          <span className="spacer" />
          <button className="icon-button" aria-label="Archive stats" title="Archive stats (g then z)" aria-pressed={admin} onClick={() => go({ view: "admin" })}>
            📊
          </button>
          <button className="icon-button" aria-label="Dark mode" aria-pressed={dark} title={dark ? "Dark mode is on" : "Dark mode is off"} onClick={toggleDark}>
            🌙
          </button>
          <button className="icon-button" title="Keyboard shortcuts (?)" onClick={() => setHelp(true)}>
            ⌨️
          </button>
        </header>
        <Sidebar
          data={sidebar}
          view={route.view}
          onLabelOptions={readOnly ? undefined : (item, anchor) => setLabelOptions({ item, anchor })}
          optionsFor={labelOptions?.item.name}
        />
        <main className="main">
          <HighlightContext.Provider value={terms}>
          <AttachmentActionsContext.Provider value={attachmentActions}>
          {admin ? (
            <AdminPage path={route.admin ?? ""} me={me} readOnly={readOnly} />
          ) : (
          <>
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
            {route.threadId && noteSaver && <NoteButton saver={noteSaver} open={noteOpen} onToggle={toggleNote} />}
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
            thread ? (
              <div className="thread-area">
                <ThreadView key={thread.threadId} thread={thread} me={me} view={route.view} onToggleStar={readOnly ? undefined : actions.star} />
                {noteOpen && noteSaver && noteSaver.threadId === thread.threadId && (
                  <NotePanel key={thread.threadId} saver={noteSaver} readOnly={readOnly} />
                )}
              </div>
            ) : (
              <div className="loading">Loading…</div>
            )
          ) : list ? (
            <ThreadList
              key={`${route.view}/${route.page}`}
              data={list}
              cursor={cursor}
              selected={selected}
              onToggleSelect={toggleSelect}
              onToggleStar={readOnly ? undefined : (t) => run("/api/threads/star", { starred: !t.starred }, null, "stay", [t.threadId])}
              onCursor={setCursor}
              onOpen={(t) => go({ view: route.view, page: route.page, threadId: t.threadId })}
              noteSnippets={route.view === "notes"}
              emptyText={
                query ? (
                  <>
                    No messages matched your search.
                    {hiddenInTrashOrSpam > 0 && (
                      <div className="hidden-matches">
                        Some messages in Trash or Spam match your search.{" "}
                        <button className="link-button" onClick={() => search(`in:anywhere ${query}`)}>View messages</button>
                      </div>
                    )}
                  </>
                ) : undefined
              }
            />
          ) : (
            <div className="loading">Loading…</div>
          )}
          </>
          )}
          </AttachmentActionsContext.Provider>
          </HighlightContext.Provider>
        </main>
        {help && <ShortcutHelp onClose={() => setHelp(false)} />}
        {searchHelp && (
          <SearchHelp
            onClose={() => setSearchHelp(false)}
            onExample={(q) => {
              setSearchHelp(false);
              search(q);
            }}
          />
        )}
        {labelMenu && sidebar && (
          <LabelMenu labels={sidebar.labels.map((l) => l.name)} applied={appliedLabels()} onApply={applyLabels} onClose={() => setLabelMenu(false)} />
        )}
        {labelOptions && sidebar && (
          <LabelOptions
            item={labelOptions.item}
            anchor={labelOptions.anchor}
            chosen={sidebar.labelColors}
            onColor={(color) => setLabelColor(labelOptions.item, color)}
            onDelete={() => {
              setLabelOptions(null);
              deleteLabel(labelOptions.item);
            }}
            onClose={() => setLabelOptions(null)}
          />
        )}
        {confirm && <ConfirmDialog data={confirm} onCancel={() => setConfirm(null)} />}
        {toast && <Toast toast={toast} onClose={() => setToast(null)} />}
      </div>
    </ChosenColorsContext.Provider>
  );
}
