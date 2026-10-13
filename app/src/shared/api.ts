// Types shared by the main process, the preload scripts and the app's own pages.

export interface Collection {
  id: string;
  name: string;
  path: string; // the archive folder (mail.db + attachments/)
  createdAt: number; // ms
  lastOpenedAt: number | null;
  /** Set while an import into this collection hasn't finished (cancelled, failed, or the app quit). */
  incomplete: { paths: string[]; skipSpamTrash: boolean } | null;
}

export interface CollectionInfo extends Collection {
  current: boolean; // open in the viewer now
  missing: boolean; // the folder (or its mail.db) isn't there
  messages: number | null;
  sizeBytes: number | null; // only when asked for (it walks the folder)
}

/** What `gmail2sqlite scan --json` says first, before reading the mail. null = known only after the scan. */
export interface QuickLook {
  files: string[];
  bytes_on_disk: number;
  mbox_count: number | null;
  uncompressed_bytes: number | null;
}

export interface ScanResult {
  files: string[];
  bytes_on_disk: number;
  uncompressed_bytes: number;
  mbox_count: number;
  messages: number;
  first_date: number | null; // epoch seconds
  last_date: number | null;
  owner: string | null;
}

export type ScanEvent =
  | { scanId: number; type: "files"; look: QuickLook; fallbackName: string } // fallbackName: from the file or folder name
  | { scanId: number; type: "progress"; done: number; total: number }
  | { scanId: number; type: "result"; result: ScanResult; defaultName: string }
  | { scanId: number; type: "error"; message: string };

export interface ImportRequest {
  /** "new": a new collection; "into": add to `collectionId`; "continue": run an unfinished import again. */
  mode: "new" | "into" | "continue";
  collectionId?: string;
  paths: string[];
  name?: string; // "new" only
  skipSpamTrash: boolean;
  storageParent?: string | null; // "new" only; null = the app data folder
  mboxCount?: number | null; // from the scan, for "3 of 14"
}

export interface ImportProgress {
  bytesDone: number;
  bytesTotal: number;
  messages: number;
  inserted: number;
  errors: number;
  mbox: string;
  mboxIndex: number;
  mboxCount: number | null;
  secondsLeft: number | null;
}

export type ImportPhase = "running" | "stopping" | "finished" | "interrupted" | "failed";

export interface ImportState {
  phase: ImportPhase;
  collectionId: string;
  collectionName: string;
  progress: ImportProgress | null;
  counts: Record<string, number> | null; // when done
  error: string | null;
}

export interface StorageInfo {
  parent: string; // the folder the collection's folder goes in
  isDefault: boolean;
  freeBytes: number | null;
}

export type UpgradeState = { phase: "running" | "finished" | "failed"; error: string | null; log: string[] };

/** The app's own pages (welcome, import, manage, upgrade) get this as window.shoeboxApp. */
export interface AppApi {
  chooseInput(kind: "file" | "folder"): Promise<string[] | null>;
  scan(paths: string[]): Promise<number>; // returns the scanId; results come as ScanEvents
  onScan(cb: (e: ScanEvent) => void): () => void;
  storageInfo(parent: string | null): Promise<StorageInfo>;
  chooseStorage(): Promise<string | null>;
  startImport(req: ImportRequest): Promise<ImportState>;
  cancelImport(): Promise<void>;
  importState(): Promise<ImportState | null>;
  onImport(cb: (s: ImportState) => void): () => void;
  showLog(): Promise<void>;
  listCollections(withSizes?: boolean): Promise<CollectionInfo[]>;
  renameCollection(id: string, name: string): Promise<void>;
  removeCollection(id: string): Promise<void>;
  deleteCollection(id: string): Promise<boolean>; // false if the user said no
  showInFolder(id: string): Promise<void>;
  locateCollection(id: string): Promise<void>;
  openCollection(id: string): Promise<void>;
  upgradeCollection(id: string): Promise<UpgradeState>;
  onCollectionsChanged(cb: () => void): () => void;
  closeWindow(): Promise<void>;
  platform: string;
}

/** The viewer page gets this as window.shoebox. The viewer owns the type (viewer/shared/types.ts). */
export type { DesktopBridge as ViewerApi } from "../../../viewer/shared/types.ts";

/** IPC channel names. */
export const CH = {
  chooseInput: "app:choose-input",
  scan: "app:scan",
  scanEvent: "app:scan-event",
  storageInfo: "app:storage-info",
  chooseStorage: "app:choose-storage",
  startImport: "app:start-import",
  cancelImport: "app:cancel-import",
  importState: "app:import-state",
  importEvent: "app:import-event",
  showLog: "app:show-log",
  listCollections: "app:list-collections",
  renameCollection: "app:rename",
  removeCollection: "app:remove",
  deleteCollection: "app:delete",
  showInFolder: "app:show-in-folder",
  locateCollection: "app:locate",
  openCollection: "app:open",
  upgradeCollection: "app:upgrade",
  collectionsChanged: "app:collections-changed",
  closeWindow: "app:close-window",
  viewerCollections: "viewer:collections",
  viewerSwitch: "viewer:switch",
  viewerOpenImport: "viewer:open-import",
  viewerOpenManage: "viewer:open-manage",
} as const;
