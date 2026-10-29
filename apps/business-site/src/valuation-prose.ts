/**
 * The written valuation report as the page lays it out: evidence citations numbered in reading order, run-in
 * capitalised headings lifted out of the paragraphs, and a one-line lead per dimension. Nothing here changes a
 * word of the report; it only decides what is a heading, a paragraph, or a footnote.
 */

/** Evidence ids as the report cites them: in brackets, in parentheses or bare. */
export const CITE = /[[(]?\b(e[0-9a-f]{10})\b[\])]?/g;

/** Evidence ids in the order the report first cites them, then the rest of the evidence list. */
export function citationOrder(texts: Array<string | null | undefined>, evidenceIds: string[]): Map<string, number> {
  const order = new Map<string, number>();
  const add = (id: string) => { if (!order.has(id)) order.set(id, order.size + 1); };
  for (const text of texts) for (const match of (text ?? "").matchAll(CITE)) add(match[1]!);
  for (const id of evidenceIds) add(id);
  return order;
}

export type ProsePart = { kind: "text"; text: string } | { kind: "cites"; ids: string[] };

/** Text split around its citations; citations with nothing but whitespace between them form one group. */
export function proseParts(text: string): ProsePart[] {
  const parts: ProsePart[] = [];
  let last = 0;
  for (const match of text.matchAll(CITE)) {
    const at = match.index ?? 0;
    const between = text.slice(last, at);
    const previous = parts[parts.length - 1];
    if (previous?.kind === "cites" && between.trim() === "") previous.ids.push(match[1]!);
    else {
      if (between) parts.push({ kind: "text", text: between });
      parts.push({ kind: "cites", ids: [match[1]!] });
    }
    last = at + match[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}

export type ProseBlock = { heading: string | null; text: string };

/**
 * A run-in heading: two or more capitalised words (hyphens allowed, an optional parenthetical) at the start of a
 * sentence, closed by a full stop, colon or question mark. "PUBLIC FACTS (as reported). Growth: ..." opens a block
 * headed "PUBLIC FACTS (as reported)"; "RPO $664B vs $455B" and "GAAP EPS $1.92" do not, since nothing closes them.
 */
const RUN_IN = /(?:^|(?<=[.!?]\s+))([A-Z][A-Z0-9'’&/-]*(?:[ -][A-Z0-9][A-Z0-9'’&/-]*){1,9}(?:\s*\([^)]{0,60}\))?)(\?|[.:])\s+/g;

/** Paragraphs (blank-line separated) with run-in headings lifted into their own blocks. */
export function proseBlocks(text: string): ProseBlock[] {
  const blocks: ProseBlock[] = [];
  for (const paragraph of text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)) {
    let heading: string | null = null, last = 0;
    for (const match of paragraph.matchAll(RUN_IN)) {
      const at = match.index ?? 0;
      const body = paragraph.slice(last, at).trim();
      if (body) blocks.push({ heading, text: body });
      heading = match[1]! + (match[2] === "?" ? "?" : "");
      last = at + match[0].length;
    }
    const tail = paragraph.slice(last).trim();
    if (tail) blocks.push({ heading, text: tail });
    else if (heading) blocks.push({ heading, text: "" });
  }
  return blocks;
}

/** The first sentence of a rationale (English or Chinese) with its citations removed: what a dimension's row says. */
export function leadSentence(text: string): string {
  const clean = text.replace(CITE, "").replace(/\s+([.,;:])/g, "$1").replace(/\s{2,}/g, " ").trim();
  const match = /^[^]*?(?:[.!?](?=\s+[A-Z("“]|$)|[。！？])/.exec(clean);
  return (match ? match[0] : clean).trim();
}

/** The last step of a source path ("Item 2. … › Liquidity and Capital Resources" → "Liquidity and Capital Resources"). */
export function pathLeaf(path: string | null | undefined): string | null {
  if (!path) return null;
  const leaf = path.split("›").map(s => s.trim()).filter(Boolean).pop() ?? null;
  return leaf ? leaf.replace(/:$/, "") : null;
}
