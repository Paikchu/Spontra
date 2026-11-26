import { MATERIAL_VERSION, MATERIAL_LAYOUT_VERSION, type MaterialBlock, type MaterialCoverage, type MaterialExtractFile, type MaterialFiling, type MaterialSnapshot, type MaterialSource, type MaterialState, type MaterialTable, type ParsedMaterialDocument } from "../../../../shared/analysis-contract/filing-material.ts";
import { MATERIAL_PARSER_VERSION, documentCoverage, tableCatalogEntry, verifyTableCsv } from "../../../../shared/analysis-runtime/filing-material.ts";
import type { MaterialKeptBlock } from "../../../../shared/analysis-runtime/filing-material-document.ts";
import type { AnalysisEnv } from "../operations.ts";
import { archiveMaterialEntry, archiveZipEntries, loadCachedSources, loadMaterialManifest, manifestKey, readSourceBytes, readSubmissionHeaderBytes, referencedMaterialEntries, saveMaterialManifest, type MaterialManifest } from "./archive.ts";
import { extractMaterialDocument } from "./formats.ts";
import { MATERIAL_PREFIX, MATERIAL_PREPARATION_VERSION, materialRecoveryKey, materialReconciliationKey, claimMaterialLease, getFilingMaterial, materialBase, materialDigest, materialSnapshotKey, ownsMaterialLease, publishMaterialState, releaseMaterialLease, requestFilingMaterial, writeMaterialState } from "./store.ts";
import { writeMaterialMarkdown } from "./markdown.ts";

const LAYOUT_VERSION = MATERIAL_LAYOUT_VERSION;
const EXTRACTOR_VERSION = MATERIAL_PARSER_VERSION;
const MAX_CSV_PUTS_PER_STEP = 200;
const CSV_PUT_CONCURRENCY = 16;
export const ASSEMBLE_STEP_FILENAME = "L1 组装与落盘 (filing.md / tables / index.json)";

export type PrepareMaterialOptions = { fetcher?: typeof fetch; causeId?: string; maxDocuments?: number; recoveryRequestId?: string; recoverySources?: Record<string, string> };

function submissionHeader(source: MaterialSource, bytes: Uint8Array, end: number): ParsedMaterialDocument {
  const text = new TextDecoder().decode(bytes.subarray(0, end)).trim();
  return {
    blocks: [{ id: `${source.id}-header`, documentId: source.id, filename: source.filename, sourceUrl: source.url, title: "SEC submission header", path: ["Submission metadata"], kind: "code", text: `\`\`\`text\n${text}\n\`\`\``, tableId: null, locator: { start: 0, end, page: null } }],
    tables: [], facts: [], coverage: { documentId: source.id, filename: source.filename, sourceTextChars: text.length, retainedTextChars: text.length, sourceTables: 0, retainedTables: 0, sourceImages: 0, retainedImages: 0, pages: 0, retainedPages: 0, issues: [] },
  };
}

export const parsedKey = (filing: MaterialFiling, source: MaterialSource) => `${MATERIAL_PREFIX}${filing.ticker}/${filing.accession}/extracted/${EXTRACTOR_VERSION}/${source.id}/${source.sha256}.json`;

async function listExtractedReceipts(env: Pick<AnalysisEnv, "SEC_FILINGS">, filing: MaterialFiling): Promise<Map<string, Set<string>>> {
  const prefix = `${MATERIAL_PREFIX}${filing.ticker}/${filing.accession}/extracted/${EXTRACTOR_VERSION}/`;
  const byDoc = new Map<string, Set<string>>();
  let cursor: string | undefined;
  do {
    const listed = await env.SEC_FILINGS.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const obj of listed.objects) {
      const rel = obj.key.slice(prefix.length);
      const slash = rel.indexOf("/");
      if (slash <= 0) continue;
      const docId = rel.slice(0, slash);
      let set = byDoc.get(docId);
      if (!set) { set = new Set(); byDoc.set(docId, set); }
      set.add(obj.key);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return byDoc;
}

function hasCompletedReceiptKey(keys: Set<string> | undefined): boolean {
  if (!keys) return false;
  for (const key of keys) {
    if (key.endsWith(".json") || key.endsWith(".recovered")) return true;
  }
  return false;
}

async function loadReconciliations(env: Pick<AnalysisEnv, "DB">, filing: MaterialFiling): Promise<Map<string, string>> {
  const prefix = `filing-material:reconciliation:v1:${filing.ticker}:${filing.accession}:`;
  const rows = await env.DB!.prepare("SELECT cache_key, payload FROM sec_cache WHERE cache_key >= ? AND cache_key < ?")
    .bind(prefix, `${prefix}\uffff`).all<{ cache_key: string; payload: string }>();
  return new Map(rows.results.map(r => [r.cache_key, r.payload]));
}

export async function readExtractionFiles(
  env: Pick<AnalysisEnv, "SEC_FILINGS" | "DB">,
  filing: MaterialFiling,
  options?: { stalled?: boolean },
): Promise<MaterialExtractFile[]> {
  const stored = await env.SEC_FILINGS.get(manifestKey(filing));
  if (!stored) return [];
  const manifest: MaterialManifest = JSON.parse(await stored.text());
  const [receipts, cachedSources] = await Promise.all([
    listExtractedReceipts(env, filing),
    env.DB ? loadCachedSources(env, filing).catch(() => []) : Promise.resolve([]),
  ]);
  const sourceById = new Map(cachedSources.map(s => [s.id, s]));
  const items: MaterialExtractFile[] = await Promise.all(manifest.entries.map(async entry => {
    const id = `d${(await materialDigest(entry.url)).slice(0, 24)}`;
    return {
      filename: entry.filename,
      type: entry.type,
      status: hasCompletedReceiptKey(receipts.get(id)) ? "done" : "pending",
      ...(entry.container ? { container: entry.container } : {}),
    } satisfies MaterialExtractFile;
  }));
  const seenKeys = new Set(items.map(i => `${i.container ?? ""}::${i.filename}`));
  for (const src of cachedSources) {
    if (!src.container) continue;
    const containerName = sourceById.get(src.container)?.filename ?? src.container;
    const k = `${containerName}::${src.filename}`;
    if (seenKeys.has(k)) continue;
    seenKeys.add(k);
    items.push({
      filename: src.filename,
      type: src.type,
      status: hasCompletedReceiptKey(receipts.get(src.id)) ? "done" : "pending",
      container: containerName,
    });
  }
  const allSourcesDone = items.length > 0 && items.every(i => i.status === "done");
  if (options?.stalled && !allSourcesDone) {
    const firstPending = items.find(i => i.status === "pending" || i.status === "extracting");
    if (firstPending) firstPending.status = "failed";
  }
  items.push({
    filename: ASSEMBLE_STEP_FILENAME,
    type: "ASSEMBLE",
    status: options?.stalled && allSourcesDone ? "failed" : allSourcesDone ? "extracting" : "pending",
  });
  return items;
}

const completeExtraction = (document: ParsedMaterialDocument) => {
  const c = document.coverage;
  return !c.issues.length && c.retainedTextChars >= c.sourceTextChars && c.retainedTables >= c.sourceTables
    && c.retainedImages >= c.sourceImages && c.retainedPages >= c.pages;
};
/** Reuse successful receipts; an explicit recovery gets one immutable attempt per failed source. */
async function extractionReceipt(
  env: AnalysisEnv,
  filing: MaterialFiling,
  source: MaterialSource,
  recoveryRequestId?: string,
  knownKeys?: Set<string>,
  reconciliations?: Map<string, string>,
): Promise<{ key: string; document: ParsedMaterialDocument | null; successPointer: string }> {
  const originalKey = parsedKey(filing, source), successPointer = `${originalKey}.recovered`;
  const recKey = materialReconciliationKey(filing.ticker, filing.accession, source.id, source.sha256);
  const approvedPayload = reconciliations
    ? reconciliations.get(recKey) ?? null
    : (await env.DB!.prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(recKey).first<{ payload: string }>())?.payload ?? null;
  if (approvedPayload) {
    const pointer = JSON.parse(approvedPayload), object = await env.SEC_FILINGS.get(pointer.parsedKey);
    if (!object) throw new Error("Reconciled source receipt missing");
    const text = await object.text(), document: ParsedMaterialDocument = JSON.parse(text);
    if (await materialDigest(text) !== pointer.parsedHash || document.coverage.documentId !== source.id || document.coverage.filename !== source.filename || document.coverage.reconciliation?.method !== "human-source-reconciliation.v1" || document.coverage.reconciliation?.sourceSha256 !== source.sha256 || document.coverage.reconciliation?.receiptKey !== pointer.receiptKey || !completeExtraction(document)) throw new Error("Reconciled source identity or coverage mismatch");
    return { key: pointer.parsedKey, document, successPointer };
  }
  if (!knownKeys || knownKeys.has(successPointer)) {
    const pointer = await env.SEC_FILINGS.get(successPointer);
    if (pointer) {
      const recoveredKey = await pointer.text();
      const receipt = await env.SEC_FILINGS.get(recoveredKey);
      if (receipt) { const document: ParsedMaterialDocument = JSON.parse(await receipt.text()); if (completeExtraction(document)) return { key: recoveredKey, document, successPointer }; }
    }
  }
  const original = !knownKeys || knownKeys.has(originalKey) ? await env.SEC_FILINGS.get(originalKey) : null;
  const document: ParsedMaterialDocument | null = original ? JSON.parse(await original.text()) : null;
  if (!recoveryRequestId || (document && completeExtraction(document))) return { key: originalKey, document, successPointer };
  const key = `${originalKey}.recovery-${recoveryRequestId}`;
  const recovered = !knownKeys || knownKeys.has(key) ? await env.SEC_FILINGS.get(key) : null;
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

async function listExistingKeys(env: Pick<AnalysisEnv, "SEC_FILINGS">, prefix: string): Promise<Set<string>> {
  const keys = new Set<string>();
  let cursor: string | undefined;
  do {
    const listed = await env.SEC_FILINGS.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const obj of listed.objects) keys.add(obj.key);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return keys;
}

async function prepareOwnedMaterial(env: AnalysisEnv, filing: MaterialFiling, owner: string, options: PrepareMaterialOptions): Promise<MaterialState> {
  const existing = await getFilingMaterial(env, filing.ticker, filing.accession);
  if (existing?.status === "ready") return existing;
  const files: MaterialExtractFile[] = [];
  const fileMap = new Map<string, MaterialExtractFile>();
  const registerFile = (filename: string, type: string, status: MaterialExtractFile["status"], container: string | null = null): MaterialExtractFile => {
    const key = `${container ?? ""}::${filename}`;
    const existingItem = fileMap.get(key);
    if (existingItem) return existingItem;
    const item: MaterialExtractFile = { filename, type, status, ...(container ? { container } : {}) };
    fileMap.set(key, item);
    files.push(item);
    return item;
  };
  const withAssemble = (assembleStatus: MaterialExtractFile["status"]): MaterialExtractFile[] => [
    ...files.map(f => ({ ...f })),
    { filename: ASSEMBLE_STEP_FILENAME, type: "ASSEMBLE", status: assembleStatus },
  ];
  const progress = async (message: string, assembleStatus: MaterialExtractFile["status"] = "pending"): Promise<MaterialState> => {
    const state: MaterialState = {
      status: "preparing",
      filing,
      progress: message,
      ...(files.length ? { files: withAssemble(assembleStatus) } : {}),
      updatedAt: new Date().toISOString(),
    };
    if (!await ownsMaterialLease(env, filing, owner)) return await getFilingMaterial(env, filing.ticker, filing.accession) ?? state;
    await writeMaterialState(env, state); return state;
  };
  try {
    const manifest = await loadMaterialManifest(env, filing, { fetcher: options.fetcher });
    const [receipts, cachedSources, reconciliations] = await Promise.all([
      listExtractedReceipts(env, filing),
      loadCachedSources(env, filing),
      loadReconciliations(env, filing),
    ]);
    const cachedSourceById = new Map(cachedSources.map(s => [s.id, s]));
    const cachedZipChildren = new Map<string, MaterialSource[]>();
    for (const src of cachedSources) {
      if (!src.container) continue;
      let list = cachedZipChildren.get(src.container);
      if (!list) { list = []; cachedZipChildren.set(src.container, list); }
      list.push(src);
    }
    for (const entry of manifest.entries) {
      const id = `d${(await materialDigest(entry.url)).slice(0, 24)}`;
      registerFile(entry.filename, entry.type, hasCompletedReceiptKey(receipts.get(id)) ? "done" : "pending", entry.container);
    }
    await progress("已获取 SEC 文件清单，开始提取", "pending");

    const headerBytes = await readSubmissionHeaderBytes(env, manifest.submission, manifest.headerEnd);
    let cachedSubmissionBytes: Uint8Array | null = null;
    const getSubmissionBytes = async (): Promise<Uint8Array> => {
      if (!cachedSubmissionBytes) cachedSubmissionBytes = await readSourceBytes(env, manifest.submission);
      return cachedSubmissionBytes;
    };

    const sources: MaterialSource[] = [manifest.submission], parsed: ParsedMaterialDocument[] = [submissionHeader(manifest.submission, headerBytes, headerBytes.byteLength)];
    let processed = 0;
    const budget = options.maxDocuments ?? 8;
    for (let index = 0; index < manifest.entries.length; index++) {
      const entry = manifest.entries[index]!;
      const item = registerFile(entry.filename, entry.type, "pending", entry.container);
      const entryId = `d${(await materialDigest(entry.url)).slice(0, 24)}`;
      const source = await archiveMaterialEntry(env, manifest, entry, getSubmissionBytes, {
        fetcher: options.fetcher,
        cachedSource: cachedSourceById.get(entryId),
      });
      const recoveryForSource = options.recoverySources?.[source.filename] ?? options.recoveryRequestId;
      const alreadyParsed = (await extractionReceipt(env, filing, source, recoveryForSource, receipts.get(source.id), reconciliations)).document;
      let document: ParsedMaterialDocument;
      let rawBytes: Uint8Array | null = null;
      if (alreadyParsed) {
        item.status = completeExtraction(alreadyParsed) ? "done" : "failed";
        document = alreadyParsed;
      } else {
        if (processed >= budget) return progress(`extracting source ${index + 1} of ${manifest.entries.length}`, "pending");
        item.status = "extracting";
        await progress(`extracting ${entry.filename} (${index + 1}/${manifest.entries.length})`, "pending");
        rawBytes = await readSourceBytes(env, source);
        document = await extractOnce(env, filing, source, rawBytes, recoveryForSource, options.recoverySources?.[source.filename] ? options.recoveryRequestId : undefined);
        processed++;
        item.status = completeExtraction(document) ? "done" : "failed";
        await progress(`extracted ${entry.filename} (${index + 1}/${manifest.entries.length})`, "pending");
        const added = referencedMaterialEntries(manifest, source, rawBytes);
        if (added.length) {
          manifest.entries.push(...added);
          for (const extra of added) registerFile(extra.filename, extra.type, "pending", extra.container);
          await saveMaterialManifest(env, manifest);
        }
      }
      sources.push(source); parsed.push(document);
      if (source.contentType === "application/zip" || /\.zip$/i.test(source.filename)) {
        const existingChildren = alreadyParsed ? cachedZipChildren.get(source.id) : undefined;
        const children = existingChildren && existingChildren.length > 0
          ? existingChildren
          : await archiveZipEntries(env, filing, source, rawBytes ?? await readSourceBytes(env, source));
        for (const child of children) {
          registerFile(child.filename, child.type, hasCompletedReceiptKey(receipts.get(child.id)) ? "done" : "pending", source.filename);
        }
        for (const child of children) {
          const childItem = registerFile(child.filename, child.type, "pending", source.filename);
          const recoveryForChild = options.recoverySources?.[child.filename] ?? options.recoveryRequestId;
          const cached = (await extractionReceipt(env, filing, child, recoveryForChild, receipts.get(child.id), reconciliations)).document;
          let childDocument: ParsedMaterialDocument;
          if (cached) {
            childItem.status = completeExtraction(cached) ? "done" : "failed";
            childDocument = cached;
          } else {
            if (processed >= budget) return progress(`extracting ZIP entry ${child.filename}`, "pending");
            childItem.status = "extracting";
            await progress(`extracting ZIP entry ${child.filename}`, "pending");
            childDocument = await extractOnce(env, filing, child, await readSourceBytes(env, child), recoveryForChild, options.recoverySources?.[child.filename] ? options.recoveryRequestId : undefined);
            processed++;
            childItem.status = completeExtraction(childDocument) ? "done" : "failed";
            await progress(`extracted ZIP entry ${child.filename}`, "pending");
          }
          sources.push(child); parsed.push(childDocument);
        }
      }
    }
    // Release submission buffer before assembly to keep peak Worker memory low.
    cachedSubmissionBytes = null;
    await progress("所有文件已提取，正在校验与组装 L1 产物...", "extracting");
    const blocks = parsed.flatMap(document => document.blocks), tables = parsed.flatMap(document => document.tables), facts = parsed.flatMap(document => document.facts);
    const docCoverages = parsed.map(document => document.coverage);
    const reconciliationsList = parsed.flatMap(document => document.coverage.reconciliation ? [document.coverage.reconciliation] : []);
    parsed.length = 0;

    const issues = docCoverages.flatMap(c => {
      const out = c.issues.map(issue => `${c.filename}: ${issue}`);
      if (c.retainedTextChars < c.sourceTextChars) out.push(`${c.filename}: uncovered source text`);
      if (c.retainedTables < c.sourceTables) out.push(`${c.filename}: uncovered tables`);
      if (c.retainedImages < c.sourceImages) out.push(`${c.filename}: uncovered images`);
      if (c.retainedPages < c.pages) out.push(`${c.filename}: uncovered pages`);
      return out;
    });
    if (issues.length) { const state: MaterialState = { status: "blocked", filing, issues, ...(files.length ? { files: withAssemble("failed") } : {}) }; await writeMaterialState(env, state); return state; }
    const version = await materialDigest(JSON.stringify({ ...(reconciliationsList.length ? { reconciliations: reconciliationsList } : {}), version: MATERIAL_VERSION, extractor: EXTRACTOR_VERSION, layout: LAYOUT_VERSION,
      inventory: { version: manifest.inventory.inventoryVersion, sha256: manifest.inventory.directory.sha256 }, sources: sources.map(source => [source.id, source.sha256]) }));
    const ref = { ticker: filing.ticker, accession: filing.accession, version }, base = materialBase(ref);
    let checkedCells = 0;
    for (const table of tables) {
      const check = verifyTableCsv(table.table, table.csv);
      checkedCells += check.checkedCells;
      issues.push(...check.issues.map(issue => `${table.tableId}:${issue}`));
      table.csvKey = `${base}/tables/${table.tableId}/${table.filename}`;
      const sha = await materialDigest(table.csv);
      if (table.sha256 && table.sha256 !== sha) throw new Error(`CSV_HASH_MISMATCH:${table.tableId}`);
      table.sha256 = sha;
    }
    if (issues.length) { const state: MaterialState = { status: "blocked", filing, issues, ...(files.length ? { files: withAssemble("failed") } : {}) }; await writeMaterialState(env, state); return state; }
    if (!await ownsMaterialLease(env, filing, owner)) return progress("awaiting active material preparation", "extracting");

    // Upload CSV tables in concurrent batches, chunked across workflow steps to stay well below Worker subrequest limits.
    const existingCsvKeys = await listExistingKeys(env, `${base}/tables/`);
    const pendingTables = tables.filter(table => !existingCsvKeys.has(table.csvKey));
    const stepTables = pendingTables.slice(0, MAX_CSV_PUTS_PER_STEP);
    for (let i = 0; i < stepTables.length; i += CSV_PUT_CONCURRENCY) {
      await Promise.all(stepTables.slice(i, i + CSV_PUT_CONCURRENCY).map(table =>
        env.SEC_FILINGS.put(table.csvKey, table.csv, { httpMetadata: { contentType: "text/csv; charset=utf-8" } }),
      ));
    }
    if (pendingTables.length > MAX_CSV_PUTS_PER_STEP) {
      const uploadedSoFar = tables.length - pendingTables.length + stepTables.length;
      return progress(`正在上传结构化表格 (${uploadedSoFar}/${tables.length})...`, "extracting");
    }

    await progress("正在生成 L1 Markdown 与索引...", "extracting");
    const organized = organizeDeterministic(filing, sources, blocks, tables);
    const coverage: MaterialCoverage = { expectedDocuments: sources.length, archivedDocuments: sources.length, documents: docCoverages,
      sourceBlocks: blocks.length, retainedBlocks: organized.kept.length, duplicates: organized.duplicates, excluded: organized.excluded,
      tableCells: tables.reduce((count, table) => count + table.table.columns.length + 1 + table.table.rows.reduce((n, row) => n + row.cells.length + 1, 0), 0), checkedCells, issues, archiveInventory: manifest.inventory };
    if (!await ownsMaterialLease(env, filing, owner)) return progress("awaiting active material preparation", "extracting");
    const snapshotKey = materialSnapshotKey(ref), markdownKey = `${base}/filing.md`;
    const document = await writeMaterialMarkdown(env, markdownKey, filing, sources, tables, blocks, organized.kept, organized.duplicates, organized.excluded);
    const snapshot: MaterialSnapshot = { format: "filing-material.index.v2", ref, filing, createdAt: new Date().toISOString(), documents: sources, tables, facts, ...document, coverage };
    const catalogSources = new Map(document.blocks.map(block => [block.id, block]));
    const tableCatalog = tables.map(table => tableCatalogEntry(table, catalogSources.get(table.anchor)));
    await Promise.all([
      env.SEC_FILINGS.put(`${base}/coverage.json`, JSON.stringify(coverage), { httpMetadata: { contentType: "application/json" } }),
      env.SEC_FILINGS.put(`${base}/tables.json`, JSON.stringify(tableCatalog), { httpMetadata: { contentType: "application/json" } }),
    ]);
    const written = await env.SEC_FILINGS.put(snapshotKey, JSON.stringify(snapshot), { httpMetadata: { contentType: "application/json" }, onlyIf: { etagDoesNotMatch: "*" } });
    if (written === null) {
      const prior = await env.SEC_FILINGS.get(snapshotKey);
      if (!prior) throw new Error("MATERIAL_INDEX_RECEIPT_MISSING");
      snapshot.createdAt = JSON.parse(await prior.text()).createdAt;
    }
    const state: MaterialState = { status: "ready", ref, filing, snapshotKey, markdownKey, preparedAt: snapshot.createdAt, preparationVersion: MATERIAL_PREPARATION_VERSION };
    if (await publishMaterialState(env, state, owner, options.causeId)) return state;
    return await getFilingMaterial(env, filing.ticker, filing.accession) ?? progress("awaiting active material preparation", "extracting");
  } catch (error) {
    const state: MaterialState = { status: "blocked", filing, issues: [error instanceof Error ? error.message : String(error)], ...(files.length ? { files: withAssemble("failed") } : {}) };
    if (await ownsMaterialLease(env, filing, owner)) { await writeMaterialState(env, state); return state; }
    return await getFilingMaterial(env, filing.ticker, filing.accession) ?? { status: "preparing", filing, progress: "awaiting active material preparation" };
  }
}
