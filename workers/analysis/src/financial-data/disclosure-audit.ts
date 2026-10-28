import { SEC_DOCUMENT_MAX_BYTES } from "../../../../shared/analysis-runtime/financial-data/limits.ts";
import {extractFinancialStatements, STATEMENTS_VERSION, type FinancialStatements} from "../../../../shared/analysis-runtime/financial-data/financial-statements.ts";
import { DISCLOSURE_EXTRACTION_VERSION, extractFilingDisclosures, type FilingDisclosures } from "../../../../shared/analysis-runtime/financial-data/disclosure-extraction.ts";
import type { DisclosureAuditSummary, DisclosureAuditPage } from "../../../../shared/analysis-contract/disclosure-audit.ts";
import type { CapitalFiling } from "../../../../shared/analysis-contract/capital-structure.ts";
import { CAPITAL_VERSION, extractCapitalFiling } from "../../../../shared/analysis-runtime/financial-data/capital-structure.ts";
import type { DocumentSource } from "./parser.ts";
import { canonicalSecHtml } from "./provider.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { outboxStatement } from "../pipeline/outbox.ts";
import { TICKER_PATTERN } from "../../../../shared/analysis-runtime/financial-data/policy.ts";

type ArchiveBucket = {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
};
export interface DisclosureArchiveEnv { DB: D1Database; SEC_FILINGS: ArchiveBucket }
type PruneBucket = ArchiveBucket & {
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{ objects: Array<{ key: string; uploaded: Date }>; truncated: boolean; cursor?: string }>;
  delete(keys: string[]): Promise<unknown>;
};
/** `capital` is the reconciled balance sheet and cash flow projection of the archived statements. */
export type StoredAudit = DisclosureAuditSummary & { rawKey: string; inventoryKey: string; statementsKey?: string; capital?: CapitalFiling };
export const disclosureAuditPrefix = (ticker: string) => `sec:disclosure-audit:v1:${ticker}:`;
export const ARCHIVE_PREFIX = "financial-disclosures/";
const digest = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map(n => n.toString(16).padStart(2, "0")).join("");
const summary = ({rawKey: _raw, inventoryKey: _inventory, statementsKey: _statements, capital: _capital, ...value}: StoredAudit): DisclosureAuditSummary => value;

/** Source-addressed archives survive reruns; the D1 pointer advances only after all source, inventory and statement objects exist. */
export async function archiveFilingDisclosures(env: DisclosureArchiveEnv, ticker: string, source: DocumentSource, served: string,
  metadata: { form?: string; reportDate?: string } = {}, causeId: string | null = null): Promise<DisclosureAuditSummary> {
  if (!TICKER_PATTERN.test(ticker) || !/^\d{10}-\d{2}-\d{6}$/.test(source.accession)) throw new Error("INVALID_DISCLOSURE_SOURCE");
  // Hash and store what was filed, not what sec.gov wrapped around it, so the same document keeps one address.
  const html = canonicalSecHtml(served);
  const url = new URL(source.url);
  if (url.protocol !== "https:" || url.hostname !== "www.sec.gov" || !url.pathname.startsWith("/Archives/edgar/data/")) throw new Error("INVALID_DISCLOSURE_SOURCE");
  const sourceBytes = new TextEncoder().encode(html).byteLength;
  if (!sourceBytes || sourceBytes > SEC_DOCUMENT_MAX_BYTES) throw new Error("DISCLOSURE_DOCUMENT_TOO_LARGE");
  const [contentSha256, documentId] = await Promise.all([digest(html), digest(source.url)]);
  const repository = new D1SecRepository(env.DB);
  const cacheKey = disclosureAuditPrefix(ticker) + documentId;
  const existing = await repository.getCache<StoredAudit>(cacheKey);
  if (existing?.payload.contentSha256 === contentSha256 && existing.payload.parserVersion === DISCLOSURE_EXTRACTION_VERSION && existing.payload.statements?.version === STATEMENTS_VERSION
    && existing.payload.capital?.version === CAPITAL_VERSION) return summary(existing.payload);
  const inventory = extractFilingDisclosures(html, { ticker, accessionNumber: source.accession, documentUrl: source.url,
    form: metadata.form ?? "SEC", reportDate: metadata.reportDate ?? "", filedAt: source.filedAt });
  const base = `financial-disclosures/${DISCLOSURE_EXTRACTION_VERSION}/${ticker}/${source.accession}/${documentId}/${contentSha256}`;
  const rawKey = base + "/source.html", inventoryKey = base + "/inventory.json";
  await env.SEC_FILINGS.put(rawKey, html, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
  await env.SEC_FILINGS.put(inventoryKey, JSON.stringify(inventory), { httpMetadata: { contentType: "application/json" } });
  const statements = extractFinancialStatements(html, inventory);
  const statementsKey = base + "/" + STATEMENTS_VERSION + ".json";
  await env.SEC_FILINGS.put(statementsKey, JSON.stringify(statements), { httpMetadata: { contentType: "application/json" } });
  const capital = extractCapitalFiling(statements, { accession: source.accession, url: source.url, filedAt: source.filedAt, form: inventory.source.form }, inventory);
  const archivedAt = new Date().toISOString();
  const record: StoredAudit = { documentId, ticker, source: inventory.source, contentSha256, parserVersion: inventory.version,
    archivedAt, sourceBytes, factCount: inventory.facts.length,
    periodEnds: [...new Set(inventory.facts.map(f => f.context?.period.end).filter((end): end is string => Boolean(end)))].sort(),
    coverage: { ...inventory.coverage, issues: inventory.coverage.issues.slice(0, 100) },
    issueDetailsTruncated: inventory.coverage.issues.length > 100, rawKey, inventoryKey, statementsKey, capital,
    statements: {version: STATEMENTS_VERSION, status: statements.status, tables: statements.coverage.tables, rows: statements.coverage.rows, cells: statements.coverage.cells} };
  // The pointer, its events and the copies it replaces commit together: a new or changed filing can change the
  // company's older quarters and capital on the map, and a replaced copy is deleted a day later if nothing uses it.
  const superseded = existing ? [existing.payload.rawKey, existing.payload.inventoryKey, existing.payload.statementsKey]
    .filter((key): key is string => !!key?.startsWith(ARCHIVE_PREFIX) && ![rawKey, inventoryKey, statementsKey].includes(key)) : [];
  const detail = { form: inventory.source.form, accession: source.accession };
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at")
      .bind(cacheKey, JSON.stringify(record), archivedAt),
    outboxStatement(env.DB, { type: "filing.archived", ticker, cik: source.cik || null, detail, causeId }, archivedAt),
    ...superseded.map(key => env.DB.prepare("INSERT INTO pipeline_superseded (key, ticker, superseded_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING").bind(key, ticker, archivedAt)),
    ...(superseded.length ? [outboxStatement(env.DB, { type: "archive.superseded", ticker, cik: source.cik || null, detail, causeId }, archivedAt)] : []),
  ]);
  return summary(record);
}

/**
 * Re-archives a few filings whose stored projection predates the current capital version, from the source
 * already in the archive: no SEC fetch. Newest first, so the quarters findings rest on are refreshed before
 * older history; the read API projects whatever is still stale on demand until this catches up.
 */
export async function refreshStaleProjections(env: DisclosureArchiveEnv, limit = 3, causeId: string | null = null): Promise<Array<{ ticker: string; accession: string }>> {
  // Stale is decided in SQL, so a refreshed filing leaves the result and no row cap can hide one still waiting.
  const rows = await env.DB.prepare(`SELECT json_remove(payload, '$.coverage') AS payload FROM sec_cache
    WHERE cache_key LIKE 'sec:disclosure-audit:v1:%' AND ifnull(json_extract(payload, '$.capital.version'), '') <> ?
      AND json_extract(payload, '$.rawKey') LIKE 'financial-disclosures/%'
    ORDER BY json_extract(payload, '$.source.filedAt') DESC`).bind(CAPITAL_VERSION).all<{ payload: string }>();
  const stale: StoredAudit[] = [];
  for (const row of rows.results) {
    try {
      const record = JSON.parse(row.payload) as StoredAudit;
      const periodic = /^(?:10-[QK]|20-F|40-F|6-K)(?:\/A)?$/.test(record.source.form);
      if (periodic && record.capital?.version !== CAPITAL_VERSION && record.rawKey?.startsWith("financial-disclosures/")) stale.push(record);
    } catch { /* A malformed record is not this step's to repair. */ }
  }
  stale.sort((a, b) => b.source.filedAt.localeCompare(a.source.filedAt));
  const done: Array<{ ticker: string; accession: string }> = [];
  for (const record of stale.slice(0, limit)) {
    const raw = await env.SEC_FILINGS.get(record.rawKey);
    if (!raw) continue;
    const s = record.source, cik = s.documentUrl.match(/\/Archives\/edgar\/data\/(\d+)\//)?.[1]?.padStart(10, "0") ?? "";
    await archiveFilingDisclosures(env, record.ticker, { url: s.documentUrl, accession: s.accessionNumber, cik, filedAt: s.filedAt, industry: "standard" }, await raw.text(), { form: s.form, reportDate: s.reportDate }, causeId);
    done.push({ ticker: record.ticker, accession: s.accessionNumber });
  }
  return done;
}

const pruneStateKey = "sec:archive-prune:v1";
/** Objects younger than this may belong to an archive write whose D1 pointer is not committed yet. */
export const PRUNE_GRACE_MS = 24 * 60 * 60_000;
type PruneState = { cursor: string | null; startedAt: string | null; finishedAt: string | null; deleted: number };
/** `{ticker}/{accession}/{documentId}` of an archive key, whatever extraction version wrote it. */
const archivedDocument = (key: string) => { const parts = key.split("/"); return parts.length === 7 && `${parts[0]}/` === ARCHIVE_PREFIX ? parts.slice(2, 5).join("/") : null; };

/** The archived copy of a document this company already stored, or null when it must still be downloaded. */
export async function readArchivedDocument(env: DisclosureArchiveEnv, ticker: string, url: string): Promise<string | null> {
  const stored = await new D1SecRepository(env.DB).getCache<StoredAudit>(disclosureAuditPrefix(ticker) + await digest(url));
  const record = stored?.payload;
  if (!record || record.ticker !== ticker || record.source?.documentUrl !== url || !record.rawKey?.startsWith(ARCHIVE_PREFIX)) return null;
  const object = await env.SEC_FILINGS.get(record.rawKey);
  return object ? canonicalSecHtml(await object.text()) : null;
}

/**
 * Deletes archive objects no D1 row points at: copies a document left behind when it was stored again under a new
 * content hash or extraction version. A key is kept when a disclosure pointer or a transcript references it, when its
 * document has no current pointer at all, or while it is younger than the grace period. Copies replaced since
 * `pipeline_superseded` existed are deleted one by one by the `archive-prune` task; this full pass is for what was
 * left before, run by `archive-prune-scan` on request: one bounded step per call, resumed from a cursor.
 */
export async function pruneSupersededArchives(env: { DB: D1Database; SEC_FILINGS: PruneBucket }, now = new Date(), pages = 4): Promise<{ scanned: number; deleted: number; finished: boolean }> {
  const repository = new D1SecRepository(env.DB);
  const state: PruneState = (await repository.getCache<PruneState>(pruneStateKey))?.payload ?? { cursor: null, startedAt: null, finishedAt: null, deleted: 0 };
  if (!state.cursor) Object.assign(state, { startedAt: now.toISOString(), finishedAt: null, deleted: 0 });
  const pointers = await env.DB.prepare("SELECT json_extract(payload,'$.rawKey') raw, json_extract(payload,'$.inventoryKey') inventory, json_extract(payload,'$.statementsKey') statements FROM sec_cache WHERE cache_key LIKE 'sec:disclosure-audit:v1:%'")
    .bind().all<{ raw: string | null; inventory: string | null; statements: string | null }>();
  const transcripts = await env.DB.prepare("SELECT raw_key FROM company_transcripts WHERE raw_key IS NOT NULL").bind().all<{ raw_key: string }>();
  const kept = new Set<string>(), current = new Set<string>();
  for (const row of pointers.results) for (const key of [row.raw, row.inventory, row.statements]) {
    if (!key) continue;
    kept.add(key);
    const document = archivedDocument(key);
    if (document) current.add(document);
  }
  for (const row of transcripts.results) kept.add(row.raw_key);
  let scanned = 0, deleted = 0, cursor = state.cursor ?? undefined, finished = false;
  for (let page = 0; page < pages; page++) {
    const listing = await env.SEC_FILINGS.list({ prefix: ARCHIVE_PREFIX, cursor, limit: 1000 });
    scanned += listing.objects.length;
    const doomed = listing.objects.filter(object => {
      const document = archivedDocument(object.key);
      return !kept.has(object.key) && document !== null && current.has(document) && now.getTime() - object.uploaded.getTime() >= PRUNE_GRACE_MS;
    }).map(object => object.key);
    if (doomed.length) await env.SEC_FILINGS.delete(doomed);
    deleted += doomed.length;
    cursor = listing.truncated ? listing.cursor : undefined;
    if (!cursor) { finished = true; break; }
  }
  await repository.setCache(pruneStateKey, { ...state, cursor: cursor ?? null, finishedAt: finished ? now.toISOString() : null, deleted: state.deleted + deleted } satisfies PruneState, now.toISOString());
  return { scanned, deleted, finished };
}

/**
 * Every archived document of one company filed on or after `since`, newest filing first; malformed rows are skipped.
 * The window is set by filing date and has no row cap: archive time says nothing about recency (a history backfill
 * archives years-old filings after the newest ones), and a fixed count is exhausted by a foreign issuer's notices.
 * The coverage inventory is left out, since no reader of the map needs it.
 */
export async function readStoredAudits(db: D1Database, ticker: string, since: string): Promise<StoredAudit[]> {
  const rows = await db.prepare(`SELECT json_remove(payload, '$.coverage') AS payload FROM sec_cache
    WHERE cache_key LIKE ? AND json_extract(payload, '$.source.filedAt') >= ? ORDER BY json_extract(payload, '$.source.filedAt') DESC, fetched_at DESC`)
    .bind(disclosureAuditPrefix(ticker) + "%", since).all<{ payload: string }>();
  const audits: StoredAudit[] = [];
  for (const row of rows.results) { try { const r = JSON.parse(row.payload) as StoredAudit; if (r.ticker === ticker && r.source?.ticker === ticker) audits.push(r); } catch { /* skipped */ } }
  return audits;
}

/** The company's 200 newest archived documents by filing date, for the admin and the maintenance audit. */
export async function listFilingDisclosureAudits(db: D1Database, ticker: string): Promise<DisclosureAuditSummary[]> {
  const rows = await db.prepare("SELECT payload FROM sec_cache WHERE cache_key LIKE ? ORDER BY json_extract(payload, '$.source.filedAt') DESC, fetched_at DESC LIMIT 200")
    .bind(disclosureAuditPrefix(ticker) + "%").all<{payload: string}>();
  return rows.results.map(row => JSON.parse(row.payload) as StoredAudit).filter(row => row.ticker === ticker).map(summary);
}

export async function getFilingDisclosureAuditPage(env: DisclosureArchiveEnv, ticker: string, documentId: string,
  query: { offset?: number; limit?: number; concept?: string; periodEnd?: string } = {}): Promise<DisclosureAuditPage | null> {
  if (!/^[a-f0-9]{64}$/.test(documentId)) return null;
  const offset = query.offset ?? 0, limit = query.limit ?? 100;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200
    || (query.concept?.length ?? 0) > 200 || (query.periodEnd && !/^\d{4}-\d{2}-\d{2}$/.test(query.periodEnd))) throw new Error("INVALID_AUDIT_QUERY");
  const stored = await new D1SecRepository(env.DB).getCache<StoredAudit>(disclosureAuditPrefix(ticker) + documentId);
  if (!stored || stored.payload.ticker !== ticker) return null;
  const object = await env.SEC_FILINGS.get(stored.payload.inventoryKey);
  if (!object) throw new Error("DISCLOSURE_ARCHIVE_UNAVAILABLE");
  const inventory = JSON.parse(await object.text()) as FilingDisclosures;
  if (inventory.source.ticker !== ticker || inventory.source.documentUrl !== stored.payload.source.documentUrl) throw new Error("DISCLOSURE_ARCHIVE_IDENTITY_MISMATCH");
  const concept = query.concept?.toLowerCase();
  const facts = inventory.facts.filter(f => (!concept || f.concept.name.toLowerCase().includes(concept)) && (!query.periodEnd || f.context?.period.end === query.periodEnd));
  return { document: summary(stored.payload), facts: facts.slice(offset, offset + limit), total: facts.length, offset, limit,
    nextOffset: offset + limit < facts.length ? offset + limit : null };
}

/** Read-only fallback makes already archived financial statements immediately inspectable.
 * The next collection persists the same deterministic output; GET never mutates archives.
 */
export async function getFinancialStatements(env: DisclosureArchiveEnv,ticker:string,documentId:string):Promise<FinancialStatements|null>{
 if(!/^[a-f0-9]{64}$/.test(documentId))return null;
 const stored=await new D1SecRepository(env.DB).getCache<StoredAudit>(disclosureAuditPrefix(ticker)+documentId);
 if(!stored||stored.payload.ticker!==ticker)return null;
 const r=stored.payload;
 if(r.statementsKey&&r.statements?.version===STATEMENTS_VERSION){const object=await env.SEC_FILINGS.get(r.statementsKey);if(!object)throw new Error('DISCLOSURE_ARCHIVE_UNAVAILABLE');const result=JSON.parse(await object.text()) as FinancialStatements;if(result.source.ticker!==ticker||result.source.documentUrl!==r.source.documentUrl)throw new Error('DISCLOSURE_ARCHIVE_IDENTITY_MISMATCH');return result;}
 const [raw,object]=await Promise.all([env.SEC_FILINGS.get(r.rawKey),env.SEC_FILINGS.get(r.inventoryKey)]);
 if(!raw||!object)throw new Error('DISCLOSURE_ARCHIVE_UNAVAILABLE');
 const inventory=JSON.parse(await object.text()) as FilingDisclosures;
 if(inventory.source.ticker!==ticker||inventory.source.documentUrl!==r.source.documentUrl)throw new Error('DISCLOSURE_ARCHIVE_IDENTITY_MISMATCH');
 return extractFinancialStatements(await raw.text(),inventory);
}
