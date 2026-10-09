// The ⋮ menu of a sidebar label: pick its color, go back to the default color, or delete it.
import { createContext, useContext, useEffect, useRef } from "react";
import { Check } from "lucide-react";
import { LABEL_COLORS, labelColor, type ChosenColors } from "../shared/labelColors.ts";
import type { SidebarItem } from "../shared/types.ts";

/** Colors chosen in the viewer, from the sidebar data; used by every label chip. */
export const ChosenColorsContext = createContext<ChosenColors>({});
export const useChosenColors = () => useContext(ChosenColorsContext);

const WIDTH = 228;
const HEIGHT = 170; // about; used only to open upward near the bottom of the window

export function LabelOptions(props: {
  item: SidebarItem;
  anchor: DOMRect;
  chosen: ChosenColors;
  onColor: (color: string | null) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { item, anchor, chosen } = props;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), []);
  const current = labelColor(item.name, chosen);
  const below = anchor.bottom + 4 + HEIGHT <= window.innerHeight;
  const style = {
    left: Math.max(8, Math.min(anchor.left, window.innerWidth - WIDTH - 8)),
    ...(below ? { top: anchor.bottom + 4 } : { bottom: window.innerHeight - anchor.top + 4 }),
  };

  return (
    <div className="overlay transparent" onClick={props.onClose}>
      <div
        ref={box}
        tabIndex={-1}
        className="label-options"
        role="dialog"
        aria-label={`Options for label ${item.name}`}
        style={style}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && props.onClose()}
      >
        <div className="label-options-title" title={item.name}>
          {item.name}
        </div>
        <div className="swatches">
          {LABEL_COLORS.map((c) => (
            <button
              key={c.id}
              className={`swatch lc-${c.id}${c.id === current ? " current" : ""}`}
              title={c.name}
              aria-label={c.name}
              aria-pressed={c.id === current}
              onClick={() => props.onColor(c.id)}
            >
              {c.id === current && <Check size={16} strokeWidth={3} />}
            </button>
          ))}
        </div>
        <button className="menu-item" disabled={!(item.name in chosen)} onClick={() => props.onColor(null)}>
          Default color
        </button>
        <button className="menu-item danger" onClick={props.onDelete}>
          Delete label…
        </button>
      </div>
    </div>
  );
}
