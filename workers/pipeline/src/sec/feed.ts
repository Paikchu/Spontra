import { cleanSecTicker, sortSecFilings, type SecFiling, type SecFilingFeed } from "./sec.ts";
import { buildPeriodIdentity } from "./analysis.ts";
import type { SecRepository } from "./types.ts";

type StoredSecFeed = Omit<SecFilingFeed, "filings"> & {
  filings: SecFiling[];
};

/** A cached filing plus the period whose structured report it carries, if it carries one. */
export type CachedSecFiling = SecFiling & { structuredPeriodId: string | null };

export type CachedSecFeed = Omit<SecFilingFeed, "filings"> & {
  filings: CachedSecFiling[];
};

export function secFilingCacheKey(ticker: string): string {
  return `sec:filings:${ticker}`;
}

/**
 * Reads the cache window without touching per-filing storage. Hydration is what costs — one summary
 * read per filing, plus a report read for the periodic ones — so callers that render a single page
 * read the window here and hydrate only the slice they return.
 */
export async function readCachedSecFeed(repository: SecRepository, rawTicker: string): Promise<CachedSecFeed | null> {
  const ticker = cleanSecTicker(rawTicker);
  const cached = await repository.getCache<StoredSecFeed>(secFilingCacheKey(ticker));
  if (!cached) return null;
  // Which filing owns a period's structured report depends on the whole window, not on the page, so
  // it is resolved here while every filing is still in hand.
  const structuredPeriods = new Set<string>();
  const filings = sortSecFilings(cached.payload.filings).map((filing) => {
    const periodId = buildPeriodIdentity(ticker, filing.form, filing.reportDate).periodId;
    const periodic = /^(10-Q|10-K|20-F)(\/A)?$/.test(filing.form);
    const structuredPeriodId = periodic && !structuredPeriods.has(periodId) ? periodId : null;
    if (periodic) structuredPeriods.add(periodId);
    return { ...filing, structuredPeriodId };
  });
  return { ...cached.payload, filings };
}
