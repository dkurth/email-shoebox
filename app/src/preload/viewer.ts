// Preload for the viewer window: window.shoebox, for the collections menu. Nothing else crosses over.
import { contextBridge, ipcRenderer } from "electron";
import { CH, type ViewerApi } from "../shared/api.ts";

const api: ViewerApi = {
  collections: () => ipcRenderer.invoke(CH.viewerCollections),
  switchTo: (id) => ipcRenderer.invoke(CH.viewerSwitch, id),
  openImport: () => ipcRenderer.invoke(CH.viewerOpenImport),
  openManage: () => ipcRenderer.invoke(CH.viewerOpenManage),
  onCollectionsChanged: (cb) => {
    const listener = () => cb();
    ipcRenderer.on(CH.collectionsChanged, listener);
    return () => ipcRenderer.removeListener(CH.collectionsChanged, listener);
  },
};

contextBridge.exposeInMainWorld("shoebox", api);
