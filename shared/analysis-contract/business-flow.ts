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
};
export type BusinessFlowQuarter = {
  id: string;
  /** Provider-declared income statement model; never inferred from ticker. */
  incomeModel?: "standard" | "financial" | "insurance" | "unknown";
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
  sources: FlowSource[];
};
/** Optional published company-analysis resource; no personal portfolio information. */
export type PublicBusinessFlow = {
  schemaVersion: "business-flow.v1";
  ticker: string;
  fetchedAt: string | null;
  quarters: BusinessFlowQuarter[];
};
