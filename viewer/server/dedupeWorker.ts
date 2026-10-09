// Runs mergeDuplicates in a worker thread, so the server keeps answering while it works.
import { parentPort, workerData } from "node:worker_threads";
import { mergeDuplicates } from "./dedupe.ts";

try {
  const result = mergeDuplicates(workerData.archiveDir, (p) => parentPort!.postMessage({ type: "progress", progress: p }));
  parentPort!.postMessage({ type: "done", progress: result });
} catch (e) {
  parentPort!.postMessage({ type: "error", error: (e as Error).message });
}
