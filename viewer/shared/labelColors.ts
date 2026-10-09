// Label colors. Takeout doesn't export the colors chosen in Gmail, so the viewer picks them:
// a chosen color (stored in meta.viewer_label_colors), else the parent label's color,
// else a stable color from the name. The CSS classes .lc-<id> hold the actual colors.

export const LABEL_COLORS = [
  { id: "red", name: "Red" },
  { id: "orange", name: "Orange" },
  { id: "yellow", name: "Yellow" },
  { id: "green", name: "Green" },
  { id: "teal", name: "Teal" },
  { id: "cyan", name: "Cyan" },
  { id: "blue", name: "Blue" },
  { id: "indigo", name: "Indigo" },
  { id: "purple", name: "Purple" },
  { id: "pink", name: "Pink" },
  { id: "brown", name: "Brown" },
  { id: "gray", name: "Gray" },
] as const;

export type LabelColorId = (typeof LABEL_COLORS)[number]["id"];

/** label name -> chosen color id. */
export type ChosenColors = Record<string, string>;

export const isLabelColor = (c: unknown): c is LabelColorId => LABEL_COLORS.some((l) => l.id === c);

// Gray looks like a system label, so it is never picked by default.
const DEFAULTS = LABEL_COLORS.filter((c) => c.id !== "gray").map((c) => c.id);

/** FNV-1a: small and stable, so a label keeps its color everywhere. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function defaultColor(name: string): LabelColorId {
  return DEFAULTS[hash(name) % DEFAULTS.length];
}

/** The color a user label shows: chosen, else its parent's, else the default for its name. */
export function labelColor(name: string, chosen: ChosenColors): LabelColorId {
  const c = chosen[name];
  if (isLabelColor(c)) return c;
  const slash = name.lastIndexOf("/");
  return slash > 0 ? labelColor(name.slice(0, slash), chosen) : defaultColor(name);
}
