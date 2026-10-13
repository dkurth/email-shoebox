import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findPython } from "../src/main/importer.ts";

export const APP_DIR = path.join(import.meta.dirname, "..");
export const SAMPLE_MBOX = path.join(APP_DIR, "..", "viewer", "test", "fixtures", "sample.mbox");

export function tempDir(prefix = "shoebox-app-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** The importer from ../importer/src, run with python3 from the PATH (or SHOEBOX_PYTHON). */
export const PYTHON = findPython({ packaged: false, resourcesPath: "", appDir: APP_DIR });

/** A Takeout-like folder: Takeout/Mail/Inbox.mbox holding the viewer's synthetic sample mail. */
export function takeoutFolder(name = "Takeout-20261008"): string {
  const root = path.join(tempDir(), name);
  fs.mkdirSync(path.join(root, "Takeout", "Mail"), { recursive: true });
  fs.copyFileSync(SAMPLE_MBOX, path.join(root, "Takeout", "Mail", "Inbox.mbox"));
  return root;
}

/** A bigger mbox: the sample `copies` times, each copy with new Gmail message IDs. */
export function bigMbox(copies = 40): string {
  const sample = fs.readFileSync(SAMPLE_MBOX, "latin1");
  let out = "";
  for (let k = 0; k < copies; k++) {
    out += sample.replace(/^From (\d+)@xxx/gm, (_m, id: string) => `From ${BigInt(id) + BigInt(k) * 1000n}@xxx`);
  }
  const file = path.join(tempDir(), "All mail Including Spam and Trash.mbox");
  fs.writeFileSync(file, out, "latin1");
  return file;
}
