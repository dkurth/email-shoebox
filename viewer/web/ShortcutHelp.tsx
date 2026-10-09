import { SHORTCUTS } from "./keyboard.ts";

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog help" role="dialog" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
        <h2>Keyboard shortcuts</h2>
        <table>
          <tbody>
            {SHORTCUTS.map(([k, d]) => (
              <tr key={k}>
                <th><kbd>{k}</kbd></th>
                <td>{d}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="dialog-buttons">
          <button className="text-button" onClick={onClose} autoFocus>Close</button>
        </div>
      </div>
    </div>
  );
}
