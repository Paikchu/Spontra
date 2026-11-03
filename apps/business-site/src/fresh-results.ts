import type { HomeCompany } from "../../../shared/analysis-contract/home.ts";

/**
 * The homepage's row of fresh results (R29): companies whose latest quarterly report was filed in the last seven days,
 * newest first, each with its revenue and year-over-year growth and the move of its operating margin against the
 * year-ago quarter, in percentage points. A company with no filing date, or one older than the window, is left out;
 * with none left the row is not drawn.
 */

export const FRESH_DAYS = 7;

export type FreshResult = {
  company: HomeCompany;
  filedAt: string;
  periodEnd: string;
  /** The company page at the quarter this report covers. */
  href: string;
  marginPct: number | null;
  /** Percentage points against the year-ago quarter; null when either margin is unknown. */
  marginChangePp: number | null;
};

const DAY = 86_400_000;

export function freshResults(companies: readonly HomeCompany[], now: Date, days = FRESH_DAYS): FreshResult[] {
  // Filing dates are calendar days; a report filed on any of the last `days` days, today included, is fresh.
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return companies.flatMap(company => {
    const period = company.latestPeriod, filed = period?.filedAt ? Date.parse(period.filedAt) : NaN;
    if (!period || !Number.isFinite(filed) || filed > today || today - filed >= days * DAY) return [];
    const margin = company.operatingMargin ?? null;
    return [{
      company, filedAt: period.filedAt!, periodEnd: period.periodEnd,
      href: `/companies/${encodeURIComponent(company.ticker)}?period=${period.periodEnd}`,
      marginPct: margin?.pct ?? null,
      marginChangePp: margin && margin.yearAgoPct != null ? Math.round((margin.pct - margin.yearAgoPct) * 10) / 10 : null,
    }];
  }).sort((a, b) => b.filedAt.localeCompare(a.filedAt) || a.company.ticker.localeCompare(b.company.ticker));
}
