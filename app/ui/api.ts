// The bridge to the main process (src/preload/app.ts).
import type { AppApi } from "../src/shared/api.ts";

declare global {
  interface Window {
    shoeboxApp: AppApi;
  }
}

export const api = (): AppApi => window.shoeboxApp;

/** The message of an error from the main process. */
export function message(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}
