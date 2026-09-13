import { ANALYSIS_API_SCHEMA_VERSION } from "./common.ts";

/**
 * Wire types for the fundamentals resource. Previously these sat in `lib/fundamentals-api.ts`
 * next to the D1 handler; they were moved here unchanged so a consumer — including the Web
 * Worker's client components — can type a response without importing anything that can reach a
 * database binding. `lib/fundamentals-api.ts` re-exports them, so existing imports still resolve.
 */
export const FUNDAMENTALS_API_SCHEMA_VERSION = "fundamentals-api.v1";
export const FUNDAMENTALS_DEFAULT_PERIOD_COUNT = 5;
export const FUNDAMENTALS_MIN_PERIOD_COUNT = 2;
export const FUNDAMENTALS_MAX_PERIOD_COUNT = 12;
export const FUNDAMENTALS_STALE_AFTER_MS = 24 * 60 * 60 * 1_000;

/**
 * What one chart can hold. Shared because both services enforce them: the Web service refuses to
 * build a model that breaks them, and the Pipeline has to know that before it publishes a chart
 * the page would then have to replace with an error.
 */
export const FUNDAMENTAL_CHART_MAX_SERIES = 4;
export const FUNDAMENTAL_CHART_MAX_AXES = 2;

export type PublicFundamentalPeriod = {
  periodType: "3M";
  periodEnd: string;
  currency: string;
};

export type PublicFundamentalPoint = {
  periodEnd: string;
  valueDecimal: string | null;
  revision: number | null;
  sourceAccession?: string;
  sourceFiledAt?: string;
  derivationFormula?: string;
};

export type PublicFundamentalSeries = {
  metricKey: FundamentalMetricKey;
  label: string;
  shortLabel: string;
  category: FundamentalMetricCategory;
  unitFamily: FundamentalUnitFamily;
  unit: string;
  currency: string;
  basis: "reported" | "derived";
  displaySign: FundamentalDisplaySign;
  defaultMark: FundamentalChartMark;
  allowedTransforms: readonly FundamentalTransform[];
  available: boolean;
  points: PublicFundamentalPoint[];
};

export type PublicFundamentalsResponse = {
  apiSchemaVersion: typeof ANALYSIS_API_SCHEMA_VERSION;
  schemaVersion: typeof FUNDAMENTALS_API_SCHEMA_VERSION;
  catalogVersion: "fundamental-metrics.v2";
  /** Actual provider; SEC-derived ratios and cash flow retain SEC provenance. */
  source: "yahoo_finance" | "sec_xbrl";
  ticker: string;
  status: "ready" | "pending";
  dataVersion: string | null;
  fetchedAt: string | null;
  stale: boolean;
  partial: boolean;
  qualityStatus: "complete" | "partial" | null;
  issueCount: number;
  requestedPeriodCount: number;
  periods: PublicFundamentalPeriod[];
  series: PublicFundamentalSeries[];
  refresh: {
    recommended: boolean;
    /**
     * Always false. Reads used to enqueue a refresh from here; they no longer do (§4.1). The
     * field is kept so existing readers do not break on a missing key.
     */
    scheduled: false;
    /** Where refresh actually happens now: the backend's scheduled sweep and admin endpoint. */
    mode: "backend_scheduled";
  };
};

export type FundamentalMetricCategory =
  | "income_statement"
  | "cash_flow"
  | "balance_sheet"
  | "per_share"
  | "valuation"
  | "ratio";

export type FundamentalUnitFamily = "currency" | "percent" | "per_share" | "shares" | "multiple";

export type FundamentalChartMark = "bar" | "line";

export type FundamentalTransform =
  | "value"
  | "qoq_growth"
  | "yoy_growth"
  | "qoq_change"
  | "yoy_change";

export type FundamentalDisplaySign = "as_reported" | "outflow_magnitude";
export type FundamentalMetricKey = keyof typeof import("./fundamental-metric-catalog.ts").FUNDAMENTAL_METRIC_CATALOG;
