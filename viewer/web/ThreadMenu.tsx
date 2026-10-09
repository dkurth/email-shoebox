// The thread toolbar's ⋮ menu, and its "Delete all attachments in this conversation" dialog.
import { useEffect, useRef, useState } from "react";
import type { AttachmentInfo, MessageDetail, ThreadDetail } from "../shared/types.ts";
import { size } from "./format.ts";

/** Images that the HTML shows itself (cid: links): "images inside the email text". */
export function shownInText(m: MessageDetail, a: AttachmentInfo): boolean {
  return a.isInline && !!a.contentId && (m.bodyHtml ?? "").toLowerCase().includes(`cid:${a.contentId.toLowerCase()}`);
}

/** The attachments a thread action can delete: those of the messages shown in this view. */
export function threadAttachments(thread: ThreadDetail): { files: AttachmentInfo[]; inText: AttachmentInfo[] } {
  const files: AttachmentInfo[] = [];
  const inText: AttachmentInfo[] = [];
  for (const m of thread.messages.filter((x) => x.inContext)) {
    for (const a of m.attachments) {
      if (a.deletedAt) continue;
      (shownInText(m, a) ? inText : files).push(a);
    }
  }
  return { files, inText };
}

export function ThreadMenu({ anchor, onDeleteAll, canDelete, onClose }: { anchor: DOMRect; onDeleteAll: () => void; canDelete: boolean; onClose: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menu.current?.focus();
    const onDown = (e: MouseEvent) => !menu.current?.contains(e.target as Node) && onClose();
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [onClose]);
  return (
    <div
      ref={menu}
      className="label-options thread-menu"
      role="menu"
      tabIndex={-1}
      style={{ top: anchor.bottom + 4, left: Math.max(8, anchor.right - 300) }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <button role="menuitem" className="menu-item danger" disabled={!canDelete} onClick={onDeleteAll}>
        Delete all attachments in this conversation…
      </button>
    </div>
  );
}

export function DeleteThreadAttachments({ thread, onCancel, onConfirm }: {
  thread: ThreadDetail;
  onCancel: () => void;
  onConfirm: (ids: number[], bytes: number) => void;
}) {
  const { files, inText } = threadAttachments(thread);
  const [alsoInText, setAlsoInText] = useState(false);
  const chosen = alsoInText ? [...files, ...inText] : files;
  const bytes = chosen.reduce((s, a) => s + a.size, 0);
  const sum = (xs: AttachmentInfo[]) => xs.reduce((s, a) => s + a.size, 0);
  const n = (k: number, w: string) => `${k.toLocaleString()} ${w}${k === 1 ? "" : "s"}`;
  return (
    <div className="overlay" onClick={onCancel} onKeyDown={(e) => e.key === "Escape" && onCancel()}>
      <div className="dialog" role="alertdialog" aria-label="Delete attachments" onClick={(e) => e.stopPropagation()}>
        <h2>Delete attachments?</h2>
        <p>
          Delete {n(chosen.length, "attachment")} ({size(bytes)}) from this conversation? The emails will be kept. <strong>This can't be undone.</strong>
        </p>
        {inText.length > 0 && (
          <label className="dialog-check">
            <input type="checkbox" checked={alsoInText} onChange={(e) => setAlsoInText(e.target.checked)} />
            Also delete images inside the email text (logos, signatures; {n(inText.length, "image")}, {size(sum(inText))})
          </label>
        )}
        <div className="dialog-buttons">
          <button className="text-button" onClick={onCancel} autoFocus>Cancel</button>
          <button className="text-button danger filled" disabled={!chosen.length} onClick={() => onConfirm(chosen.map((a) => a.id), bytes)}>
            Delete attachments
          </button>
        </div>
      </div>
    </div>
  );
}
