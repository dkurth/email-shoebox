// Keys for a PDF shown in the viewer's lightbox (an <iframe class="lightbox-pdf"> holding Chromium's PDF viewer).
// The page can't do these itself: once the PDF has focus the page never sees a key, and before that the PDF
// viewer ignores arrow keys. The main process can reach into the PDF viewer's frame, so it fills the gaps:
//   Esc with the PDF focused: the viewer's frame asks the page to close the lightbox, as Esc does everywhere else.
//   ←/→ before the PDF has been clicked: previous/next page; ↑/↓: scroll a few lines, as in Preview.
//   (Once the PDF has focus, its viewer does these itself.)
import type { WebContents, WebFrameMain } from "electron";

type Where = "none" | "inside" | "outside";

const SCROLL_STEP = 40; // px, what the viewer itself scrolls for an arrow key

// The viewer's own paging and scrolling; if a later Chromium renames them, these keys simply do nothing here.
const ACTIONS: Record<string, string> = {
  ArrowRight: "viewport.goToNextPage()",
  ArrowLeft: "viewport.goToPreviousPage()",
  ArrowDown: `viewport.scrollBy({ x: 0, y: ${SCROLL_STEP} })`,
  ArrowUp: `viewport.scrollBy({ x: 0, y: -${SCROLL_STEP} })`,
};

const WHERE = `(() => {
  const f = document.querySelector("iframe.lightbox-pdf");
  return !f ? "none" : document.activeElement === f ? "inside" : "outside";
})()`;

// Runs in the PDF viewer's frame, once: Esc there posts a message the lightbox listens for (Lightbox.tsx).
const ESCAPE_HOOK = `if (!window.__shoeboxEscape) {
  window.__shoeboxEscape = true;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) window.top.postMessage({ shoebox: "close-lightbox" }, "*");
  }, true);
}`;

/** Chromium's PDF viewer: an extension frame inside the lightbox's frame. */
function pdfViewerFrame(contents: WebContents): WebFrameMain | undefined {
  return contents.mainFrame.framesInSubtree.find((f) => f.url.startsWith("chrome-extension://") && !!f.parent?.url.includes("/inline/"));
}

async function handle(contents: WebContents, key: string): Promise<void> {
  try {
    const where = (await contents.mainFrame.executeJavaScript(WHERE)) as Where;
    if (where !== "outside") return;
    await pdfViewerFrame(contents)?.executeJavaScript(`try { document.querySelector("pdf-viewer").${ACTIONS[key]} } catch {}`);
  } catch {
    /* the page navigated away, or the lightbox closed meanwhile */
  }
}

export function watchPdfLightboxKeys(contents: WebContents): void {
  contents.on("did-frame-finish-load", () => {
    const viewer = pdfViewerFrame(contents);
    if (viewer) viewer.executeJavaScript(ESCAPE_HOOK).catch(() => {});
  });
  contents.on("before-input-event", (_e, input) => {
    if (input.type !== "keyDown" || input.alt || input.control || input.meta || input.shift) return;
    if (!Object.hasOwn(ACTIONS, input.key)) return;
    if (!pdfViewerFrame(contents)) return; // no PDF showing: leave the key alone, without asking the page
    void handle(contents, input.key);
  });
}
