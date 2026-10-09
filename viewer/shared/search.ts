// Gmail search syntax: the parser (shared by server and web), highlight terms, and the help table.
// The parser never throws: a bad query gives the best parse it can, as Gmail does.

export type Node =
  | { and: Node[] }
  | { or: Node[] }
  | { not: Node }
  | { text: string; phrase: boolean; prefix: boolean }
  | { op: string; value: string; phrase: boolean; prefix: boolean };

/** Operators the search understands. Anything else ("foo:bar") is searched as plain text. */
export const OPERATORS = [
  "from", "to", "cc", "bcc", "subject", "label", "in", "category", "is", "has", "filename",
  "after", "before", "newer", "older", "newer_than", "older_than", "larger", "smaller", "size",
  "rfc822msgid", "list", "note",
] as const;
const KNOWN = new Set<string>(OPERATORS);

/** A prefix search needs at least this many characters before the "*". */
export const MIN_PREFIX = 2;

type Token =
  | { t: "(" | ")" | "{" | "}" | "OR" | "AND" | "-" }
  | { t: "word"; v: string }
  | { t: "phrase"; v: string }
  | { t: "op"; op: string; v: string; phrase: boolean }
  | { t: "opgroup"; op: string };

const isSpace = (c: string) => /\s/.test(c);

function tokenize(q: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const readPhrase = (): string => {
    // at the opening quote; an unclosed quote runs to the end
    const end = q.indexOf('"', i + 1);
    const v = q.slice(i + 1, end < 0 ? q.length : end);
    i = end < 0 ? q.length : end + 1;
    return v;
  };
  while (i < q.length) {
    const c = q[i];
    if (isSpace(c)) {
      i++;
      continue;
    }
    if ("(){}".includes(c)) {
      out.push({ t: c as "(" | ")" | "{" | "}" });
      i++;
      continue;
    }
    if (c === "|") {
      out.push({ t: "OR" });
      i++;
      continue;
    }
    if (c === '"') {
      out.push({ t: "phrase", v: readPhrase() });
      continue;
    }
    if (c === "-" && i + 1 < q.length && !isSpace(q[i + 1]) && (i === 0 || isSpace(q[i - 1]) || "({".includes(q[i - 1]))) {
      out.push({ t: "-" });
      i++;
      continue;
    }
    // A word: up to a space, a parenthesis or brace, or a quote.
    let j = i;
    while (j < q.length && !isSpace(q[j]) && !'(){}"'.includes(q[j])) j++;
    const word = q.slice(i, j);
    i = j;
    const m = /^([a-z_0-9]+):(.*)$/i.exec(word);
    if (m && KNOWN.has(m[1].toLowerCase())) {
      const op = m[1].toLowerCase();
      if (m[2] === "" && q[i] === '"') {
        out.push({ t: "op", op, v: readPhrase(), phrase: true });
        continue;
      }
      if (m[2] === "" && q[i] === "(") {
        out.push({ t: "opgroup", op });
        i++;
        continue;
      }
      if (m[2] !== "") {
        out.push({ t: "op", op, v: m[2], phrase: false });
        continue;
      }
      // "from:" with nothing after it: plain text
    }
    if (word === "OR") out.push({ t: "OR" });
    else if (word === "AND") out.push({ t: "AND" });
    else if (word) out.push({ t: "word", v: word });
  }
  return out;
}

function prefixOf(v: string): { value: string; prefix: boolean } {
  const m = /^(.*?)\*+$/.exec(v);
  if (m && [...m[1].trim()].length >= MIN_PREFIX && !/\s$/.test(m[1])) return { value: m[1], prefix: true };
  return { value: v, prefix: false };
}

function textNode(v: string, phrase: boolean): Node {
  const p = prefixOf(v);
  return { text: p.value, phrase, prefix: p.prefix };
}

/** Apply an operator to every term of a group: subject:(a b) = subject:a subject:b. */
function distribute(op: string, n: Node): Node {
  if ("and" in n) return { and: n.and.map((c) => distribute(op, c)) };
  if ("or" in n) return { or: n.or.map((c) => distribute(op, c)) };
  if ("not" in n) return { not: distribute(op, n.not) };
  if ("text" in n) return { op, value: n.text, phrase: n.phrase, prefix: n.prefix };
  return n; // an operator inside the group keeps its own
}

class Parser {
  private i = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek() {
    return this.tokens[this.i];
  }

  // Gmail's precedence: OR binds tighter than AND, so "a b OR c" is a AND (b OR c).
  parse(): Node {
    const parts: Node[] = [];
    while (this.i < this.tokens.length) {
      const n = this.andExpr();
      if (n) parts.push(n);
      else this.i++; // a stray ")" or "}": skip it
    }
    return simplify({ and: parts });
  }

  private andExpr(): Node | null {
    const items: Node[] = [];
    for (;;) {
      const t = this.peek();
      if (!t || t.t === ")" || t.t === "}") break;
      if (t.t === "AND" || t.t === "OR") {
        this.i++; // AND is the default; an OR with nothing before it is ignored
        continue;
      }
      const n = this.orExpr();
      if (n) items.push(n);
    }
    if (!items.length) return null;
    return items.length > 1 ? { and: items } : items[0];
  }

  private orExpr(): Node | null {
    const first = this.unary();
    if (!first) return null;
    const items = [first];
    while (this.peek()?.t === "OR") {
      this.i++;
      const t = this.peek();
      if (!t || t.t === ")" || t.t === "}") break;
      const next = this.unary();
      if (next) items.push(next);
    }
    return items.length > 1 ? { or: items } : first;
  }

  private unary(): Node | null {
    const t = this.peek();
    if (t?.t === "-") {
      this.i++;
      const n = this.unary();
      return n ? { not: n } : null;
    }
    return this.primary();
  }

  private group(close: ")" | "}"): Node | null {
    const parts: Node[] = [];
    while (this.i < this.tokens.length && this.peek()!.t !== close) {
      const n = this.andExpr();
      if (n) parts.push(n);
      else if (this.peek()?.t === (close === ")" ? "}" : ")")) this.i++; // the other closer: skip
    }
    this.i++; // the closer (or the end)
    if (!parts.length) return null;
    return parts.length > 1 ? { and: parts } : parts[0];
  }

  private primary(): Node | null {
    const t = this.tokens[this.i++];
    switch (t.t) {
      case "(":
        return this.group(")");
      case "{": {
        // Gmail's {a b} means a OR b.
        const g = this.group("}");
        if (!g) return null;
        return "and" in g ? { or: g.and } : g;
      }
      case "opgroup": {
        const g = this.group(")");
        return g ? distribute(t.op, g) : null;
      }
      case "word":
        return textNode(t.v, false);
      case "phrase":
        return t.v.trim() ? textNode(t.v, true) : null;
      case "op": {
        const p = prefixOf(t.v);
        return { op: t.op, value: p.value, phrase: t.phrase, prefix: p.prefix };
      }
      default:
        return null; // ")" "}" "AND" "OR" in odd places
    }
  }
}

function simplify(n: Node): Node {
  if ("and" in n) {
    const items = n.and.map(simplify).flatMap((c) => ("and" in c ? c.and : [c]));
    return items.length === 1 ? items[0] : { and: items };
  }
  if ("or" in n) {
    const items = n.or.map(simplify).flatMap((c) => ("or" in c ? c.or : [c]));
    return items.length === 1 ? items[0] : { or: items };
  }
  if ("not" in n) return { not: simplify(n.not) };
  return n;
}

export function parseQuery(q: string): Node {
  return new Parser(tokenize(q)).parse();
}

/** True for an empty query (nothing to search for). */
export function isEmptyQuery(n: Node): boolean {
  return ("and" in n && n.and.length === 0) || ("or" in n && n.or.length === 0);
}

export interface HighlightTerm {
  text: string;
  prefix: boolean;
}

/** The words to highlight: positive text, phrase, subject: and note: terms. */
export function highlightTerms(n: Node, negated = false): HighlightTerm[] {
  if ("and" in n) return dedupe(n.and.flatMap((c) => highlightTerms(c, negated)));
  if ("or" in n) return dedupe(n.or.flatMap((c) => highlightTerms(c, negated)));
  if ("not" in n) return highlightTerms(n.not, !negated);
  if (negated) return [];
  if ("text" in n) return n.text.trim() ? [{ text: n.text.trim(), prefix: n.prefix }] : [];
  if ((n.op === "subject" || n.op === "note") && n.value.trim()) return [{ text: n.value.trim(), prefix: n.prefix }];
  return [];
}

function dedupe(ts: HighlightTerm[]): HighlightTerm[] {
  const seen = new Set<string>();
  return ts.filter((t) => {
    const k = `${t.prefix ? 1 : 0}${t.text.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Which messages a search looks at: Trash and Spam only when the query asks for them. */
export function searchContext(n: Node): "normal" | "trash" | "spam" | "all" {
  const ins: string[] = [];
  const walk = (x: Node, neg: boolean) => {
    if ("and" in x) x.and.forEach((c) => walk(c, neg));
    else if ("or" in x) x.or.forEach((c) => walk(c, neg));
    else if ("not" in x) walk(x.not, !neg);
    else if ("op" in x && x.op === "in" && !neg) ins.push(x.value.toLowerCase());
  };
  walk(n, false);
  if (ins.includes("anywhere")) return "all";
  const trash = ins.includes("trash");
  const spam = ins.includes("spam");
  if (trash && spam) return "all";
  if (trash) return "trash";
  if (spam) return "spam";
  return "normal";
}

// ------------------------------------------------------------------ matching (highlights, snippets)

/** Lower case, accents removed (like the index's remove_diacritics 2). Keeps the string length. */
export function fold(s: string): string {
  let out = "";
  for (const ch of s) {
    const base = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
    const lower = (base || ch).toLowerCase();
    // keep one output unit per input unit, so indexes match the original text
    out += lower.length === ch.length ? lower : ch.toLowerCase().length === ch.length ? ch.toLowerCase() : ch;
  }
  return out;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Where the terms match in a text: [start, end) ranges, sorted, not overlapping. Whole words only. */
export function findMatches(text: string, terms: HighlightTerm[]): [number, number][] {
  if (!terms.length || !text) return [];
  const hay = fold(text);
  const ranges: [number, number][] = [];
  for (const term of terms) {
    const needle = fold(term.text).replace(/\s+/g, " ");
    if (!needle) continue;
    // Phrases may span any whitespace; match word by word.
    const words = needle.split(" ").map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const pattern = words.join("\\s+") + (term.prefix ? "[\\p{L}\\p{N}]*" : "");
    const re = new RegExp(pattern, "gu");
    for (let m = re.exec(hay); m; m = re.exec(hay)) {
      const start = m.index;
      const end = start + m[0].length;
      const before = start > 0 ? hay[start - 1] : "";
      const after = end < hay.length ? hay[end] : "";
      const startsWord = !WORD_CHAR.test(needle[0]) || !before || !WORD_CHAR.test(before);
      const endsWord = term.prefix || !after || !WORD_CHAR.test(after) || !WORD_CHAR.test(needle[needle.length - 1]);
      if (startsWord && endsWord) ranges.push([start, end]);
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/**
 * The text around the first match: about `before` characters before it and `max` in all, cut at
 * word boundaries, whitespace collapsed, "…" at a cut end. null if nothing matches.
 */
export function contextSnippet(text: string, terms: HighlightTerm[], max = 200, before = 60): string | null {
  const flat = text.replace(/\s+/g, " ").trim();
  const first = findMatches(flat, terms)[0];
  if (!first) return null;
  let start = Math.max(0, first[0] - before);
  if (start > 0) {
    const space = flat.indexOf(" ", start);
    start = space >= 0 && space < first[0] ? space + 1 : first[0];
  }
  let end = Math.min(flat.length, start + max);
  if (end < flat.length) {
    const space = flat.lastIndexOf(" ", end);
    if (space > first[1]) end = space;
  }
  return (start > 0 ? "…" : "") + flat.slice(start, end) + (end < flat.length ? "…" : "");
}

// ------------------------------------------------------------------ help

export interface HelpRow {
  syntax: string;
  what: string;
  example: string;
}

export const SEARCH_HELP: { group: string; rows: HelpRow[] }[] = [
  {
    group: "Words",
    rows: [
      { syntax: "word", what: "Messages with this word (subject, people, text, attachment names), or a thread whose note has it", example: "invoice" },
      { syntax: '"exact phrase"', what: "These words, in this order", example: '"tax return"' },
      { syntax: "word*", what: "Words that start with this (at least 2 letters before the *)", example: "invoic*" },
    ],
  },
  {
    group: "Combine",
    rows: [
      { syntax: "a b", what: "Both (this is the default)", example: "dinner friday" },
      { syntax: "a OR b", what: "Either one (OR in capitals; | also works)", example: "from:amy OR from:david" },
      { syntax: "{a b}", what: "Either one", example: "{from:amy from:david}" },
      { syntax: "-word", what: "Leave out messages with this (works on any option)", example: "dinner -movie" },
      { syntax: "( … )", what: "Group terms", example: "subject:(dinner film)" },
    ],
  },
  {
    group: "People",
    rows: [
      { syntax: "from:", what: "Sender: a full address, or part of a name or address", example: "from:alice" },
      { syntax: "to:", what: "Recipient (To, Cc or Bcc)", example: "to:bob@example.com" },
      { syntax: "cc:", what: "Recipient in Cc", example: "cc:carol" },
      { syntax: "bcc:", what: "Recipient in Bcc", example: "bcc:dana" },
      { syntax: "me", what: "Your own addresses, with from:, to:, cc: or bcc:", example: "from:me" },
    ],
  },
  {
    group: "Where",
    rows: [
      { syntax: "in:", what: "inbox, sent, drafts, chats, starred, important, spam, trash, anywhere, or a label", example: "in:sent" },
      { syntax: "label:", what: "A label (case, spaces, - and / don't matter)", example: "label:travel-2024" },
      { syntax: "category:", what: "personal, social, promotions, updates, forums…", example: "category:promotions" },
      { syntax: "list:", what: "A mailing list (its List-Id, or part of its name)", example: "list:announce" },
    ],
  },
  {
    group: "Status",
    rows: [
      { syntax: "is:unread", what: "Unread messages", example: "is:unread" },
      { syntax: "is:read", what: "Read messages", example: "is:read" },
      { syntax: "is:starred", what: "Starred messages", example: "is:starred" },
      { syntax: "is:important", what: "Messages marked important", example: "is:important" },
      { syntax: "has:userlabels", what: "Messages with one of your labels", example: "has:userlabels" },
      { syntax: "has:nouserlabels", what: "Messages with none of your labels", example: "has:nouserlabels" },
    ],
  },
  {
    group: "Attachments",
    rows: [
      { syntax: "has:attachment", what: "Messages with an attachment", example: "has:attachment" },
      { syntax: "filename:", what: "An attachment whose name contains this", example: "filename:pdf" },
    ],
  },
  {
    group: "Dates and size",
    rows: [
      { syntax: "after: / newer:", what: "On or after a date: 2024/03/01, 2024-03-01 or 3/1/2024", example: "after:2024/03/01" },
      { syntax: "before: / older:", what: "Before a date", example: "before:2024-03-01" },
      { syntax: "newer_than:", what: "Newer than a time ago: d (days), m (months), y (years)", example: "newer_than:3d" },
      { syntax: "older_than:", what: "Older than a time ago", example: "older_than:1y" },
      { syntax: "larger: / size:", what: "Bigger than a size in bytes, or with K or M", example: "larger:10M" },
      { syntax: "smaller:", what: "Smaller than a size", example: "smaller:500K" },
    ],
  },
  {
    group: "Notes",
    rows: [
      { syntax: "note:", what: "Only your notes (not the messages)", example: 'note:"call back"' },
      { syntax: "has:note", what: "Threads that have a note", example: "has:note" },
    ],
  },
  {
    group: "Other",
    rows: [
      { syntax: "subject:", what: "Words in the subject", example: "subject:report" },
      { syntax: "rfc822msgid:", what: "A message's Message-ID header", example: "rfc822msgid:abc123@mail.example.com" },
    ],
  },
];
