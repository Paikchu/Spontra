import type { FiscalPeriodFields } from "./period.ts";

/**
 * The public homepage digest: one read for every covered company.
 * Amounts are decimal strings in the filing currency (value × scale). Missing figures stay null.
 */

export type HomeDigestStatus = "ready" | "partial" | "unavailable";
export type HomeCompanyStatus = "ready" | "preparing" | "partial";
/** Why a revenue figure or its year-over-year rate is absent. The page maps these; it never shows the code. */
export type HomeRevenueReason = "NOT_DISCLOSED" | "MISSING_TWO_QUARTERS";
export type HomeFindingKind = "risk" | "strength" | "shift" | "watch";

export type HomeFinding = {
  id: string;
  kind: HomeFindingKind;
  severity: 1 | 2 | 3;
  title: string;
  periodEnd: string;
};

export type HomeRevenue = {
  value: string;
  currency: string;
  yoyPct: number | null;
  qoqPct: number | null;
};

export type HomeStatement = { currency: string; revenue: string; cost: string | null; net: string };

export type HomeCompany = {
  ticker: string;
  name: string;
  /** 【假设】Filled only from the editorial note map until admin stores a Chinese name. */
  nameZh: string | null;
  aliases: string[];
  /** 【假设】Null until admin stores a sector. The page hides the sector filter while every value is null. */
  sector: string | null;
  status: HomeCompanyStatus;
  /**
   * `fiscalLabel` and `calendarLabel` are the calendar quarter (2026-07-26 → "2026 Q3"), kept for older clients.
   * The fiscal fields are the issuer's own quarter. `labelSource: "unknown"` means the quarter was not determined.
   */
  latestPeriod: ({
    periodEnd: string;
    periodStart: string | null;
    fiscalLabel: string;
    calendarLabel: string;
    filedAt: string | null;
  } & FiscalPeriodFields) | null;
  revenue: HomeRevenue | null;
  revenueReason: HomeRevenueReason | null;
  /** Up to eight quarters, oldest first. */
  revenueTrend: Array<{ periodEnd: string; value: string }>;
  /**
   * The latest quarter's statement in three figures (revenue, cost of revenue, net income), decimal strings in the
   * filing currency, for the row's small revenue-to-profit flow. Null when the quarter does not carry them.
   */
  statement?: HomeStatement | null;
  findingCounts: { risk: number; strength: number; shift: number; watch: number };
  /** At most two, highest severity first. */
  topFindings: HomeFinding[];
};

export type HomeDigest = {
  schemaVersion: "home-digest.v1";
  status: HomeDigestStatus;
  generatedAt: string;
  coverage: { count: number; lastUpdatedAt: string | null };
  companies: HomeCompany[];
  /** 【假设】Editorial list, then companies that have findings, then the rest. Only covered tickers. */
  popular: string[];
};
