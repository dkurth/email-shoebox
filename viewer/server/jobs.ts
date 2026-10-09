// Long jobs that run in a worker thread (Merge duplicate files; Compact database): one at a time,
// with progress the page checks every few seconds.
import { Worker } from "node:worker_threads";
import type { JobState } from "../shared/types.ts";

export class Busy extends Error {}

const jobs = new Map<string, JobState>();

export function jobState(name: string): JobState {
  return jobs.get(name) ?? { running: false, startedAt: null, finishedAt: null, progress: null, error: null };
}

/** Start a worker for a job. Only one job (of any kind) runs at a time. */
export function startJob(name: string, script: URL, data: unknown): JobState {
  for (const [n, j] of jobs) if (j.running) throw new Busy(n === name ? "This is already running." : "Another maintenance job is running. Wait for it to finish.");
  const state: JobState = { running: true, startedAt: Date.now(), finishedAt: null, progress: null, error: null };
  jobs.set(name, state);
  const w = new Worker(script, { workerData: data });
  w.on("message", (m: { type: string; progress?: unknown; error?: string }) => {
    if (m.progress) state.progress = m.progress;
    if (m.type === "error") state.error = m.error ?? "failed";
    if (m.type === "done" || m.type === "error") {
      state.running = false;
      state.finishedAt = Date.now();
    }
  });
  w.on("error", (e: Error) => {
    state.error = e.message;
    state.running = false;
    state.finishedAt = Date.now();
  });
  w.on("exit", () => {
    if (state.running) {
      state.running = false;
      state.finishedAt = Date.now();
      state.error ??= "The job stopped unexpectedly.";
    }
  });
  return state;
}
