// The Electron main process: windows, menus, dialogs, and the bridge between the pages and the service.
import { app, BrowserWindow, dialog, ipcMain, Menu, screen, session, shell, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type WebContents } from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TOKEN_COOKIE } from "../../../viewer/server/security.ts";
import { CH, type Collection, type ImportRequest, type ViewerApi } from "../shared/api.ts";
import { formatBytes } from "../shared/format.ts";
import { findPython } from "./importer.ts";
import { watchPdfLightboxKeys } from "./pdfKeys.ts";
import { startupCollection, viewToOpen } from "./registry.ts";
import { ViewerServer, SwitchError } from "./server.ts";
import { folderSize, Service, ServiceError } from "./service.ts";
import { checkForUpdates } from "./updater.ts";
import { boundsOnScreen, loadWindowState, saveWindowState } from "./windowState.ts";

// Tests (and anyone who wants a second, separate set of collections) can choose the data folder.
if (process.env.SHOEBOX_USER_DATA) app.setPath("userData", process.env.SHOEBOX_USER_DATA);

// SHOEBOX_HIDDEN_WINDOWS=1: never show a window or come to the front (the end-to-end tests set it, so they don't
// get in the way of someone using the computer). The pages still load and run; tests drive them as usual.
const hidden = process.env.SHOEBOX_HIDDEN_WINDOWS === "1";

/** Show a window and bring it to the front, unless windows are hidden. */
function reveal(w: BrowserWindow): void {
  if (hidden) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

const distDir = import.meta.dirname; // dist/ (inside app.asar when packaged)
const appDir = path.dirname(distDir);
const UI_INDEX = path.join(distDir, "ui", "index.html");
const UI_URL = pathToFileURL(UI_INDEX).href;
const ICON = path.join(appDir, "build", "icon.png");

let service: Service;
let server: ViewerServer;
let mainWindow: BrowserWindow | null = null;
let appWindow: BrowserWindow | null = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const w = appWindow ?? mainWindow;
    if (w) reveal(w);
  });
  app.whenReady().then(start, (e) => {
    dialog.showErrorBox("Email Shoebox could not start", String(e?.stack ?? e));
    app.quit();
  });
}

async function start(): Promise<void> {
  if (hidden) app.dock?.hide(); // macOS: no Dock icon, so the app can't come to the front
  service = new Service({
    dataDir: app.getPath("userData"),
    python: findPython({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appDir }),
  });
  server = new ViewerServer({
    staticDir: path.join(distDir, "viewer-web"),
    workerUrl: (name) => pathToFileURL(path.join(distDir, "workers", `${name}.js`)), // Electron loads workers from app.asar too
  });
  await server.start();
  // Only this app's windows have the token, so other programs can't read the mail from the local server.
  await session.defaultSession.cookies.set({ url: server.origin, name: TOKEN_COOKIE, value: server.token, httpOnly: true, sameSite: "strict" });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  service.onImport((s) => broadcast(CH.importEvent, s));
  registerIpc();
  buildMenu();

  const first = startupCollection(service.reg);
  if (first) await openCollection(first, { atStartup: true });
  else showAppWindow("welcome");

  if (app.isPackaged) checkForUpdates(() => mainWindow ?? appWindow ?? undefined);
}

// ---------------------------------------------------------------- windows

// Hidden windows count as in the background, and Chromium slows the timers of background pages; not when hidden on purpose.
const baseWebPreferences = { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: !hidden } as const;

let loads = 0;

const windowStateFile = () => path.join(app.getPath("userData"), "window.json");

function showMainWindow(hash = "#/inbox"): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    // Another collection is open now: load the page again. A new query makes it a new document; with only a new
    // hash (or the same URL), Chromium stays on the page, and the page keeps the old collection's mail.
    mainWindow.loadURL(`${server.origin}/?load=${++loads}${hash}`);
    reveal(mainWindow);
    return mainWindow;
  }
  // The size and place it had last time, if that's still on a screen.
  const saved = loadWindowState(windowStateFile());
  const bounds = saved && boundsOnScreen(saved.bounds, screen.getAllDisplays().map((d) => d.workArea));
  const w = new BrowserWindow({
    ...(bounds ?? { width: 1280, height: 860 }),
    minWidth: 720,
    minHeight: 480,
    title: "Email Shoebox",
    icon: process.platform === "linux" ? ICON : undefined,
    show: false,
    webPreferences: { ...baseWebPreferences, preload: path.join(distDir, "preload-viewer.cjs") },
  });
  mainWindow = w;
  w.once("ready-to-show", () => {
    if (saved?.maximized && !hidden) w.maximize();
    reveal(w);
  });
  // Remember where the viewer is in the mail, to go back there at the next start.
  const remember = () => server.currentId && service.rememberView(server.currentId, new URL(w.webContents.getURL()).hash);
  w.webContents.on("did-navigate-in-page", remember);
  w.webContents.on("did-navigate", remember);
  w.on("close", () => {
    try {
      saveWindowState(windowStateFile(), { bounds: w.getNormalBounds(), maximized: w.isMaximized() });
    } catch {
      /* the window opens at the default size next time */
    }
  });
  w.on("closed", () => {
    if (mainWindow === w) mainWindow = null;
  });
  w.loadURL(`${server.origin}/${hash}`);
  return w;
}

type Page = "welcome" | "import" | "manage" | "upgrade" | "into";

/**
 * The app's own pages, one window at a time, centered over the viewer. Not a modal child of the viewer: the
 * viewer window can close (the last collection was deleted) while this one stays.
 */
function showAppWindow(page: Page, params: Record<string, string> = {}): BrowserWindow {
  const hash = `#/${page}${Object.keys(params).length ? "?" + new URLSearchParams(params) : ""}`;
  if (appWindow && !appWindow.isDestroyed()) {
    appWindow.loadURL(UI_URL + hash);
    reveal(appWindow);
    return appWindow;
  }
  const width = 680;
  const height = page === "manage" ? 560 : 640;
  const over = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? mainWindow.getBounds() : null;
  const w = new BrowserWindow({
    width,
    height,
    ...(over ? { x: Math.round(over.x + (over.width - width) / 2), y: Math.round(over.y + Math.min(80, (over.height - height) / 2)) } : {}),
    minWidth: 520,
    minHeight: 420,
    title: "Email Shoebox",
    icon: process.platform === "linux" ? ICON : undefined,
    show: false,
    webPreferences: { ...baseWebPreferences, preload: path.join(distDir, "preload-app.cjs") },
  });
  appWindow = w;
  w.once("ready-to-show", () => reveal(w));
  w.on("close", (e) => {
    if (quitting || !service.isImporting()) return;
    // The import keeps going without the window, but then nobody sees it; ask first.
    const choice = dialog.showMessageBoxSync(w, {
      type: "question",
      buttons: ["Keep importing", "Stop the import"],
      defaultId: 0,
      cancelId: 0,
      message: "An import is running.",
      detail: "If you stop it, the mail imported so far is kept, and you can continue the import later.",
    });
    e.preventDefault();
    if (choice === 1) service.cancelImport();
  });
  w.on("closed", () => {
    if (appWindow === w) appWindow = null;
    // Closing the welcome window with nothing imported ends the app.
    if (!mainWindow && !quitting && service.reg.collections.length === 0) app.quit();
  });
  w.loadURL(UI_URL + hash);
  return w;
}

function broadcast(channel: string, value?: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, value);
}

function collectionsChanged(): void {
  broadcast(CH.collectionsChanged);
}

// ---------------------------------------------------------------- opening collections

/** Open a collection in the viewer, after checking it. Returns an error message, or null when it opened. */
async function openCollection(c: Collection, opts: { atStartup?: boolean } = {}): Promise<string | null> {
  const status = service.schemaStatus(c.id);
  if (status === "missing") {
    if (opts.atStartup || !mainWindow) showAppWindow("manage");
    return `The folder of "${c.name}" was not found. It may have been moved, or be on a drive that isn't connected. Use Manage collections to find it.`;
  }
  if (status === "older") {
    showAppWindow("upgrade", { id: c.id });
    return null;
  }
  if (status === "newer") {
    const message = `"${c.name}" was made by a newer version of Email Shoebox. Update the app to open it.`;
    if (opts.atStartup || !mainWindow) {
      await dialog.showMessageBox({ type: "warning", message, buttons: ["OK"] });
      showAppWindow("manage");
    }
    return message;
  }
  try {
    server.open(c);
  } catch (e) {
    const message = e instanceof SwitchError ? e.message : `"${c.name}" could not be opened: ${(e as Error).message}`;
    if (opts.atStartup || !mainWindow) showAppWindow("manage");
    return message;
  }
  service.markOpened(c.id);
  showMainWindow(viewToOpen(c)); // where the viewer was in this collection last time
  collectionsChanged();
  return null;
}

/** Before a collection is removed or deleted: if it's open, open another, or go back to the welcome page. */
async function leaveCollection(id: string): Promise<void> {
  if (server.currentId !== id) return;
  server.closeCollection();
  const other = service.reg.collections.filter((c) => c.id !== id).sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))[0];
  if (other && (await openCollection(other)) === null) return;
  // No collection to show: close the viewer. Open the app's own window first if it isn't (on Windows and Linux,
  // the app quits when no window is left).
  if (!appWindow || appWindow.isDestroyed()) showAppWindow("manage");
  mainWindow?.destroy();
  mainWindow = null;
}

/** After a collection is removed or deleted: with none left, start again at the welcome page. */
function afterRemoval(): void {
  collectionsChanged();
  if (service.reg.collections.length === 0) showAppWindow("welcome");
}

// ---------------------------------------------------------------- IPC

function senderIsAppPage(e: IpcMainInvokeEvent): boolean {
  return (e.senderFrame?.url ?? "").startsWith(UI_URL);
}

function senderIsViewer(e: IpcMainInvokeEvent): boolean {
  try {
    return new URL(e.senderFrame?.url ?? "").origin === server.origin;
  } catch {
    return false;
  }
}

function handle(channel: string, allowed: (e: IpcMainInvokeEvent) => boolean, fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (e, ...args) => {
    if (!allowed(e)) throw new Error("Not allowed");
    try {
      return await fn(e, ...args);
    } catch (err) {
      // The page shows the message; keep it short (no "Error invoking remote method..." noise).
      throw new Error(err instanceof ServiceError || err instanceof SwitchError ? err.message : String((err as Error)?.message ?? err));
    }
  });
}

function windowOf(e: IpcMainInvokeEvent): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(e.sender) ?? undefined;
}

function registerIpc(): void {
  const page = senderIsAppPage;

  handle(CH.chooseInput, page, async (e, kind: "file" | "folder") => {
    const r = await dialog.showOpenDialog(windowOf(e)!, {
      title: kind === "file" ? "Choose your Gmail backup" : "Choose the folder with your Gmail backup",
      properties: kind === "file" ? ["openFile", "multiSelections"] : ["openDirectory"],
      filters: kind === "file" ? [{ name: "Mail backups", extensions: ["mbox", "gz", "zip", "tgz", "tar"] }] : undefined,
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths;
  });
  handle(CH.scan, page, (e, paths: string[]) => service.scan(paths, (ev) => !e.sender.isDestroyed() && e.sender.send(CH.scanEvent, ev)));
  handle(CH.storageInfo, page, (_e, parent: string | null) => service.storageInfo(parent));
  handle(CH.chooseStorage, page, async (e) => {
    const r = await dialog.showOpenDialog(windowOf(e)!, {
      title: "Choose where to keep this collection",
      buttonLabel: "Keep it here",
      properties: ["openDirectory", "createDirectory"],
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });
  handle(CH.startImport, page, (_e, req: ImportRequest) => {
    const s = service.startImport(req);
    collectionsChanged();
    return s;
  });
  handle(CH.cancelImport, page, () => service.cancelImport());
  handle(CH.importState, page, () => service.importState());
  handle(CH.showLog, page, () => shell.openPath(service.logFile));
  handle(CH.listCollections, page, (_e, withSizes: boolean) => service.list(server.currentId, withSizes));
  handle(CH.renameCollection, page, (_e, id: string, name: string) => {
    service.rename(id, name);
    collectionsChanged();
  });
  handle(CH.removeCollection, page, async (_e, id: string) => {
    await leaveCollection(id);
    service.remove(id);
    afterRemoval();
  });
  handle(CH.deleteCollection, page, async (e, id: string) => {
    const c = service.get(id);
    const size = folderSize(c.path); // exact: the delete removes everything in the folder, also files the database doesn't list
    const r = await dialog.showMessageBox(windowOf(e)!, {
      type: "warning",
      buttons: ["Delete", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: `Delete "${c.name}" from your disk?`,
      detail: `This deletes the folder ${c.path} and frees ${formatBytes(size)}. You can't undo this.`,
    });
    if (r.response !== 0) return false;
    await leaveCollection(id);
    await service.deleteFromDisk(id);
    afterRemoval();
    return true;
  });
  handle(CH.showInFolder, page, (_e, id: string) => {
    const c = service.get(id);
    const db = path.join(c.path, "mail.db");
    if (fs.existsSync(db)) shell.showItemInFolder(db);
    else shell.openPath(path.dirname(c.path));
  });
  handle(CH.locateCollection, page, async (e, id: string) => {
    const r = await dialog.showOpenDialog(windowOf(e)!, {
      title: `Where is "${service.get(id).name}"?`,
      message: "Choose the collection's folder (the one with mail.db in it).",
      properties: ["openDirectory"],
    });
    if (r.canceled || !r.filePaths.length) return;
    service.locate(id, r.filePaths[0]);
    collectionsChanged();
  });
  handle(CH.openCollection, page, async (e, id: string) => {
    const err = await openCollection(service.get(id));
    if (err) throw new ServiceError(err);
    const w = windowOf(e);
    if (w && w === appWindow && service.schemaStatus(id) === "ok") w.destroy();
  });
  handle(CH.upgradeCollection, page, (e, id: string) => service.upgrade(id, () => {}).finally(() => collectionsChanged()));
  handle(CH.closeWindow, page, (e) => windowOf(e)?.close());

  const viewer = senderIsViewer;
  handle(CH.viewerCollections, viewer, (): ReturnType<ViewerApi["collections"]> =>
    Promise.resolve({
      current: server.currentId,
      list: service.list(server.currentId).map((c) => ({ id: c.id, name: c.name, messages: c.messages, incomplete: !!c.incomplete })),
    }),
  );
  handle(CH.viewerSwitch, viewer, async (_e, id: string) => {
    const err = await openCollection(service.get(id));
    return err ? { ok: false, error: err } : { ok: true };
  });
  handle(CH.viewerOpenImport, viewer, () => void showAppWindow("import"));
  handle(CH.viewerOpenManage, viewer, () => void showAppWindow("manage"));
}

// ---------------------------------------------------------------- links and navigation

app.on("web-contents-created", (_e, contents: WebContents) => {
  watchPdfLightboxKeys(contents);
  contents.on("will-navigate", (e, url) => {
    if (!allowedInApp(url)) {
      e.preventDefault();
      openOutside(url);
    }
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (server && sameOrigin(url)) openAttachmentWindow(url); // a PDF or an image "in a new tab"
    else openOutside(url);
    return { action: "deny" };
  });
});

function sameOrigin(url: string): boolean {
  try {
    return new URL(url).origin === server.origin;
  } catch {
    return false;
  }
}

function allowedInApp(url: string): boolean {
  return sameOrigin(url) || url.startsWith(UI_URL);
}

function openOutside(url: string): void {
  if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
}

/** Attachments open in a plain window: no preload, so the page can't reach the app. */
function openAttachmentWindow(url: string): void {
  const w = new BrowserWindow({ width: 900, height: 900, title: "Email Shoebox", show: !hidden, webPreferences: { ...baseWebPreferences } });
  w.loadURL(url);
}

// ---------------------------------------------------------------- menu

function buildMenu(): void {
  const isMac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        { label: "Import…", accelerator: "CmdOrCtrl+O", click: () => showAppWindow(service.reg.collections.length ? "import" : "welcome") },
        { label: "Manage Collections…", click: () => showAppWindow("manage") },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        ...(app.isPackaged ? [] : [{ role: "toggleDevTools" as const }]),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "Email Shoebox on GitHub", click: () => shell.openExternal("https://github.com/dkurth/email-shoebox") },
        { label: "Show the Importer Log", click: () => shell.openPath(service.logFile) },
        ...(app.isPackaged ? [] : [{ label: "Open the Data Folder", click: () => shell.openPath(app.getPath("userData")) }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- app lifecycle

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length) return;
  if (server?.currentId) showMainWindow(viewToOpen(service.get(server.currentId)));
  else showAppWindow(service?.reg.collections.length ? "manage" : "welcome");
});

app.on("before-quit", (e) => {
  if (quitting || !service?.isImporting()) {
    quitting = true;
    return;
  }
  e.preventDefault();
  const choice = dialog.showMessageBoxSync({
    type: "question",
    buttons: ["Keep importing", "Stop and quit"],
    defaultId: 0,
    cancelId: 0,
    message: "An import is running.",
    detail: "If you quit, the mail imported so far is kept, and you can continue the import later.",
  });
  if (choice !== 1) return;
  quitting = true;
  // Let the importer save its work and stop; quit when it has (or after 30 seconds).
  const stop = service.onImport((s) => {
    if (s.phase !== "running" && s.phase !== "stopping") {
      stop();
      app.quit();
    }
  });
  service.cancelImport();
  setTimeout(() => {
    service.killImport();
    app.exit(0);
  }, 30_000).unref();
});

app.on("will-quit", () => {
  service?.flush();
  server?.stop();
});
