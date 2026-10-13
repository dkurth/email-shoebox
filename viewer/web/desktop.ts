// In the desktop app, window.shoebox switches between collections (app/src/preload/viewer.ts).
import { useCallback, useEffect, useState } from "react";
import type { CollectionChoice, DesktopBridge } from "../shared/types.ts";

declare global {
  interface Window {
    shoebox?: DesktopBridge;
  }
}

export const desktop = (): DesktopBridge | undefined => window.shoebox;

/** The collections and the current one; updated when the app changes them (import, rename, delete). */
export function useCollections(enabled: boolean): { current: CollectionChoice | null; list: CollectionChoice[] } {
  const [data, setData] = useState<{ current: string | null; list: CollectionChoice[] }>({ current: null, list: [] });
  const load = useCallback(() => {
    desktop()?.collections().then(setData, () => {});
  }, []);
  useEffect(() => {
    const bridge = desktop();
    if (!enabled || !bridge) return;
    load();
    return bridge.onCollectionsChanged(load);
  }, [enabled, load]);
  return { current: data.list.find((c) => c.id === data.current) ?? null, list: data.list };
}
