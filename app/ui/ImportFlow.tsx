// Choose a backup, name the collection, import it with a progress bar. Used by the welcome page,
// File > Import… (a new collection) and Manage > Import into this collection.
import { FileArchive, FolderOpen, TriangleAlert } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import type { CollectionInfo, ImportRequest, ImportState, QuickLook, ScanResult, StorageInfo } from "../src/shared/api.ts";
import { formatBytes, formatCount, formatDuration } from "../src/shared/format.ts";
import { api, message } from "./api.ts";
import { Header } from "./App.tsx";

interface Props {
  mode: "new" | "into";
  collectionId?: string;
  welcome?: boolean;
}

export function ImportFlow({ mode, collectionId, welcome }: Props) {
  const [paths, setPaths] = useState<string[] | null>(null);
  const [look, setLook] = useState<QuickLook | null>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number } | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const nameEdited = useRef(false);
  const [skip, setSkip] = useState(false);
  const [storageParent, setStorageParent] = useState<string | null>(null);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [state, setState] = useState<ImportState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<CollectionInfo | null>(null);
  const lastRequest = useRef<ImportRequest | null>(null);
  const scanId = useRef(0);

  // An import may already be running (the window was opened again): show it.
  useEffect(() => {
    api().importState().then((s) => s && (s.phase === "running" || s.phase === "stopping") && setState(s));
    return api().onImport(setState);
  }, []);

  useEffect(() => {
    if (mode === "into") api().listCollections().then((list) => setTarget(list.find((c) => c.id === collectionId) ?? null));
  }, [mode, collectionId]);

  useEffect(
    () =>
      api().onScan((e) => {
        if (e.scanId !== scanId.current) return;
        if (e.type === "files") {
          setLook(e.look);
          if (!nameEdited.current) setName(e.fallbackName);
        } else if (e.type === "progress") setScanProgress({ done: e.done, total: e.total });
        else if (e.type === "result") {
          setScan(e.result);
          if (!nameEdited.current) setName(e.defaultName);
        } else if (e.type === "error") setScanError(e.message);
      }),
    [],
  );

  useEffect(() => {
    if (mode === "new") api().storageInfo(storageParent).then(setStorage, (e) => setError(message(e)));
  }, [mode, storageParent]);

  // When the import finishes, open the collection (the main process closes this window).
  useEffect(() => {
    if (state?.phase === "finished") api().openCollection(state.collectionId).catch((e) => setError(message(e)));
  }, [state?.phase, state?.collectionId]);

  async function choose(kind: "file" | "folder") {
    const chosen = await api().chooseInput(kind);
    if (!chosen) return;
    setPaths(chosen);
    setLook(null);
    setScan(null);
    setScanProgress(null);
    setScanError(null);
    setError(null);
    scanId.current = await api().scan(chosen);
  }

  async function start(req: ImportRequest) {
    setError(null);
    lastRequest.current = req;
    try {
      setState(await api().startImport(req));
    } catch (e) {
      setError(message(e));
    }
  }

  function startFromForm() {
    if (!paths) return;
    start({
      mode,
      collectionId,
      paths,
      name: name.trim(),
      skipSpamTrash: skip,
      storageParent,
      mboxCount: scan?.mbox_count ?? look?.mbox_count ?? null,
    });
  }

  async function retry() {
    if (!state) return;
    const exists = (await api().listCollections()).some((c) => c.id === state.collectionId);
    if (exists) start({ mode: "continue", collectionId: state.collectionId, paths: [], skipSpamTrash: false, mboxCount: lastRequest.current?.mboxCount });
    else if (lastRequest.current) start(lastRequest.current);
  }

  const title = welcome ? "Welcome to Email Shoebox" : mode === "into" ? `Import into “${target?.name ?? "…"}”` : "Import a backup";
  const lede = welcome
    ? "Keep your old email in a shoebox, on your own computer."
    : mode === "into"
      ? "Add a newer backup of the same account. Messages already in the collection are skipped."
      : "Each backup you import becomes its own collection.";

  if (state) return <Progress state={state} title={title} onRetry={retry} error={error} />;

  const needed = scan?.uncompressed_bytes ?? look?.uncompressed_bytes ?? look?.bytes_on_disk ?? null;
  const lowSpace = mode === "new" && needed !== null && storage?.freeBytes != null && storage.freeBytes < needed;
  const compressed = paths?.some((p) => /\.(zip|tgz|tar\.gz|gz)$/i.test(p));
  const canImport = !!paths && (mode === "into" || name.trim().length > 0) && !scanError;

  return (
    <div className="page">
      <Header title={title} lede={lede} />

      <section className="card">
        <h2>{welcome ? "Choose your Gmail backup" : "Choose the backup"}</h2>
        {!paths && (
          <p className="muted" style={{ margin: 0 }}>
            Get one from <a href="https://takeout.google.com/" target="_blank" rel="noreferrer">Google Takeout</a>: choose Mail, then download the export.
            You can choose the <code>.zip</code> or <code>.tgz</code> file as it is, or the folder you unzipped it into.
          </p>
        )}
        {paths ? (
          <div className="row">
            <div className="grow">
              {paths.map((p) => (
                <div key={p} className="path">
                  {p}
                </div>
              ))}
            </div>
            <button className="button small" onClick={() => choose("file")}>
              Choose a file…
            </button>
            <button className="button small" onClick={() => choose("folder")}>
              Choose a folder…
            </button>
          </div>
        ) : (
          <div className="big-choices">
            <button className="big-choice" onClick={() => choose("file")}>
              <FileArchive size={28} />
              <strong>Choose a file…</strong>
              <span className="muted small">.mbox, .zip or .tgz</span>
            </button>
            <button className="big-choice" onClick={() => choose("folder")}>
              <FolderOpen size={28} />
              <strong>Choose a folder…</strong>
              <span className="muted small">a folder of .mbox files</span>
            </button>
          </div>
        )}
        {paths && <ScanStatus look={look} scan={scan} progress={scanProgress} error={scanError} />}
      </section>

      {paths && !scanError && (
        <section className="card">
          {mode === "new" && (
            <div className="field">
              <label htmlFor="name">Name this collection</label>
              <input
                id="name"
                type="text"
                value={name}
                placeholder="A name, such as “Personal email”"
                onChange={(e) => {
                  nameEdited.current = true;
                  setName(e.target.value);
                }}
              />
            </div>
          )}
          <label className="check">
            <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
            <span>
              Skip Spam and Trash
              <br />
              <span className="muted small">Leave out messages labeled Spam or Trash.</span>
            </span>
          </label>
          {mode === "new" && (
            <div className="field">
              <label>Store in</label>
              <label className="choice">
                <input type="radio" name="storage" checked={storageParent === null} onChange={() => setStorageParent(null)} />
                Email Shoebox’s folder
              </label>
              <label className="choice">
                <input
                  type="radio"
                  name="storage"
                  checked={storageParent !== null}
                  onChange={async () => {
                    const dir = await api().chooseStorage();
                    if (dir) setStorageParent(dir);
                  }}
                />
                Another folder…
                {storageParent !== null && (
                  <button
                    className="button small"
                    onClick={async (e) => {
                      e.preventDefault();
                      const dir = await api().chooseStorage();
                      if (dir) setStorageParent(dir);
                    }}
                  >
                    Change…
                  </button>
                )}
              </label>
              {storage && (
                <div className="path path-free">
                  <span>{storage.parent.split(/(?<=[/\\])/).map((part, i) => <Fragment key={i}>{part}<wbr /></Fragment>)}</span>
                  {storage.freeBytes !== null && <span className="free">{formatBytes(storage.freeBytes)} free</span>}
                </div>
              )}
            </div>
          )}
          {lowSpace && needed !== null && storage?.freeBytes != null && (
            <div className="notice row">
              <TriangleAlert size={18} />
              <span className="grow">
                The collection will need about {formatBytes(needed)}, but only {formatBytes(storage.freeBytes)} is free on this disk.
                {compressed && " (A compressed backup grows when it is imported.)"} The import may run out of space.
              </span>
            </div>
          )}
        </section>
      )}

      {error && <div className="error">{error}</div>}

      <div className="grow" />
      <div className="buttons">
        <button className="button" onClick={() => api().closeWindow()}>
          {welcome ? "Quit" : "Cancel"}
        </button>
        <button className="button primary" disabled={!canImport} onClick={startFromForm}>
          {lowSpace ? "Import anyway" : "Import"}
        </button>
      </div>
    </div>
  );
}

function years(first: number, last: number): string {
  const a = new Date(first * 1000).getUTCFullYear();
  const b = new Date(last * 1000).getUTCFullYear();
  return a === b ? `in ${a}` : `from ${a} to ${b}`;
}

function ScanStatus(p: { look: QuickLook | null; scan: ScanResult | null; progress: { done: number; total: number } | null; error: string | null }) {
  if (p.error) return <div className="error">{p.error}</div>;
  const count = p.scan?.mbox_count ?? p.look?.mbox_count;
  const size = p.scan?.uncompressed_bytes ?? p.look?.uncompressed_bytes ?? p.look?.bytes_on_disk;
  const summary =
    count != null && size != null ? `Found ${formatCount(count)} mbox file${count === 1 ? "" : "s"}, ${formatBytes(size)}` : size != null ? `${formatBytes(size)} on disk` : null;
  if (p.scan) {
    return (
      <div className="muted">
        {summary}, {formatCount(p.scan.messages)} messages
        {p.scan.first_date !== null && p.scan.last_date !== null && <> {years(p.scan.first_date, p.scan.last_date)}</>}
        .
      </div>
    );
  }
  const pct = p.progress && p.progress.total ? Math.round((100 * p.progress.done) / p.progress.total) : null;
  return (
    <div className="field">
      <div className="muted">
        {summary ? `${summary}. ` : ""}Reading your backup…{pct !== null ? ` ${pct}%` : ""}
      </div>
      <div className={`bar ${pct === null ? "indeterminate" : ""}`}>
        <div style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
      <div className="muted small">You can name the collection and start the import now.</div>
    </div>
  );
}

function Progress({ state, title, onRetry, error }: { state: ImportState; title: string; onRetry: () => void; error: string | null }) {
  const p = state.progress;
  const pct = p && p.bytesTotal ? Math.min(100, Math.floor((100 * p.bytesDone) / p.bytesTotal)) : null;
  const running = state.phase === "running" || state.phase === "stopping";
  const imported = state.counts?.inserted ?? p?.inserted ?? 0;
  return (
    <div className="page">
      <Header title={title} lede={`Collection: ${state.collectionName}`} />
      <section className="card">
        {running && (
          <>
            <div className="row">
              <span className="big-number grow">{pct === null ? "Starting…" : `${pct}%`}</span>
              {p?.secondsLeft != null && state.phase === "running" && <span className="muted">{formatDuration(p.secondsLeft)} left</span>}
            </div>
            <div className={`bar ${pct === null ? "indeterminate" : ""}`} role="progressbar" aria-valuenow={pct ?? undefined} aria-valuemin={0} aria-valuemax={100}>
              <div style={pct === null ? undefined : { width: `${pct}%` }} />
            </div>
            {p && (
              <div className="muted">
                {formatCount(p.messages)} messages read, {formatCount(p.inserted)} new
                {p.mbox && (
                  <>
                    {" · "}
                    {p.mbox}
                    {p.mboxCount && p.mboxCount > 1 ? `, ${p.mboxIndex} of ${p.mboxCount}` : ""}
                  </>
                )}
              </div>
            )}
            {state.phase === "stopping" && <div className="notice">Stopping. The mail imported so far is being saved…</div>}
          </>
        )}
        {state.phase === "finished" && <div>Imported {formatCount(imported)} new messages. Opening the collection…</div>}
        {state.phase === "interrupted" && (
          <div>
            The import stopped. {formatCount(imported)} new messages were imported and kept. You can continue the import now, or later from
            Manage Collections.
          </div>
        )}
        {state.phase === "failed" && <div className="error">{state.error ?? "The import failed."}</div>}
        {error && <div className="error">{error}</div>}
      </section>
      <div className="grow" />
      <div className="buttons">
        {running && (
          <button className="button" disabled={state.phase === "stopping"} onClick={() => api().cancelImport()}>
            Stop
          </button>
        )}
        {state.phase === "failed" && (
          <button className="button" onClick={() => api().showLog()}>
            Show log
          </button>
        )}
        {(state.phase === "interrupted" || state.phase === "failed") && (
          <>
            <button className="button" onClick={() => api().closeWindow()}>
              Close
            </button>
            {state.phase === "interrupted" && (
              <button className="button" onClick={() => api().openCollection(state.collectionId)}>
                Open what was imported
              </button>
            )}
            <button className="button primary" onClick={onRetry}>
              {state.phase === "failed" ? "Retry" : "Continue the import"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
