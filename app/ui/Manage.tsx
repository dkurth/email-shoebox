// Manage Collections: rename, import into, continue, show in the file manager, remove from the list, delete.
import { useEffect, useState } from "react";
import type { CollectionInfo } from "../src/shared/api.ts";
import { formatBytes, formatCount } from "../src/shared/format.ts";
import { api, message } from "./api.ts";
import { Header } from "./App.tsx";

const FILE_MANAGER: Record<string, string> = { darwin: "Show in Finder", win32: "Show in Explorer" };

export function Manage() {
  const [list, setList] = useState<CollectionInfo[] | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api().listCollections(true).then(setList, (e) => setError(message(e)));
  useEffect(() => {
    load();
    return api().onCollectionsChanged(load);
  }, []);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    }
    load();
  }

  async function saveName() {
    if (!renaming) return;
    const { id, name } = renaming;
    await run(async () => {
      await api().renameCollection(id, name);
      setRenaming(null);
    });
  }

  return (
    <div className="page">
      <Header title="Manage Collections" lede="Each collection is one imported backup, kept in its own folder." />
      {error && <div className="error">{error}</div>}
      <div className="collections">
        {list?.length === 0 && <div className="muted">There are no collections yet. Import a backup to make one.</div>}
        {list?.map((c) => (
          <div className="collection" key={c.id} data-testid="collection">
            {renaming?.id === c.id ? (
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  saveName();
                }}
              >
                <input
                  type="text"
                  className="grow"
                  style={{ width: "auto" }}
                  aria-label="New name"
                  autoFocus
                  value={renaming.name}
                  onChange={(e) => setRenaming({ id: c.id, name: e.target.value })}
                  onKeyDown={(e) => e.key === "Escape" && setRenaming(null)}
                />
                <button className="button small primary" type="submit">
                  Save
                </button>
                <button className="button small" type="button" onClick={() => setRenaming(null)}>
                  Cancel
                </button>
              </form>
            ) : (
              <div className="title">
                <strong>{c.name}</strong>
                {c.current && <span className="badge">Open now</span>}
                {c.incomplete && <span className="badge warn">Import not finished</span>}
                {c.missing && <span className="badge warn">Not found</span>}
              </div>
            )}
            <div className="path">{c.path}</div>
            <div className="muted small">
              {c.missing
                ? "The folder isn’t there. It may have been moved, or be on a drive that isn’t connected."
                : [c.messages !== null && `${formatCount(c.messages)} messages`, c.sizeBytes !== null && formatBytes(c.sizeBytes)].filter(Boolean).join(" · ")}
            </div>
            <div className="actions">
              {c.missing ? (
                <button className="button small" onClick={() => run(() => api().locateCollection(c.id))}>
                  Locate…
                </button>
              ) : (
                <>
                  {!c.current && (
                    <button className="button small" onClick={() => run(() => api().openCollection(c.id))}>
                      Open
                    </button>
                  )}
                  <button className="button small" onClick={() => setRenaming({ id: c.id, name: c.name })}>
                    Rename
                  </button>
                  {c.incomplete ? (
                    <button
                      className="button small"
                      onClick={() =>
                        run(async () => {
                          await api().startImport({ mode: "continue", collectionId: c.id, paths: [], skipSpamTrash: false });
                          location.hash = `#/into?id=${c.id}`; // shows the progress
                        })
                      }
                    >
                      Continue the import
                    </button>
                  ) : (
                    <button className="button small" onClick={() => (location.hash = `#/into?id=${c.id}`)}>
                      Import into this collection…
                    </button>
                  )}
                  <button className="button small" onClick={() => run(() => api().showInFolder(c.id))}>
                    {FILE_MANAGER[api().platform] ?? "Show the folder"}
                  </button>
                </>
              )}
              <button className="button small" onClick={() => run(() => api().removeCollection(c.id))} title="Forget this collection. Its files stay on the disk.">
                Remove from list
              </button>
              {!c.missing && (
                <button className="button small danger" onClick={() => run(() => api().deleteCollection(c.id))}>
                  Delete…
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="grow" />
      <div className="buttons">
        <button className="button" onClick={() => (location.hash = "#/import")}>
          Import a new backup…
        </button>
        <button className="button primary" onClick={() => api().closeWindow()}>
          Done
        </button>
      </div>
    </div>
  );
}
