import { MATERIAL_VERSION, MATERIAL_LAYOUT_VERSION, type MaterialBlock, type MaterialCoverage, type MaterialFiling, type MaterialSnapshot, type MaterialSource, type MaterialState, type MaterialTable, type ParsedMaterialDocument } from "../../../../shared/analysis-contract/filing-material.ts";
import { MATERIAL_PARSER_VERSION, documentCoverage, tableCatalogEntry, verifyTableCsv } from "../../../../shared/analysis-runtime/filing-material.ts";
import type { MaterialKeptBlock } from "../../../../shared/analysis-runtime/filing-material-document.ts";
import type { AnalysisEnv } from "../operations.ts";
import { archiveMaterialEntry, archiveZipEntries, loadMaterialManifest, readSourceBytes, referencedMaterialEntries, saveMaterialManifest } from "./archive.ts";
import { extractMaterialDocument } from "./formats.ts";
import { MATERIAL_PREFIX, MATERIAL_PREPARATION_VERSION, materialRecoveryKey, materialReconciliationKey, claimMaterialLease, getFilingMaterial, materialBase, materialDigest, materialSnapshotKey, ownsMaterialLease, publishMaterialState, releaseMaterialLease, requestFilingMaterial, writeMaterialState } from "./store.ts";
import { writeMaterialMarkdown } from "./markdown.ts";

const LAYOUT_VERSION = MATERIAL_LAYOUT_VERSION;
const EXTRACTOR_VERSION = MATERIAL_PARSER_VERSION;

export type PrepareMaterialOptions = { fetcher?: typeof fetch; causeId?: string; maxDocuments?: number; recoveryRequestId?: string; recoverySources?: Record<string, string> };

function submissionHeader(source: MaterialSource, bytes: Uint8Array, end: number): ParsedMaterialDocument {
  const text = new TextDecoder().decode(bytes.subarray(0, end)).trim();
  return {
    blocks: [{ id: `${source.id}-header`, documentId: source.id, filename: source.filename, sourceUrl: source.url, title: "SEC submission header", path: ["Submission metadata"], kind: "code", text: `\`\`\`text\n${text}\n\`\`\``, tableId: null, locator: { start: 0, end, page: null } }],
    tables: [], facts: [], coverage: { documentId: source.id, filename: source.filename, sourceTextChars: text.length, retainedTextChars: text.length, sourceTables: 0, retainedTables: 0, sourceImages: 0, retainedImages: 0, pages: 0, retainedPages: 0, issues: [] },
  };
}

export const parsedKey = (filing: MaterialFiling, source: MaterialSource) => `${MATERIAL_PREFIX}${filing.ticker}/${filing.accession}/extracted/${EXTRACTOR_VERSION}/${source.id}/${source.sha256}.json`;

const completeExtraction = (document: ParsedMaterialDocument) => {
  const c = document.coverage;
  return !c.issues.length && c.retainedTextChars >= c.sourceTextChars && c.retainedTables >= c.sourceTables
    && c.retainedImages >= c.sourceImages && c.retainedPages >= c.pages;
};
/** Reuse successful receipts; an explicit recovery gets one immutable attempt per failed source. */
async function extractionReceipt(env: AnalysisEnv, filing: MaterialFiling, source: MaterialSource, recoveryRequestId?: string): Promise<{ key: string; document: ParsedMaterialDocument | null; successPointer: string }> {
  const originalKey = parsedKey(filing, source), successPointer = `${originalKey}.recovered`;
  const approved = await env.DB!.prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(materialReconciliationKey(filing.ticker,filing.accession,source.id,source.sha256)).first<{payload:string}>();
  if (approved) {
    const pointer = JSON.parse(approved.payload), object = await env.SEC_FILINGS.get(pointer.parsedKey);
    if (!object) throw new Error("Reconciled source receipt missing");
    const text = await object.text(), document: ParsedMaterialDocument = JSON.parse(text);
    if (await materialDigest(text) !== pointer.parsedHash || document.coverage.documentId !== source.id || document.coverage.filename !== source.filename || document.coverage.reconciliation?.method !== "human-source-reconciliation.v1" || document.coverage.reconciliation?.sourceSha256 !== source.sha256 || document.coverage.reconciliation?.receiptKey !== pointer.receiptKey || !completeExtraction(document)) throw new Error("Reconciled source identity or coverage mismatch");
    return {key:pointer.parsedKey,document,successPointer};
  }
  const pointer = await env.SEC_FILINGS.get(successPointer);
  if (pointer) {
    const recoveredKey = await pointer.text();
    const receipt = await env.SEC_FILINGS.get(recoveredKey);
    if (receipt) { const document: ParsedMaterialDocument = JSON.parse(await receipt.text()); if (completeExtraction(document)) return { key: recoveredKey, document, successPointer }; }
  }
  const original = await env.SEC_FILINGS.get(originalKey);
  const document: ParsedMaterialDocument | null = original ? JSON.parse(await original.text()) : null;
  if (!recoveryRequestId || (document && completeExtraction(document))) return { key: originalKey, document, successPointer };
  const key = `${originalKey}.recovery-${recoveryRequestId}`;
  const recovered = await env.SEC_FILINGS.get(key);
  return { key, document: recovered ? JSON.parse(await recovered.text()) : null, successPointer };
}
async function extractOnce(env: AnalysisEnv, filing: MaterialFiling, source: MaterialSource, bytes: Uint8Array, recoveryRequestId?: string, reuseRawRequestId?: string): Promise<ParsedMaterialDocument> {
  const receipt = await extractionReceipt(env, filing, source, recoveryRequestId);
  if (receipt.document) return receipt.document;
  if (recoveryRequestId) {
    // Persist admission before any model call: a crashed attempt stays blocked rather than spending again.
    const coverage = documentCoverage(source);
    coverage.issues.push("MATERIAL_RECOVERY_ATTEMPT_INTERRUPTED: explicit attempt started without a completed receipt");
    const pending: ParsedMaterialDocument = { blocks: [], tables: [], facts: [], coverage };
    const admitted = await env.SEC_FILINGS.put(receipt.key, JSON.stringify(pending), { httpMetadata: { contentType: "application/json" }, onlyIf: { etagDoesNotMatch: "*" } });
    if (!admitted) return (await extractionReceipt(env, filing, source, recoveryRequestId)).document ?? pending;
  }
  const document = await extractMaterialDocument(env, filing, source, bytes, receipt.key, reuseRawRequestId ? `${parsedKey(filing, source)}.recovery-${reuseRawRequestId}` : undefined);
  await env.SEC_FILINGS.put(receipt.key, JSON.stringify(document), { httpMetadata: { contentType: "application/json" } });
  if (recoveryRequestId && completeExtraction(document)) await env.SEC_FILINGS.put(receipt.successPointer, receipt.key, { httpMetadata: { contentType: "text/plain" } });
  return document;
}

/** Zero-LLM deterministic L1 layout: primary document first, business exhibits next, code/technical originals last. */
function organizeDeterministic(
  filing: MaterialFiling,
  sources: MaterialSource[],
  blocks: MaterialBlock[],
  tables: MaterialTable[],
): { kept: MaterialKeptBlock[]; duplicates: MaterialCoverage["duplicates"]; excluded: MaterialCoverage["excluded"] } {
  const tableById = new Map(tables.map(table => [table.tableId, table]));
  const docRank = new Map<string, number>();
  sources.forEach((source, idx) => {
    const isPrimary = source.filename === filing.primaryDocument && !source.container;
    const isEarningsExhibit = /^EX-99/i.test(source.type) || /^ex99/i.test(source.filename);
    docRank.set(source.id, isPrimary ? 0 : isEarningsExhibit ? 1000 + idx : 2000 + idx);
  });
  const ordered = blocks.map((block, index) => ({ block, index })).sort((a, b) => {
    const aCode = a.block.kind === "code" ? 1 : 0;
    const bCode = b.block.kind === "code" ? 1 : 0;
    if (aCode !== bCode) return aCode - bCode;
    const ra = docRank.get(a.block.documentId) ?? 9999;
    const rb = docRank.get(b.block.documentId) ?? 9999;
    return ra !== rb ? ra - rb : a.index - b.index;
  });

  const kept: MaterialKeptBlock[] = [];
  const duplicates: MaterialCoverage["duplicates"] = [];
  const seen = new Map<string, MaterialBlock>();
  for (const { block } of ordered) {
    const table = block.tableId ? tableById.get(block.tableId) : null;
    const tableSig = table ? JSON.stringify(table.table) : "";
    const sig = `${block.kind}\u0000${block.title}\u0000${block.path.join("|")}\u0000${block.text}\u0000${tableSig}`;
    const earlier = seen.get(sig);
    if (earlier) {
      duplicates.push({ blockId: block.id, target: earlier.id });
      continue;
    }
    seen.set(sig, block);
    if (block.kind === "code") {
      kept.push({ block, section: "Technical & Submission Originals", sectionKind: "technical" });
      continue;
    }
    const isPrimary = block.filename === filing.primaryDocument;
    const topic = block.path[0]?.trim() || block.title.trim() || (isPrimary ? "Primary Filing" : block.filename);
    kept.push({
      block,
      section: isPrimary ? topic : `${block.filename}: ${topic}`,
      sectionKind: isPrimary ? "primary" : "exhibit",
    });
  }
  return { kept, duplicates, excluded: [] };
}

export async function prepareFilingMaterial(env: AnalysisEnv, filing: MaterialFiling, options: PrepareMaterialOptions = {}): Promise<MaterialState> {
  const existing = await getFilingMaterial(env, filing.ticker, filing.accession);
  if (existing?.status === "ready") return existing;
  if (!options.recoveryRequestId) {
    const request = await env.DB!.prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(materialRecoveryKey(filing.ticker, filing.accession)).first<{payload:string}>();
    if (request) { const id = JSON.parse(request.payload).requestId; if (typeof id === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) options = { ...options, recoveryRequestId: id }; }
  }
  const owner = crypto.randomUUID();
  if (!await claimMaterialLease(env, filing, owner)) return existing ?? requestFilingMaterial(env, filing);
  try { return await prepareOwnedMaterial(env, filing, owner, options); }
  finally { await releaseMaterialLease(env, filing, owner); }
}

async function prepareOwnedMaterial(env: AnalysisEnv, filing: MaterialFiling, owner: string, options: PrepareMaterialOptions): Promise<MaterialState> {
  const existing = await getFilingMaterial(env, filing.ticker, filing.accession);
  if (existing?.status === "ready") return existing;
  const progress = async (message: string): Promise<MaterialState> => {
    const state: MaterialState = { status: "preparing", filing, progress: message };
    if (!await ownsMaterialLease(env, filing, owner)) return await getFilingMaterial(env, filing.ticker, filing.accession) ?? state;
    await writeMaterialState(env, state); return state;
  };
  try {
    const manifest = await loadMaterialManifest(env, filing, { fetcher: options.fetcher });
    const submissionBytes = await readSourceBytes(env, manifest.submission);
    const sources: MaterialSource[] = [manifest.submission], parsed: ParsedMaterialDocument[] = [submissionHeader(manifest.submission, submissionBytes, manifest.headerEnd)];
    let processed = 0;
    const budget = options.maxDocuments ?? 8;
    for (let index = 0; index < manifest.entries.length; index++) {
      const entry = manifest.entries[index]!;
      const source = await archiveMaterialEntry(env, manifest, entry, submissionBytes, { fetcher: options.fetcher });
      const bytes = await readSourceBytes(env, source), alreadyParsed = (await extractionReceipt(env, filing, source, options.recoverySources?.[source.filename] ?? options.recoveryRequestId)).document;
      if (!alreadyParsed && processed >= budget) return progress(`extracting source ${index + 1} of ${manifest.entries.length}`);
      const document = alreadyParsed ?? await extractOnce(env, filing, source, bytes, options.recoverySources?.[source.filename] ?? options.recoveryRequestId, options.recoverySources?.[source.filename] ? options.recoveryRequestId : undefined);
      if (!alreadyParsed) processed++;
      sources.push(source); parsed.push(document);
      const added = referencedMaterialEntries(manifest, source, bytes);
      if (added.length) { manifest.entries.push(...added); await saveMaterialManifest(env, manifest); }
      if (source.contentType === "application/zip" || /\.zip$/i.test(source.filename)) {
        const children = await archiveZipEntries(env, filing, source, bytes);
        for (const child of children) {
          const cached = (await extractionReceipt(env, filing, child, options.recoverySources?.[child.filename] ?? options.recoveryRequestId)).document;
          if (!cached && processed >= budget) return progress(`extracting ZIP entry ${child.filename}`);
          const childDocument = cached ?? await extractOnce(env, filing, child, await readSourceBytes(env, child), options.recoverySources?.[child.filename] ?? options.recoveryRequestId, options.recoverySources?.[child.filename] ? options.recoveryRequestId : undefined);
          if (!cached) processed++;
          sources.push(child); parsed.push(childDocument);
        }
      }
    }
    const blocks = parsed.flatMap(document => document.blocks), tables = parsed.flatMap(document => document.tables), facts = parsed.flatMap(document => document.facts);
    const issues = parsed.flatMap(document => {
      const c = document.coverage, out = c.issues.map(issue => `${c.filename}: ${issue}`);
      if (c.retainedTextChars < c.sourceTextChars) out.push(`${c.filename}: uncovered source text`);
      if (c.retainedTables < c.sourceTables) out.push(`${c.filename}: uncovered tables`);
      if (c.retainedImages < c.sourceImages) out.push(`${c.filename}: uncovered images`);
      if (c.retainedPages < c.pages) out.push(`${c.filename}: uncovered pages`);
      return out;
    });
    if (issues.length) { const state: MaterialState = { status: "blocked", filing, issues }; await writeMaterialState(env, state); return state; }
    const reconciliations = parsed.flatMap(document => document.coverage.reconciliation ? [document.coverage.reconciliation] : []);
    const version = await materialDigest(JSON.stringify({ ...(reconciliations.length ? {reconciliations} : {}), version: MATERIAL_VERSION, extractor: EXTRACTOR_VERSION, layout: LAYOUT_VERSION,
      inventory: { version: manifest.inventory.inventoryVersion, sha256: manifest.inventory.directory.sha256 }, sources: sources.map(source => [source.id, source.sha256]) }));
    const ref = { ticker: filing.ticker, accession: filing.accession, version }, base = materialBase(ref);
    const organized = organizeDeterministic(filing, sources, blocks, tables);
    let checkedCells = 0;
    for (const table of tables) {
      const check = verifyTableCsv(table.table, table.csv);
      checkedCells += check.checkedCells;
      issues.push(...check.issues.map(issue => `${table.tableId}:${issue}`));
    }
    if (issues.length) { const state: MaterialState = { status: "blocked", filing, issues }; await writeMaterialState(env, state); return state; }
    const coverage: MaterialCoverage = { expectedDocuments: sources.length, archivedDocuments: sources.length, documents: parsed.map(document => document.coverage),
      sourceBlocks: blocks.length, retainedBlocks: organized.kept.length, duplicates: organized.duplicates, excluded: organized.excluded,
      tableCells: tables.reduce((count, table) => count + table.table.columns.length + 1 + table.table.rows.reduce((n, row) => n + row.cells.length + 1, 0), 0), checkedCells, issues, archiveInventory: manifest.inventory };
    if (!await ownsMaterialLease(env, filing, owner)) return progress("awaiting active material preparation");
    const snapshotKey = materialSnapshotKey(ref), markdownKey = `${base}/filing.md`;
    const document = await writeMaterialMarkdown(env, markdownKey, filing, sources, tables, blocks, organized.kept, organized.duplicates, organized.excluded);
    for (const table of tables) {
      table.csvKey = `${base}/tables/${table.tableId}/${table.filename}`;
      const sha = await materialDigest(table.csv);
      if (table.sha256 && table.sha256 !== sha) throw new Error(`CSV_HASH_MISMATCH:${table.tableId}`);
      table.sha256 = sha;
      await env.SEC_FILINGS.put(table.csvKey, table.csv, { httpMetadata: { contentType: "text/csv; charset=utf-8" } });
    }
    const snapshot: MaterialSnapshot = { format: "filing-material.index.v2", ref, filing, createdAt: new Date().toISOString(), documents: sources, tables, facts, ...document, coverage };
    const catalogSources = new Map(document.blocks.map(block => [block.id, block]));
    const tableCatalog = tables.map(table => tableCatalogEntry(table, catalogSources.get(table.anchor)));
    await env.SEC_FILINGS.put(`${base}/coverage.json`, JSON.stringify(coverage), { httpMetadata: { contentType: "application/json" } });
    await env.SEC_FILINGS.put(`${base}/tables.json`, JSON.stringify(tableCatalog), { httpMetadata: { contentType: "application/json" } });
    const written = await env.SEC_FILINGS.put(snapshotKey, JSON.stringify(snapshot), { httpMetadata: { contentType: "application/json" }, onlyIf: { etagDoesNotMatch: "*" } });
    if (written === null) {
      const prior = await env.SEC_FILINGS.get(snapshotKey);
      if (!prior) throw new Error("MATERIAL_INDEX_RECEIPT_MISSING");
      snapshot.createdAt = JSON.parse(await prior.text()).createdAt;
    }
    const state: MaterialState = { status: "ready", ref, filing, snapshotKey, markdownKey, preparedAt: snapshot.createdAt, preparationVersion: MATERIAL_PREPARATION_VERSION };
    if (await publishMaterialState(env, state, owner, options.causeId)) return state;
    return await getFilingMaterial(env, filing.ticker, filing.accession) ?? progress("awaiting active material preparation");
  } catch (error) {
    const state: MaterialState = { status: "blocked", filing, issues: [error instanceof Error ? error.message : String(error)] };
    if (await ownsMaterialLease(env, filing, owner)) { await writeMaterialState(env, state); return state; }
    return await getFilingMaterial(env, filing.ticker, filing.accession) ?? { status: "preparing", filing, progress: "awaiting active material preparation" };
  }
}
