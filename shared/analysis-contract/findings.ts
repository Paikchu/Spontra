import type { FlowMetric } from "./business-flow.ts";
import type { ExplainerClaim, ExplainerSource } from "./business-explainer.ts";
import type { FundamentalMetricKey } from "./fundamentals.ts";

/**
 * What an analyst (a model, or a person until the model runs) says deserves attention in a
 * company's statements, bound to the figures that show it. A finding never carries an amount:
 * every number the page shows is resolved from the published flow, capital, fundamentals and
 * guidance at read time, and a finding whose text states a number those data do not support is
 * withheld rather than displayed.
 */

/** Cash-flow and balance-sheet figures the capital projection can answer. */
export type CapitalMetric =
  | "operatingCashFlow" | "capex" | "freeCashFlow" | "financing" | "debtIssued" | "debtRepaid" | "equityIssued" | "buybacks" | "dividends"
  | "totalAssets" | "debt" | "cash" | "equity"
  | "rpo" | "rpoNext12MonthsShare";

/** Where a figure comes from. A node is a disclosed business (segment or revenue breakdown node) by its flow id. */
export type FindingBaseRef =
  | { metric: FlowMetric }
  | { capital: CapitalMetric }
  | { fundamental: FundamentalMetricKey }
  | { nodeId: string }
  | { guidanceId: string };
/** A base figure, or one figure over another at the same period and span (cloud revenue per dollar of capex). */
export type FindingRef = FindingBaseRef | { ratio: { numerator: FindingBaseRef; denominator: FindingBaseRef } };

/** A quarter, or the four quarters ending at the evidence's period (a fiscal year when the period is a fiscal year end). */
export type FindingSpan = "quarter" | "fiscal_year";
/** Compared with the same span a year earlier, the previous quarter, or a guided range. */
export type FindingCompare = "yoy" | "qoq" | { guidanceId: string };

export type FindingEvidence = {
  ref: FindingRef;
  periodEnd: string;
  span: FindingSpan;
  compare?: FindingCompare;
  /** Overrides the resolved label, e.g. "FY2026 资本开支". */
  label?: string;
};

export type FindingKind = "risk" | "strength" | "shift" | "watch";
export type FindingSeverity = 1 | 2 | 3;
export type FindingView = "profit" | "cash" | "balance";

/** The chart that shows the finding; each binds to refs, never to written values. */
export type FindingLens =
  | { type: "trend"; refs: FindingRef[]; span: FindingSpan; rate?: "yoy" | "qoq" }
  | { type: "compare_bars"; refs: FindingRef[]; span: FindingSpan }
  | { type: "share_area"; nodeIds: string[] }
  /** Remaining performance obligations over the quarters and, for the finding's report, how they convert over time. */
  | { type: "ladder" };

/**
 * What to look at when the next report lands: the figure, in words what would settle it, and how
 * far ahead. Once that period is published the page resolves the figure (and its comparison) and
 * shows the outcome beside the condition.
 */
export type FindingWatch = { ref: FindingRef; condition: string; horizon: "next_quarter" | "fiscal_year"; compare?: FindingCompare };

export type AnalysisFinding = {
  id: string;
  kind: FindingKind;
  severity: FindingSeverity;
  /** At most 24 characters. */
  title: string;
  judgment: ExplainerClaim;
  evidence: FindingEvidence[];
  /** What the stage shows while the finding is in focus. */
  anchors: { view: FindingView; nodeIds: string[]; metrics: FlowMetric[]; capital?: CapitalMetric[] };
  lens: FindingLens;
  /** The finding on the other side of the same trade-off; shown side by side. */
  pairWith?: string;
  watch?: FindingWatch;
};

export type FindingsPublication = {
  schemaVersion: "findings.v1";
  ticker: string;
  /** The report the findings were written from. */
  periodEnd: string;
  generatedAt: string;
  /** Model name, or "authored" for a human-written set. */
  model: string;
  /** Hash of the report, guidance and narrative the set was written from; the sweep regenerates when it changes. */
  fingerprint?: string;
  findings: AnalysisFinding[];
  sources: ExplainerSource[];
};

export type FindingsResponse = {
  schemaVersion: "findings-response.v1";
  status: "ready" | "preparing";
  findings: FindingsPublication | null;
};
