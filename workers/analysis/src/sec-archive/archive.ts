import { archiveFilingDisclosures, disclosureAuditPrefix, readArchivedDocument, ARCHIVE_PREFIX, type StoredAudit } from "../financial-data/disclosure-audit.ts";
import { withFilingStructure } from "../financial-data/presentation.ts";
import type { DocumentSource } from "../financial-data/parser.ts";
import { canonicalSecHtml, exhibitLinks, type SecReader } from "../financial-data/provider.ts";
import { classifyExhibit, exhibitTitle, type FoundMaterial } from "../guidance/sources.ts";
import type { AnalysisEnv } from "../operations.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { htmlToSecText } from "../sec/sec.ts";
import { edgarDocumentReader, type GatewayOptions } from "./gateway.ts";

/** Written by the archive task once a filing's documents are all stored, or when the filing is recorded as one that cannot be. */
export const archiveCompleteKey = (ticker: string, accession: string) => `sec-archive:complete:v1:${ticker}:${accession}`;
export type ArchiveCompletion = { documents: number } | { unsupported: string; attempts: number };

/** Why the archive task gave the filing up (a document over the size cap, reads that kept failing), or null. */
export async function archiveUnsupported(env: Pick<ArchiveEnv, "DB">, ticker: string, accession: string): Promise<string | null> {
  const marker = (await new D1SecRepository(env.DB).getCache<ArchiveCompletion>(archiveCompleteKey(ticker, accession)))?.payload;
  return marker && "unsupported" in marker ? marker.unsupported : null;
}

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
/**
 * A filing as the archive holds it: every document stored for the accession, the body first. `complete` says the body
 * and every exhibit it names are stored; a batch interrupted between them is not, and its readers wait.
 */
type ArchivedFiling = { ticker: string; accession: string; form: string; filedAt: string; reportDate: string; complete: boolean; documents: ArchivedDocument[] };

const MIN_EXHIBIT_TEXT = 400;
const fileOf = (url: string) => decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
const exhibitLike = (file: string) => /ex[-_]?\d|exhibit|\b99\b/i.test(file);
/** A filing body opens with its cover: the form named, then the commission file number or an item. Exhibits do not. */
const coverPage = (html: string) => { const head = html.slice(0, 60_000).replace(/<[^>]+>/g, " ").replace(/\s+/g, " "); return /\bform\s+(?:8-k|6-k|10-q|10-k|20-f|40-f)\b/i.test(head) && /commission file number|\bitem\s*\d\.\d{2}\b|pursuant to (?:section|rule)/i.test(head); };
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

/**
 * True when the archive holds the whole filing: its body and the exhibits the body names (`exhibitLinks`). A body stored
 * before its exhibits (the collector and the archive task commit one document at a time) does not count yet, so the
 * report and guidance that follow `filing.archived` read the filing only once it is all there.
 */
export async function archiveHolds(env: ArchiveEnv, ticker: string, accession: string, primaryUrl?: string): Promise<boolean> {
  return (await archivedFiling(env, ticker, accession, primaryUrl))?.complete ?? false;
}

/**
 * The filing as archived, or null when the archive holds nothing for the accession yet (the collector or the archive
 * task stores it; the caller waits for `filing.archived`). Documents come back as filed, the body first.
 *
 * `primaryUrl` is the filing's own primary document as EDGAR lists it: with it, that document is the body and every
 * other one an exhibit, whatever their file names (an earnings release can be `coreweave4q25earningspress.htm`).
 * Without it, the body is the document that opens with the filing's cover page, else the one not named as an exhibit.
 */
export async function archivedFiling(env: ArchiveEnv, ticker: string, accession: string, primaryUrl?: string): Promise<ArchivedFiling | null> {
  const records = await pointers(env, ticker, accession);
  if (!records.length) return null;
  const read: Array<{ url: string; file: string; form: string; html: string }> = [];
  for (const record of records) {
    const object = await env.SEC_FILINGS.get(record.rawKey);
    if (!object) continue;
    read.push({ url: record.source.documentUrl, file: fileOf(record.source.documentUrl), form: record.source.form, html: canonicalSecHtml(await object.text()) });
  }
  if (!read.length) return null;
  const listed = primaryUrl && read.some(d => d.url === primaryUrl) ? primaryUrl : null;
  const covered = listed ? null : read.find(d => coverPage(d.html))?.url ?? null;
  const body = listed ?? covered ?? read.find(d => !exhibitLike(d.file))?.url ?? read[0]!.url;
  const documents: ArchivedDocument[] = read.map(d => d.url === body
    ? { url: d.url, filename: d.file, role: "primary", type: d.form, html: d.html }
    : { url: d.url, filename: d.file, role: "exhibit", type: exhibitType(d.file), html: d.html });
  documents.sort((a, b) => Number(a.role === "exhibit") - Number(b.role === "exhibit") || a.url.localeCompare(b.url));
  const bodyRecord = records.find(r => r.source.documentUrl === body) ?? records[0]!;
  const held = new Set(documents.map(d => d.url));
  const complete = exhibitLinks(documents[0]!.html, documents[0]!.url).every(url => held.has(url));
  return { ticker, accession, form: bodyRecord.source.form, filedAt: bodyRecord.source.filedAt ?? "", reportDate: bodyRecord.source.reportDate ?? "", complete, documents };
}

/**
 * An earnings filing's Exhibit 99 documents as archived, in the shape guidance reads: text, or why there is none.
 * Null when the archive holds nothing for the accession.
 */
export async function archivedExhibits(env: ArchiveEnv, ticker: string, accession: string, filingDate: string, primaryUrl?: string): Promise<FoundMaterial[] | null> {
  const filing = await archivedFiling(env, ticker, accession, primaryUrl);
  // A body whose exhibits are not all stored yet reads as not archived: the release is in those exhibits.
  if (!filing?.complete) return null;
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
export function archivingReader(env: ArchiveEnv, ticker: string, causeId: string | null = null, options: GatewayOptions & { announce?: boolean } = {}): SecReader {
  const { announce, ...gateway } = options;
  const reader = edgarDocumentReader(env.SEC_USER_AGENT, { delayMs: 1000, ...gateway });
  const archive = { DB: env.DB, SEC_FILINGS: env.SEC_FILINGS };
  reader.archive = (source, html, metadata) => archiveFilingDisclosures(archive, ticker, source, html, metadata, causeId, { announce: announce ?? true }).then(() => undefined);
  reader.archived = url => readArchivedDocument(archive, ticker, url);
  return withFilingStructure(reader, env.DB);
}

/** Stores a filing's documents the reader downloaded, as the collector does for the filings it parses. */
export async function archiveDocuments(reader: SecReader, source: Omit<DocumentSource, "url">, documents: Array<{ url: string; html: string }>, metadata: { form?: string; reportDate?: string }): Promise<void> {
  for (const document of documents) await reader.archive?.({ ...source, url: document.url }, document.html, metadata);
}
