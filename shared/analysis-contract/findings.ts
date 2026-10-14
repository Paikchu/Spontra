import type { FlowMetric } from "./business-flow.ts";
import type { ExplainerClaim, ExplainerSource } from "./business-explainer.ts";
import type { FundamentalMetricKey } from "./fundamentals.ts";
import type { LensDocument } from "./lens.ts";
import type { ScheduleKind } from "./capital-structure.ts";
import type { PeersPublication } from "./peers.ts";

/**
 * What an analyst (a model, or a person until the model runs) says deserves attention in a
 * company's statements, bound to the figures that show it. A finding never carries an amount:
 * every number the page shows is resolved from the published flow, capital, fundamentals and
 * guidance at read time, and a finding whose text states a number those data do not support is
 * withheld rather than displayed.
 */

/**
 * Cash-flow and balance-sheet figures the capital projection can answer. Flows are positive as spent or raised
 * (capex, acquisitions, leasePrincipal, buybacks and dividends read as outflows); instants are the balance-sheet
 * groups at the period end; supplemental lines are what the statement discloses beneath itself.
 */
export type CapitalMetric =
  | "operatingCashFlow" | "capex" | "freeCashFlow" | "financing" | "debtIssued" | "debtRepaid" | "equityIssued" | "buybacks" | "dividends"
  | "acquisitions" | "investmentsNet" | "leasePrincipal" | "depreciation" | "stockCompensation"
  | "interestPaid" | "taxesPaid" | "unpaidCapex" | "leaseAssetsObtained"
  | "totalAssets" | "debt" | "cash" | "equity" | "totalLiabilities" | "currentAssets" | "currentLiabilities"
  | "receivables" | "inventory" | "productive" | "leaseAssets" | "intangibles" | "investments"
  | "leases" | "customerAdvances" | "payables" | "deferredTax"
  | "rpo" | "rpoNext12MonthsShare";

/** Where a figure comes from. A node is a disclosed business (segment or revenue breakdown node) by its flow id. */
export type FindingBaseRef =
  | { metric: FlowMetric }
  | { capital: CapitalMetric }
  | { fundamental: FundamentalMetricKey }
  | { nodeId: string }
  | { guidanceId: string }
  /** One rung of the RPO conversion schedule the filing tags, by position from the nearest (0); the amount expected in that stretch. */
  | { rpoBucket: number }
  /** The same figure at a tracked peer, from the peers projection (docs/analyst-agent-design.md), aligned to the period asked for. */
  | { peer: { ticker: string; ref: PeerBaseRef } }
  /** A cell of a filing-library table, by passage and position; resolvable only when the table's unit parses to a scale. */
  | { passageCell: { passageId: string; row: number; col: number } }
  /** A figure of one filed event (a Form 4's shares sold, proceeds, holdings after), read from the events publication by accession. */
  | { event: { id: string; field: EventField } }
  /** One rung of a tagged schedule (debt maturities, lease payments due, purchase obligations): year `bucket` 0–5 (5 = thereafter), or the total when `bucket` is "total". */
  | { schedule: { kind: ScheduleKind; bucket: number | "total" } };
export type EventField = "sharesSold" | "proceeds" | "averagePrice" | "sharesBought" | "cost" | "exercised" | "heldAfter";
export const EVENT_FIELDS = ["sharesSold", "proceeds", "averagePrice", "sharesBought", "cost", "exercised", "heldAfter"] as const;
/** What a peer reference may point at: a capital figure or a fundamental series; never another peer, a node or guidance. */
export type PeerBaseRef = { capital: CapitalMetric } | { fundamental: FundamentalMetricKey } | { metric: FlowMetric };
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
  /** Overrides the resolved label, e.g. "FY2026 capex"; at most 100 characters. */
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
  | { type: "ladder" }
  /** The lens agent's composition: charts and paragraphs laid out as rows (docs/finding-lens-agent.md). */
  | { type: "document"; document: LensDocument };

/**
 * What to look at when the next report lands: the figure, in words what would settle it, and how
 * far ahead. Once that period is published the page resolves the figure (and its comparison) and
 * shows the outcome beside the condition.
 */
/**
 * The deterministic reading of a watch once its period is published: the figure stands above, below or within its
 * comparison (a year earlier, the prior period, a guided range, or another figure), `tolerance` being the percent
 * band for "within" against a single figure. Pass or fail is computed by the shared runtime, never written.
 */
export type FindingWatchTest = { expect: "above" | "below" | "within"; against: "yoy" | "qoq" | { guidanceId: string } | { ref: FindingRef }; tolerance?: number };
export type FindingWatch = { ref: FindingRef; /** One sentence, at most 400 characters. */ condition: string; horizon: "next_quarter" | "fiscal_year"; compare?: FindingCompare; test?: FindingWatchTest };
/** A watch from an earlier publication, kept so the page can score it against the data as it stands now. */
export type FindingRecordEntry = { findingId: string; title: string; kind: FindingKind; /** The report the watch was written from. */ periodEnd: string; publishedAt: string; watch: FindingWatch };
/** A filing passage, transcript excerpt or web page a lens document quotes; the text itself is re-read at serve time, never trusted from here. */
export type FindingMaterial = { id: string; kind: "sec" | "transcript" | "web"; title: string; url: string; publishedAt: string | null; passageId?: string; documentId?: string; form?: string; path?: string[]; textSha256?: string };

export type AnalysisFinding = {
  id: string;
  kind: FindingKind;
  severity: FindingSeverity;
  /** A headline of at most 80 characters. */
  title: string;
  /** One paragraph of 80 to 180 words, at most 1,400 characters. */
  judgment: ExplainerClaim;
  evidence: FindingEvidence[];
  /** What the stage shows while the finding is in focus. */
  anchors: { view: FindingView; nodeIds: string[]; metrics: FlowMetric[]; capital?: CapitalMetric[] };
  lens: FindingLens;
  /** The finding on the other side of the same trade-off; shown side by side. */
  pairWith?: string;
  watch?: FindingWatch;
};

/**
 * A headline figure for one statement view, picked by the model because it moved against the five quarters before:
 * the model names the figure and says whether its level or its change is the news; the page resolves both.
 */
export type StatementHighlight = {
  /** A plain name of at most 40 characters, no number and no word of motion or emphasis: "Cloud infrastructure revenue growth". */
  title: string;
  /** Always read at the report's quarter. */
  ref: FindingRef;
  /** The comparison the tile shows. */
  compare?: "yoy" | "qoq";
  /** What the large number is: the figure itself (default), or its change against `compare` when the rate is the news. */
  show?: "value" | "change";
};

/** One report's headline figures per statement view, most notable first. */
export type ReportHighlights = { periodEnd: string; profit: StatementHighlight[]; cash: StatementHighlight[]; balance: StatementHighlight[] };

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
  /** Headline figures of this report and of the reports before it, each written when its report was the newest. */
  highlights?: ReportHighlights[];
  /** Watches from earlier publications of this company, oldest first; scored on the page against current data. */
  record?: FindingRecordEntry[];
  /** Sources the lens documents quote, by material id. */
  materials?: FindingMaterial[];
};

/** A passage as the read route re-reads it for a publication's quotes and table cells. */
export type FindingPassage = { passageId: string; documentId: string; title: string; form: string; filedAt: string; url: string; path: string[]; text: string; table: { unit: string | null; columns: string[]; rows: Array<{ label: string; cells: Array<{ text: string; value: number | null }> }> } | null };

export type FindingsResponse = {
  schemaVersion: "findings-response.v1";
  status: "ready" | "preparing";
  findings: FindingsPublication | null;
  /** The passages the publication's materials point at, as they stand in the library now (absent ones are left out). */
  passages?: FindingPassage[];
  /** The peers projection the page resolves peer references against. */
  peers?: PeersPublication | null;
};
