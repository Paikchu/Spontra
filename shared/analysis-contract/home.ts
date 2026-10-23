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

export type HomeCompany = {
  ticker: string;
  name: string;
  /** 【假设】Filled only from the editorial note map until admin stores a Chinese name. */
  nameZh: string | null;
  aliases: string[];
  /** 【假设】Null until admin stores a sector. The page hides the sector filter while every value is null. */
  sector: string | null;
  status: HomeCompanyStatus;
  latestPeriod: { periodEnd: string; fiscalLabel: string; filedAt: string | null } | null;
  revenue: HomeRevenue | null;
  revenueReason: HomeRevenueReason | null;
  /** Up to eight quarters, oldest first. */
  revenueTrend: Array<{ periodEnd: string; value: string }>;
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
