// The desktop app's collections menu, left of Archive stats: switch collections, import, manage.
import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CollectionChoice } from "../shared/types.ts";

export function CollectionsMenu({
  current,
  list,
  onSwitch,
  onImport,
  onManage,
}: {
  current: CollectionChoice | null;
  list: CollectionChoice[];
  onSwitch: (id: string) => void;
  onImport: () => void;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    const onDown = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const choose = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  const rect = button.current?.getBoundingClientRect();

  return (
    <>
      <button
        ref={button}
        className="collection-button"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Switch collection"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="collection-name">{current?.name ?? "Collections"}</span>
        <ChevronDown size={16} />
      </button>
      {open && rect && (
        <div
          ref={menu}
          className="label-options collections-menu"
          role="menu"
          aria-label="Collections"
          style={{ top: rect.bottom + 4, left: Math.max(8, Math.min(rect.left, window.innerWidth - 328)) }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setOpen(false);
              button.current?.focus();
            }
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])];
              const i = items.indexOf(document.activeElement as HTMLButtonElement);
              items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
            }
          }}
        >
          {list.map((c) => (
            <button key={c.id} role="menuitem" className="menu-item collection-item" onClick={choose(() => c.id !== current?.id && onSwitch(c.id))}>
              <span className="collection-check">{c.id === current?.id && <Check size={16} />}</span>
              <span className="collection-item-name">{c.name}</span>
              <span className="collection-count">
                {c.incomplete ? "not finished" : c.messages !== null ? `${c.messages.toLocaleString("en-US")} messages` : "not found"}
              </span>
            </button>
          ))}
          <div className="menu-separator" role="separator" />
          <button role="menuitem" className="menu-item" onClick={choose(onImport)}>
            Import…
          </button>
          <button role="menuitem" className="menu-item" onClick={choose(onManage)}>
            Manage collections…
          </button>
        </div>
      )}
    </>
  );
}
