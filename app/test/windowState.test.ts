import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { boundsOnScreen, loadWindowState, saveWindowState } from "../src/main/windowState.ts";
import { tempDir } from "./helpers.ts";

describe("window state", () => {
  it("saves and loads, and is null when the file is missing or broken", () => {
    const file = path.join(tempDir(), "window.json");
    expect(loadWindowState(file)).toBeNull();
    const state = { bounds: { x: 10, y: 20, width: 1000, height: 700 }, maximized: true };
    saveWindowState(file, state);
    expect(loadWindowState(file)).toEqual(state);
    fs.writeFileSync(file, JSON.stringify({ bounds: { x: 0, y: 0, width: "wide", height: 700 } }));
    expect(loadWindowState(file)).toBeNull();
    fs.writeFileSync(file, "{not json");
    expect(loadWindowState(file)).toBeNull();
  });

  it("keeps the bounds only if the window's top is on a screen, made to fit it", () => {
    const laptop = { x: 0, y: 0, width: 1440, height: 875 };
    const external = { x: 1440, y: -200, width: 2560, height: 1400 };
    const onExternal = { x: 2000, y: 100, width: 1600, height: 1000 };
    expect(boundsOnScreen(onExternal, [laptop, external])).toEqual(onExternal);
    expect(boundsOnScreen(onExternal, [laptop])).toBeNull(); // the external screen is gone
    expect(boundsOnScreen({ x: 100, y: 50, width: 2000, height: 1200 }, [laptop])).toEqual({ x: 100, y: 50, width: 1440, height: 875 });
    expect(boundsOnScreen({ x: 1400, y: 50, width: 800, height: 600 }, [laptop])).toBeNull(); // only 40 pixels on the screen
    expect(boundsOnScreen({ x: 100, y: -30, width: 800, height: 600 }, [laptop])).toBeNull(); // its top is above the screen
  });
});
