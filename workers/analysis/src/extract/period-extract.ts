import type { ExplainerSource } from "../../../../shared/analysis-contract/business-explainer.ts";
import { STATEMENT_ANALYSIS_VERSION } from "../../../../shared/analysis-contract/statement-analysis.ts";
import { readFindingFundamentals, type FindingData } from "../../../../shared/analysis-runtime/findings.ts";
import { isSecUrl } from "../../../../shared/analysis-runtime/sec-sources.ts";
import { requireDb } from "../core.ts";
import { readMapDerived } from "../financial-data/derived.ts";
import { readCompletePublicationForTicker } from "../financial-data/publication.ts";
import { buildLedger, type Ledger } from "../findings/ledger.ts";
import { parseFundamentalApiQuery } from "../fundamentals/fundamentals-api.ts";
import { getSecFundamentals } from "../fundamentals/sec-fundamentals.ts";
import type { AnalysisEnv } from "../operations.ts";
import { sha256 } from "../sha256.ts";
import { D1SecRepository } from "../sec/d1.ts";

/** Changing what the extract holds or how its ledger is cut writes every company's extract again. */
export const EXTRACT_VERSION = "period-extract.v1";
export const periodExtractKey = (ticker: string) => `period-extract:v1:${ticker}`;

/**
 * Layer 2's per-period extract (docs/spontra-architecture-upgrade.md, U2): the company's eight reported quarters as the
 * layers above read them — the statements, capital and fundamentals, and the ledger every figure a finding
 * may state comes from, with the three-statement checkup's flags. Cut deterministically from layer 1's publication,
 * so no key figure can be left out; the layers above read this and never layer 1.
 */
export type PeriodExtract = { schemaVersion: "period-extract.v1"; ticker: string; periodEnd: string; generatedAt: string; data: FindingData; ledger: Ledger; fingerprint: string };

/** The extract as it would be cut now; null until the company has a complete publication and its derived snapshot. */
export async function buildPeriodExtract(env: AnalysisEnv, ticker: string, now = new Date()): Promise<PeriodExtract | null> {
  const db = requireDb(env);
  const publication = await readCompletePublicationForTicker(db, ticker);
  const flow = publication.status === "ready" ? publication.flow : null;
  const newest = [...flow?.quarters ?? []].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
  if (!flow || !newest) return null;
  const snapshot = await readMapDerived(db, flow);
  if (!snapshot) return null;
  const quarters = [...new Map([...(snapshot.reports?.quarters ?? []), ...flow.quarters].map(q => [q.periodEnd, q])).values()];
  const capital = snapshot.capital;
  const fundamentals = await getSecFundamentals(db, parseFundamentalApiQuery(ticker, new URLSearchParams({ periodCount: "12" }))).then(r => readFindingFundamentals(r, ticker)).catch(() => null);
  const data: FindingData = { quarters, history: publication.history ?? null, capital, fundamentals };
  const sources = new Map<string, ExplainerSource>();
  for (const q of quarters) for (const s of q.sources) if (isSecUrl(s.url) && !sources.has(s.id)) sources.set(s.id, { id: s.id, title: s.title, url: s.url, kind: "sec", publishedAt: s.publishedAt ?? null });
  const ledger = buildLedger(data, newest.periodEnd, [...sources.values()].slice(0, 40));
  // By what it says: the periods covered, and the newest backlog, not when anything was rebuilt.
  const fingerprint = await sha256(JSON.stringify({ version: EXTRACT_VERSION, checkup: STATEMENT_ANALYSIS_VERSION, ticker, periodEnd: newest.periodEnd,
    quarters: quarters.map(q => q.periodEnd).sort(), capital: capital?.quarters.map(q => q.periodEnd).sort() ?? [], rpo: capital?.quarters.find(q => q.periodEnd === newest.periodEnd)?.rpo?.total ?? null,
    fundamentals: fundamentals ? await sha256(JSON.stringify(fundamentals)) : null }));
  return { schemaVersion: EXTRACT_VERSION, ticker, periodEnd: newest.periodEnd, generatedAt: now.toISOString(), data, ledger, fingerprint };
}

/** The stored extract; null when layer 2 has not cut one yet. */
export async function readPeriodExtract(db: D1Database, ticker: string): Promise<PeriodExtract | null> {
  const stored = (await new D1SecRepository(db).getCache<PeriodExtract>(periodExtractKey(ticker)).catch(() => null))?.payload;
  return stored?.schemaVersion === EXTRACT_VERSION && stored.ticker === ticker ? stored : null;
}
