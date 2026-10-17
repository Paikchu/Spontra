import { featureDisplayed } from "../admin/feature-settings.ts";
import type { FindingPassage, FindingsPublication, FindingsResponse } from "../../../../shared/analysis-contract/findings.ts";
import { readFindingsPublication } from "../../../../shared/analysis-runtime/findings.ts";
import { mergeDossier, readDossierPublication } from "../../../../shared/analysis-runtime/dossier.ts";
import { libraryPassages, readLibraryDocument } from "../filing-library/store.ts";
import { dossierCacheKey } from "../analyst/workflow.ts";
import { webPassages } from "../analyst/web.ts";
import { readPeersResponse } from "../peers/read.ts";
import { AnalysisRequestError } from "../read-api/contract-support/errors.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { ORCL_FINDINGS } from "./authored/ORCL.ts";

/**
 * The passages a publication quotes or reads cells from, as the library holds them now. A passage that no longer exists
 * (the parser re-split the document) is simply absent, and the page withdraws what rested on it.
 */
export async function findingPassages(db: D1Database, ticker: string, publication: FindingsPublication | null): Promise<FindingPassage[]> {
  const materials = publication?.materials ?? [];
  const web = await webPassages(db, ticker, materials.flatMap(m => m.kind === "web" && m.passageId ? [m.passageId] : []));
  const ids = [...new Set(materials.flatMap(m => m.kind === "sec" && m.passageId ? [m.passageId] : []))];
  if (!ids.length) return web;
  const passages = await libraryPassages(db, ids.slice(0, 60));
  const documents = new Map(await Promise.all([...new Set(passages.map(p => p.documentId))].map(async id => [id, await readLibraryDocument(db, id)] as const)));
  const out: FindingPassage[] = [...web];
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

/** The findings as the writer published them (or the authored set), before the analyst's documents are laid over them. */
export async function readStoredFindings(db: D1Database, rawTicker: string): Promise<FindingsPublication | null> {
  const ticker = rawTicker.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(ticker)) throw new AnalysisRequestError("INVALID_TICKER", "Invalid company ticker.");
  const stored = await new D1SecRepository(db).getCache<unknown>(findingsCacheKey(ticker));
  return (stored ? readFindingsPublication(stored.payload, ticker) : null) ?? authoredFindings(ticker);
}

/** A stored publication wins over an authored one; both are re-validated and never repaired. The analyst's dossier, when written for this very publication, supplies the documents. */
export async function readFindingsResponse(db: D1Database, rawTicker: string, options: { public?: boolean } = {}): Promise<FindingsResponse> {
  const ticker = rawTicker.trim().toUpperCase();
  // The admin's display switch: a hidden publication reads as hidden for readers and stays stored.
  if (options.public && !await featureDisplayed(db, ticker, "findings")) return { schemaVersion: "findings-response.v1", status: "hidden", findings: null };
  const base = await readStoredFindings(db, ticker);
  const dossier = base ? await new D1SecRepository(db).getCache<unknown>(dossierCacheKey(ticker)).then(d => d ? readDossierPublication(d.payload, ticker) : null).catch(() => null) : null;
  const findings = base ? mergeDossier(base, dossier) : null;
  if (!findings) return { schemaVersion: "findings-response.v1", status: "preparing", findings: null };
  // Quoted passages and the peers projection ride with the publication; neither is required for it to serve.
  const [passages, peers] = await Promise.all([findingPassages(db, ticker, findings).catch(() => []), readPeersResponse(db).then(r => r.peers).catch(() => null)]);
  return { schemaVersion: "findings-response.v1", status: "ready", findings, passages, peers };
}
