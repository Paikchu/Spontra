/** Quarterly revenue by business, as each filing presented it. Unknown periods are absent, never zero. */
export type RevenueHistoryLineage = { accession: string; url: string; concept: string; contextId: string; periodStart: string; periodEnd: string; parserVersion: string; dimensions: Record<string, string> };
export type RevenueHistoryLeaf = { id: string; name: string; value: string; lineage?: RevenueHistoryLineage[] };
export type RevenueHistoryNode = RevenueHistoryLeaf & { children?: RevenueHistoryLeaf[] };
export type RevenueHistoryQuarter = {
  periodStart: string;
  periodEnd: string;
  currency: string;
  scale: number;
  revenue: string;
  /** derived = same-concept full year minus nine-month cumulative (fourth quarter only). */
  basis: "reported" | "derived";
  formula?: string;
  /** Original filing presentation; never implies verification against other filings. */
  presentation?: string;
  lineage?: RevenueHistoryLineage[];
  segments: RevenueHistoryNode[];
  revenueAdjustments?: RevenueHistoryLeaf[];
  source: { accession: string; url: string; filedAt: string; form: string };
};
export type RevenueHistory = { schemaVersion: "revenue-history.v1"; ticker: string; updatedAt: string; quarters: RevenueHistoryQuarter[] };
