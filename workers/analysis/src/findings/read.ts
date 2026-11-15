import type { FindingsPublication, FindingsResponse } from "../../../../shared/analysis-contract/findings.ts";
import { findingLeadsOf, readFindingsPublication } from "../../../../shared/analysis-runtime/findings.ts";
import { citedPeers, peersFor } from "../../../../shared/analysis-runtime/peers.ts";
import { publishedDossiers } from "../artifact/store.ts";
import { readPeersResponse } from "../peers/read.ts";
import { AnalysisRequestError } from "../read-api/contract-support/errors.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { TICKER_PATTERN } from "../../../../shared/analysis-runtime/financial-data/policy.ts";

/** v2: English findings. Sets stored under v1 are Chinese and are no longer served; each ticker rewrites under v2. */
export const findingsCacheKey = (ticker: string) => `findings:v2:${ticker}`;

/** The findings as the writer published them, before the analyst's documents are laid over them. */
export async function readStoredFindings(db: D1Database, rawTicker: string): Promise<FindingsPublication | null> {
  const ticker = rawTicker.trim().toUpperCase();
  if (!TICKER_PATTERN.test(ticker)) throw new AnalysisRequestError("INVALID_TICKER", "Invalid company ticker.");
  const stored = await new D1SecRepository(db).getCache<unknown>(findingsCacheKey(ticker));
  return stored ? readFindingsPublication(stored.payload, ticker) : null;
}

/**
 * Leads name the analyses a reader can open. Detector drafts and historical lens documents are never public bodies;
 * the analyst's published HTML is read through the artifact route.
 */
export async function readServedFindings(db: D1Database, rawTicker: string): Promise<FindingsPublication | null> {
  const ticker = rawTicker.trim().toUpperCase();
  const base = await readStoredFindings(db, ticker);
  if (!base) return null;
  const { materials: _materials, record: _record, ...navigation } = base;
  void _materials; void _record;
  return readFindingsPublication({ ...navigation, findings: [], leads: findingLeadsOf(base) }, ticker);
}

/** The stored publication, re-validated and never repaired. */
export async function readFindingsResponse(db: D1Database, rawTicker: string, options: { hidden?: boolean } = {}): Promise<FindingsResponse> {
  const ticker = rawTicker.trim().toUpperCase();
  // Switched off in the admin: readers see it as hidden, and what is stored stays.
  if (options.hidden) return { schemaVersion: "findings-response.v1", status: "hidden", findings: null };
  const findings = await readServedFindings(db, ticker);
  if (!findings) return { schemaVersion: "findings-response.v1", status: "preparing", findings: null };
  // Quoted passages and the peers the publication cites ride with it; neither is required for it to serve. Only the cited
  // peers, so another company's new quarter leaves this answer, and this company's revision, as they were.
  // The findings whose dossier the analyst published as an artifact for this very publication.
  const [peers, published] = await Promise.all([readPeersResponse(db).then(r => peersFor(r.peers, citedPeers(findings))).catch(() => null),
    findings.fingerprint ? publishedDossiers(db, ticker, findings.fingerprint) : Promise.resolve<Record<string, string>>({})]);
  const ids = new Set(findingLeadsOf(findings).map(lead => lead.id));
  const dossiers = Object.fromEntries(Object.entries(published).filter(([id]) => ids.has(id)));
  return { schemaVersion: "findings-response.v1", status: Object.keys(dossiers).length ? "ready" : "preparing", findings, passages: [], peers, dossiers };
}
