import type { ArtifactDocument } from "../../analysis-contract/artifact.ts";
import { nodeText, parseHtml, serializeHtml, type HtmlNode } from "./html.ts";
import { chartTranslationUnits, localizeArtifactChart, localizeFinancialLabel } from "./chart-localization.ts";

/** A complete phrase, with its inline markup and figures represented by immutable tokens. */
export type ArtifactTranslationUnit = { id: string; text: string; context: string; values: Readonly<Record<string, string>> };
export type ArtifactTranslationPlan = {
  units: ArtifactTranslationUnit[];
  /** Every unit is required; a partial translation is never a published sourceDoc. */
  apply(translations: ReadonlyMap<string, string>): ArtifactDocument;
};

const TOKEN = /\{[ocx]\d+\}/g;
const NUMBER = /(?:\b(?:[369]|12)M\s+20\d{2}\b|\b(?:10-[KQ]|8-K|20-F|6-K)\b|(?:[$€£]\([\d,.]+\)|\([$€£][\d,.]+)(?:\s?(?:million|billion|mn|bn|[mb]))?\)?|(?:[$€£¥]\s*)?(?:[+−]|(?<![A-Za-z0-9])[-])?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)(?:\s?(?:trillion|billion|million|thousand|bn|mn|[BMKbm]|%|bps|pp|x|×)(?![A-Za-z]))?)/g;
const INLINE = new Set(["span", "strong", "em", "small", "sub", "sup", "a", "cite", "data", "kbd", "mark", "abbr", "br"]);
const PROTECTED = new Set(["kbd"]);
const TEXT_ATTRIBUTES = new Set(["title", "data-content"]);
const SEGMENT_CHARS = 3500;
const ORIGINAL_TERMS = new Set("gaap non-gaap rpo eps ebitda fcf arr ttm usd eur gbp cny hkd twd ai api cpu gpu cdn ceo cfo sec fy q".split(" "));

const tokens = (text: string) => text.match(TOKEN) ?? [];
const tokenSet = (text: string) => tokens(text).sort().join(" ");
const prose = (text: string) => text.replace(TOKEN, "");
function inlineStructure(text: string): string | null {
  const stack: string[] = [], parents: string[] = [], external: string[] = [];
  for (const token of tokens(text)) {
    if (token[1] !== "c") {
      parents.push(`${token}:${stack.at(-1) ?? "root"}`);
      if (token[1] === "o") stack.push(token);
    } else if (stack.length) {
      if (stack.pop() !== token.replace("{c", "{o")) return null;
    } else external.push(token);
  }
  return `${parents.sort().join("|")} / ${stack.join("|")} / ${external.join("|")}`;
}
const needsTranslation = (text: string, ticker: string) => {
  if (/^Item\s*(?:\{x\d+\}\s*)+$/i.test(text)) return false;
  const words = prose(text).trim();
  return /[A-Za-z]{2,}/.test(words) && words !== ticker && !ORIGINAL_TERMS.has(words.toLowerCase()) && !/^(?:Q|FY)(?:\s+(?:Q|FY))*$/.test(words);
};

/** A model translates text only. It cannot invent markup, remove a figure or alter a protected inline element. */
export function checkArtifactTranslation(source: string, target: string): string[] {
  const errors: string[] = [];
  if (tokenSet(source) !== tokenSet(target)) errors.push("artifact placeholders changed; copy every {oN}, {cN} and {xN} exactly once");
  if (inlineStructure(source) !== inlineStructure(target) || inlineStructure(target) === null) errors.push("artifact inline structure changed; keep each placeholder in its original parent element");
  if (/<\/?[A-Za-z][^>]*>/.test(target)) errors.push("HTML is not a translation; return text with the original placeholders only");
  return errors;
}

/** Divide long prose at sentence/word boundaries; no long unit is silently discarded. */
function segments(text: string): string[] {
  if (text.length <= SEGMENT_CHARS) return [text];
  const sentences: string[] = [];
  let from = 0;
  for (const match of text.matchAll(/[.!?](?:\s+|$)/g)) {
    const to = match.index + match[0].length;
    sentences.push(text.slice(from, to)); from = to;
  }
  if (from < text.length) sentences.push(text.slice(from));
  const parts: string[] = [];
  let current = "";
  const append = (part: string) => {
    if (current && current.length + part.length > SEGMENT_CHARS) { parts.push(current); current = ""; }
    current += part;
  };
  for (const sentence of sentences) {
    if (sentence.length <= SEGMENT_CHARS) { append(sentence); continue; }
    for (const word of sentence.match(/\S+\s*|\s+/g) ?? [sentence]) append(word);
  }
  if (current) parts.push(current);
  return parts;
}

type ElementNode = Extract<HtmlNode, { type: "element" }>;
type Literal = { type: "text"; value: string; formatted: string | null } | { type: "node"; value: HtmlNode };
type RichText = { text: string; elements: Map<number, ElementNode>; literals: Map<number, Literal> };

function encodeRich(nodes: HtmlNode[]): RichText {
  const elements = new Map<number, ElementNode>(), literals = new Map<number, Literal>();
  const literal = (value: Literal) => { const id = literals.size; literals.set(id, value); return `{x${id}}`; };
  const encode = (children: HtmlNode[]): string => children.map(node => {
    if (node.type === "text") return node.text.replace(/\s+/g, " ").replace(NUMBER, (value: string, offset: number, text: string) => {
      const scaled = /(?:trillion|billion|million|thousand|bn|mn|[BMK])$/i.test(value);
      // A prose "to $980m" is not a range. Only preserve a shared scale
      // when a second numeric endpoint is actually present.
      const range = /\d\s*(?:[–—-]|\bto)\s*$/i.test(text.slice(0, offset)) || /^\s*(?:[–—-]|to\b)\s*[$€£]?\d/i.test(text.slice(offset + value.length));
      return literal({ type: "text", value, formatted: !range && (scaled || /^\d+M\s+20\d{2}$/.test(value) || /[$€£]/.test(value)) ? localizeFinancialLabel(value) : null });
    });
    if (PROTECTED.has(node.tag) || node.tag === "br") return literal({ type: "node", value: node });
    const id = elements.size;
    elements.set(id, node);
    return `{o${id}}${encode(node.children)}{c${id}}`;
  }).join("");
  return { text: encode(nodes), elements, literals };
}

function decodeRich(rich: RichText, text: string, localized: boolean): HtmlNode[] {
  const roots: HtmlNode[] = [];
  const stack: Array<{ id: number; node: ElementNode }> = [];
  const originalParents = new Map<number, number | null>();
  const literalParents = new Map<number, number | null>();
  const originalStack: number[] = [];
  for (const token of tokens(rich.text)) {
    const id = Number(token.slice(2, -1));
    if (token[1] === "o") { originalParents.set(id, originalStack.at(-1) ?? null); originalStack.push(id); }
    else if (token[1] === "c") originalStack.pop();
    else literalParents.set(id, originalStack.at(-1) ?? null);
  }
  const append = (node: HtmlNode) => (stack.at(-1)?.node.children ?? roots).push(node);
  let from = 0;
  for (const match of text.matchAll(TOKEN)) {
    if (match.index > from) append({ type: "text", text: text.slice(from, match.index) });
    const token = match[0], id = Number(token.slice(2, -1));
    if (token[1] === "x") {
      const value = rich.literals.get(id);
      if (!value) throw new Error(`Unknown artifact literal ${token}`);
      if (literalParents.get(id) !== (stack.at(-1)?.id ?? null)) throw new Error(`Artifact figure or literal moved outside its inline element at ${token}`);
      if (value.type === "text") append({ type: "text", text: localized ? value.formatted ?? value.value : value.value });
      else append(structuredClone(value.value));
    } else if (token[1] === "o") {
      const original = rich.elements.get(id);
      if (!original || originalParents.get(id) !== (stack.at(-1)?.id ?? null)) throw new Error(`Artifact inline structure changed at ${token}`);
      const node: ElementNode = { ...original, attrs: original.attrs.map(([key, value]) => [key, value]), children: [] };
      append(node); stack.push({ id, node });
    } else {
      if (stack.at(-1)?.id !== id) throw new Error(`Artifact inline structure changed at ${token}`);
      stack.pop();
    }
    from = match.index + token.length;
  }
  if (from < text.length) append({ type: "text", text: text.slice(from) });
  if (stack.length) throw new Error("Artifact inline element was not closed");
  return roots;
}

function build(sourceDoc: ArtifactDocument, translations?: ReadonlyMap<string, string>): { document: ArtifactDocument; units: ArtifactTranslationUnit[] } {
  const units: ArtifactTranslationUnit[] = [];
  const phrase = (id: string, rich: RichText, context: string): HtmlNode[] => {
    const parts = segments(rich.text);
    const output = parts.map((part, index) => {
      if (!needsTranslation(part, sourceDoc.ticker)) return part;
      const lead = part.match(/^\s*/)?.[0] ?? "", trail = part.match(/\s*$/)?.[0] ?? "";
      const text = part.trim(), unitId = `${id}:${index}`;
      const values: Record<string, string> = {};
      for (const token of tokens(text)) {
        if (token[1] !== "x") continue;
        const literal = rich.literals.get(Number(token.slice(2, -1)))!;
        values[token] = literal.type === "text" ? literal.value : nodeText([literal.value]);
      }
      units.push({ id: unitId, text, context, values });
      if (!translations) return part;
      const target = translations.get(unitId);
      if (target === undefined) throw new Error(`Missing artifact translation ${unitId}`);
      const problems = checkArtifactTranslation(text, target);
      if (problems.length) throw new Error(`${unitId}: ${problems.join("; ")}`);
      return lead + target.trim() + trail;
    }).join("");
    return decodeRich(rich, output, !!translations);
  };
  const plain = (id: string, text: string, context: string) => phrase(id, encodeRich([{ type: "text", text }]), context)
    .map(node => node.type === "text" ? node.text : "").join("");
  const prepareNodes = (nodes: HtmlNode[], id: string, context: string): HtmlNode[] =>
    nodes.map((node, index): HtmlNode => {
      if (node.type === "text") return { ...node };
      const path = `${id}.${index}`;
      const attrs: Array<[string, string]> = node.attrs.map(([key, value]) => [key,
        TEXT_ATTRIBUTES.has(key) ? plain(`${path}@${key}`, value, context) : key === "lang" && value === "en" ? "zh-CN" : value]);
      return { ...node, attrs, children: prepareNodes(node.children, path, context) };
    });
  const localizeNodes = (nodes: HtmlNode[], id: string, context: string): HtmlNode[] => {
    const out: HtmlNode[] = [];
    let run: HtmlNode[] = [], runIndex = 0;
    const flush = () => {
      if (!run.length) return;
      out.push(...phrase(`${id}.text${runIndex++}`, encodeRich(run), context));
      run = [];
    };
    nodes.forEach((node, index) => {
      if (node.type === "text" || INLINE.has(node.tag)) { run.push(node); return; }
      flush();
      out.push({ ...node, children: localizeNodes(node.children, `${id}.${index}`, context) });
    });
    flush();
    return out;
  };
  const result: ArtifactDocument = {
    ...sourceDoc,
    lang: translations ? "zh-CN" : sourceDoc.lang,
    title: plain("document:title", sourceDoc.title, sourceDoc.ticker),
    blocks: sourceDoc.blocks.map(block => {
      const parsed = parseHtml(block.html);
      if (parsed.errors.length) throw new Error(`Cannot translate ${block.id}: ${parsed.errors.join("; ")}`);
      const context = `${sourceDoc.title} — ${block.title}`;
      return { ...block, title: plain(`block:${block.id}:title`, block.title, context), html: serializeHtml(localizeNodes(prepareNodes(parsed.nodes, `block:${block.id}`, context), `block:${block.id}`, context)) };
    }),
    sources: sourceDoc.sources.map(source => ({ ...source, title: plain(`source:${source.id}:title`, source.title, sourceDoc.title) })),
    charts: sourceDoc.charts.map(chart => {
      const chartMap = new Map<string, string>();
      for (const unit of chartTranslationUnits(chart)) chartMap.set(unit.id, plain(unit.id, unit.text, `${sourceDoc.title} — ${chart.title}`));
      return translations ? localizeArtifactChart(chart, chartMap) : chart;
    }),
  };
  return { document: result, units };
}

/** The same deterministic extraction serves planning and assembly of one frozen source version. */
export function extractArtifactTranslation(sourceDoc: ArtifactDocument): ArtifactTranslationPlan {
  return {
    units: build(sourceDoc).units,
    apply: translations => build(sourceDoc, translations).document,
  };
}
