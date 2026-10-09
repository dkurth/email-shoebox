// Highlight the words of the current search: in React text (subjects, snippets, plain bodies)
// and inside an HTML email's iframe. Matching ignores case and accents (shared/search.ts).
import { createContext, useContext, type ReactNode } from "react";
import { findMatches, type HighlightTerm } from "../shared/search.ts";

const NONE: HighlightTerm[] = [];
export const HighlightContext = createContext<HighlightTerm[]>(NONE);
export const useHighlight = () => useContext(HighlightContext);

export function highlightText(text: string, terms: HighlightTerm[]): ReactNode {
  const ranges = findMatches(text, terms);
  if (!ranges.length) return text;
  const out: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([s, e], i) => {
    if (s > at) out.push(text.slice(at, s));
    out.push(<mark key={i} className="hl">{text.slice(s, e)}</mark>);
    at = e;
  });
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** <Hl text="…" />: the text, with the current search's words marked. */
export function Hl({ text }: { text: string }) {
  return <>{highlightText(text, useHighlight())}</>;
}

const SKIP = new Set(["STYLE", "SCRIPT", "TEXTAREA", "TITLE", "NOSCRIPT", "MARK"]);

/** Wrap matches in <mark> inside a DOM tree (an email's iframe). Returns how many were marked. */
export function highlightDom(root: Element, terms: HighlightTerm[]): number {
  if (!terms.length) return 0;
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      for (let p = n.parentElement; p && p !== root; p = p.parentElement) if (SKIP.has(p.tagName)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  let count = 0;
  for (const node of nodes) {
    const ranges = findMatches(node.data, terms);
    // From the end, so earlier offsets stay valid.
    for (let i = ranges.length - 1; i >= 0; i--) {
      const [s, e] = ranges[i];
      node.splitText(e);
      const mid = node.splitText(s);
      const mark = doc.createElement("mark");
      mark.className = "hl";
      mid.parentNode!.replaceChild(mark, mid);
      mark.appendChild(mid);
      count++;
    }
  }
  return count;
}
