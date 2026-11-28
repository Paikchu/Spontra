import type { MaterialIndexedBlock, MaterialSnapshot } from "./contract.ts";
import { sourceText } from "./read.ts";

type ReadEnv = Parameters<typeof sourceText>[0];
type Alias = { sourceId: string; documentId: string; locator: MaterialIndexedBlock["locator"] };
type TextEntry = { kind: "paragraph" | "image"; sourceId: string; aliases: Alias[]; documentId: string; title: string; path: string[]; text: string };
type Entry = TextEntry
  | { kind: "document"; source: MaterialSnapshot["documents"][number]; readableDuplicateOf: string | null }
  | { kind: "archive-directory"; inventory: Omit<NonNullable<MaterialSnapshot["coverage"]["archiveInventory"]>, "directory"> & { directory: Omit<NonNullable<MaterialSnapshot["coverage"]["archiveInventory"]>["directory"], "files"> } }
  | { kind: "archive-file"; filename: string }
  | { kind: "technical-original"; sourceId: string; documentId: string; title: string; readWith: { tool: "read_filing_markdown"; view: "raw"; anchor: string } }
  | { kind: "table-reference"; tableId: string; aliases: Alias[]; documentId: string; title: string; unit: string | null; rows: number; source: string; readWith: "read_filing_table" }
  | { kind: "deferred-text"; sourceId: string; aliases: Alias[]; documentId: string; reason: string; readWith: { tool: "read_filing_markdown"; view: "raw"; anchor: string } };
type Item = { entry: Entry } | { block: MaterialIndexedBlock; aliases: Alias[] };

const PAGE_CHARS = 48_000;
const prefix = (snapshot: MaterialSnapshot) => `readable:v1:${snapshot.ref.accession}:${snapshot.ref.version}:`;

function position(snapshot: MaterialSnapshot, cursor: string | undefined, length: number) {
  if (cursor === undefined) return 0;
  const head = prefix(snapshot), tail = cursor.startsWith(head) ? cursor.slice(head.length) : "";
  if (!/^(0|[1-9]\d*)$/.test(tail)) throw new Error("Invalid readable cursor; use this material version's nextCursor. Raw Markdown cursors are separate.");
  const index = Number(tail);
  if (!Number.isSafeInteger(index) || index >= length) throw new Error("Readable cursor is outside this fixed material.");
  return index;
}

/** Only a matching complete readable archive-document sequence shares text; equal short paragraphs in other contexts stay separate. */
function inventory(snapshot: MaterialSnapshot) {
  const tables = new Map(snapshot.tables.map(table => [table.tableId, table]));
  const byDocument = new Map<string, MaterialIndexedBlock[]>();
  for (const block of snapshot.blocks) if (block.kind !== "code") {
    const blocks = byDocument.get(block.documentId) ?? [];
    blocks.push(block); byDocument.set(block.documentId, blocks);
  }
  const originalDocuments = new Map<string, { id: string; blocks: MaterialIndexedBlock[]; sequence: string }>();
  const duplicateDocuments = new Map<string, string>(), duplicates = new Map<string, string>(), aliases = new Map<string, Alias[]>();
  for (const document of snapshot.documents) {
    const blocks = byDocument.get(document.id);
    if (!blocks?.length || blocks.some(block => block.kind === "table" ? !tables.has(block.tableId ?? "") : block.storage !== "inline")) continue;
    const sequence = JSON.stringify(blocks.map(block => {
      const table = tables.get(block.tableId ?? "");
      return [block.kind, block.title, block.path, block.text, table ? [table.csv, table.table.unit, table.table.columns, table.table.notes] : null];
    }));
    const previous = originalDocuments.get(document.filename);
    if (document.type === "ZIP-ENTRY" && document.container && previous?.sequence === sequence) {
      duplicateDocuments.set(document.id, previous.id);
      blocks.forEach((block, index) => {
        const target = previous.blocks[index]!;
        duplicates.set(block.id, target.id);
        const list = aliases.get(target.id) ?? [];
        list.push({ sourceId: block.tableId ?? block.id, documentId: block.documentId, locator: block.locator });
        aliases.set(target.id, list);
      });
    } else if (document.type !== "ZIP-ENTRY") originalDocuments.set(document.filename, { id: document.id, blocks, sequence });
  }
  const items: Item[] = snapshot.documents.map(source => ({ entry: { kind: "document", source, readableDuplicateOf: duplicateDocuments.get(source.id) ?? null } }));
  const archive = snapshot.coverage.archiveInventory;
  if (archive) {
    const { files, ...directory } = archive.directory;
    items.push({ entry: { kind: "archive-directory", inventory: { ...archive, directory } } });
    for (const filename of files) items.push({ entry: { kind: "archive-file", filename } });
  }
  let readableBlocks = 0, duplicateAliases = 0, technicalOriginals = 0, tableReferences = 0;
  for (const block of snapshot.blocks) {
    if (block.kind === "code") {
      technicalOriginals++;
      items.push({ entry: { kind: "technical-original", sourceId: block.id, documentId: block.documentId, title: block.title,
        readWith: { tool: "read_filing_markdown", view: "raw", anchor: block.id } } });
    } else if (block.kind === "table") {
      tableReferences++;
      if (duplicates.has(block.id)) continue;
      const table = tables.get(block.tableId ?? "");
      if (!table) throw new Error(`MATERIAL_TABLE_MISSING:${block.id}`);
      items.push({ entry: { kind: "table-reference", tableId: table.tableId, aliases: aliases.get(block.id) ?? [], documentId: table.documentId, title: table.title,
        unit: table.table.unit, rows: table.table.rows.length, source: table.sourceUrl, readWith: "read_filing_table" } });
    } else {
      readableBlocks++;
      if (duplicates.has(block.id)) { duplicateAliases++; continue; }
      items.push({ block, aliases: aliases.get(block.id) ?? [] });
    }
  }
  return { items, readableBlocks, duplicateAliases, technicalOriginals, tableReferences };
}

export type ReadablePage = {
  material: MaterialSnapshot["ref"]; view: "readable"; nextCursor: string | null;
  coverage: {
    scope: string; entriesFrom: number; entriesTo: number; totalEntries: number; endOfView: boolean;
    readableBlocks: number; exactDuplicateAliases: number; technicalOriginals: number; tableReferences: number;
    expectedDocuments: number; archivedDocuments: number; snapshotExcludedBlocks: number; snapshotIssues: string[];
    pageTextSources: number; pageDeferredTextSources: number; raw: { tool: "read_filing_markdown"; view: "raw" };
  };
  entries: Entry[];
};

/** The entire serialized page fits the tool limit; CSV/facts remain available through the existing original-data tools. */
export async function readFilingReadable(env: ReadEnv, snapshot: MaterialSnapshot, request: { anchor?: string; cursor?: string; maxChars?: number } = {}): Promise<ReadablePage> {
  const requested = request.maxChars ?? PAGE_CHARS;
  if (!Number.isSafeInteger(requested) || requested < 1000) throw new Error("Readable page budget must be at least 1000 characters.");
  const budget = Math.min(PAGE_CHARS, requested), catalog = inventory(snapshot);
  let start = position(snapshot, request.cursor, catalog.items.length);
  if (request.anchor && !request.cursor) {
    start = catalog.items.findIndex(item => "block" in item
      ? item.block.id === request.anchor || item.aliases.some(alias => alias.sourceId === request.anchor)
      : ("sourceId" in item.entry && item.entry.sourceId === request.anchor) || (item.entry.kind === "table-reference" && (item.entry.tableId === request.anchor || item.entry.aliases.some(alias => alias.sourceId === request.anchor))));
    if (start < 0) throw new Error(`Unknown readable anchor ${request.anchor}; use view raw for Markdown section anchors.`);
  }
  const page: ReadablePage = {
    material: snapshot.ref, view: "readable", nextCursor: null,
    coverage: {
      scope: "Verbatim paragraph/image text; only complete matching readable archive-document sequences share aliases. Equal short text in other contexts stays separate. CSV, facts and technical bodies need original tools. Follow nextCursor; endOfView is not full raw-filing coverage.",
      entriesFrom: start, entriesTo: start, totalEntries: catalog.items.length, endOfView: false,
      readableBlocks: catalog.readableBlocks, exactDuplicateAliases: catalog.duplicateAliases, technicalOriginals: catalog.technicalOriginals, tableReferences: catalog.tableReferences,
      expectedDocuments: snapshot.coverage.expectedDocuments, archivedDocuments: snapshot.coverage.archivedDocuments,
      snapshotExcludedBlocks: snapshot.coverage.excluded.length, snapshotIssues: snapshot.coverage.issues,
      pageTextSources: 0, pageDeferredTextSources: 0, raw: { tool: "read_filing_markdown", view: "raw" },
    }, entries: [],
  };
  const finalize = (end: number) => {
    page.nextCursor = end < catalog.items.length ? `${prefix(snapshot)}${end}` : null;
    page.coverage.entriesTo = end;
    page.coverage.endOfView = page.nextCursor === null;
    page.coverage.pageTextSources = page.entries.filter(entry => entry.kind === "paragraph" || entry.kind === "image").length;
    page.coverage.pageDeferredTextSources = page.entries.filter(entry => entry.kind === "deferred-text").length;
  };
  for (let index = start; index < catalog.items.length; index++) {
    const item = catalog.items[index]!;
    let entry: Entry;
    if ("entry" in item) entry = item.entry;
    else {
      const { block, aliases } = item;
      const defer = (): Entry => ({ kind: "deferred-text", sourceId: block.id, aliases, documentId: block.documentId,
        reason: "This original text exceeds one readable page; read the raw anchor and follow its nextCursor. Its text has not been returned by this view.",
        readWith: { tool: "read_filing_markdown", view: "raw", anchor: block.id } });
      if (block.storage === "markdown" && (!block.range || block.range.length > budget / 2)) entry = defer();
      else {
        const source = await sourceText(env, snapshot, block.id);
        if (!source) throw new Error(`MATERIAL_SOURCE_MISSING:${block.id}`);
        entry = { kind: block.kind as TextEntry["kind"], sourceId: block.id, aliases, documentId: block.documentId, title: block.title, path: block.path, text: source.text };
        // A large original is named explicitly rather than silently cut or marked as read.
        if (JSON.stringify(entry).length > budget / 2) entry = defer();
      }
    }
    page.entries.push(entry);
    finalize(index + 1);
    if (JSON.stringify(page).length > budget) {
      page.entries.pop();
      finalize(index);
      if (!page.entries.length) throw new Error(`READABLE_PAGE_TOO_SMALL:${budget}. Use maxChars 48000 or view raw with the original anchor; no content was marked as read.`);
      return page;
    }
  }
  finalize(catalog.items.length);
  if (JSON.stringify(page).length > budget) throw new Error("READABLE_COVERAGE_EXCEEDS_PAGE_BUDGET; use the original raw view. No complete readable page was returned.");
  return page;
}
