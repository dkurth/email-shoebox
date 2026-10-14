// Back and Forward inside the app, as in a browser. Every history entry carries its place in the
// app's history (history.state.idx), so the buttons know whether there is anywhere to go, and each
// scrolling pane can remember where it was for that entry.
import { useLayoutEffect, type RefObject } from "react";

export interface Place {
  idx: number; // this entry's place, 0 = the first page the app showed
  max: number; // the newest entry: Forward goes no further
}

const MAX_KEY = "historyMax";

function readMax(): number {
  try {
    return Number(sessionStorage.getItem(MAX_KEY) ?? 0);
  } catch {
    return 0;
  }
}

function saveMax(max: number) {
  try {
    sessionStorage.setItem(MAX_KEY, String(max));
  } catch {
    /* Forward may stay disabled after a reload */
  }
}

function stateIdx(): number | null {
  const s = history.state as { idx?: unknown } | null;
  return typeof s?.idx === "number" ? s.idx : null;
}

/** On load: the entry's place, numbering the entry if it has none yet. */
export function firstPlace(): Place {
  let idx = stateIdx();
  if (idx === null) {
    idx = 0;
    history.replaceState({ ...history.state, idx }, "");
    saveMax(0);
  }
  return { idx, max: Math.max(idx, readMax()) };
}

/** After a hashchange: Back/Forward land on a numbered entry; a new one gets the next number and ends the Forward list. */
export function nextPlace(prev: Place): Place {
  const idx = stateIdx();
  if (idx !== null) return { idx, max: prev.max };
  const next = prev.idx + 1;
  history.replaceState({ ...history.state, idx: next }, "");
  saveMax(next);
  return { idx: next, max: next };
}

const positions = new Map<string, number>();

/**
 * Remembers where `ref` was scrolled for this history entry (`key`, null while hidden), and scrolls back
 * there when Back or Forward returns to it. The content usually loads after the pane appears, so it keeps
 * trying for a moment, and stops as soon as the person scrolls or clicks.
 */
export function useScrollMemory(ref: RefObject<HTMLElement | null>, key: string | null): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || key === null) return;
    const target = positions.get(key);
    let frame = 0;
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
    };
    if (target !== undefined) {
      const until = performance.now() + 2000;
      const apply = () => {
        el.scrollTop = target;
        frame = Math.abs(el.scrollTop - target) >= 1 && performance.now() < until ? requestAnimationFrame(apply) : 0;
      };
      apply();
    }
    const save = () => {
      if (!frame) positions.set(key, el.scrollTop);
    };
    el.addEventListener("scroll", save);
    el.addEventListener("wheel", stop, { passive: true });
    el.addEventListener("pointerdown", stop);
    window.addEventListener("keydown", stop);
    return () => {
      stop();
      el.removeEventListener("scroll", save);
      el.removeEventListener("wheel", stop);
      el.removeEventListener("pointerdown", stop);
      window.removeEventListener("keydown", stop);
    };
  }, [ref, key]);
}
