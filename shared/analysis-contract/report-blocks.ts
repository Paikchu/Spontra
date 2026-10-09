/**
 * The block protocol for a model-composed analysis.
 *
 * A published report used to be a fixed set of sections, so a filing with three interesting things
 * to say and one with ten rendered the same shape. A block list lets the analysis decide how many
 * pieces it needs and which form each one takes, while the reader-facing vocabulary stays closed:
 * the model picks from these types and nothing else, and every renderer lives in the Web service.
 *
 * No block carries a rendered value. `metrics` and `chart` name what to show and the page resolves
 * the numbers from data that already passed verification, so a block can never put a figure on the
 * page that the Pipeline did not verify — the same split `FundamentalChartSpec` already uses.
 *
 * A chart series reuses the fundamentals vocabulary rather than restating it, so a metric retired
 * there stops type-checking here. SEC metric keys are a separate, open vocabulary and stay strings.
 */
import type {
  FundamentalChartMark,
  FundamentalMetricKey,
  FundamentalTransform,
} from "./fundamentals.ts";

export type ReportBlockTone = "neutral" | "positive" | "negative" | "caution";

export type ReportBlockImportance = "high" | "medium" | "low";

/** Prose. Rendered through the rich-text subset, so light markup survives and HTML never does. */
export type ReportProseBlock = {
  type: "prose";
  id: string;
  title?: string;
  text: string;
};

export type ReportKeyPointsBlock = {
  type: "key_points";
  id: string;
  title?: string;
  points: Array<{ label: string; detail: string; importance: ReportBlockImportance }>;
};

/** Names verified metrics to surface; the page supplies every value and comparison. */
export type ReportMetricsBlock = {
  type: "metrics";
  id: string;
  title?: string;
  metricKeys: string[];
};

/**
 * Names series to plot. Points come from the fundamentals response, never from the model.
 *
 * There is no axis here on purpose. An explicitly requested side was the only way a chart could
 * reach `AXIS_CONFLICT` in the renderer, and the model has no information the renderer lacks —
 * sides are assigned from unit families, which it knows and the model is guessing at.
 */
export type ReportChartBlock = {
  type: "chart";
  id: string;
  title: string;
  caption?: string;
  periodCount?: number;
  series: Array<{
    metricKey: FundamentalMetricKey;
    mark?: FundamentalChartMark;
    transform?: FundamentalTransform;
  }>;
};

/** Filing excerpts with their character offsets, so a claim can be checked against the source. */
export type ReportEvidenceBlock = {
  type: "evidence";
  id: string;
  title?: string;
  items: Array<{ excerpt: string; start: number; end: number; score: number }>;
};

/** A framed aside: a caveat, an accounting change, a risk worth separating from the narrative. */
export type ReportCalloutBlock = {
  type: "callout";
  id: string;
  tone: ReportBlockTone;
  title?: string;
  text: string;
};

export type ReportBlock =
  | ReportProseBlock
  | ReportKeyPointsBlock
  | ReportMetricsBlock
  | ReportChartBlock
  | ReportEvidenceBlock
  | ReportCalloutBlock;
