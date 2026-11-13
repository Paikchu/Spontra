import type { LibraryTable } from "../analysis-contract/filing-library.ts";
import type { MaterialBlock, MaterialDocumentCoverage, MaterialFiling, MaterialIndexedBlock, MaterialSource, MaterialTable, ParsedMaterialDocument } from "../analysis-contract/filing-material.ts";
import { decodeEntities, descendants, extractFilingDisclosures, nodeText, parseMarkup, type Element } from "./financial-data/disclosure-extraction.ts";
import { tableGrid, type TableGrid } from "./financial-data/table-grid.ts";
import { headingPeriod, type FilingFactRow } from "./filing-library/facts.ts";
import { libraryHash } from "./filing-library/parse.ts";
import { omit } from "./omit.ts";

export const MATERIAL_PARSER_VERSION = "material-parser.v6";
const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
const numeric = (text: string): number | null => {
  const raw = text.replace(/[$€£¥,%\s]/g, "");
  const value = /^\([\d,.]+\)$/.test(raw) ? `-${raw.slice(1, -1)}` : raw.replace(/^[−–]/, "-");
  return /^-?\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) ? Number(value) : null;
};
const hidden = (node: Element) => /^(?:script|style|head|noscript)$/.test(node.local)
  || /^ix:/i.test(node.name) && /^(?:header|hidden)$/.test(node.local)
  || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(node.attributes.style ?? "")
  || Object.hasOwn(node.attributes, "hidden");
const blockId = (source: MaterialSource, kind: string, start: number) => `b${libraryHash(`${source.id}|${kind}|${start}`)}`;
const filenamePart = (value: string) => value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, "_").replace(/^\.+|\.+$/g, "");
const csvCell = (value: string) => /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

export function csvFromTable(table: LibraryTable): string {
  const rows = [[table.rowHeader ?? "Item", ...table.columns], ...table.rows.map(row => [[...row.path, row.label].filter(Boolean).join(" > "), ...row.cells.map(cell => cell.text)])];
  return rows.map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function tableCatalogEntry(table: MaterialTable, block: Pick<MaterialIndexedBlock, "locator" | "range"> | undefined) {
  if (!block) throw new Error(`MATERIAL_TABLE_SOURCE_MISSING:${table.tableId}`);
  return { ...omit(table, "csv", "table"), unit: table.table.unit, notes: table.table.notes,
    rowHeader: table.table.rowHeader ?? "Item", columns: table.table.columns,
    rowCount: table.table.rows.length, columnCount: table.table.columns.length + 1,
    locator: block.locator, markdownRange: block.range };
}

export function parseCsv(csv: string): string[][] {
  const rows: string[][] = [], row: string[] = [];
  let cell = "", quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i]!;
    if (quoted) {
      if (ch === '"' && csv[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && !cell) quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && csv[i + 1] === "\n") i++;
      row.push(cell); rows.push([...row]); row.length = 0; cell = "";
    } else cell += ch;
  }
  if (quoted) throw new Error("CSV_UNCLOSED_QUOTE");
  if (cell || row.length) { row.push(cell); rows.push([...row]); }
  return rows;
}

export function verifyTableCsv(table: LibraryTable, csv: string): { checkedCells: number; issues: string[] } {
  const expected = [[table.rowHeader ?? "Item", ...table.columns], ...table.rows.map(row => [[...row.path, row.label].filter(Boolean).join(" > "), ...row.cells.map(cell => cell.text)])];
  const actual = parseCsv(csv), issues: string[] = [];
  let checkedCells = 0;
  if (actual.length !== expected.length) issues.push(`CSV_ROWS:${expected.length}:${actual.length}`);
  expected.forEach((row, r) => {
    if (actual[r]?.length !== row.length) issues.push(`CSV_COLUMNS:${r}`);
    row.forEach((cell, c) => { if (actual[r]?.[c] !== cell) issues.push(`CSV_CELL:${r}:${c}`); else checkedCells++; });
  });
  return { checkedCells, issues };
}

export function materialBlock(source: MaterialSource, input: { kind: MaterialBlock["kind"]; title: string; text: string; start?: number; end?: number; page?: number }): MaterialBlock {
  const start = input.start ?? 0;
  return { id: blockId(source, input.kind, start), documentId: source.id, filename: source.filename, sourceUrl: source.url,
    title: input.title, path: [source.filename, input.title], kind: input.kind, text: input.text, tableId: null,
    locator: { start, end: input.end ?? null, page: input.page ?? null } };
}

export function documentCoverage(source: MaterialSource): MaterialDocumentCoverage {
  return { documentId: source.id, filename: source.filename, sourceTextChars: 0, retainedTextChars: 0, sourceTables: 0, retainedTables: 0,
    sourceImages: 0, retainedImages: 0, pages: 0, retainedPages: 0, issues: [] };
}

export function parseMaterialText(filing: MaterialFiling, source: MaterialSource, text: string, kind: "paragraph" | "code" = "paragraph"): ParsedMaterialDocument {
  void filing;
  const coverage = documentCoverage(source);
  coverage.sourceTextChars = text.length;
  coverage.retainedTextChars = text.length;
  const language = /\.(?:xml|xsd)$/i.test(source.filename) ? "xml" : /\.json$/i.test(source.filename) ? "json" : "text";
  const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1)));
  const block = materialBlock(source, { kind, title: source.filename, text: kind === "code" ? `${fence}${language}\n${text}\n${fence}` : text, end: text.length });
  return { blocks: [block], tables: [], facts: [], coverage };
}

type TextLeaf = { text: string; start: number; end: number; owner: Element };
type SourceInventory = { text: TextLeaf[]; tables: Element[]; images: Element[] };
const TEXT_BLOCKS = new Set(["p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "td", "th", "pre", "caption", "blockquote"]);

function inventoryOf(html: string, root: Element): SourceInventory {
  const inventory: SourceInventory = { text: [], tables: [], images: [] };
  const visit = (node: Element, owner: Element) => {
    if (hidden(node)) return;
    const own = TEXT_BLOCKS.has(node.local) ? node : owner;
    if (node.local === "table") inventory.tables.push(node);
    if (node.local === "img" || node.local === "image") inventory.images.push(node);
    let position = node.openingEnd;
    for (const child of node.children) {
      if (typeof child !== "string") { visit(child, own); position = child.end; continue; }
      const start = html.indexOf(child, position);
      const text = normalize(decodeEntities(child));
      if (text) inventory.text.push({ text, start: start < 0 ? position : start, end: (start < 0 ? position : start) + child.length, owner: own });
      position = (start < 0 ? position : start) + child.length;
    }
  };
  visit(root, root);
  return inventory;
}

const isNumericCell = (text: string) => numeric(text) !== null && !/^(?:19|20)\d{2}$/.test(text.trim());
const directlyBold = (node: Element) => /^(?:th|b|strong)$/.test(node.local) || /font-weight\s*:\s*(?:bold|[6-9]00)/i.test(node.attributes.style ?? "");
const bold = (node: Element) => {
  if (directlyBold(node)) return true;
  const children = descendants(node).filter(directlyBold);
  const length = normalize(nodeText(node)).length;
  return length > 0 && children.filter(child => !children.some(parent => parent !== child && parent.start < child.start && parent.end >= child.end)).reduce((n, child) => n + normalize(nodeText(child)).length, 0) >= length * 0.75;
};
const heading = (text: string, node: Element) => text.length < 220 && (/^h[1-6]$/.test(node.local) || bold(node) || /^[A-Z][A-Z\d ,.'’&()/-]+$/.test(text) || /^Note\s+\d+\s*[—:-]\s*[A-Z][A-Z\s&]+$/.test(text));
const titleQualifier = (text: string) => /^\(?\s*(?:unaudited|audited|in (?:thousands|millions|billions)[\s\S]*|(?:amounts|dollars) in [\s\S]*)\s*\)?$/i.test(text);
const indent = (node: Element) => {
  let out = 0;
  const pixels = (value: string) => { const m = /^([\d.]+)(pt|px|em)?$/.exec(value); return m ? Number(m[1]) * (m[2] === "em" ? 12 : m[2] === "pt" ? 1.333 : 1) : 0; };
  for (const n of [node, ...descendants(node)]) {
    const css = n.attributes.style ?? "";
    for (const m of css.matchAll(/(?:padding-left|text-indent|margin-left)\s*:\s*([\d.]+\s*(?:pt|px|em))/g)) out = Math.max(out, pixels(m[1]!.replace(/\s/g, "")));
    for (const m of css.matchAll(/(?:^|;)\s*padding\s*:\s*([^;]+)/g)) { const values = m[1]!.trim().split(/\s+/); out = Math.max(out, pixels(values.length === 4 ? values[3]! : values[1] ?? values[0]!)); }
  }
  return out;
};

function tableFromGrid(grid: TableGrid, context: string): { table: LibraryTable; headers: number; columnMap: Map<number, number>; issues: string[] } {
  const expanded = grid.rows.map(() => Array.from({ length: grid.columns }, () => ""));
  const owners = grid.rows.map(() => Array.from<number | null>({ length: grid.columns }).fill(null));
  grid.rows.forEach((row, r) => row.cells.forEach(cell => {
    for (let rr = r; rr < Math.min(grid.rows.length, r + cell.rowSpan); rr++) for (let c = cell.column; c < Math.min(grid.columns, cell.column + cell.colSpan); c++) { expanded[rr]![c] = cell.text; owners[rr]![c] = cell.node.start; }
  }));
  const firstNumeric = grid.rows.findIndex(row => row.cells.some(cell => cell.column > 0 && isNumericCell(cell.text)));
  const firstText = Math.max(0, grid.rows.findIndex(row => row.cells.some(cell => cell.text)));
  let headers = firstText;
  while (headers < grid.rows.length && grid.rows[headers]!.cells.some(cell => cell.text) && grid.rows[headers]!.cells.every(cell => !cell.text || cell.header)) headers++;
  const explicitHeaders = headers > firstText;
  if (!explicitHeaders && firstNumeric > firstText) {
    headers = firstNumeric;
    const labelSpan = grid.rows[firstNumeric]!.cells.find(cell => cell.column === 0)?.colSpan;
    let body = headers;
    while (labelSpan && body > firstText) {
      const filled = grid.rows[body - 1]!.cells.filter(cell => cell.text);
      if (!filled.length) { body--; continue; }
      if (filled.length !== 1 || filled[0]!.column !== 0 || filled[0]!.colSpan !== labelSpan || titleQualifier(filled[0]!.text)) break;
      headers = --body;
    }
  }
  else if (!explicitHeaders) while (headers < grid.rows.length && grid.rows[headers]!.cells.some(cell => cell.text) && grid.rows[headers]!.cells.filter(cell => cell.text).every(cell => bold(cell.node))) headers++;
  if (headers === grid.rows.length) headers = 0;
  if (!headers && grid.rows.length > 1 && /\b(?:name|jurisdiction|incorporation|description|country|subsidiar(?:y|ies))\b/i.test(expanded[0]!.join(" ")) && firstNumeric !== 0) headers = 1;
  type Column = { source: number[]; values: string[] };
  const logical: Column[] = [];
  for (let c = 0; c < grid.columns; c++) {
    const previous = logical.at(-1);
    if (previous && owners.every((row, r) => row[c] === row[previous.source[0]!] || !expanded[r]![c] && !expanded[r]![previous.source[0]!])) previous.source.push(c);
    else logical.push({ source: [c], values: expanded.map(row => row[c] ?? "") });
  }
  const visible = logical.filter(column => column.values.some(Boolean));
  for (let c = 1; c < visible.length; c++) {
    const column = visible[c]!;
    const body = column.values.slice(headers).filter(Boolean);
    const prefix = body.length > 0 && body.every(value => /^(?:[$€£¥]|\(|[$€£¥]\s*\()$/.test(value));
    const suffix = body.length > 0 && body.every(value => /^(?:\)|%|\)%|%\))$/.test(value));
    const target = prefix ? visible[c + 1] : suffix ? visible[c - 1] : null;
    if (!target) continue;
    target.values = target.values.map((value, r) => {
      const addition = column.values[r] ?? "";
      if (r < headers) return [value, addition].filter((text, index, all) => text && all.indexOf(text) === index).join(" > ");
      return prefix ? addition + value : value + addition;
    });
    target.source.push(...column.source);
    visible.splice(c, 1); c--;
  }
  const columnHeading = (column: Column) => column.values.slice(0, headers).filter((value, index, all) => value && all.indexOf(value) === index).join(" > ");
  const glyph = (value: string) => /^(?:[$€£¥()]|%|\)%|%\))+$/.test(value);
  const sameSourceCell = (left: Column, right: Column, row: number) => left.source.some(a => right.source.some(b => owners[row]![a] !== null && owners[row]![a] === owners[row]![b]));
  for (let c = 1; c < visible.length; c++) {
    const previous = visible[c - 1]!, column = visible[c]!;
    if (!columnHeading(column) || columnHeading(previous) !== columnHeading(column)) continue;
    if (!column.values.slice(headers).every((value, r) => !value || !previous.values[r + headers] || glyph(value) || glyph(previous.values[r + headers]!) || sameSourceCell(previous, column, r + headers))) continue;
    previous.values = previous.values.map((value, r) => {
      const next = column.values[r] ?? "";
      if (r < headers || !next) return value;
      if (sameSourceCell(previous, column, r)) return value.includes(next) ? value : next.includes(value) ? next : value + next;
      return value + next;
    });
    previous.source.push(...column.source);
    visible.splice(c, 1); c--;
  }
  for (let c = visible.length - 1; c > 0; c--) {
    const column = visible[c]!;
    if (column.values.slice(headers).some(Boolean)) continue;
    if (column.values.slice(0, headers).every(value => !value || visible.some((other, i) => i !== c && other.values.slice(headers).some(Boolean) && columnHeading(other).includes(value)))) visible.splice(c, 1);
  }
  const values = grid.rows.map((_row, r) => visible.map(column => column.values[r] ?? ""));
  const columnMap = new Map<number, number>();
  visible.forEach((column, c) => column.source.forEach(source => columnMap.set(source, c)));
  const headerFor = (c: number) => {
    const parts: string[] = [];
    for (const row of values.slice(0, headers)) if (row[c] && parts.at(-1) !== row[c]) parts.push(row[c]!);
    return parts.join(" > ");
  };
  const rowHeader = headerFor(0) || "Item";
  const columns = visible.slice(1).map((_column, c) => headerFor(c + 1) || `Column ${c + 2}`);
  const stack: Array<{ indent: number; label: string }> = [];
  const rows: LibraryTable["rows"] = values.slice(headers).map((cells, offset) => {
    const r = offset + headers, label = cells[0] ?? "";
    const labelNode = grid.rows[r]!.cells.find(cell => cell.column === 0)?.node;
    const space = labelNode ? indent(labelNode) : 0;
    while (stack.length && stack.at(-1)!.indent >= space) stack.pop();
    const path = stack.map(p => p.label);
    if (label && cells.slice(1).every(v => !v)) stack.push({ indent: space, label });
    return { label, path, cells: cells.slice(1).map(text => ({ text, value: numeric(text) })) };
  });
  const unitPattern = /\((?:[^)]{0,60}\b)?(?:thousands|millions|billions)[^)]*\)|\b(?:in|dollars in|amounts in) (?:thousands|millions|billions)(?:, except [^.;)]{0,100})?/gi;
  const unitIn = (text: string) => [...text.matchAll(unitPattern)].at(-1)?.[0] ?? null;
  const unit = unitIn(expanded.slice(0, headers).flat().join(" ")) ?? unitIn(context);
  const issues = [...grid.issues];
  grid.rows.forEach((row, r) => row.cells.forEach(cell => {
    const represented = r < headers ? [rowHeader, ...columns].join(" ") : [rows[r - headers]?.label ?? "", ...rows[r - headers]?.cells.map(c => c.text) ?? []].join(" ");
    if (cell.text && !represented.includes(cell.text)) {
      if (r < headers && cell.column === 0) return;
      issues.push(`TABLE_SOURCE_CELL:${r}:${cell.column}`);
    }
  }));
  return { table: { unit, rowHeader, columns, rows, notes: [], xbrlBlock: null }, headers, columnMap, issues };
}

export function tableMarkdown(table: LibraryTable): string {
  const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
  return [...table.unit ? [`Unit: ${table.unit}`, ""] : [],
    `| ${[table.rowHeader ?? "Item", ...table.columns].map(cell).join(" | ")} |`,
    `| ${["Item", ...table.columns].map(() => "---").join(" | ")} |`,
    ...table.rows.map(row => `| ${[[...row.path, row.label].filter(Boolean).join(" > "), ...row.cells.map(c => c.text)].map(cell).join(" | ")} |`),
    ...table.notes.map(note => `\n${note}`)].join("\n");
}

export function createMaterialTable(filing: MaterialFiling, source: MaterialSource, title: string, table: LibraryTable, start: number): MaterialTable {
  const tableId = blockId(source, "table", start);
  const csv = csvFromTable(table);
  return { tableId, documentId: source.id, title, description: `${title}. ${table.rows.length} disclosed rows and ${table.columns.length + 1} columns.${table.unit ? ` Unit: ${table.unit}.` : ""}`,
    filename: `${filenamePart(filing.ticker)}_${filing.filedAt.slice(0, 10)}_${filenamePart(filing.form)}_${filenamePart(title)}.csv`,
    csvKey: "", csv, sha256: "", sourceUrl: source.url, anchor: tableId, form: filing.form, filedAt: filing.filedAt, reportDate: filing.reportDate, table };
}

export function parseMaterialHtml(filing: MaterialFiling, source: MaterialSource, html: string): ParsedMaterialDocument {
  const parsed = parseMarkup(html), inventory = inventoryOf(html, parsed.root), coverage = documentCoverage(source);
  const blocks: MaterialBlock[] = [], tables: MaterialTable[] = [];
  const selected = inventory.tables.filter(table => !descendants(table).some(n => n.local === "table") && tableGrid(table).rows.some(row => row.cells.some(cell => cell.text)));
  const grids = new Map(selected.map(table => [table, tableGrid(table)]));
  const sourceTableOf = (leaf: TextLeaf) => selected.find(table => leaf.start >= table.start && leaf.end <= table.end);
  const outside = inventory.text.filter(leaf => !sourceTableOf(leaf));
  type Piece = { kind: "text"; leaves: TextLeaf[]; start: number } | { kind: "table"; node: Element; start: number } | { kind: "image"; node: Element; start: number };
  const pieces: Piece[] = [];
  let current: TextLeaf[] = [];
  const flush = () => { if (current.length) pieces.push({ kind: "text", leaves: current, start: current[0]!.start }); current = []; };
  for (const leaf of outside) {
    const prior = current.at(-1);
    if (prior && (prior.owner !== leaf.owner || selected.some(t => t.start > prior.end && t.end < leaf.start))) flush();
    current.push(leaf);
  }
  flush();
  pieces.push(...selected.map(node => ({ kind: "table" as const, node, start: node.start })), ...inventory.images.map(node => ({ kind: "image" as const, node, start: node.start })));
  pieces.sort((a, b) => a.start - b.start);
  let title = source.filename;
  let tableContext: string[] = [];
  const tableLocations = new Map<string, { node: Element; grid: TableGrid; headers: number; columnMap: Map<number, number> }>();
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!;
    if (piece.kind === "text") {
      const text = piece.leaves.map(leaf => leaf.text).join(" ");
      if (heading(text, piece.leaves[0]!.owner) && !titleQualifier(text)) title = text;
      blocks.push(materialBlock(source, { kind: "paragraph", title, text, start: piece.start, end: piece.leaves.at(-1)!.end }));
      tableContext.push(text);
    } else if (piece.kind === "image") {
      const path = piece.node.attributes.src ?? piece.node.attributes.href ?? piece.node.attributes["xlink:href"] ?? "";
      let url = path;
      try { url = new URL(path, source.url).href; } catch { coverage.issues.push(`IMAGE_SOURCE:${piece.start}`); }
      const alt = piece.node.attributes.alt ?? piece.node.attributes.title ?? "Source image";
      blocks.push(materialBlock(source, { kind: "image", title: alt, text: `![${alt.replace(/\]/g, "\\]")}](${url})`, start: piece.start, end: piece.node.end }));
    } else {
      const grid = grids.get(piece.node)!;
      const caption = descendants(piece.node).find(n => n.local === "caption");
      const headingLine = grid.rows.flatMap(row => row.cells.map(cell => cell.text)).filter(Boolean).join(" ");
      if (headingLine.length < 220 && /^(?:Item\s+\d+[A-Z]?\.?\s|PART\s+[IVX]+\b)/i.test(headingLine)) title = headingLine;
      const name = caption ? normalize(nodeText(caption)) : `${title} - table ${tables.length + 1}`;
      const converted = tableFromGrid(grid, tableContext.join("\n"));
      tableContext = [];
      let collectingNotes = false;
      for (const next of pieces.slice(i + 1)) {
        if (next.kind !== "text") break;
        const note = next.leaves.map(leaf => leaf.text).join(" ");
        if (/^[\s_*=.-]+$/.test(note)) continue;
        if (heading(note, next.leaves[0]!.owner)) break;
        if (/^(?:\(?\d{1,2}\)?[.)]?\s|note\b|\*|†|注)/i.test(note)) collectingNotes = true;
        if (collectingNotes) converted.table.notes.push(note); else break;
      }
      const asset = createMaterialTable(filing, source, name, converted.table, piece.start);
      tables.push(asset);
      coverage.issues.push(...converted.issues.map(issue => `${asset.tableId}:${issue}`), ...verifyTableCsv(asset.table, asset.csv).issues.map(issue => `${asset.tableId}:${issue}`));
      const originalHeader = grid.rows.slice(0, converted.headers).flatMap(row => row.cells.filter(c => c.column === 0).map(c => c.text)).filter(Boolean);
      const complex = grid.rows.some(row => row.cells.some(cell => cell.rowSpan > 1 || cell.colSpan > 1));
      const body = complex ? [...asset.table.unit ? [`Unit: ${asset.table.unit}`] : [], html.slice(piece.node.start, piece.node.end), ...asset.table.notes].join("\n\n") : tableMarkdown(asset.table);
      const text = [...new Set(originalHeader), body].join("\n\n");
      blocks.push({ ...materialBlock(source, { kind: "table", title: name, text, start: piece.start, end: piece.node.end }), id: asset.tableId, tableId: asset.tableId });
      tableLocations.set(asset.tableId, { node: piece.node, grid, headers: converted.headers, columnMap: converted.columnMap });
    }
  }
  const inline = extractFilingDisclosures(html, { ticker: filing.ticker, accessionNumber: filing.accession, documentUrl: source.url, form: filing.form, reportDate: filing.reportDate, filedAt: filing.filedAt });
  const inlineBlock = inline.facts.length || inline.contexts.length || inline.footnotes.length ? materialBlock(source, {
    kind: "code", title: "Inline XBRL facts, contexts, units and footnotes",
    text: `\`\`\`json\n${JSON.stringify({ facts: inline.facts.map(fact => omit(fact, "rawHtml", "source")), contexts: inline.contexts, units: inline.units, footnotes: inline.footnotes, relationships: inline.relationships })}\n\`\`\``,
    start: html.length, end: html.length,
  }) : null;
  if (inlineBlock) blocks.push(inlineBlock);
  const facts: FilingFactRow[] = [];
  const taggedCells = new Set<string>();
  for (const fact of inline.facts) {
    if (fact.kind !== "numeric" || fact.numericValue === null || fact.nil || !Number.isFinite(Number(fact.numericValue))) continue;
    const at = fact.source.locator.start;
    const block = blocks.find(b => b.locator.start !== null && b.locator.end !== null && at >= b.locator.start && at < b.locator.end) ?? inlineBlock;
    if (!block) continue;
    const asset = tables.find(t => t.tableId === block.tableId), location = asset ? tableLocations.get(asset.tableId) : null;
    let row: number | null = null, col: number | null = null;
    if (location) location.grid.rows.forEach((r, ri) => r.cells.forEach(cell => {
      const logicalColumn = location.columnMap.get(cell.column);
      if (at >= cell.node.start && at < cell.node.end && ri >= location.headers && logicalColumn !== undefined && logicalColumn > 0) { row = ri - location.headers; col = logicalColumn - 1; }
    }));
    if (row !== null && col !== null) taggedCells.add(`${block.id}|${row}|${col}`);
    const p = fact.context?.period;
    const periodStart = p?.kind === "duration" ? p.start : null, periodEnd = p?.end ?? null;
    const unitSide = (values: Array<{ name: string }>) => values.map(v => v.name.split(":").at(-1) ?? v.name).join("*");
    const numerator = fact.unit ? unitSide(fact.unit.numerator) : "", denominator = fact.unit ? unitSide(fact.unit.denominator) : "";
    const tableRow = row === null ? null : asset?.table.rows[row];
    facts.push({ factId: `f${libraryHash(`${source.id}|${at}`).slice(0, 14)}`, passageId: block.id, sectionId: block.id, ordinal: blocks.indexOf(block), row, col,
      label: tableRow ? [...tableRow.path, tableRow.label].filter(Boolean).join(" > ") : fact.concept.name.split(":").at(-1)!.replace(/([a-z])([A-Z])/g, "$1 $2"),
      concept: fact.concept.name, dimensions: (fact.context?.dimensions ?? []).map(d => `${d.axis.name}=${d.member?.name ?? d.value}`).join(";"),
      periodStart, periodEnd, periodMonths: p?.kind === "instant" ? 0 : periodStart && periodEnd ? Math.max(1, Math.round((Date.parse(periodEnd) - Date.parse(periodStart)) / (30.4375 * 86400000))) : null,
      value: Number(fact.numericValue), shown: fact.rawValue, unit: denominator ? `${numerator}/${denominator}` : numerator === "pure" ? "ratio" : numerator || "number", tagged: true });
  }
  for (const asset of tables) {
    const byColumn = new Map<number, FilingFactRow[]>();
    for (const fact of facts) if (fact.passageId === asset.tableId && fact.col !== null && fact.periodEnd) byColumn.set(fact.col, [...byColumn.get(fact.col) ?? [], fact]);
    const fromTagged = new Map<number, FilingFactRow>();
    for (const [column, found] of byColumn) if (new Set(found.map(f => `${f.periodStart}|${f.periodEnd}|${f.periodMonths}|${f.unit}`)).size === 1) fromTagged.set(column, found[0]!);
    const scale = /billions/i.test(asset.table.unit ?? "") ? 1e9 : /millions/i.test(asset.table.unit ?? "") ? 1e6 : /thousands/i.test(asset.table.unit ?? "") ? 1e3 : null;
    const stated = [asset.table.unit ?? "", ...asset.table.rows.flatMap(row => row.cells.map(cell => cell.text))].join(" ");
    const currencies = [
      /\b(?:RMB|CNY)\b/.test(stated) ? "CNY" : null, /\bEUR\b|€/.test(stated) ? "EUR" : null,
      /\bGBP\b|£/.test(stated) ? "GBP" : null, /\bJPY\b/.test(stated) ? "JPY" : null,
      /\bUSD\b|U\.?S\.? dollars?|(?:^|[^A-Za-z])\$/.test(stated) ? "USD" : null,
    ].filter(value => value !== null);
    const currency = currencies.length === 1 ? currencies[0]! : null;
    asset.table.rows.forEach((row, r) => row.cells.forEach((cell, c) => {
      if (cell.value === null || taggedCells.has(`${asset.tableId}|${r}|${c}`)) return;
      const label = [...row.path, row.label].filter(Boolean).join(" > ");
      const column = asset.table.columns[c] ?? "";
      const tagged = fromTagged.get(c), named = headingPeriod(column.replace(/\s*>\s*/g, " "));
      const end = tagged?.periodEnd ?? named.end;
      const percent = cell.text.includes("%") || /%|\bpercent(?:age)?\b/i.test(column) || /%|\bpercent(?:age)?\b/i.test(label);
      const shares = /\b(?:shares|stock[- ]based awards?|(?:restricted )?stock units?|RSUs?|stock options?)\b/i.test(label)
        && /\b(?:used|outstanding|issued|repurchased|vested|weighted|number)\b/i.test(label)
        && !/\b(?:expenses?|costs?|value|price|proceeds|payments?|cash)\b/i.test(row.label);
      const count = /\bemployees\b/i.test(label) || /\bnumber of\b/i.test(label) && !shares;
      const perShare = !shares && /per (?:basic |diluted |common )?share/i.test(label);
      if (!end && !/\bQ[1-4]\s+(?:19|20)\d{2}\b/.test(column)) return;
      if (!percent && !shares && !count && !perShare && (scale === null || currency === null)) return;
      if (perShare && currency === null) return;
      const unit = percent ? "percent" : shares ? "shares" : count ? "number" : perShare ? `${currency}/shares` : currency!;
      const multiplier = percent || perShare || count ? 1 : scale ?? 1;
      const outstanding = shares && /\boutstanding\b/i.test(label) && !/\b(?:weighted|average)\b/i.test(label);
      const periodMonths = /\bTTM\b|trailing twelve months/i.test(label) ? 12 : count || outstanding || /end of (?:the )?period/i.test(label) || /balance sheets?/i.test(asset.title) ? 0 : tagged?.periodMonths ?? named.months ?? (/\bQ[1-4]\s+(?:19|20)\d{2}\b/.test(column) ? 3 : null);
      const beginning = /beginning of (?:the )?period/i.test(label);
      facts.push({ factId: `f${libraryHash(`${asset.tableId}|${r}|${c}`).slice(0, 14)}`, passageId: asset.tableId, sectionId: asset.tableId, ordinal: blocks.findIndex(b => b.id === asset.tableId), row: r, col: c,
        label: end && !beginning ? label : `${label} [${column}]`, concept: null, dimensions: "", periodStart: beginning ? null : tagged?.periodStart ?? null, periodEnd: beginning ? null : end,
        periodMonths: beginning ? null : periodMonths,
        value: cell.value * multiplier, shown: cell.text, unit, tagged: false });
    }));
  }
  coverage.sourceTextChars = inventory.text.reduce((n, leaf) => n + leaf.text.length, 0);
  for (const leaf of inventory.text) {
    const owner = blocks.find(block => block.kind !== "image" && block.locator.start !== null && block.locator.end !== null && leaf.start >= block.locator.start && leaf.end <= block.locator.end);
    if (owner && normalize(decodeEntities(owner.text)).includes(leaf.text.replace(/\|/g, "\\|"))) coverage.retainedTextChars += leaf.text.length;
    else if (owner?.kind === "table") {
      const asset = tables.find(table => table.tableId === owner.tableId);
      if (asset && normalize(csvFromTable(asset.table) + asset.title + owner.text).includes(leaf.text)) coverage.retainedTextChars += leaf.text.length;
      else coverage.issues.push(`SOURCE_TEXT_UNMAPPED:${leaf.start}`);
    } else coverage.issues.push(`SOURCE_TEXT_UNMAPPED:${leaf.start}`);
  }
  coverage.sourceTables = selected.length;
  coverage.retainedTables = tables.length;
  coverage.sourceImages = inventory.images.length;
  coverage.retainedImages = blocks.filter(block => block.kind === "image").length;
  return { blocks, tables, facts, coverage };
}
