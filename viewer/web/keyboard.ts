// Gmail-style keyboard shortcuts: single keys plus "g then x" chords.
import { useEffect, useRef } from "react";

export type KeyHandlers = Record<string, (() => void) | undefined>;

/** Keys as they appear in the help overlay. */
export const SHORTCUTS: [string, string][] = [
  ["j / k", "Older / newer conversation (moves the cursor in the list)"],
  ["x", "Select the conversation under the cursor"],
  ["Enter or o", "Open the conversation"],
  ["u or Esc", "Back to the list (Esc in the list clears the selection)"],
  ["#", "Move to Trash"],
  ["y", "Remove from this view (Inbox: archive; a label: remove it; Trash: move to Inbox)"],
  ["s", "Star / unstar"],
  ["l", "Labels menu"],
  ["Shift-i / Shift-u", "Mark as read / unread"],
  ["z", "Undo the last action"],
  ["g then i / s / t / a / d", "Go to Inbox / Starred / Sent / All Mail / Drafts"],
  ["/", "Search (click ⓘ in the search box for the search options)"],
  ["?", "Show or hide this help"],
];

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) && (el as HTMLInputElement).type !== "checkbox";
}

/**
 * Calls handlers[key] for e.key ("j", "#", "I", "Enter", "Escape", ...), and handlers["g i"] etc. for chords.
 * Ignored while typing in a text field or with Ctrl/Cmd/Alt held.
 */
export function useKeyboard(handlers: KeyHandlers, enabled = true): void {
  const latest = useRef(handlers);
  latest.current = handlers;
  const chord = useRef<{ key: string; at: number } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      let name = e.key;
      const pending = chord.current;
      chord.current = null;
      if (pending && Date.now() - pending.at < 1500) {
        name = `${pending.key} ${e.key}`;
      } else if (e.key === "g") {
        chord.current = { key: "g", at: Date.now() };
        e.preventDefault();
        return;
      }
      const h = latest.current[name];
      if (h) {
        e.preventDefault();
        h();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
