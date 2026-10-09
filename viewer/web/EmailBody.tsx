// Render one email body safely.
// HTML: DOMPurify, then a sandboxed iframe (no scripts) with its own Content-Security-Policy.
// Remote images are blocked until the user clicks "Show images".
import DOMPurify from "dompurify";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AttachmentInfo } from "../shared/types.ts";
import { highlightDom, highlightText, useHighlight } from "./highlight.tsx";

const REMOTE = /^(https?:)?\/\//i;

// Shown in place of a deleted inline image. Made by the app, not taken from the email.
const DELETED_IMAGE =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="48"><rect width="160" height="48" rx="6" fill="#eceff1" stroke="#c4c7c5"/>' +
      '<text x="80" y="29" font-family="Arial" font-size="12" fill="#5f6368" text-anchor="middle">image deleted</text></svg>',
  );

interface Prepared {
  html: string;
  remoteImages: number;
}

export function prepareHtml(raw: string, attachments: AttachmentInfo[], showImages: boolean): Prepared {
  const byCid = new Map(attachments.filter((a) => a.contentId).map((a) => [a.contentId!.toLowerCase(), a]));
  let remoteImages = 0;
  const purify = DOMPurify(window); // a private instance, so hooks do not leak between calls
  purify.addHook("afterSanitizeAttributes", (node) => {
    const el = node as Element;
    if (el.tagName === "A") {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
    for (const attr of ["src", "background"]) {
      const v = el.getAttribute?.(attr);
      if (!v) continue;
      if (/^cid:/i.test(v)) {
        const a = byCid.get(decodeURIComponent(v.slice(4)).replace(/^<|>$/g, "").toLowerCase());
        if (a?.deletedAt) {
          el.setAttribute(attr, DELETED_IMAGE);
          el.setAttribute("title", "This image was deleted from the archive");
        } else if (a) el.setAttribute(attr, `/api/attachments/${a.id}/inline`);
        else el.removeAttribute(attr);
      } else if (REMOTE.test(v)) {
        remoteImages++;
        if (!showImages) {
          el.setAttribute(`data-blocked-${attr}`, v);
          el.removeAttribute(attr);
        }
      }
    }
  });
  const clean = purify.sanitize(raw, {
    WHOLE_DOCUMENT: true,
    ADD_TAGS: ["style"],
    ADD_ATTR: ["target", "background"],
    FORBID_TAGS: ["form", "input", "button", "textarea", "select", "iframe", "frame", "object", "embed", "base", "meta", "link", "audio", "video"],
  }) as string;
  // Remote images in CSS (background: url(...)) are counted too; the CSP below blocks them.
  if (/url\(\s*['"]?(https?:)?\/\//i.test(clean)) remoteImages++;
  const csp = [
    "default-src 'none'",
    `img-src 'self' data:${showImages ? " https: http:" : ""}`,
    "style-src 'unsafe-inline'",
    `font-src data:${showImages ? " https:" : ""}`,
  ].join("; ");
  const head = `<meta http-equiv="Content-Security-Policy" content="${csp}"><style>body{margin:0;padding:12px 16px;font:14px Arial,Helvetica,sans-serif;color:#222;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}mark.hl{background:#fde293;color:inherit}</style>`;
  const html = clean.includes("<head>") ? clean.replace("<head>", `<head>${head}`) : `<!doctype html><html><head>${head}</head><body>${clean}</body></html>`;
  return { html, remoteImages };
}

function HtmlBody({ html, attachments }: { html: string; attachments: AttachmentInfo[] }) {
  const [showImages, setShowImages] = useState(false);
  const prepared = useMemo(() => prepareHtml(html, attachments, showImages), [html, attachments, showImages]);
  const frame = useRef<HTMLIFrameElement>(null);
  const terms = useHighlight();

  useEffect(() => {
    const f = frame.current;
    if (!f) return;
    let observer: ResizeObserver | undefined;
    const fit = () => {
      const doc = f.contentDocument;
      if (!doc?.body) return;
      // Measure the body: the root element is never shorter than the frame, so a short email
      // would keep the frame's first (default 150px) height.
      f.style.height = `${Math.ceil(Math.max(doc.body.scrollHeight, doc.body.getBoundingClientRect().height)) + 4}px`;
    };
    // Keys pressed after clicking inside the email still reach the app's shortcuts.
    const forward = (e: KeyboardEvent) =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey }));
    const onLoad = () => {
      if (f.contentDocument?.body) highlightDom(f.contentDocument.body, terms);
      fit();
      f.contentDocument?.addEventListener("keydown", forward);
      const body = f.contentDocument?.body;
      if (body) {
        observer = new ResizeObserver(fit);
        observer.observe(body);
      }
    };
    f.addEventListener("load", onLoad);
    return () => {
      f.removeEventListener("load", onLoad);
      observer?.disconnect();
    };
  }, [prepared.html, terms]);

  return (
    <div className="html-body">
      {prepared.remoteImages > 0 && !showImages && (
        <div className="images-bar">
          Images from the internet are not shown. <button onClick={() => setShowImages(true)}>Show images in this message</button>
        </div>
      )}
      <iframe
        ref={frame}
        title="Message body"
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        srcDoc={prepared.html}
      />
    </div>
  );
}

const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g;

function PlainBody({ text }: { text: string }) {
  const terms = useHighlight();
  const parts = text.split(URL_RE);
  return (
    <div className="plain-body">
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <a key={i} href={p} target="_blank" rel="noopener noreferrer">
            {p}
          </a>
        ) : (
          <span key={i}>{highlightText(p, terms)}</span>
        ),
      )}
    </div>
  );
}

export function EmailBody(props: { bodyHtml: string | null; bodyText: string | null; attachments: AttachmentInfo[] }) {
  if (props.bodyHtml) return <HtmlBody html={props.bodyHtml} attachments={props.attachments} />;
  if (props.bodyText) return <PlainBody text={props.bodyText} />;
  return <div className="plain-body empty">(This message has no text.)</div>;
}
