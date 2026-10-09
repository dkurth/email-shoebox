// Gmail's "Label as" menu: filter, tri-state checkboxes for the selected threads, Create new, Apply.
import { useEffect, useMemo, useRef, useState } from "react";

type State = "all" | "some" | "none";

export function LabelMenu(props: {
  labels: string[]; // all user labels
  applied: string[][]; // user labels on each target thread
  onApply: (add: string[], remove: string[], create: string[]) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("");
  const initial = useMemo(() => {
    const m = new Map<string, State>();
    for (const l of props.labels) {
      const n = props.applied.filter((a) => a.includes(l)).length;
      m.set(l, n === 0 ? "none" : n === props.applied.length ? "all" : "some");
    }
    return m;
  }, [props.labels, props.applied]);
  const [state, setState] = useState(initial);
  const [created, setCreated] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const names = [...props.labels, ...created].filter((l) => l.toLowerCase().includes(filter.trim().toLowerCase()));
  const exact = filter.trim() && [...props.labels, ...created].some((l) => l.toLowerCase() === filter.trim().toLowerCase());
  const changed = [...state].some(([l, s]) => s !== (initial.get(l) ?? "none"));

  const toggle = (l: string) => setState((s) => new Map(s).set(l, s.get(l) === "all" ? "none" : "all"));
  const apply = () => {
    const add = [...state].filter(([l, s]) => s === "all" && initial.get(l) !== "all").map(([l]) => l);
    const remove = [...state].filter(([l, s]) => s === "none" && (initial.get(l) ?? "none") !== "none").map(([l]) => l);
    props.onApply(add, remove, created.filter((c) => state.get(c) === "all"));
  };
  const create = () => {
    const name = filter.trim();
    setCreated((c) => [...c, name]);
    setState((s) => new Map(s).set(name, "all"));
    setFilter("");
  };

  return (
    <div className="overlay transparent" onClick={props.onClose}>
      <div
        className="label-menu"
        role="dialog"
        aria-label="Label as"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") props.onClose();
          if (e.key === "Enter" && !(e.target as HTMLElement).matches("button")) {
            e.preventDefault();
            if (filter.trim() && !exact) create();
            else if (changed) apply();
          }
        }}
      >
        <div className="label-menu-title">Label as:</div>
        <input ref={input} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter or create a label" />
        <ul>
          {names.map((l) => {
            const s = state.get(l) ?? "none";
            return (
              <li key={l}>
                <label>
                  <input
                    type="checkbox"
                    checked={s === "all"}
                    ref={(el) => { if (el) el.indeterminate = s === "some"; }}
                    onChange={() => toggle(l)}
                  />
                  {l}
                </label>
              </li>
            );
          })}
          {!names.length && !filter.trim() && <li className="muted">No labels yet.</li>}
        </ul>
        {filter.trim() && !exact && (
          <button className="link-button create-label" onClick={create}>
            Create new: "{filter.trim()}"
          </button>
        )}
        <div className="dialog-buttons">
          <button className="text-button" onClick={props.onClose}>Cancel</button>
          <button className="text-button filled" disabled={!changed} onClick={apply}>Apply</button>
        </div>
      </div>
    </div>
  );
}
