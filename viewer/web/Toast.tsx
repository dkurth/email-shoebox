import { useEffect } from "react";
import { X } from "lucide-react";

export interface ToastData {
  id: number;
  text: string;
  onUndo?: () => void;
}

export function Toast({ toast, onClose }: { toast: ToastData; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 8000);
    return () => clearTimeout(t);
  }, [toast.id, onClose]);
  return (
    <div className="toast" role="status">
      <span>{toast.text}</span>
      {toast.onUndo && (
        <button className="toast-undo" onClick={toast.onUndo}>
          Undo
        </button>
      )}
      <button className="toast-close" aria-label="Close" onClick={onClose}>
        <X size={16} />
      </button>
    </div>
  );
}
