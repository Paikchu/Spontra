import type { MaterialFiling, MaterialIndexedBlock, MaterialPage, MaterialSnapshot, MaterialTable } from "../../../../shared/analysis-contract/filing-material.ts";
import { factText, periodText } from "../../../../shared/analysis-runtime/filing-library/facts.ts";
import { csvFromTable } from "../../../../shared/analysis-runtime/filing-material.ts";
import type { AnalysisEnv } from "../operations.ts";
import type { SecFiling } from "../sec/sec.ts";

type MaterialReadEnv = Pick<AnalysisEnv, "SEC_FILINGS">;
const encoder = new TextEncoder();
const SOURCE_BYTES = 64_000;

export const filingMaterialMeta = (filing: SecFiling): MaterialFiling => ({
  ticker: filing.ticker, accession: filing.accessionNumber, cik: filing.cik, form: filing.form,
  filedAt: filing.filingDate, reportDate: filing.reportDate, companyName: filing.companyName,
  primaryDocument: filing.primaryDocument, documentUrl: filing.documentUrl, indexUrl: filing.indexUrl,
});

const position = (cursor: string | undefined) => {
  const n = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("Invalid material cursor");
  return n;
};

async function markdownBytes(env: MaterialReadEnv, snapshot: MaterialSnapshot, offset: number, length: number): Promise<Uint8Array> {
  if (!length) return new Uint8Array();
  const object = await env.SEC_FILINGS.get(snapshot.markdown.key, { range: { offset, length } });
  if (!object) throw new Error(`MATERIAL_MARKDOWN_MISSING:${snapshot.ref.accession}:${snapshot.ref.version}`);
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.length !== length) throw new Error(`MATERIAL_RANGE_INCOMPLETE:${offset}:${length}`);
  return bytes;
}

export const materialBlockId = (sourceId: string): string => /^(.+)#\d+-\d+$/.exec(sourceId)?.[1] ?? sourceId;

export async function readFilingMarkdown(env: MaterialReadEnv, snapshot: MaterialSnapshot, request: { anchor?: string; cursor?: string; maxChars?: number } = {}): Promise<MaterialPage> {
  let start = position(request.cursor);
  if (request.anchor && !request.cursor) {
    const offset = snapshot.blocks.find(block => block.id === request.anchor)?.range?.anchorOffset
      ?? snapshot.toc.find(section => section.anchor === request.anchor)?.offset;
    if (offset === undefined) throw new Error(`Unknown material anchor ${request.anchor}`);
    start = offset;
  }
  const requested = request.maxChars ?? 48_000;
  if (!Number.isSafeInteger(requested) || requested < 1000) throw new Error("Material read budget must be at least 1000 bytes");
  const budget = Math.min(SOURCE_BYTES, requested);
  if (start >= snapshot.markdown.bytes) return { ref: snapshot.ref, text: "", blockIds: [], nextCursor: null, toc: snapshot.toc };
  let end = Math.min(snapshot.markdown.bytes, start + budget);
  const boundary = snapshot.blocks.reduce<number | undefined>((found, block) => block.range && block.range.anchorOffset > start && block.range.anchorOffset <= end
    ? Math.max(found ?? 0, block.range.anchorOffset) : found, undefined);
  if (end < snapshot.markdown.bytes && boundary !== undefined) end = boundary;
  const bytes = await markdownBytes(env, snapshot, start, Math.min(snapshot.markdown.bytes - start, end - start + 4));
  if (bytes.length && (bytes[0]! & 0xc0) === 0x80) throw new Error("Use the previous read's nextCursor to preserve UTF-8 boundaries");
  let consumed = Math.min(end - start, bytes.length);
  while (consumed < bytes.length && consumed > 0 && (bytes[consumed]! & 0xc0) === 0x80) consumed--;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, consumed));
  end = start + consumed;
  const blockIds = snapshot.blocks.flatMap(block => {
    if (!block.range) return [];
    const from = Math.max(start, block.range.offset), to = Math.min(end, block.range.offset + block.range.length);
    if (from >= to) return [];
    return [block.storage === "markdown" || from > block.range.offset || to < block.range.offset + block.range.length
      ? `${block.id}#${from - block.range.offset}-${to - block.range.offset}` : block.id];
  });
  return { ref: snapshot.ref, text, blockIds, nextCursor: end < snapshot.markdown.bytes ? String(end) : null, toc: snapshot.toc };
}

export function findFilingTables(snapshot: MaterialSnapshot, query: { name?: string; description?: string; limit?: number; cursor?: string } = {}): { tables: MaterialTable[]; nextCursor: string | null } {
  const words = [query.name, query.description].filter(Boolean).join(" ").toLowerCase().split(/\s+/).filter(Boolean);
  const tables = snapshot.tables.filter(table => words.every(word => `${table.title} ${table.description}`.toLowerCase().includes(word)));
  const start = position(query.cursor), end = start + (query.limit ?? 30);
  return { tables: tables.slice(start, end), nextCursor: end < tables.length ? String(end) : null };
}

export function readFilingTable(snapshot: MaterialSnapshot, tableId: string, request: { cursor?: string; rows?: number } = {}): { ref: MaterialSnapshot["ref"]; table: MaterialTable; csv: string; nextCursor: string | null } {
  const table = snapshot.tables.find(item => item.tableId === tableId);
  if (!table) throw new Error(`Unknown table ${tableId} in material ${snapshot.ref.version}`);
  const start = position(request.cursor), end = start + (request.rows ?? 250);
  const csv = start === 0 && end >= table.table.rows.length ? table.csv : csvFromTable({ ...table.table, rows: table.table.rows.slice(start, end) });
  return { ref: snapshot.ref, table, csv, nextCursor: end < table.table.rows.length ? String(end) : null };
}

async function blockContains(env: MaterialReadEnv, snapshot: MaterialSnapshot, block: MaterialIndexedBlock, terms: string[]): Promise<boolean> {
  const title = block.title.toLowerCase();
  if (block.storage === "inline") return terms.every(term => `${title} ${block.text.toLowerCase()}`.includes(term));
  const missing = new Set(terms.filter(term => !title.includes(term)));
  if (!missing.size) return true;
  const range = block.range;
  if (!range) return false;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const overlap = Math.max(...terms.map(term => term.length), 1);
  let carry = "";
  for (let offset = 0; offset < range.length;) {
    const length = Math.min(SOURCE_BYTES, range.length - offset);
    const bytes = await markdownBytes(env, snapshot, range.offset + offset, length);
    if (!bytes.length) throw new Error(`MATERIAL_RANGE_INCOMPLETE:${block.id}`);
    offset += bytes.length;
    const text = carry + decoder.decode(bytes, { stream: offset < range.length }).toLowerCase();
    for (const term of missing) if (text.includes(term)) missing.delete(term);
    if (!missing.size) return true;
    carry = text.slice(-overlap);
  }
  return false;
}

export async function searchFilingMarkdown(env: MaterialReadEnv, snapshot: MaterialSnapshot, query: { query: string; cursor?: string; limit?: number }): Promise<{ matches: Array<{ anchor: string; title: string; chars: number }>; nextCursor: string | null }> {
  const terms = query.query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches: Array<{ anchor: string; title: string; chars: number }> = [];
  const limit = query.limit ?? 20;
  let index = position(query.cursor);
  for (; index < snapshot.blocks.length; index++) {
    const block = snapshot.blocks[index]!;
    if (!block.range || !await blockContains(env, snapshot, block, terms)) continue;
    matches.push({ anchor: block.id, title: block.title, chars: block.range.chars });
    if (matches.length >= limit) { index++; break; }
  }
  return { matches, nextCursor: index < snapshot.blocks.length ? String(index) : null };
}

export async function sourceText(env: MaterialReadEnv, snapshot: MaterialSnapshot, id: string): Promise<{ title: string; text: string; exact?: number; url: string } | null> {
  const fact = snapshot.facts.find(item => item.factId === id);
  if (fact) {
    const block = snapshot.blocks.find(item => item.id === fact.passageId);
    return { title: `${fact.label} ${periodText(fact)}`, text: `${fact.label}: ${factText(fact)} ${periodText(fact)}. Printed as ${fact.shown}. ${fact.dimensions}`, exact: fact.value, url: block?.sourceUrl ?? snapshot.filing.documentUrl };
  }
  const part = /^(.+)#(\d+)-(\d+)$/.exec(id);
  const block = snapshot.blocks.find(item => item.id === (part?.[1] ?? id));
  if (block) {
    const bytes = block.storage === "inline" ? encoder.encode(block.text) : null;
    const total = bytes?.length ?? block.range?.length ?? 0;
    const start = part ? position(part[2]) : 0, end = part ? position(part[3]) : total;
    if (end <= start || end > total) throw new Error(`Invalid source range ${id}`);
    if (block.storage === "markdown" && end - start > SOURCE_BYTES) throw new Error(`SOURCE_RANGE_REQUIRED:${block.id}. Read this anchor with read_filing_markdown and cite its returned source range.`);
    const slice = bytes ? bytes.subarray(start, end) : block.range ? await markdownBytes(env, snapshot, block.range.offset + start, end - start) : new Uint8Array();
    return { title: block.title, text: new TextDecoder("utf-8", { fatal: true }).decode(slice), url: block.sourceUrl };
  }
  const table = snapshot.tables.find(item => item.tableId === id);
  return table ? { title: table.title, text: `${table.description}\nUnit: ${table.table.unit ?? "not stated"}\n${table.csv}\n${table.table.notes.join("\n")}`, url: table.sourceUrl } : null;
}
