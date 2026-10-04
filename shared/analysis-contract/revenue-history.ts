/** Quarterly revenue by business, as each filing presented it. Unknown periods are absent, never zero. */
export type RevenueHistoryNode = { id: string; name: string; value: string; children?: Array<{ id: string; name: string; value: string }> };
export type RevenueHistoryQuarter = {
  periodStart: string;
  periodEnd: string;
  currency: string;
  scale: number;
  revenue: string;
  /** derived = same-concept full year minus nine-month cumulative (fourth quarter only). */
  basis: "reported" | "derived";
  formula?: string;
  segments: RevenueHistoryNode[];
  source: { accession: string; url: string; filedAt: string; form: string };
};
export type RevenueHistory = { schemaVersion: "revenue-history.v1"; ticker: string; updatedAt: string; quarters: RevenueHistoryQuarter[] };
