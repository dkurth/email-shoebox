// Updates from GitHub Releases (electron-updater).
// Windows and Linux (AppImage) download the update and install it when the app quits.
// macOS can install updates only when the app is signed with a Developer ID; until then, the app says that a
// new version is out and opens the download page.
import { app, dialog, shell, type BrowserWindow } from "electron";
import electronUpdater from "electron-updater";
import fs from "node:fs";
import path from "node:path";

const { autoUpdater } = electronUpdater;
const RELEASES = "https://github.com/dkurth/email-shoebox/releases/latest";

/** build-info.json is written by scripts/dist.ts: { "macSigned": true } when the Mac build was signed. */
function macSigned(): boolean {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "build-info.json"), "utf8"));
    return info.macSigned === true;
  } catch {
    return false;
  }
}

export function checkForUpdates(window: () => BrowserWindow | undefined): void {
  if (process.env.SHOEBOX_NO_UPDATES) return;
  const canInstall = process.platform !== "darwin" || macSigned();
  if (process.platform === "linux" && !process.env.APPIMAGE) return; // a .deb is updated by downloading the new .deb
  autoUpdater.autoDownload = canInstall;
  autoUpdater.autoInstallOnAppQuit = canInstall;
  autoUpdater.logger = null;

  autoUpdater.on("update-available", async (info) => {
    if (canInstall) return; // it downloads; we say so when it's ready
    const w = window();
    const options = {
      type: "info" as const,
      buttons: ["Download", "Later"],
      defaultId: 0,
      cancelId: 1,
      message: `Email Shoebox ${info.version} is available.`,
      detail: `You have version ${app.getVersion()}. Download the new version, then replace the app in your Applications folder. Your collections are kept.`,
    };
    const r = w ? await dialog.showMessageBox(w, options) : await dialog.showMessageBox(options);
    if (r.response === 0) shell.openExternal(RELEASES);
  });
  autoUpdater.on("update-downloaded", async (info) => {
    const w = window();
    const options = {
      type: "info" as const,
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      message: `Email Shoebox ${info.version} is ready to install.`,
      detail: "It installs when you quit the app, or now if you restart.",
    };
    const r = w ? await dialog.showMessageBox(w, options) : await dialog.showMessageBox(options);
    if (r.response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on("error", () => {
    /* offline, or no release yet: try again next launch */
  });
  autoUpdater.checkForUpdates().catch(() => {});
}
