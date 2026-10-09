import { describe, expect, it } from "vitest";
import { OPERATORS, SEARCH_HELP, contextSnippet, findMatches, fold, highlightTerms, parseQuery, searchContext, type Node } from "../shared/search.ts";

const w = (text: string, prefix = false): Node => ({ text, phrase: false, prefix });
const ph = (text: string, prefix = false): Node => ({ text, phrase: true, prefix });
const op = (o: string, value: string, phrase = false, prefix = false): Node => ({ op: o, value, phrase, prefix });
const and = (...and: Node[]): Node => ({ and });
const or = (...or: Node[]): Node => ({ or });
const not = (n: Node): Node => ({ not: n });

const CASES: [string, Node][] = [
  ["", and()],
  ["   ", and()],
  ["invoice", w("invoice")],
  ["dinner friday", and(w("dinner"), w("friday"))],
  ["dinner AND friday", and(w("dinner"), w("friday"))],
  ['"tax return"', ph("tax return")],
  ['"unclosed phrase', ph("unclosed phrase")],
  ['""', and()],
  ["-movie", not(w("movie"))],
  ["dinner -movie", and(w("dinner"), not(w("movie")))],
  ["a-b", w("a-b")], // a dash inside a word is not NOT
  ["- alone", and(w("-"), w("alone"))],
  ["a OR b", or(w("a"), w("b"))],
  ["a or b", and(w("a"), w("or"), w("b"))], // lower-case or is a word, as in Gmail
  ["a | b", or(w("a"), w("b"))],
  ["a OR b c", and(or(w("a"), w("b")), w("c"))],
  ["a b OR c", and(w("a"), or(w("b"), w("c")))],
  ["a OR b OR c", or(w("a"), w("b"), w("c"))],
  ["{a b}", or(w("a"), w("b"))],
  ["{from:amy from:david}", or(op("from", "amy"), op("from", "david"))],
  ["(a OR b) c", and(or(w("a"), w("b")), w("c"))],
  ["((a))", w("a")],
  ["(a b", and(w("a"), w("b"))], // unclosed group
  ["a ) b", and(w("a"), w("b"))], // stray closer
  ["-(a OR b)", not(or(w("a"), w("b")))],
  ["from:alice", op("from", "alice")],
  ["FROM:alice", op("from", "alice")],
  ["from:alice@example.com", op("from", "alice@example.com")],
  ['from:"Alice Adams"', op("from", "Alice Adams", true)],
  ["from:", w("from:")], // no value: plain text
  ["foo:bar", w("foo:bar")], // unknown operator: plain text
  ["subject:(dinner film)", and(op("subject", "dinner"), op("subject", "film"))],
  ["subject:(dinner OR film)", or(op("subject", "dinner"), op("subject", "film"))],
  ["-from:me", not(op("from", "me"))],
  ["is:unread label:work", and(op("is", "unread"), op("label", "work"))],
  ["after:2024/03/01 before:2024-04-01", and(op("after", "2024/03/01"), op("before", "2024-04-01"))],
  ["larger:10M", op("larger", "10M")],
  ['note:"call back"', op("note", "call back", true)],
  ["note:(a b)", and(op("note", "a"), op("note", "b"))],
  ["invoic*", w("invoic", true)],
  ["i*", w("i*")], // too short for a prefix
  ["fo*o", w("fo*o")],
  ["*", w("*")],
  ['"tax retur*"', ph("tax retur", true)],
  ["subject:invoic*", op("subject", "invoic", false, true)],
  ["has:attachment filename:pdf", and(op("has", "attachment"), op("filename", "pdf"))],
  ["list:announce.hikers.example", op("list", "announce.hikers.example")],
];

describe("parseQuery", () => {
  it.each(CASES)("%s", (q, expected) => {
    expect(parseQuery(q)).toEqual(expected);
  });

  it("never throws", () => {
    for (const q of ['(((', '))) {{{ ', '"', '-', 'OR', 'OR OR', 'from:(', '{', 'a OR', '- - -x', 'subject:()', '"a" "b', '\\', "\u0000"]) {
      expect(() => parseQuery(q)).not.toThrow();
    }
  });
});

describe("highlightTerms", () => {
  it("collects positive words, phrases, subject: and note: terms", () => {
    expect(highlightTerms(parseQuery('dinner "tax return" -movie subject:report note:call from:alice invoic*'))).toEqual([
      { text: "dinner", prefix: false },
      { text: "tax return", prefix: false },
      { text: "report", prefix: false },
      { text: "call", prefix: false },
      { text: "invoic", prefix: true },
    ]);
    expect(highlightTerms(parseQuery("-(a OR b)"))).toEqual([]);
    expect(highlightTerms(parseQuery("-(-a)"))).toEqual([{ text: "a", prefix: false }]);
  });
});

describe("searchContext", () => {
  it("looks at Trash and Spam only when asked", () => {
    expect(searchContext(parseQuery("invoice"))).toBe("normal");
    expect(searchContext(parseQuery("in:trash invoice"))).toBe("trash");
    expect(searchContext(parseQuery("in:spam"))).toBe("spam");
    expect(searchContext(parseQuery("in:anywhere x"))).toBe("all");
    expect(searchContext(parseQuery("in:trash OR in:spam"))).toBe("all");
    expect(searchContext(parseQuery("-in:trash"))).toBe("normal");
  });
});

describe("findMatches", () => {
  it("matches whole words, ignoring case and accents", () => {
    expect(findMatches("Café au lait at the CAFE", [{ text: "cafe", prefix: false }])).toEqual([[0, 4], [20, 24]]);
    expect(findMatches("cafeteria", [{ text: "cafe", prefix: false }])).toEqual([]);
    expect(findMatches("Invoices and invoicing", [{ text: "invoic", prefix: true }])).toEqual([[0, 8], [13, 22]]);
    expect(findMatches("the tax\n return", [{ text: "tax return", prefix: false }])).toEqual([[4, 15]]);
    expect(findMatches("a+b (c)", [{ text: "(c)", prefix: false }])).toEqual([[4, 7]]);
    expect(fold("Grüße")).toHaveLength("Grüße".length);
  });
});

describe("SEARCH_HELP", () => {
  const rows = SEARCH_HELP.flatMap((g) => g.rows);

  it("has a row for every operator", () => {
    const documented = new Set(rows.flatMap((r) => [...r.syntax.matchAll(/([a-z_0-9]+):/g)].map((m) => m[1])));
    for (const o of OPERATORS) expect(documented, o).toContain(o);
  });

  it("every example parses, with no operator falling back to plain text", () => {
    const ops = (n: Node): string[] =>
      "and" in n ? n.and.flatMap(ops) : "or" in n ? n.or.flatMap(ops) : "not" in n ? ops(n.not) : "op" in n ? [n.op] : [];
    for (const r of rows) {
      const written = [...r.example.matchAll(/(?:^|[\s({-])([a-z_0-9]+):/g)].map((m) => m[1]);
      expect([...new Set(ops(parseQuery(r.example)))].sort(), r.example).toEqual([...new Set(written)].sort());
    }
  });
});

describe("contextSnippet", () => {
  const t = (text: string) => [{ text, prefix: false }];
  it("cuts at word boundaries with … at a cut end", () => {
    const text = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen";
    expect(contextSnippet(text, t("nine"), 30, 10)).toBe("…eight nine ten eleven twelve…");
    expect(contextSnippet(text, t("one"), 20, 10)).toBe("one two three four…");
    expect(contextSnippet("short text", t("text"))).toBe("short text");
    expect(contextSnippet("a\n\n  b   c", t("c"))).toBe("a b c");
    expect(contextSnippet("nothing here", t("zebra"))).toBeNull();
  });
});
