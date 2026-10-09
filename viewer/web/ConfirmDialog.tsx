import type { ReactNode } from "react";

export interface ConfirmData {
  title: string;
  body: ReactNode;
  confirmText: string;
  danger?: boolean;
  onConfirm: () => void;
}

export function ConfirmDialog({ data, onCancel }: { data: ConfirmData; onCancel: () => void }) {
  return (
    <div className="overlay" onClick={onCancel} onKeyDown={(e) => e.key === "Escape" && onCancel()}>
      <div className="dialog" role="alertdialog" aria-label={data.title} onClick={(e) => e.stopPropagation()}>
        <h2>{data.title}</h2>
        <div>{data.body}</div>
        <div className="dialog-buttons">
          <button className="text-button" onClick={onCancel} autoFocus>
            Cancel
          </button>
          <button className={`text-button${data.danger ? " danger filled" : ""}`} onClick={data.onConfirm}>
            {data.confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
