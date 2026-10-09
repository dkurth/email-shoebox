// "Search options": every supported search option, like the keyboard shortcuts help.
import { useEffect, useRef } from "react";
import { SEARCH_HELP } from "../shared/search.ts";

export function SearchHelp({ onClose, onExample }: { onClose: () => void; onExample?: (q: string) => void }) {
  const close = useRef<HTMLButtonElement>(null);
  // Focus Close (for Esc) without scrolling the table to the bottom.
  useEffect(() => close.current?.focus({ preventScroll: true }), []);
  return (
    <div className="overlay" onClick={onClose} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="dialog help search-help" role="dialog" aria-label="Search options" onClick={(e) => e.stopPropagation()}>
        <h2>Search options</h2>
        <table>
          <thead>
            <tr>
              <th>Syntax</th>
              <th>What it finds</th>
              <th>Example</th>
            </tr>
          </thead>
          {SEARCH_HELP.map((g) => (
            <tbody key={g.group}>
              <tr className="help-group">
                <th colSpan={3}>{g.group}</th>
              </tr>
              {g.rows.map((r) => (
                <tr key={r.syntax}>
                  <td><code>{r.syntax}</code></td>
                  <td>{r.what}</td>
                  <td>
                    {onExample ? (
                      <button className="link-button example" title="Search for this" onClick={() => onExample(r.example)}>
                        <code>{r.example}</code>
                      </button>
                    ) : (
                      <code>{r.example}</code>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
        <p className="help-note">
          Trash and Spam are not searched unless you use <code>in:trash</code>, <code>in:spam</code> or <code>in:anywhere</code>.
        </p>
        <div className="dialog-buttons">
          <button ref={close} className="text-button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
