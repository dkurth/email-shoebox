// Preload for the app's own pages (welcome, import, manage, upgrade): window.shoeboxApp.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { CH, type AppApi } from "../shared/api.ts";

function on<T>(channel: string, cb: (value: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, value: T) => cb(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: AppApi = {
  chooseInput: (kind) => ipcRenderer.invoke(CH.chooseInput, kind),
  scan: (paths) => ipcRenderer.invoke(CH.scan, paths),
  onScan: (cb) => on(CH.scanEvent, cb),
  storageInfo: (parent) => ipcRenderer.invoke(CH.storageInfo, parent),
  chooseStorage: () => ipcRenderer.invoke(CH.chooseStorage),
  startImport: (req) => ipcRenderer.invoke(CH.startImport, req),
  cancelImport: () => ipcRenderer.invoke(CH.cancelImport),
  importState: () => ipcRenderer.invoke(CH.importState),
  onImport: (cb) => on(CH.importEvent, cb),
  showLog: () => ipcRenderer.invoke(CH.showLog),
  listCollections: (withSizes) => ipcRenderer.invoke(CH.listCollections, !!withSizes),
  renameCollection: (id, name) => ipcRenderer.invoke(CH.renameCollection, id, name),
  removeCollection: (id) => ipcRenderer.invoke(CH.removeCollection, id),
  deleteCollection: (id) => ipcRenderer.invoke(CH.deleteCollection, id),
  showInFolder: (id) => ipcRenderer.invoke(CH.showInFolder, id),
  locateCollection: (id) => ipcRenderer.invoke(CH.locateCollection, id),
  openCollection: (id) => ipcRenderer.invoke(CH.openCollection, id),
  upgradeCollection: (id) => ipcRenderer.invoke(CH.upgradeCollection, id),
  onCollectionsChanged: (cb) => on(CH.collectionsChanged, () => cb()),
  closeWindow: () => ipcRenderer.invoke(CH.closeWindow),
  platform: process.platform,
};

contextBridge.exposeInMainWorld("shoeboxApp", api);
