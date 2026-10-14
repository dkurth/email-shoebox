// Full-screen viewer for images and PDFs: ←/→ move between items, Esc or a click on the backdrop closes it.
// PDFs show in the browser's own PDF viewer (zoom, pages, print), framed.
import { useEffect, type MouseEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { size } from "./format.ts";

export interface LightboxItem {
  id: number; // attachment id
  name: string;
  size: number;
  details?: ReactNode; // extra lines under the image (the gallery shows date, sender, subject)
  kind?: "image" | "pdf"; // default image
}

/** A plain click on a link that would open a file in a new window: show it here instead. Cmd/Ctrl/Shift-click still opens the window. */
export function inLightbox(open: () => void) {
  return (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    open();
  };
}

export function Lightbox({ items, index, onIndex, onClose, actions }: {
  items: LightboxItem[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  actions?: (item: LightboxItem) => ReactNode; // more buttons next to Download
}) {
  const item = items[index];
  const go = (d: number) => {
    if (items.length) onIndex((index + d + items.length) % items.length);
  };

  useEffect(() => {
    // Capture phase on window, so the list and thread shortcuts never see these keys.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
      else if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return; // ↑/↓ don't scroll the page behind (the desktop app scrolls a PDF with them)
      e.preventDefault();
      e.stopPropagation();
    };
    const block = (e: KeyboardEvent) => e.stopPropagation();
    // A focused PDF gets every key, so the page never sees Esc. The desktop app has the PDF viewer post this instead.
    const onMessage = (e: MessageEvent) => {
      if (e.origin.startsWith("chrome-extension://") && (e.data as { shoebox?: string } | null)?.shoebox === "close-lightbox") onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keypress", block, true);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keypress", block, true);
      window.removeEventListener("message", onMessage);
    };
  });

  if (!item) return null;
  return (
    <div className="lightbox" role="dialog" aria-label={`${item.kind === "pdf" ? "PDF" : "Image"}: ${item.name}`} onClick={onClose}>
      <div className="lightbox-top" onClick={(e) => e.stopPropagation()}>
        <span className="lightbox-name">{item.name}</span>
        <span className="lightbox-meta">{size(item.size)}{items.length > 1 ? ` · ${index + 1} of ${items.length}` : ""}</span>
        <span className="spacer" />
        {actions?.(item)}
        <a className="text-button" href={`/api/attachments/${item.id}/download`} download={item.name}>Download</a>
        <button className="icon-button" aria-label="Close" title="Close (Esc)" onClick={onClose}><X size={20} /></button>
      </div>
      <div className="lightbox-stage">
        {items.length > 1 && (
          <button className="lightbox-nav prev" aria-label="Previous image" onClick={(e) => { e.stopPropagation(); go(-1); }}><ChevronLeft size={32} /></button>
        )}
        {item.kind === "pdf" ? (
          <iframe key={item.id} className="lightbox-pdf" src={`/api/attachments/${item.id}/inline/${encodeURIComponent(item.name)}`} title={item.name} />
        ) : (
          <img key={item.id} src={`/api/attachments/${item.id}/inline`} alt={item.name} onClick={(e) => e.stopPropagation()} />
        )}
        {items.length > 1 && (
          <button className="lightbox-nav next" aria-label="Next image" onClick={(e) => { e.stopPropagation(); go(1); }}><ChevronRight size={32} /></button>
        )}
      </div>
      {item.details && <div className="lightbox-details" onClick={(e) => e.stopPropagation()}>{item.details}</div>}
    </div>
  );
}
