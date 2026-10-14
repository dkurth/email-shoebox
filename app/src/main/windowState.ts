// The viewer window's size and place on the screen (window.json in the app data folder), kept between runs.
// Plain data and file I/O, no Electron, so it can be tested on its own.
import fs from "node:fs";
import { writeJsonFile } from "./registry.ts";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  bounds: Rect; // when not maximized
  maximized: boolean;
}

const isRect = (r: any): r is Rect => r && ["x", "y", "width", "height"].every((k) => Number.isFinite(r[k])) && r.width > 0 && r.height > 0;

export function loadWindowState(file: string): WindowState | null {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (isRect(data?.bounds)) return { bounds: data.bounds, maximized: data.maximized === true };
  } catch {
    /* missing or broken: open at the default size */
  }
  return null;
}

export function saveWindowState(file: string, state: WindowState): void {
  writeJsonFile(file, state);
}

/**
 * The saved bounds, if the window's top (where you drag it) is on a screen that's connected now; made to fit that
 * screen. Else null: the screen it was on is gone, so open at the default size and place.
 */
export function boundsOnScreen(bounds: Rect, screens: Rect[]): Rect | null {
  const topStrip = { ...bounds, height: Math.min(bounds.height, 40) };
  const screen = screens.find((s) => overlap(topStrip, s) >= 80 * topStrip.height && bounds.y >= s.y);
  if (!screen) return null;
  return { x: bounds.x, y: bounds.y, width: Math.min(bounds.width, screen.width), height: Math.min(bounds.height, screen.height) };
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
