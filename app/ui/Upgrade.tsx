// A collection made by an older version of the app: upgrade it, then open it.
import { useEffect, useState } from "react";
import type { CollectionInfo, UpgradeState } from "../src/shared/api.ts";
import { api, message } from "./api.ts";
import { Header } from "./App.tsx";

export function Upgrade({ id }: { id: string }) {
  const [c, setC] = useState<CollectionInfo | null>(null);
  const [state, setState] = useState<UpgradeState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api().listCollections().then((list) => setC(list.find((x) => x.id === id) ?? null));
  }, [id]);

  async function upgrade() {
    setError(null);
    setState({ phase: "running", error: null, log: [] });
    try {
      const s = await api().upgradeCollection(id);
      setState(s);
      if (s.phase === "finished") await api().openCollection(id);
    } catch (e) {
      setError(message(e));
    }
  }

  return (
    <div className="page">
      <Header title={`Upgrade “${c?.name ?? "…"}”`} lede="This collection was made by an older version of Email Shoebox." />
      <section className="card">
        <p style={{ margin: 0 }}>
          To open it, Email Shoebox must upgrade it first. For a large collection this can take a few minutes. After the upgrade, older versions of
          the app can’t open it.
        </p>
        {state?.phase === "running" && (
          <div className="field">
            <div className="muted">Upgrading…</div>
            <div className="bar indeterminate">
              <div />
            </div>
            {state.log.length > 0 && <div className="path">{state.log.at(-1)}</div>}
          </div>
        )}
        {state?.phase === "finished" && <div>Upgraded. Opening it…</div>}
        {state?.phase === "failed" && <div className="error">{state.error}</div>}
        {error && <div className="error">{error}</div>}
      </section>
      <div className="grow" />
      <div className="buttons">
        <button className="button" onClick={() => (location.hash = "#/manage")} disabled={state?.phase === "running"}>
          Manage Collections…
        </button>
        <button className="button primary" onClick={upgrade} disabled={!c || state?.phase === "running" || state?.phase === "finished"}>
          {state?.phase === "failed" ? "Try again" : "Upgrade"}
        </button>
      </div>
    </div>
  );
}
