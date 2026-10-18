import type { FacetMatch, PeerBasis, TagFacet } from "./business-tags.ts";

/**
 * One global projection of comparable figures for every tracked company (docs/analyst-agent-design.md, 前置数据工作 3):
 * deterministic, no model, rebuilt whenever a company's map snapshot or SEC fundamentals change. A peers table on a
 * finding page names a ticker and a figure; the cell resolves from this publication at read time, aligned to the
 * finding's period (the company's latest quarter ending on or before it, within 120 days). A figure the company's
 * data does not hold is absent, never zero.
 */

/** Comparable figures, each the same reading the findings runtime gives the matching reference at span "quarter". */
export const PEER_FIGURES = [
  "revenue", "grossProfit", "operatingIncome", "netIncome",
  "operatingCashFlow", "capex", "freeCashFlow", "debtIssued", "equityIssued", "buybacks", "dividends",
  "totalAssets", "debt", "cash", "equity", "leases", "customerAdvances", "rpo",
  /** Operating non-cash lines whose concept names depreciation or amortization; the SEC D&A series when the statement has none. */
  "depreciation",
  /** The SEC stock-based compensation series, when the company's fundamentals carry it. */
  "stockBasedCompensation",
] as const;
export type PeerFigure = (typeof PEER_FIGURES)[number];

export type PeerQuarter = {
  periodEnd: string;
  /** Filings the quarter's figures were read from. */
  accessions: string[];
  /** Decimal strings in USD base units; a figure the data cannot answer is left out. */
  figures: Partial<Record<PeerFigure, string>>;
};

export type PeerCompany = {
  ticker: string;
  /** `IndustryCategory` keys the company's businesses are linked to (status verified or confirmed), sorted. */
  categories: string[];
  newestQuarter: string | null;
  /** Up to eight quarters, newest first. */
  quarters: PeerQuarter[];
};

/** A comparable unit (docs/peer-similarity-design.md): one disclosed revenue node and its share of the company's revenue. */
export type PeerUnit = {
  ticker: string;
  unitKey: string;
  name: string;
  /** The revenue node; `reported-company-total` for a single-segment company. */
  flowNodeId: string;
  /** Level-one sector tags (`IndustryCategory` keys). */
  sectors: string[];
  periodEnd: string | null;
  /** Decimal string in USD base units; null when the node's revenue is not disclosed. */
  revenue: string | null;
  /** Unit revenue over company revenue at the same quarter; null when either is missing. */
  exposure: number | null;
};

/** Two comparable units and how far they can be compared: the tier from their business tags, the basis from it and their exposures. */
export type PeerPair = {
  left: string;
  right: string;
  tier: "direct" | "partial" | "adjacent";
  /** The sector the tier was found under. */
  sector: string;
  basis: PeerBasis;
  facets: Record<TagFacet, FacetMatch>;
};

export type PeersPublication = {
  schemaVersion: "peers.v1";
  generatedAt: string;
  companies: PeerCompany[];
  /** Absent before the business tags exist; readers then fall back to shared categories. */
  units?: PeerUnit[];
  pairs?: PeerPair[];
};

export type PeersResponse = {
  schemaVersion: "peers-response.v1";
  status: "ready" | "preparing";
  peers: PeersPublication | null;
};
