import type { FindingPassage, FindingsPublication, FindingsResponse } from "../../../../shared/analysis-contract/findings.ts";
import { readFindingsPublication } from "../../../../shared/analysis-runtime/findings.ts";
import { libraryPassages, readLibraryDocument } from "../filing-library/store.ts";
import { readPeersResponse } from "../peers/read.ts";
import { AnalysisRequestError } from "../read-api/contract-support/errors.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { ORCL_FINDINGS } from "./authored/ORCL.ts";

/**
 * The passages a publication quotes or reads cells from, as the library holds them now. A passage that no longer exists
 * (the parser re-split the document) is simply absent, and the page withdraws what rested on it.
 */
export async function findingPassages(db: D1Database, ticker: string, publication: FindingsPublication | null): Promise<FindingPassage[]> {
  const ids = [...new Set((publication?.materials ?? []).flatMap(m => m.passageId ? [m.passageId] : []))];
  if (!ids.length) return [];
  const passages = await libraryPassages(db, ids.slice(0, 60));
  const documents = new Map(await Promise.all([...new Set(passages.map(p => p.documentId))].map(async id => [id, await readLibraryDocument(db, id)] as const)));
  const out: FindingPassage[] = [];
  for (const p of passages) {
    const d = documents.get(p.documentId);
    if (!d || d.ticker !== ticker || d.status !== "ready") continue;
    const material = publication?.materials?.find(m => m.passageId === p.passageId);
    out.push({ passageId: p.passageId, documentId: p.documentId, title: material?.title ?? `${ticker} ${d.form} ${d.reportDate}`, form: d.form, filedAt: d.filedAt, url: d.documentUrl, path: material?.path ?? [],
      text: p.text, table: p.table ? { unit: p.table.unit, columns: p.table.columns, rows: p.table.rows.map(r => ({ label: r.label, cells: r.cells.map(c => ({ text: c.text, value: c.value })) })) } : null });
  }
  return out;
}

/** v2: English findings. Sets stored under v1 are Chinese and are no longer served; each ticker rewrites under v2. */
export const findingsCacheKey = (ticker: string) => `findings:v2:${ticker}`;

/** Hand-written sets that stand in until the findings workflow publishes for the ticker. */
const AUTHORED: Record<string, unknown> = { ORCL: ORCL_FINDINGS };

/** The hand-written set for a ticker, validated; null where none exists. */
export const authoredFindings = (ticker: string) => readFindingsPublication(AUTHORED[ticker], ticker);

/** A stored publication wins over an authored one; both are re-validated and never repaired. */
export async function readFindingsResponse(db: D1Database, rawTicker: string): Promise<FindingsResponse> {
  const ticker = rawTicker.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(ticker)) throw new AnalysisRequestError("INVALID_TICKER", "Invalid company ticker.");
  const stored = await new D1SecRepository(db).getCache<unknown>(findingsCacheKey(ticker));
  const findings = (stored ? readFindingsPublication(stored.payload, ticker) : null) ?? authoredFindings(ticker);
  if (!findings) return { schemaVersion: "findings-response.v1", status: "preparing", findings: null };
  // Quoted passages and the peers projection ride with the publication; neither is required for it to serve.
  const [passages, peers] = await Promise.all([findingPassages(db, ticker, findings).catch(() => []), readPeersResponse(db).then(r => r.peers).catch(() => null)]);
  return { schemaVersion: "findings-response.v1", status: "ready", findings, passages, peers };
}
