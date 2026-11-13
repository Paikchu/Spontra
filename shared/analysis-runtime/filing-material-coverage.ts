import type { MaterialBlock, ParsedMaterialDocument } from "../analysis-contract/filing-material.ts";
import { decodeEntities } from "./financial-data/disclosure-extraction.ts";

type Leaf = { start: number; end: number; text: string };
type SourceTable = { start: number; end: number; childTable: boolean; cellTextChars: number };
type Frame = { name: string; local: string; hidden: boolean; table?: SourceTable };
type RawInventory = { leaves: Leaf[]; tables: SourceTable[]; images: number[] };
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

function attributes(token: string, from: number): Record<string, string> {
  const result: Record<string, string> = {};
  let index = from;
  while (index < token.length) {
    while (/\s/.test(token[index] ?? "")) index++;
    if (!token[index] || /[/>]/.test(token[index]!)) break;
    const start = index;
    while (index < token.length && !/[\s=/>]/.test(token[index]!)) index++;
    const name = token.slice(start, index).toLowerCase();
    while (/\s/.test(token[index] ?? "")) index++;
    let value = "";
    if (token[index] === "=") {
      index++;
      while (/\s/.test(token[index] ?? "")) index++;
      const quote = token[index] === '"' || token[index] === "'" ? token[index++] : null;
      const valueStart = index;
      if (quote) { while (index < token.length && token[index] !== quote) index++; }
      else { while (index < token.length && !/[\s>]/.test(token[index]!)) index++; }
      value = token.slice(valueStart, index);
      if (quote) index++;
    }
    if (name) result[name] = decodeEntities(value);
    else index++;
  }
  return result;
}

function rawInventory(html: string): RawInventory {
  const inventory: RawInventory = { leaves: [], tables: [], images: [] }, stack: Frame[] = [];
  const visible = () => !stack.at(-1)?.hidden;
  const text = (start: number, end: number) => {
    if (end <= start || !visible()) return;
    const value = normalize(decodeEntities(html.slice(start, end)));
    if (!value) return;
    inventory.leaves.push({ start, end, text: value });
    const cell = stack.findLastIndex(frame => frame.local === "td" || frame.local === "th");
    const table = stack.findLastIndex(frame => frame.table !== undefined);
    if (cell > table && table >= 0) stack[table]!.table!.cellTextChars += value.length;
  };
  const close = (from: number, end: number) => {
    while (stack.length > from) {
      const frame = stack.pop()!;
      if (frame.table) { frame.table.end = end; inventory.tables.push(frame.table); }
    }
  };
  let scan = 0, previous = 0;
  while (scan < html.length) {
    const start = html.indexOf("<", scan);
    if (start < 0) break;
    if (html.startsWith("<!--", start)) {
      text(previous, start);
      const end = html.indexOf("-->", start + 4);
      previous = scan = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<![CDATA[", start)) {
      text(previous, start);
      const end = html.indexOf("]]>", start + 9);
      text(start + 9, end < 0 ? html.length : end);
      previous = scan = end < 0 ? html.length : end + 3;
      continue;
    }
    const opening = /^<\/?([A-Za-z_][\w:.-]*)/.exec(html.slice(start));
    const declaration = html[start + 1] === "!" || html[start + 1] === "?";
    if (!opening && !declaration) { scan = start + 1; continue; }
    let end = start + 1, quote: string | null = null;
    for (; end < html.length; end++) {
      const character = html[end]!;
      if (quote) { if (character === quote) quote = null; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === ">") { end++; break; }
    }
    text(previous, start);
    previous = scan = end;
    if (!opening) continue;
    const token = html.slice(start, end), name = opening[1]!.toLowerCase(), local = name.split(":").at(-1)!;
    if (token.startsWith("</")) {
      const index = stack.findLastIndex(frame => frame.name === name);
      if (index >= 0) close(index, end);
      continue;
    }
    const attr = attributes(token, opening[0].length);
    const hidden = !visible() || /^(?:head|script|style|noscript)$/.test(local)
      || /^ix:(?:header|hidden)$/.test(name) || Object.hasOwn(attr, "hidden")
      || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attr.style ?? "");
    const frame: Frame = { name, local, hidden };
    if (!hidden && local === "table") {
      for (const ancestor of stack) if (ancestor.table) ancestor.table.childTable = true;
      frame.table = { start, end, childTable: false, cellTextChars: 0 };
    }
    if (!hidden && (local === "img" || local === "image")) inventory.images.push(start);
    if (/\/\s*>$/.test(token) || !name.includes(":") && VOID.has(local)) {
      if (frame.table) inventory.tables.push(frame.table);
    } else {
      stack.push(frame);
      if (local === "script" || local === "style") {
        const closing = new RegExp(`</${name}\\s*>`, "gi");
        closing.lastIndex = end;
        scan = closing.exec(html)?.index ?? html.length;
      }
    }
  }
  text(previous, html.length);
  close(0, html.length);
  inventory.tables = inventory.tables.filter(table => !table.childTable && table.cellTextChars > 0);
  return inventory;
}

export function verifyMaterialHtmlCoverage(html: string, parsed: ParsedMaterialDocument): void {
  const inventory = rawInventory(html), issues: string[] = [];
  const blocks = parsed.blocks.filter(block => block.kind !== "image" && block.locator.start !== null && block.locator.end !== null)
    .sort((a, b) => a.locator.start! - b.locator.start!);
  const tableText = new Map(parsed.tables.map(table => [table.tableId, normalize(decodeEntities(JSON.stringify(table.table)))]));
  const retained = new Map<MaterialBlock, string>();
  let mappedLeaves = 0, mappedTextChars = 0, first = 0;
  for (const leaf of inventory.leaves) {
    while (first < blocks.length && blocks[first]!.locator.end! <= leaf.start) first++;
    let found = false;
    for (let index = first; index < blocks.length && blocks[index]!.locator.start! <= leaf.start; index++) {
      const block = blocks[index]!;
      if (block.locator.end! < leaf.end) continue;
      let body = retained.get(block);
      if (body === undefined) { body = normalize(decodeEntities(block.text)); retained.set(block, body); }
      if (body.includes(leaf.text) || body.includes(leaf.text.replace(/\|/g, "\\|")) || block.tableId && tableText.get(block.tableId)?.includes(leaf.text)) { found = true; break; }
    }
    if (found) { mappedLeaves++; mappedTextChars += leaf.text.length; }
    else issues.push(`INDEPENDENT_HTML_TEXT:${leaf.start}:${leaf.end}`);
  }
  const mappedTables = inventory.tables.filter(table => parsed.blocks.some(block => block.kind === "table" && block.locator.start === table.start && block.locator.end! >= table.end)).length;
  for (const table of inventory.tables) if (!parsed.blocks.some(block => block.kind === "table" && block.locator.start === table.start && block.locator.end! >= table.end)) issues.push(`INDEPENDENT_HTML_TABLE:${table.start}`);
  const imageStarts = new Set(parsed.blocks.filter(block => block.kind === "image").map(block => block.locator.start));
  for (const image of inventory.images) if (!imageStarts.has(image)) issues.push(`INDEPENDENT_HTML_IMAGE:${image}`);
  parsed.coverage.htmlBaseline = { method: "independent-raw-token-inventory.v1", textLeaves: inventory.leaves.length, mappedLeaves,
    textChars: inventory.leaves.reduce((sum, leaf) => sum + leaf.text.length, 0), mappedTextChars,
    tables: inventory.tables.length, mappedTables, images: inventory.images.length, mappedImages: inventory.images.filter(image => imageStarts.has(image)).length };
  parsed.coverage.issues.push(...issues);
}
