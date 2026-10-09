// The admin page's Maintenance tab: Compact database.
import { useEffect, useState } from "react";
import type { AdminOverview, CompactProgress } from "../shared/types.ts";
import { size } from "./format.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { useAdminData, type AdminProps } from "./AdminPage.tsx";
import { useJob } from "./AdminAttachments.tsx";

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((now - since) / 1000));
  return <>{Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}</>;
}

export function MaintenanceTab({ readOnly }: AdminProps) {
  const { data: o, reload } = useAdminData<AdminOverview>("/api/admin/overview");
  const [confirm, setConfirm] = useState(false);
  const job = useJob<CompactProgress>("/api/admin/compact", reload);
  if (!o) return <div className="loading">Loading…</div>;
  const dbSize = o.dbBytes + o.walBytes;
  const s = job.state;
  return (
    <div className="maintenance">
      <section>
        <h2>Compact database</h2>
        <p>
          <code>mail.db</code> is {size(dbSize)}, with <strong>{size(o.freeBytes)}</strong> of free space inside it.
        </p>
        <p className="muted-small">
          Emptying the Trash deletes the messages and their attachment files, but SQLite keeps the freed space inside <code>mail.db</code> for
          reuse, so the file doesn't get smaller. Compacting rewrites the file without that free space.
        </p>
        {!readOnly && !s?.running && (
          <button className="text-button" onClick={() => setConfirm(true)}>Compact database</button>
        )}
        {s?.running && s.startedAt && (
          <p className="job-progress">
            <progress /> Compacting… <Elapsed since={s.startedAt} />
          </p>
        )}
        {!s?.running && s?.finishedAt && s.progress?.after != null && !s.error && (
          <p className="job-result">Done: {size(s.progress.before)} → {size(s.progress.after)}.</p>
        )}
        {s?.error && <p className="error-text">{s.error}</p>}
      </section>
      {confirm && (
        <ConfirmDialog
          data={{
            title: "Compact the database?",
            body: (
              <p>
                Compacting rewrites <code>mail.db</code>. It takes about 10 seconds for each GB (measured on a 1.8 GB archive), and needs about {size(dbSize)} of free disk space.
                Don't run an import at the same time. You can keep reading mail while it runs.
              </p>
            ),
            confirmText: "Compact",
            onConfirm: () => {
              setConfirm(false);
              job.start();
            },
          }}
          onCancel={() => setConfirm(false)}
        />
      )}
    </div>
  );
}
