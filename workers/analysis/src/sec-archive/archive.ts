import { archiveFilingDisclosures, disclosureAuditPrefix, readArchivedDocument, ARCHIVE_PREFIX, type StoredAudit } from "../financial-data/disclosure-audit.ts";
import { withFilingStructure } from "../financial-data/presentation.ts";
import type { DocumentSource } from "../financial-data/parser.ts";
import { canonicalSecHtml, type SecReader } from "../financial-data/provider.ts";
import { classifyExhibit, exhibitTitle, type FoundMaterial } from "../guidance/sources.ts";
import type { AnalysisEnv } from "../operations.ts";
import { htmlToSecText } from "../sec/sec.ts";
import { edgarDocumentReader, type GatewayOptions } from "./gateway.ts";

/** What the archive needs: the pointers in D1 and the documents in R2. */
export type ArchiveEnv = { DB: D1Database; SEC_FILINGS: AnalysisEnv["SEC_FILINGS"]; SEC_USER_AGENT: string };

/** One archived document of a filing: the body, or an exhibit the collector followed from it. */
export type ArchivedDocument = {
  url: string;
  filename: string;
  /** The filing's own form for the body, the exhibit's type (`EX-99.1`) as its file name says it, else `EX-99`. */
  type: string;
  role: "primary" | "exhibit";
  html: string;
};
/** A filing as the archive holds it: every document stored for the accession, the body first. */
export type ArchivedFiling = { ticker: string; accession: string; form: string; filedAt: string; reportDate: string; documents: ArchivedDocument[] };

const MIN_EXHIBIT_TEXT = 400;
const fileOf = (url: string) => decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
const exhibitLike = (file: string) => /ex[-_]?\d|exhibit|\b99\b/i.test(file);
/** `EX-99.1` from `orcl-ex99_1.htm`, `ex991.htm`, `exhibit99-1.htm`; `EX-99` when the file names no sub-number. */
export function exhibitType(file: string): string {
  const match = /ex(?:hibit)?[-_]?(\d{1,2})(?:[-_.]?(\d))?(?=\D|$)/i.exec(file);
  if (!match) return "EX-99";
  return match[2] ? `EX-${match[1]}.${match[2]}` : `EX-${match[1]}`;
}

async function pointers(env: ArchiveEnv, ticker: string, accession: string): Promise<StoredAudit[]> {
  const prefix = disclosureAuditPrefix(ticker);
  const { results } = await env.DB.prepare("SELECT payload FROM sec_cache WHERE cache_key >= ? AND cache_key < ? AND json_extract(payload, '$.source.accessionNumber') = ? ORDER BY cache_key")
    .bind(prefix, prefix + "￿", accession).all<{ payload: string }>();
  const out: StoredAudit[] = [];
  for (const row of results) {
    try { const record = JSON.parse(row.payload) as StoredAudit; if (record.ticker === ticker && record.rawKey?.startsWith(ARCHIVE_PREFIX)) out.push(record); } catch { /* a malformed row is not a document */ }
  }
  return out;
}

/** True when the archive holds the filing's body, without reading it. */
export async function archiveHolds(env: ArchiveEnv, ticker: string, accession: string): Promise<boolean> {
  return (await pointers(env, ticker, accession)).length > 0;
}

/**
 * The filing as archived, or null when the archive holds nothing for the accession yet (the collector or the archive
 * task stores it; the caller waits for `filing.archived`). Documents come back as filed, the body first.
 */
export async function archivedFiling(env: ArchiveEnv, ticker: string, accession: string): Promise<ArchivedFiling | null> {
  const records = await pointers(env, ticker, accession);
  if (!records.length) return null;
  const documents: ArchivedDocument[] = [];
  for (const record of records) {
    const object = await env.SEC_FILINGS.get(record.rawKey);
    if (!object) continue;
    const file = fileOf(record.source.documentUrl);
    const exhibit = exhibitLike(file);
    documents.push({ url: record.source.documentUrl, filename: file, role: exhibit ? "exhibit" : "primary", type: exhibit ? exhibitType(file) : record.source.form, html: canonicalSecHtml(await object.text()) });
  }
  if (!documents.length) return null;
  documents.sort((a, b) => Number(a.role === "exhibit") - Number(b.role === "exhibit") || a.url.localeCompare(b.url));
  const body = records.find(r => r.source.documentUrl === documents[0]!.url) ?? records[0]!;
  return { ticker, accession, form: body.source.form, filedAt: body.source.filedAt ?? "", reportDate: body.source.reportDate ?? "", documents };
}

/**
 * An earnings filing's Exhibit 99 documents as archived, in the shape guidance reads: text, or why there is none.
 * Null when the archive holds nothing for the accession.
 */
export async function archivedExhibits(env: ArchiveEnv, ticker: string, accession: string, filingDate: string): Promise<FoundMaterial[] | null> {
  const filing = await archivedFiling(env, ticker, accession);
  if (!filing) return null;
  return filing.documents.filter(d => d.role === "exhibit").slice(0, 4).map((d): FoundMaterial => {
    const base = { sourceKind: "sec" as const, url: d.url, publishedAt: filingDate };
    const text = htmlToSecText(d.html);
    if (text.length < MIN_EXHIBIT_TEXT) return { ...base, kind: "press_release", title: `${d.type} ${d.filename}`, unsupported: "no readable text" };
    return { ...base, kind: classifyExhibit(text), title: exhibitTitle(text, `${d.type} ${d.filename}`), text };
  });
}

export { readArchivedDocument };

/**
 * The only reader that downloads filing documents: paced EDGAR requests whose documents are archived for the company
 * under their content hash, and read back from the archive when already there. Every collector step, maintenance step
 * and archive task reads through one of these, so nothing a task reads is left out of the archive.
 */
export function archivingReader(env: ArchiveEnv, ticker: string, causeId: string | null = null, options: GatewayOptions = {}): SecReader {
  const reader = edgarDocumentReader(env.SEC_USER_AGENT, { delayMs: 1000, ...options });
  const archive = { DB: env.DB, SEC_FILINGS: env.SEC_FILINGS };
  reader.archive = (source, html, metadata) => archiveFilingDisclosures(archive, ticker, source, html, metadata, causeId).then(() => undefined);
  reader.archived = url => readArchivedDocument(archive, ticker, url);
  return withFilingStructure(reader, env.DB);
}

/** Stores a filing's documents the reader downloaded, as the collector does for the filings it parses. */
export async function archiveDocuments(reader: SecReader, source: Omit<DocumentSource, "url">, documents: Array<{ url: string; html: string }>, metadata: { form?: string; reportDate?: string }): Promise<void> {
  for (const document of documents) await reader.archive?.({ ...source, url: document.url }, document.html, metadata);
}
