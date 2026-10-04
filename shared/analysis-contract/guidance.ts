/**
 * Forward-looking guidance management gave in earnings releases, decks and calls. Every item is a
 * model extraction that passed deterministic checks: its quote appears verbatim in the source and
 * every number appears in its quote. Revisions, derived amounts and actuals are computed, not
 * written by a model.
 */
export type GuidanceMaterialKind = "press_release" | "shareholder_letter" | "deck" | "transcript";
export type GuidanceSourceKind = "sec" | "transcript_api" | "ir";
export type GuidanceHorizon = "quarter" | "annual" | "long_term";
export type GuidanceForm = "range" | "point" | "floor" | "ceiling" | "qualitative";
export type GuidanceBasis = "gaap" | "non_gaap" | "constant_currency" | "unspecified";
/** What the number measures: an amount, a year-over-year growth rate, a margin, or a per-share value. */
export type GuidanceMeasure = "amount" | "growth" | "margin" | "per_share";
export type GuidanceMetric =
  | "revenue" | "segment_revenue" | "gross_margin" | "operating_margin" | "operating_income" | "eps"
  | "free_cash_flow" | "operating_cash_flow" | "capex" | "rpo" | "billings" | "other";
export type GuidanceUnit = "USD" | "percent" | "USD_per_share";
export type GuidanceDirection = "up" | "down" | "flat";
/** Change against the same target from the previous earnings event; null when nothing came before. */
export type GuidanceAction = "initiated" | "raised" | "lowered" | "reaffirmed" | "narrowed" | "widened" | "updated";

export type GuidanceSource = {
  id: string;
  kind: GuidanceMaterialKind;
  sourceKind: GuidanceSourceKind;
  title: string;
  url: string;
  publishedAt: string;
};

export type GuidanceItem = {
  /** Stable across publications: target, metric, basis and the event that issued it. */
  id: string;
  metric: GuidanceMetric;
  measure: GuidanceMeasure;
  /** Segment or product line as the source names it; null for company totals. */
  segment: string | null;
  /** Metric as the source labels it, e.g. "Total revenues". */
  label: string;
  basis: GuidanceBasis;
  horizon: GuidanceHorizon;
  form: GuidanceForm;
  fiscalYear: number | null;
  fiscalQuarter: 1 | 2 | 3 | 4 | null;
  /** Approximate end date of the target period from the company's fiscal calendar; null if unresolved. */
  periodEnd: string | null;
  unit: GuidanceUnit | null;
  low: number | null;
  high: number | null;
  direction: GuidanceDirection | null;
  /** Revenue growth guidance converted to an amount from the matching prior-year actual. */
  derived: { low: number; high: number; basePeriodEnd: string; base: number } | null;
  /** Reported revenue for the target quarter, once published. */
  actual: { value: number; periodEnd: string } | null;
  /** One sentence in Simplified Chinese. */
  text: string;
  /** Verbatim from the source, at most 200 characters. */
  quote: string;
  sourceIds: string[];
  issuedAt: string;
  action: GuidanceAction | null;
  previous: { low: number | null; high: number | null; issuedAt: string } | null;
};

export type GuidanceCoverage = {
  eventDate: string;
  accession: string;
  materials: Array<{ kind: GuidanceMaterialKind; status: "extracted" | "unsupported" | "unavailable" | "failed" }>;
};

export type GuidancePublication = {
  schemaVersion: "guidance.v1";
  ticker: string;
  updatedAt: string;
  items: GuidanceItem[];
  sources: GuidanceSource[];
  coverage: GuidanceCoverage[];
};

export type GuidanceResponse = {
  schemaVersion: "guidance-response.v1";
  status: "ready" | "preparing";
  guidance: GuidancePublication | null;
};
