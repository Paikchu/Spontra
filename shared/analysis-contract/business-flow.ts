export const FLOW_METRICS = ["revenue", "cost", "gross", "research", "sales", "administration", "operatingExpenses", "operating", "other", "pretax", "tax", "net"] as const;
export type FlowMetric = (typeof FLOW_METRICS)[number];
export type FlowSource = { id: string; title: string; url: string; publishedAt?: string | null };
export type FlowAmount = {
  value: string | null;
  basis: "reported" | "derived";
  definition: string;
  /** Same key means the provider has verified the same restatement/definition basis. */
  comparabilityKey: string | null;
  sourceIds: string[];
  formula?: string;
  lineage?: Array<{ accession: string; url: string; concept: string; contextId: string; periodStart: string; periodEnd: string; dimensions: Record<string, string>; parserVersion: string }>;

};
export type BusinessSegment = {
  id: string;
  name: string;
  revenue: FlowAmount | null;
  description: string;
  products: string[];
  customers: string | null;
  monetization: string | null;
  disclosure: string;
  sourceIds: string[];
  children?: Array<{ id: string; name: string; revenue: FlowAmount }>;
};
/** Each dimension is an independent partition of revenue, never a cross-dimension hierarchy. */
export type RevenueBreakdown = {
  id: string;
  label: string;
  kind: "business" | "product_service" | "end_market" | "segment" | "customer" | "geography";
  /** Identifies the disclosure definition/recast version, not the filing date. */
  definitionKey: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  scale: number;
  complete: boolean;
  nodes: RevenueBreakdownNode[];
};
export type RevenueBreakdownNode = BusinessSegment & {
  parentId: string | null;
  /** Only expand when the explicitly disclosed children exhaust this node's revenue. */
  childrenComplete: boolean;
};
export type BusinessFlowQuarter = {
  id: string;
  /** Provider-declared income statement model; never inferred from ticker. */
  incomeModel?: "standard" | "direct_operating" | "financial" | "insurance" | "unknown";
  label: string;
  periodStart: string | null;
  periodEnd: string;
  periodType: "3M";
  currency: string;
  /** All amounts use the same scale (1 = base currency, 1000000 = million). */
  scale: number;
  basisLabel: string;
  reportedAt: string | null;
  figures: Partial<Record<FlowMetric, FlowAmount>>;
  segments: BusinessSegment[];
  segmentsComplete: boolean;
  segmentDisclosure?: "single_reportable_segment";
  /** Signed consolidation adjustments; never allocated to individual businesses. */
  revenueAdjustments?: Array<{ id: string; name: string; amount: FlowAmount }>;
  revenueBreakdowns?: RevenueBreakdown[];
  expenseComponents?: Array<{ id: string; name: string; group: "direct" | "research" | "sales" | "administration" | "other"; amount: FlowAmount }>;
  otherComponents?: Array<{ id: string; name: string; amount: FlowAmount }>;
  /**
   * Signed lines the statement places between income taxes and net income (equity-method results, noncontrolling
   * interests, discontinued operations), read from the filing's own calculation: net = pretax − tax + Σ amounts.
   */
  afterTaxComponents?: Array<{ id: string; name: string; amount: FlowAmount }>;
  /**
   * How the arithmetic from operating income to net income was established: the filing's calculation linkbase, its
   * statement rows, a structure verified on an earlier filing (`profile`), or `degraded` when none balanced and the
   * lines between operating and net income are shown as one derived total.
   */
  presentation?: { source: "calculation" | "statement" | "profile" | "degraded"; structure?: string };
  /**
   * Lines a later filing presents differently for an earlier period (a restatement or reclassification): this quarter
   * and the previous one are not compared on them, and every other line still is.
   */
  basisChanges?: FlowMetric[];

  sources: FlowSource[];
};
/** Optional published company-analysis resource; no personal portfolio information. */
export type PublicBusinessFlow = {
  schemaVersion: "business-flow.v1";
  ticker: string;
  fetchedAt: string | null;
  quarters: BusinessFlowQuarter[];
};
