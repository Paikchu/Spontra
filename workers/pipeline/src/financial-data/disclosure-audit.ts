import {extractFinancialStatements, STATEMENTS_VERSION, type FinancialStatements} from "../../../../shared/analysis-runtime/financial-data/financial-statements.ts";
import { DISCLOSURE_EXTRACTION_VERSION, extractFilingDisclosures, type FilingDisclosures } from "../../../../shared/analysis-runtime/financial-data/disclosure-extraction.ts";
import type { DisclosureAuditSummary, DisclosureAuditPage } from "../../../../shared/analysis-contract/disclosure-audit.ts";
import type { DocumentSource } from "./parser.ts";
import { D1SecRepository } from "../sec/d1.ts";

type ArchiveBucket = {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
};
export interface DisclosureArchiveEnv { DB: D1Database; SEC_FILINGS: ArchiveBucket }
type StoredAudit = DisclosureAuditSummary & { rawKey: string; inventoryKey: string; statementsKey?: string };
export const disclosureAuditPrefix = (ticker: string) => `sec:disclosure-audit:v1:${ticker}:`;
const digest = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map(n => n.toString(16).padStart(2, "0")).join("");
const summary = ({rawKey: _raw, inventoryKey: _inventory, statementsKey: _statements, ...value}: StoredAudit): DisclosureAuditSummary => value;

/** Source-addressed archives survive reruns; the D1 pointer advances only after all source, inventory and statement objects exist. */
export async function archiveFilingDisclosures(env: DisclosureArchiveEnv, ticker: string, source: DocumentSource, html: string,
  metadata: { form?: string; reportDate?: string } = {}): Promise<DisclosureAuditSummary> {
  if (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(ticker) || !/^\d{10}-\d{2}-\d{6}$/.test(source.accession)) throw new Error("INVALID_DISCLOSURE_SOURCE");
  const url = new URL(source.url);
  if (url.protocol !== "https:" || url.hostname !== "www.sec.gov" || !url.pathname.startsWith("/Archives/edgar/data/")) throw new Error("INVALID_DISCLOSURE_SOURCE");
  const sourceBytes = new TextEncoder().encode(html).byteLength;
  if (!sourceBytes || sourceBytes > 12_000_000) throw new Error("DISCLOSURE_DOCUMENT_TOO_LARGE");
  const [contentSha256, documentId] = await Promise.all([digest(html), digest(source.url)]);
  const repository = new D1SecRepository(env.DB);
  const cacheKey = disclosureAuditPrefix(ticker) + documentId;
  const existing = await repository.getCache<StoredAudit>(cacheKey);
  if (existing?.payload.contentSha256 === contentSha256 && existing.payload.parserVersion === DISCLOSURE_EXTRACTION_VERSION && existing.payload.statements?.version === STATEMENTS_VERSION) return summary(existing.payload);
  const inventory = extractFilingDisclosures(html, { ticker, accessionNumber: source.accession, documentUrl: source.url,
    form: metadata.form ?? "SEC", reportDate: metadata.reportDate ?? "", filedAt: source.filedAt });
  const base = `financial-disclosures/${DISCLOSURE_EXTRACTION_VERSION}/${ticker}/${source.accession}/${documentId}/${contentSha256}`;
  const rawKey = base + "/source.html", inventoryKey = base + "/inventory.json";
  await env.SEC_FILINGS.put(rawKey, html, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
  await env.SEC_FILINGS.put(inventoryKey, JSON.stringify(inventory), { httpMetadata: { contentType: "application/json" } });
  const statements = extractFinancialStatements(html, inventory);
  const statementsKey = base + "/" + STATEMENTS_VERSION + ".json";
  await env.SEC_FILINGS.put(statementsKey, JSON.stringify(statements), { httpMetadata: { contentType: "application/json" } });
  const archivedAt = new Date().toISOString();
  const record: StoredAudit = { documentId, ticker, source: inventory.source, contentSha256, parserVersion: inventory.version,
    archivedAt, sourceBytes, factCount: inventory.facts.length,
    periodEnds: [...new Set(inventory.facts.map(f => f.context?.period.end).filter((end): end is string => Boolean(end)))].sort(),
    coverage: { ...inventory.coverage, issues: inventory.coverage.issues.slice(0, 100) },
    issueDetailsTruncated: inventory.coverage.issues.length > 100, rawKey, inventoryKey, statementsKey,
    statements: {version: STATEMENTS_VERSION, status: statements.status, tables: statements.coverage.tables, rows: statements.coverage.rows, cells: statements.coverage.cells} };
  await repository.setCache(cacheKey, record, archivedAt);
  return summary(record);
}

export async function listFilingDisclosureAudits(db: D1Database, ticker: string): Promise<DisclosureAuditSummary[]> {
  const rows = await db.prepare("SELECT payload FROM sec_cache WHERE cache_key LIKE ? ORDER BY fetched_at DESC LIMIT 200")
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
