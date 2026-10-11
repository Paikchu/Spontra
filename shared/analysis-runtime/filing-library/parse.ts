import type {
  LibraryCanonical, LibraryDocType, LibraryFactRef, LibraryPassage, LibraryRole, LibrarySection, LibraryStructure, LibraryTable,
  LibraryTableRow, ParsedLibraryDocument,
} from "../../analysis-contract/filing-library.ts";
import { decodeEntities, descendants, nodeText, parseMarkup, type Element } from "../financial-data/disclosure-extraction.ts";
import { tableGrid } from "../financial-data/table-grid.ts";

/** Changing how documents are split re-parses every document; ids of unchanged text survive it. */
export const LIBRARY_PARSER_VERSION = "filing-library.v1";
/**
 * A leaf longer than this is split again. A headed section is a unit however short (a one-line product still names a product);
 * only a heading with next to no text under it folds into its parent. A split chunk starts at a bold lead-in once it holds a few hundred characters.
 */
export const LEAF_MAX_CHARS = 8_000, LEAF_TARGET_CHARS = 6_000, LEAF_MIN_CHARS = 80, CHUNK_MIN_CHARS = 300;

/** A stable 112-bit content hash. The shared runtime has no platform crypto, and ids only need to be unique within a document. */
export function libraryHash(text: string): string {
  const round = (seed: number) => {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < text.length; i++) { const ch = text.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507); h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507); h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
  };
  return round(1) + round(2);
}

export type LibraryDocumentMeta = { documentId: string; accessionNumber: string; documentUrl: string; form: string };
export type ParsedLibraryResult = ParsedLibraryDocument & { docType: LibraryDocType };

type Style = { bold: boolean; italic: boolean; underline: boolean; size: number | null; center: boolean; hidden: boolean };
type Run = { text: string; style: Style };
type TextBlock = { kind: "text"; index: number; start: number; end: number; text: string; bold: number; italic: number; underline: number; leadBold: string; size: number | null; caps: boolean; center: boolean };
type TableBlock = { kind: "table"; index: number; start: number; end: number; node: Element };
type Block = TextBlock | TableBlock | { kind: "break"; index: number; start: number; end: number };
type FactNode = { concept: string; start: number; end: number; shown: string };
type Span = { concept: string; start: number; end: number };
type Draft = {
  title: string; canonical: LibraryCanonical; itemKey: string | null; xbrlBlock: string | null; level: number;
  parent: Draft | null; children: Draft[]; blocks: Array<TextBlock | TableBlock>; container: boolean;
};

const BLOCK_TAGS = new Set(["p", "div", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "td", "th", "tbody", "thead", "tfoot", "section", "article", "center", "blockquote", "pre", "dl", "dt", "dd", "body", "html", "caption", "form"]);
const PAGE_BREAK = /page-break-(?:before|after)\s*:\s*always|break-(?:before|after)\s*:\s*page/i;
const BULLET = /^[•●◦▪■□◆◇►‣⁃·*\-–—]$/;
const PAGE_FURNITURE = /^(?:table of contents|index|(?:page\s+)?(?:\d{1,3}|[ivxlc]{1,7})|[a-z]?-?\d{1,3}|\d{1,3}\s*\|.{0,60})$/i;
const NUMBER_CELL = /^\(?\s*[-–—]?\s*[$€£¥]?\s*\(?\s*\d[\d,]*(?:\.\d+)?\s*\)?\s*%?\s*\)?$/;
const DASH_CELL = /^[-–—]+$/;
const YEAR_CELL = /^(?:19|20)\d{2}$/;

const ITEM = /^item\s*(\d{1,2}[a-k]?)\s*(?:[.:\-–—]\s*|\s+(?=[a-z]))?(.*)$/i;
const ITEM_EVENT = /^item\s*(\d\.\d{2})\b\.?\s*(.*)$/i;
const PART = /^part\s+(iv|i{1,3})\b\.?\s*(.*)$/i;

const TEN_K: Record<string, LibraryCanonical> = {
  "1": "business", "1a": "risk_factors", "1b": "unresolved_comments", "1c": "cybersecurity", "2": "properties", "3": "legal",
  "4": "mine_safety", "5": "market", "6": "reserved", "7": "mdna", "7a": "market_risk", "8": "financial_statements",
  "9": "accountant_changes", "9a": "controls", "9b": "other_information", "9c": "foreign_inspection", "10": "governance",
  "11": "compensation", "12": "ownership", "13": "relationships", "14": "accountant_fees", "15": "exhibits", "16": "summary",
};
const TEN_Q: Record<string, LibraryCanonical> = {
  "i-1": "financial_statements", "i-2": "mdna", "i-3": "market_risk", "i-4": "controls", "ii-1": "legal", "ii-1a": "risk_factors",
  "ii-2": "market", "ii-3": "other", "ii-4": "mine_safety", "ii-5": "other_information", "ii-6": "exhibits",
};
const TWENTY_F: Record<string, LibraryCanonical> = {
  "3": "risk_factors", "4": "business", "4a": "unresolved_comments", "5": "mdna", "6": "governance", "7": "ownership",
  "8": "other", "9": "market", "10": "other", "11": "market_risk", "15": "controls", "16k": "cybersecurity", "17": "financial_statements",
  "18": "financial_statements", "19": "exhibits",
};
const PERIODIC_BOILERPLATE = new Set<LibraryCanonical>(["front", "unresolved_comments", "mine_safety", "reserved", "foreign_inspection", "governance", "compensation", "ownership", "relationships", "accountant_fees", "exhibits", "summary", "back"]);
const SIGNAL = new Set<LibraryCanonical>(["risk_factors", "controls", "legal", "accountant_changes", "cybersecurity"]);

const normalize = (text: string) => text.replace(/[    ]/g, " ").replace(/[​-‍﻿]/g, "").replace(/\s+/g, " ").trim();
const nonSpace = (text: string) => text.replace(/\s/g, "").length;
const isInline = (node: Element) => node.name.toLowerCase().startsWith("ix:");

function styleOf(node: Element, parent: Style): Style {
  const css = (node.attributes.style ?? "").toLowerCase();
  const next = { ...parent };
  if (node.local === "b" || node.local === "strong") next.bold = true;
  if (node.local === "i" || node.local === "em") next.italic = true;
  if (node.local === "u") next.underline = true;
  const weight = /font-weight\s*:\s*([a-z0-9]+)/.exec(css)?.[1];
  if (weight) next.bold = /bold|bolder|[6-9]00/.test(weight) ? true : /normal|lighter|[1-4]00/.test(weight) ? false : next.bold;
  const fontStyle = /font-style\s*:\s*([a-z]+)/.exec(css)?.[1];
  if (fontStyle) next.italic = fontStyle === "italic" || fontStyle === "oblique";
  if (/text-decoration[^;]*underline/.test(css)) next.underline = true;
  const size = /font-size\s*:\s*([\d.]+)\s*(pt|px)/.exec(css);
  if (size) next.size = Math.round((size[2] === "px" ? Number(size[1]) * 0.75 : Number(size[1])) * 2) / 2;
  const align = /text-align\s*:\s*([a-z]+)/.exec(css)?.[1];
  if (align) next.center = align === "center";
  if (/display\s*:\s*none/.test(css)) next.hidden = true;
  return next;
}

/** Text blocks, data tables and page breaks in reading order. Layout tables are read as text; tables of contents are dropped. */
function flatten(html: string, root: Element): Block[] {
  const blocks: Block[] = [];
  let runs: Run[] = [], start = -1, end = -1;
  const push = (block: Omit<TextBlock, "index"> | Omit<TableBlock, "index"> | { kind: "break"; start: number; end: number }) => blocks.push({ ...block, index: blocks.length } as Block);
  const flush = () => {
    if (runs.length) {
      const text = normalize(runs.map(r => r.text).join(""));
      if (text && !BULLET.test(text)) {
        let total = 0, bold = 0, italic = 0, underline = 0, center = 0, lead = "", leading = true;
        const sizes = new Map<number, number>();
        for (const run of runs) {
          const n = nonSpace(run.text);
          if (!n) { if (leading && run.style.bold) lead += run.text; continue; }
          total += n;
          if (run.style.bold) bold += n;
          if (run.style.italic) italic += n;
          if (run.style.underline) underline += n;
          if (run.style.center) center += n;
          if (run.style.size) sizes.set(run.style.size, (sizes.get(run.style.size) ?? 0) + n);
          if (leading) { if (run.style.bold) lead += run.text; else leading = false; }
        }
        const size = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
        const letters = text.replace(/[^A-Za-z]/g, "");
        push({ kind: "text", start, end: Math.max(end, start), text, bold: total ? bold / total : 0, italic: total ? italic / total : 0, underline: total ? underline / total : 0,
          leadBold: normalize(lead), size, caps: letters.length >= 3 && letters === letters.toUpperCase(), center: total > 0 && center / total >= 0.9 });
      }
    }
    runs = []; start = -1; end = -1;
  };
  const visit = (node: Element, style: Style) => {
    let position = node.openingEnd;
    for (const child of node.children) {
      if (typeof child === "string") {
        const at = html.indexOf(child, position), offset = at >= 0 ? at : position;
        position = offset + child.length;
        if (style.hidden) continue;
        const text = decodeEntities(child);
        if (text.trim()) { if (start < 0) start = offset; end = offset + child.length; }
        runs.push({ text, style });
        continue;
      }
      position = child.end;
      const local = child.local;
      if (local === "script" || local === "style" || (isInline(child) && (local === "header" || local === "hidden"))) continue;
      const own = styleOf(child, style);
      if (own.hidden) continue;
      if (local === "br") { runs.push({ text: " ", style }); continue; }
      if (local === "hr") { flush(); push({ kind: "break", start: child.start, end: child.end }); continue; }
      const pageBreak = PAGE_BREAK.test(child.attributes.style ?? "");
      if (local === "table") {
        flush();
        const kind = classifyTable(child);
        if (kind === "data") push({ kind: "table", start: child.start, end: child.end, node: child });
        else if (kind === "layout") { visit(child, own); flush(); }
        continue;
      }
      if (BLOCK_TAGS.has(local)) {
        flush();
        if (pageBreak) push({ kind: "break", start: child.start, end: child.start });
        visit(child, own);
        flush();
        if (pageBreak) push({ kind: "break", start: child.end, end: child.end });
        continue;
      }
      visit(child, own);
    }
  };
  visit(root, { bold: false, italic: false, underline: false, size: null, center: false, hidden: false });
  flush();
  return blocks;
}

/** A table of contents links to its own document; a layout table holds a heading or a column of text; anything else is data. */
function classifyTable(table: Element): "toc" | "layout" | "data" {
  const grid = tableGrid(table);
  const filled = grid.rows.map(row => row.cells.filter(cell => cell.text && !BULLET.test(cell.text)));
  const rows = filled.filter(cells => cells.length);
  if (!rows.length) return "layout";
  const linked = grid.rows.filter(row => row.cells.some(cell => descendants(cell.node).some(n => n.local === "a" && (n.attributes.href ?? "").startsWith("#")))).length;
  if (rows.length >= 3 && linked / rows.length >= 0.5) return "toc";
  const text = rows.flat().reduce((n, cell) => n + cell.text.length, 0);
  if (rows.length <= 2 && text <= 300 && !rows.flat().some(cell => NUMBER_CELL.test(cell.text) && !YEAR_CELL.test(cell.text))) return "layout";
  if (rows.every(cells => cells.length <= 1)) return "layout";
  // Bulleted lists laid out as a glyph column next to a text column.
  if (rows.every(cells => cells.length <= 1 || (cells.length === 2 && cells[0].text.length <= 3))) return "layout";
  return "data";
}

/** Inline XBRL facts shown in the document, located by the same element offset the archive inventory's ids carry. */
function readFacts(nodes: Element[], meta: LibraryDocumentMeta): { facts: FactNode[]; notes: Span[]; tableBlocks: Span[] } {
  const continuations = new Map<string, Element>();
  for (const node of nodes) if (isInline(node) && node.local === "continuation" && node.attributes.id) continuations.set(node.attributes.id, node);
  const facts: FactNode[] = [], notes: Span[] = [], tableBlocks: Span[] = [];
  for (const node of nodes) {
    if (!isInline(node) || (node.local !== "nonfraction" && node.local !== "nonnumeric")) continue;
    let hidden = false;
    for (let p = node.parent; p; p = p.parent) if (isInline(p) && (p.local === "hidden" || p.local === "header")) hidden = true;
    if (hidden) continue;
    const concept = node.attributes.name ?? "";
    if (/TextBlock$/.test(concept)) {
      let end = node.end;
      const seen = new Set<string>();
      for (let next: string | undefined = node.attributes.continuedat; next && !seen.has(next); next = continuations.get(next)?.attributes.continuedat) {
        seen.add(next);
        const part = continuations.get(next);
        if (part) end = Math.max(end, part.end);
      }
      const local = concept.slice(concept.indexOf(":") + 1);
      if (/Policy/i.test(local)) continue;
      (/Table|Schedule/.test(local) ? tableBlocks : notes).push({ concept, start: node.start, end });
      continue;
    }
    facts.push({ concept, start: node.start, end: node.end, shown: normalize(nodeText(node)) });
  }
  facts.sort((a, b) => a.start - b.start);
  // A note nested in another note's span belongs to the outer one only.
  notes.sort((a, b) => a.start - b.start || b.end - a.end);
  const outer: Span[] = [];
  for (const span of notes) if (!outer.some(o => span.start >= o.start && span.end <= o.end)) outer.push(span);
  return { facts, notes: outer, tableBlocks };
}

/** Facts whose start lies in [start, end], from a list sorted by start. */
function factsIn(facts: FactNode[], start: number, end: number): FactNode[] {
  let lo = 0, hi = facts.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (facts[mid].start < start) lo = mid + 1; else hi = mid; }
  const out: FactNode[] = [];
  for (let i = lo; i < facts.length && facts[i].start <= end; i++) out.push(facts[i]);
  return out;
}

/** Page numbers, "Table of Contents" links and running headers that sit next to a page break. */
function dropPageFurniture(blocks: Block[]): Block[] {
  const nearBreak = new Set<number>();
  blocks.forEach((block, i) => {
    if (block.kind !== "break") return;
    for (let j = Math.max(0, i - 3); j <= Math.min(blocks.length - 1, i + 3); j++) nearBreak.add(j);
  });
  const counts = new Map<string, number>();
  for (const block of blocks) if (block.kind === "text" && block.text.length <= 80) counts.set(block.text.toLowerCase(), (counts.get(block.text.toLowerCase()) ?? 0) + 1);
  return blocks.filter((block, i) => {
    if (block.kind !== "text") return block.kind === "table";
    if (/^table of contents$/i.test(block.text) || /^\(?\d{1,2}[.)]?$/.test(block.text)) return false;
    if (!nearBreak.has(i)) return true;
    if (PAGE_FURNITURE.test(block.text)) return false;
    return !(block.text.length <= 80 && (counts.get(block.text.toLowerCase()) ?? 0) >= 3 && !isHeadingLike(block));
  });
}

const isHeadingLike = (block: TextBlock) => block.bold >= 0.9 || block.italic >= 0.9 || block.underline >= 0.9;

function isHeading(block: TextBlock): boolean {
  const text = block.text;
  if (text.length < 2 || text.length > 140 || text.split(" ").length > 20) return false;
  if (/[.;,]$/.test(text) && !/\b(?:inc|corp|co|ltd|no)\.$/i.test(text)) return false;
  if (/^\(?\d+\)?$/.test(text) || /^\$?[\d,.]+%?$/.test(text) || /^\(.*\)$/.test(text)) return false;
  return isHeadingLike(block) || (block.caps && text.length <= 80);
}

/** A heading's type style; bold italic and italic count as one family, so a sub-heading set either way sits at one level. */
const styleKey = (block: TextBlock): string => {
  const family = block.italic >= 0.9 ? "i" : block.bold >= 0.9 ? "b" : block.underline >= 0.9 ? "u" : "p";
  // Capitals tell plain headings apart; on a bold, italic or underlined heading they are usually a name (XBOX), not a level.
  return `${block.size ?? 0}|${block.center ? "c" : ""}|${family === "p" && block.caps ? "C" : ""}|${family}|${block.underline >= 0.9 ? "u" : ""}`;
};

/** Heading levels within one item: a larger font is always higher; otherwise the style met first is the outer one. */
function headingLevels(headings: TextBlock[]): (block: TextBlock) => number {
  const first = new Map<string, { size: number; at: number }>();
  for (const h of headings) { const key = styleKey(h); if (!first.has(key)) first.set(key, { size: h.size ?? 0, at: first.size }); }
  const order = [...first.entries()].sort((a, b) => b[1].size - a[1].size || a[1].at - b[1].at).map(([key]) => key);
  return block => order.indexOf(styleKey(block));
}

function detectDocType(form: string, url: string, blocks: Block[]): LibraryDocType {
  const file = url.slice(url.lastIndexOf("/") + 1);
  if (/^(?:8-K|6-K)(?:\/A)?$/.test(form)) {
    const head = blocks.filter((b): b is TextBlock => b.kind === "text").slice(0, 60).map(b => b.text).join(" ");
    const cover = /\bform\s+(?:8-k|6-k)\b/i.test(head) && (/\bitem\s*\d\.\d{2}\b/i.test(head) || /commission file number|pursuant to (?:section|rule)/i.test(head));
    return cover ? "primary" : "press_release";
  }
  return /ex[-_]?\d|exhibit/i.test(file) ? "exhibit" : "primary";
}

type ItemHit = { index: number; key: string; number: string; title: string; consumed: number[] };

/** The document's items: for each item number, the occurrence followed by the most content (a table of contents entry has almost none). */
function findItems(blocks: Block[], form: string): ItemHit[] {
  const event = /^(?:8-K|6-K)(?:\/A)?$/.test(form), quarterly = /^10-Q/.test(form);
  const hits: ItemHit[] = [];
  let part = quarterly ? "i" : "";
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.kind !== "text" || block.text.length > 220) continue;
    const partMatch = PART.exec(block.text);
    if (partMatch && block.text.length <= 120) { part = partMatch[1].toLowerCase(); continue; }
    const match = (event ? ITEM_EVENT : ITEM).exec(block.text);
    if (!match || (!isHeadingLike(block) && !block.caps && block.text.length > 120)) continue;
    let title = normalize(match[2] ?? "");
    const consumed = [i];
    if (!title) {
      const next = blocks[i + 1];
      if (next?.kind === "text" && next.text.length <= 150 && !ITEM.test(next.text)) { title = next.text; consumed.push(i + 1); }
    }
    const number = match[1].toLowerCase();
    hits.push({ index: i, key: quarterly ? `${part}-${number}` : number, number, title, consumed });
  }
  const size = (from: number, to: number) => { let n = 0; for (let i = from; i < to; i++) { const b = blocks[i]; n += b.kind === "text" ? b.text.length : b.kind === "table" ? 400 : 0; } return n; };
  const best = new Map<string, { hit: ItemHit; size: number }>();
  hits.forEach((hit, k) => {
    const content = size(hit.index + hit.consumed.length, hits[k + 1]?.index ?? blocks.length);
    const current = best.get(hit.key);
    if (!current || content > current.size) best.set(hit.key, { hit, size: content });
  });
  return [...best.values()].map(v => v.hit).sort((a, b) => a.index - b.index);
}

function canonicalFor(form: string, key: string, docType: LibraryDocType): LibraryCanonical {
  if (docType !== "primary") return "press_release";
  if (/^(?:8-K|6-K)/.test(form)) return "event";
  if (/^10-Q/.test(form)) return TEN_Q[key] ?? "other";
  if (/^20-F/.test(form)) return TWENTY_F[key] ?? "other";
  return TEN_K[key] ?? "other";
}

function roleFor(section: { canonical: LibraryCanonical; title: string; path: string[]; text: string; itemKey: string | null }, form: string, docType: LibraryDocType): LibraryRole {
  const titles = section.path.join(" › ");
  if (/forward[- ]looking statements|cautionary (?:note|statement)|safe harbor|^signatures?$|report of independent registered public accounting firm|management'?s report on internal control/i.test(titles)) {
    if (/critical audit matter/i.test(titles)) return "signal";
    // An auditor's report is a page or two; a long section under that title has absorbed the content that follows it.
    if (!/report of independent registered public accounting firm/i.test(section.title) || section.text.length <= 15_000) return "boilerplate";
  }
  if (/critical audit matter/i.test(titles)) return "signal";
  if (section.text.length <= 200 && /^(?:none|not applicable|\[?reserved\]?)\.?$/i.test(section.text.trim())) return "boilerplate";
  if (docType === "primary" && /^(?:8-K|6-K)/.test(form) && section.itemKey === "9.01") return "boilerplate";
  if (docType === "primary" && /^(?:10-K|10-Q)/.test(form) && PERIODIC_BOILERPLATE.has(section.canonical)) return "boilerplate";
  if (section.canonical === "front" || section.canonical === "back") return "boilerplate";
  return SIGNAL.has(section.canonical) ? "signal" : "core";
}

const PARENTHESIZED = /^\((.*)\)$/;
function cellValue(text: string): number | null {
  const clean = text.replace(/[$€£¥,%\s]/g, "");
  if (!clean || DASH_CELL.test(clean)) return null;
  const negative = PARENTHESIZED.test(clean) || /^[-–—]\d/.test(clean);
  const digits = clean.replace(/[()–—-]/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(digits)) return null;
  const value = Number(digits);
  return Number.isFinite(value) ? (negative ? -value : value) : null;
}

const indentOf = (cell: Element): number => {
  let indent = 0;
  for (const node of [cell, ...descendants(cell).slice(0, 4)]) {
    const css = (node.attributes.style ?? "").toLowerCase();
    for (const m of css.matchAll(/(?:padding-left|text-indent|margin-left)\s*:\s*([\d.]+)\s*(pt|px|em)/g)) indent = Math.max(indent, Number(m[1]) * (m[2] === "px" ? 0.75 : m[2] === "em" ? 10 : 1));
  }
  return Math.round(indent);
};

/** A data table as columns with full header names, labelled rows, numeric cells and the facts each cell shows. */
function readTable(block: TableBlock, facts: FactNode[], before: string, notes: string[], xbrlBlock: string | null): { table: LibraryTable; text: string; factRefs: LibraryFactRef[] } | null {
  const grid = tableGrid(block.node);
  const width = grid.columns;
  const tableFacts = factsIn(facts, block.start, block.end);
  if (!width) return null;
  const isData = (row: typeof grid.rows[number]) => row.cells.some(cell => cell.column > 0 && (NUMBER_CELL.test(cell.text) || DASH_CELL.test(cell.text)) && !YEAR_CELL.test(cell.text));
  let headerRows = 0;
  while (headerRows < Math.min(4, grid.rows.length) && !isData(grid.rows[headerRows])) headerRows++;
  if (headerRows === grid.rows.length) headerRows = Math.min(1, grid.rows.length);
  const header: string[][] = Array.from({ length: width }, () => []);
  for (const row of grid.rows.slice(0, headerRows)) for (const cell of row.cells) {
    if (!cell.text) continue;
    for (let c = cell.column; c < Math.min(width, cell.column + cell.colSpan); c++) if (header[c].at(-1) !== cell.text) header[c].push(cell.text);
  }
  // Body cells by column, with currency, sign and percent glyphs folded into the number they belong to.
  const body = grid.rows.slice(headerRows).map(row => {
    const cells: Array<{ text: string; node: Element | null; facts: FactNode[] }> = Array.from({ length: width }, () => ({ text: "", node: null, facts: [] }));
    for (const cell of row.cells) if (cell.column < width) cells[cell.column] = { text: cell.text, node: cell.node, facts: tableFacts.filter(f => f.start >= cell.node.start && f.end <= cell.node.end) };
    for (let c = 0; c < width; c++) {
      const text = cells[c].text;
      if (/^[$€£¥(]$/.test(text)) {
        const next = cells.findIndex((x, j) => j > c && x.text);
        if (next > 0) { cells[next] = { ...cells[next], text: text + cells[next].text, facts: [...cells[c].facts, ...cells[next].facts] }; cells[c] = { text: "", node: cells[c].node, facts: [] }; }
      } else if (/^(?:\)|%|\)%|%\))$/.test(text)) {
        let previous = -1;
        for (let j = c - 1; j >= 0; j--) if (cells[j].text) { previous = j; break; }
        if (previous >= 0) { cells[previous] = { ...cells[previous], text: cells[previous].text + text }; cells[c] = { text: "", node: cells[c].node, facts: cells[c].facts }; }
      }
    }
    return cells;
  });
  const valueColumns = Array.from({ length: width }, (_, c) => c).filter(c => c > 0 && body.some(cells => cells[c].text));
  if (!valueColumns.length || !body.length) return null;
  const labelColumn = (cells: typeof body[number]) => cells.findIndex((cell, c) => cell.text && c < valueColumns[0]);
  const rows: LibraryTableRow[] = [], factRefs: LibraryFactRef[] = [];
  const stack: Array<{ indent: number; label: string }> = [];
  for (const cells of body) {
    const at = labelColumn(cells);
    const label = at >= 0 ? cells[at].text : "";
    const values = valueColumns.map(c => cells[c]);
    const indent = at >= 0 && cells[at].node ? indentOf(cells[at].node!) : 0;
    while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
    if (label && values.every(v => !v.text)) { stack.push({ indent, label: label.replace(/:$/, "") }); continue; }
    if (!label && values.every(v => !v.text)) continue;
    const row = rows.length;
    rows.push({ label, path: stack.map(s => s.label), cells: values.map(v => ({ text: v.text, value: cellValue(v.text) })) });
    values.forEach((v, col) => { for (const fact of v.facts) factRefs.push({ at: fact.start, concept: fact.concept, row, col }); });
  }
  if (!rows.length) return null;
  const columns = valueColumns.map(c => header[c].join(" ").trim());
  const unitSource = [...header.flat(), before].join(" ");
  const unit = /\((?:in |dollars in |amounts in |[a-z]+ in )?(?:millions|thousands|billions)[^)]{0,80}\)|\b(?:in|dollars in|amounts in) (?:millions|thousands|billions)(?:, except [^.;)]{0,60})?/i.exec(unitSource)?.[0] ?? null;
  const cell = (text: string) => text.replace(/\|/g, "\\|");
  const lines = [
    ...(unit ? [`单位：${unit.replace(/^\(|\)$/g, "")}`] : []),
    `| ${["", ...columns].map(cell).join(" | ")} |`,
    `|${["", ...columns].map(() => "---").join("|")}|`,
    ...rows.map(r => `| ${[[...r.path, r.label].filter(Boolean).join(" › "), ...r.cells.map(c => c.text)].map(cell).join(" | ")} |`),
    ...notes.map(n => `注：${n}`),
  ];
  return { table: { unit, columns, rows, notes, xbrlBlock }, text: lines.join("\n"), factRefs };
}

/**
 * Splits one archived SEC document into sections and verbatim passages. Items are found by their own
 * headings, headings by their type style, notes by their XBRL text blocks; long leaves split at bold
 * lead-in sentences and short ones fold into their parent. Pure and deterministic: the same HTML and
 * parser version always give the same ids.
 */
export function parseFilingDocument(html: string, meta: LibraryDocumentMeta): ParsedLibraryResult {
  const { nodes, root } = parseMarkup(html);
  const issues: string[] = [];
  const { facts, notes, tableBlocks } = readFacts(nodes, meta);
  const blocks = dropPageFurniture(flatten(html, root));
  blocks.forEach((block, i) => { block.index = i; });
  const docType = detectDocType(meta.form, meta.documentUrl, blocks);
  const periodic = docType === "primary";
  const items = periodic ? findItems(blocks, meta.form) : [];
  const structured = items.length >= (/^(?:8-K|6-K)/.test(meta.form) ? 1 : 2);
  if (periodic && !structured) issues.push("ITEMS_NOT_FOUND");

  const roots: Draft[] = [];
  const draft = (title: string, canonical: LibraryCanonical, parent: Draft | null, level: number, extra: Partial<Draft> = {}): Draft => {
    const d: Draft = { title, canonical, itemKey: null, xbrlBlock: null, level, parent, children: [], blocks: [], container: false, ...extra };
    if (parent) parent.children.push(d); else roots.push(d);
    return d;
  };
  const consumed = new Set(items.flatMap(item => item.consumed));
  const ranges: Array<{ container: Draft; from: number; to: number }> = [];
  if (structured) {
    if (items[0].index > 0) {
      // Some filers (banks' cross-reference 10-Qs) put the whole report before their first item heading: that is content, not a cover.
      const front = blocks.slice(0, items[0].index).reduce((n, b) => n + (b.kind === "text" ? b.text.length : b.kind === "table" ? 400 : 0), 0);
      const main = front > 30_000;
      if (main) issues.push("CONTENT_BEFORE_ITEMS");
      ranges.push({ container: draft(main ? "Report" : "Front matter", main ? "other" : "front", null, -2, { container: true }), from: 0, to: items[0].index });
    }
    items.forEach((item, k) => {
      const label = `Item ${item.number.toUpperCase()}${item.title ? `. ${item.title}` : ""}`;
      const canonical = canonicalFor(meta.form, item.key, docType);
      ranges.push({ container: draft(label, canonical, null, -2, { itemKey: item.key.toUpperCase(), container: true }), from: item.index, to: items[k + 1]?.index ?? blocks.length });
    });
  } else {
    const firstHeading = blocks.find((b): b is TextBlock => b.kind === "text" && isHeading(b));
    const canonical: LibraryCanonical = docType === "primary" ? (/^(?:8-K|6-K)/.test(meta.form) ? "event" : "other") : "press_release";
    ranges.push({ container: draft(firstHeading?.text ?? (docType === "primary" ? meta.form : "Press release"), canonical, null, -2, { container: true }), from: 0, to: blocks.length });
  }

  let headingCount = 0;
  for (const range of ranges) {
    const inRange = blocks.slice(range.from, range.to).filter(b => b.kind !== "break" && !consumed.has(b.index)) as Array<TextBlock | TableBlock>;
    const levelOf = headingLevels(inRange.filter((b): b is TextBlock => b.kind === "text" && isHeading(b) && !PART.test(b.text) && !(structured && ITEM.test(b.text))));
    const statements = range.container.canonical === "financial_statements" || range.container.canonical === "other";
    let stack: Draft[] = [range.container], note: Span | null = null, noteDraft: Draft | null = null;
    let usedTitle = range.from > 0 || !structured ? false : true;
    for (const block of inRange) {
      if (statements) {
        const inside = notes.find(n => block.start >= n.start && block.start < n.end) ?? null;
        if (inside !== note) {
          const top = stack.at(-1)!;
          note = inside;
          stack = [range.container];
          noteDraft = null;
          if (inside) {
            // Filers often tag a note from just after its number, so "2. Revenue" sits outside the span: that empty heading is the note.
            if (top !== range.container && !top.container && top.parent === range.container && !top.blocks.length && !top.children.length) {
              Object.assign(top, { canonical: "note" as const, xbrlBlock: inside.concept, container: true });
              noteDraft = top;
              stack.push(top);
            } else {
              const titled = block.kind === "text" && block.text.length <= 160;
              noteDraft = draft(titled ? block.text : humanConcept(inside.concept), "note", range.container, -1, { xbrlBlock: inside.concept, container: true });
              stack.push(noteDraft);
              if (titled) continue;
            }
          }
        }
      }
      if (!usedTitle && !structured && block.kind === "text" && block.text === range.container.title) { usedTitle = true; continue; }
      if (block.kind === "text" && isHeading(block) && !PART.test(block.text) && !(structured && ITEM.test(block.text))) {
        const level = levelOf(block);
        while (stack.length > 1 && !stack.at(-1)!.container && stack.at(-1)!.level >= level) stack.pop();
        stack.push(draft(block.text, stack.at(-1)!.canonical === "note" ? "note" : range.container.canonical, stack.at(-1)!, level, { xbrlBlock: stack.at(-1)!.canonical === "note" ? stack.at(-1)!.xbrlBlock : null }));
        headingCount++;
        continue;
      }
      stack.at(-1)!.blocks.push(block);
    }
  }
  const structure: LibraryStructure = structured ? "items" : headingCount ? "outline" : "flat";

  // Footnotes directly under a data table belong to it.
  const footnotes = new Map<number, string[]>();
  const absorbed = new Set<number>();
  for (const d of walk(roots)) for (let i = 0; i < d.blocks.length; i++) {
    const block = d.blocks[i];
    if (block.kind !== "table") continue;
    const list: string[] = [];
    for (let j = i + 1; j < d.blocks.length; j++) {
      const next = d.blocks[j];
      if (next.kind !== "text" || next.text.length > 500 || !/^(?:\*{1,3}|†|‡|\(\d{1,2}\)|\(?[a-z]\)|\d{1,2}\)|\d{1,2}\.\s|note:)/i.test(next.text)) break;
      list.push(next.text); absorbed.add(next.index);
    }
    footnotes.set(block.index, list);
  }
  for (const d of walk(roots)) d.blocks = d.blocks.filter(b => !absorbed.has(b.index));

  // Sizes: split long leaves at bold lead-in sentences, fold short leaves into their parent.
  const blockChars = (b: TextBlock | TableBlock) => b.kind === "text" ? b.text.length : 400;
  const ownChars = (d: Draft) => d.blocks.reduce((n, b) => n + blockChars(b), 0);
  for (const d of [...walk(roots)]) {
    if (d.children.length || ownChars(d) <= LEAF_MAX_CHARS) continue;
    const chunks: Array<{ title: string; blocks: Array<TextBlock | TableBlock> }> = [];
    let size = 0;
    for (const block of d.blocks) {
      const lead = block.kind === "text" && block.leadBold.length >= 15 && block.leadBold.length < block.text.length + 1 ? block.leadBold : "";
      if (!chunks.length || (lead && size >= CHUNK_MIN_CHARS) || size >= LEAF_TARGET_CHARS) {
        chunks.push({ title: lead ? clip(lead) : `${d.title} (${chunks.length + 1})`, blocks: [] });
        size = 0;
      }
      chunks.at(-1)!.blocks.push(block);
      size += blockChars(block);
    }
    if (chunks.length < 2) continue;
    d.blocks = [];
    for (const chunk of chunks) draft(chunk.title, d.canonical, d, d.level + 1, { blocks: chunk.blocks, xbrlBlock: d.xbrlBlock });
  }
  for (const d of [...walk(roots)].reverse()) {
    if (d.container || d.children.length || !d.parent) continue;
    if (ownChars(d) >= LEAF_MIN_CHARS) continue;
    d.parent.blocks.push(...d.blocks);
    d.parent.blocks.sort((a, b) => a.index - b.index);
    d.parent.children.splice(d.parent.children.indexOf(d), 1);
  }

  // Ids, passages and sections in document order.
  const sections: LibrarySection[] = [], passages: LibraryPassage[] = [];
  const sectionIds = new Map<Draft, string>(), seenPaths = new Map<string, number>(), seenTexts = new Map<string, number>();
  const pathOf = (d: Draft): string[] => d.parent ? [...pathOf(d.parent), d.title] : [d.title];
  const order = [...walk(roots)];
  for (const d of order) {
    const path = pathOf(d);
    const key = `${d.canonical}|${path.map(p => p.toLowerCase()).join("›")}`;
    const dup = seenPaths.get(key) ?? 0;
    seenPaths.set(key, dup + 1);
    sectionIds.set(d, `s${libraryHash(`${meta.documentId}|${key}|${dup}`)}`);
  }
  const owner = new Map<number, Draft>();
  for (const d of order) for (const b of d.blocks) owner.set(b.index, d);
  const contentBlocks = [...owner.keys()].sort((a, b) => a - b).map(i => blocks[i] as TextBlock | TableBlock);
  const textOf = new Map<Draft, string[]>();
  for (const block of contentBlocks) {
    const d = owner.get(block.index)!;
    let text: string, table: LibraryTable | null = null, factRefs: LibraryFactRef[] = [];
    if (block.kind === "table") {
      const previous = blocks.slice(0, block.index).reverse().find((b): b is TextBlock => b.kind === "text");
      const span = tableBlocks.find(t => block.start >= t.start && block.end <= t.end) ?? null;
      const read = readTable(block, facts, previous?.text.slice(-300) ?? "", footnotes.get(block.index) ?? [], span?.concept ?? null);
      if (!read) {
        text = normalize(tableGrid(block.node).rows.map(r => r.cells.map(c => c.text).filter(Boolean).join(" ")).filter(Boolean).join("\n"));
        if (!text) continue;
      } else ({ text, table, factRefs } = read);
    } else {
      text = block.text;
      let cursor = 0;
      for (const fact of factsIn(facts, block.start, block.end)) {
        const at = fact.shown ? text.indexOf(fact.shown, cursor) : -1;
        if (at >= 0) { factRefs.push({ at: fact.start, concept: fact.concept, start: at, end: at + fact.shown.length }); cursor = at + fact.shown.length; }
        else factRefs.push({ at: fact.start, concept: fact.concept });
      }
    }
    const textHash = libraryHash(text);
    const dup = seenTexts.get(textHash) ?? 0;
    seenTexts.set(textHash, dup + 1);
    passages.push({ passageId: `p${libraryHash(`${meta.documentId}|${textHash}|${dup}`)}`, sectionId: sectionIds.get(d)!, ordinal: passages.length, kind: table ? "table" : "paragraph", text, table, factRefs, chars: text.length, textHash });
    textOf.set(d, [...textOf.get(d) ?? [], text]);
  }
  const depthOf = (d: Draft): number => d.parent ? depthOf(d.parent) + 1 : 0;
  const fullText = (d: Draft): string[] => [...textOf.get(d) ?? [], ...d.children.flatMap(fullText)];
  order.forEach((d, ordinal) => {
    const text = fullText(d), joined = text.join("\n");
    const path = pathOf(d);
    const itemKey = d.itemKey ?? ancestorItem(d);
    sections.push({
      sectionId: sectionIds.get(d)!, parentId: d.parent ? sectionIds.get(d.parent)! : null, ordinal, depth: depthOf(d), isLeaf: !d.children.length,
      canonical: d.canonical, itemKey, title: d.title, path, xbrlBlock: d.xbrlBlock,
      role: roleFor({ canonical: d.canonical, title: d.title, path, text: joined, itemKey }, meta.form, docType),
      chars: joined.length, textHash: libraryHash(joined),
    });
  });
  // Under a boilerplate or signal parent, a plain section takes the parent's role; one its own title marks (a critical audit matter) keeps it.
  const byId = new Map(sections.map(s => [s.sectionId, s]));
  for (const s of sections) { const parent = s.parentId ? byId.get(s.parentId) : null; if (parent && parent.role !== "core" && s.role === "core") s.role = parent.role; }
  if (!passages.length) issues.push("NO_READABLE_TEXT");
  return { docType, structure, sections, passages, issues };
}

function* walk(roots: Draft[]): Generator<Draft> { for (const d of roots) { yield d; yield* walk(d.children); } }
function ancestorItem(d: Draft): string | null { for (let p: Draft | null = d; p; p = p.parent) if (p.itemKey) return p.itemKey; return null; }
const clip = (text: string) => text.length <= 140 ? text.replace(/[.:]$/, "") : `${text.slice(0, 137).replace(/\s+\S*$/, "")}…`;
const humanConcept = (concept: string) => concept.slice(concept.indexOf(":") + 1).replace(/TextBlock$/, "").replace(/Disclosure$/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
