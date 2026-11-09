import type { SecPresentation, SecSourceMaterial } from "../../../../shared/analysis-contract/sec-presentation.ts";
/**
 * v4: reports are written in English. The version keys analysis jobs and the R2 artifact path, so the bump makes
 * every filing eligible again and keeps admin regeneration from restoring v3 (Chinese) plans and nodes. Published
 * v3 reports stay in D1 and keep being served until a v4 report for the same period replaces them.
 */
export const SEC_ANALYSIS_SCHEMA_VERSION = "sec-analysis.v4";
export const SEC_ANALYSIS_PROMPT_VERSION = "sec-analysis-prompt.v9-english";

const SEC_CANONICAL_SERIES_IDS = [
  "revenue",
  "gross_profit",
  "gross_margin",
  "operating_income",
  "operating_margin",
  "net_income",
  "diluted_eps",
  "operating_cash_flow",
  "capex",
  "free_cash_flow",
  "cash",
  "debt",
  "shares",
  "rpo",
  "depreciation",
  "stock_compensation",
  "buybacks",
  "dividends",
  "equity_securities_gains",
  "interest_income",
  "interest_expense",
  "fx_gains",
  "total_assets",
  "total_liabilities",
  "equity",
  "receivables",
  "inventory",
  "long_term_debt",
] as const;

export type SecCanonicalSeriesId = typeof SEC_CANONICAL_SERIES_IDS[number];

export type HistoricalObservation = {
  observationId: string;
  seriesId: SecCanonicalSeriesId;
  metricKey: string;
  value: string;
  unit: string;
  currency?: string;
  basis: "gaap" | "derived";
  periodScope: "quarter" | "annual";
  startDate?: string;
  endDate: string;
  sourceAccession: string;
  sourceFiledAt: string;
  sourceVersion: string;
  qualityStatus: "validated_xbrl";
  xbrlConcept?: string;
  derivationFormula?: string;
};

type SecHistorySeries = {
  seriesId: SecCanonicalSeriesId;
  quarters: HistoricalObservation[];
  annual: HistoricalObservation[];
};

export type SecHistorySnapshot = {
  registryVersion: string;
  series: SecHistorySeries[];
};

export type CompanyMemoryStatus = "provisional" | "active" | "stale" | "resolved" | "contradicted" | "superseded" | "rejected";

export type CompanyMemoryItem = {
  memoryId: string;
  ticker: string;
  kind: "fact" | "judgment";
  topicKey: string;
  statement: string;
  status: CompanyMemoryStatus;
  materialityScore: number;
  confidence: "high" | "medium" | "low";
  evidenceIds: string[];
  firstSeenPeriod: string;
  lastConfirmedPeriod: string;
  horizon?: string;
  nextTest?: string;
  falsifier?: string;
  duePeriod?: string;
  sourceJobIds?: string[];
};

export type SecAnalysisBrief = {
  marketSnapshot?: import("../../../../shared/analysis-contract/sec-reader.ts").SecMarketSnapshot;
  reportContinuity?: import("./continuity.ts").ReportContinuity;
  version: "sec-analysis-brief.v2";
  ticker: string;
  filingId: string;
  periodId: string;
  periodScope: "quarter" | "annual";
  currentFacts: AnalysisFact[];
  history: SecHistorySnapshot;
  comparisons: Array<{
    seriesId: SecCanonicalSeriesId;
    comparisonType: "qoq" | "yoy";
    currentValue: string;
    priorValue: string;
    percentageDelta?: string;
    /** Set for ratio-unit series only, as the fraction the ratio moved. See `pointDelta`. */
    percentagePointDelta?: string;
    unit: string;
    currency?: string;
    basis: string;
    currentEndDate: string;
    priorEndDate: string;
  }>;
  companyMemorySummary: string;
  memoryItems: CompanyMemoryItem[];
  allowedMetricKeys: SecCanonicalSeriesId[];
  missingSeriesIds: SecCanonicalSeriesId[];
};

export type SecNodeSpecV2 = {
  id: string;
  title: string;
  question: string;
  sectionIds: string[];
  keywords?: string[];
  historySeriesIds: SecCanonicalSeriesId[];
  memoryIds: string[];
  acceptanceCriteria: string[];
  materiality: "high" | "medium" | "low";
};

type ManagerQuestionStatus = "answered" | "partial" | "unanswered" | "not_disclosed";

type ManagerRepairTask = SecNodeSpecV2 & {
  questionId: string;
  targetNodeId: string;
  missingEvidence: string[];
};

export type ManagerReview = {
  status: "complete" | "needs_repair" | "partial";
  questions: Array<{ questionId: string; status: ManagerQuestionStatus; explanation: string }>;
  repairTasks: ManagerRepairTask[];
  unresolvedQuestions: string[];
  coverageScore: number;
  stopReason: "complete" | "max_rounds" | "no_progress" | "analysis_incomplete" | null;
};

type SecComparisonType = "qoq" | "yoy" | "guidance_revision" | "disclosure_change";

export function buildPeriodIdentity(ticker: string, form: string, reportDate: string): { periodId: string; periodScope: "quarter" | "annual" } {
  const periodScope = form.startsWith("10-K") || form.startsWith("20-F") ? "annual" : "quarter";
  return {
    periodId: `${ticker}:${reportDate}:${periodScope}`,
    periodScope,
  };
}

export type FilingBlock = {
  blockId: string;
  ordinal: number;
  /** Character span in the cleaned filing text, used to map blocks onto outline sections. */
  start: number;
  end: number;
  heading: string;
  headingPath: string;
  elementType: "heading_and_text" | "text" | "table_like";
  preview: string;
  body: string;
  tokenCount: number;
  numericDensity: number;
  tableCount: number;
  contentHash: string;
  /** Where the block came from: the filing body itself or an attached exhibit document. */
  source?: "body" | "exhibit";
  /** SEC submission TYPE of the originating document, e.g. "8-K" or "EX-99.1". */
  exhibitType?: string;
};

export type AnalysisFact = {
  cashFlow?: {
    classification: "operating" | "investing" | "financing" | "non_cash" | "unknown";
    includedInOperatingCashFlow: "yes" | "no" | "unknown";
    obligation: string;
    sourceQuote: string;
  };
  definition?: string;
  periodEnd?: string;
  factId?: string;
  metricKey: string;
  value: string;
  unit: string;
  currency?: string;
  periodScope?: string;
  basis: "gaap" | "non_gaap" | "management_kpi" | "derived" | "unknown";
  evidenceIds: string[];
  confidence: "high" | "medium" | "low";
  sourceLabel: "fact_source_reported" | "management_adjusted" | "derived_calculation" | "unknown";
  definitionHash?: string;
};

type AnalysisClaim = {
  claimId?: string;
  topicKey: string;
  claimType: "driver" | "guidance" | "risk" | "one_off" | "accounting" | "commitment" | "tone";
  statement: string;
  direction: "positive" | "negative" | "mixed" | "neutral" | "unknown";
  horizon: "current" | "next_period" | "longer_term" | "unknown";
  materialityScore: number;
  confidence: "high" | "medium" | "low";
  evidenceIds: string[];
  targetPeriodId?: string;
};

export type ComparisonResult = {
  comparisonType: SecComparisonType;
  currentPeriodId: string;
  priorPeriodId: string;
  comparability: "full" | "partial" | "not_comparable";
  metricDeltas: Array<{
    metricKey: string;
    currentValue: string;
    priorValue: string;
    absoluteDelta?: string;
    percentageDelta?: string;
    /** Set for ratio-unit series only, as the fraction the ratio moved. See `pointDelta`. */
    percentagePointDelta?: string;
    reason?: string;
  }>;
  narrativeDeltas: Array<{
    topicKey: string;
    changeType: "introduced" | "reaffirmed" | "strengthened" | "weakened" | "withdrawn" | "resolved" | "not_mentioned";
    currentStatement?: string;
    priorStatement?: string;
    evidenceIds: string[];
    materialityScore: number;
  }>;
};

export type PublishedSecReport = {
  trends?: import("../../../../shared/analysis-contract/sec-presentation.ts").SecTrend[];
  /** Application-built figures the reader places by `figureKey`. */
  figures?: import("../../../../shared/analysis-runtime/sec-figures.ts").SecFigure[];
  reader?: import("../../../../shared/analysis-contract/sec-reader.ts").SecReaderReport;
  financialLens?: import("../../../../shared/analysis-contract/sec-reader.ts").SecFinancialLens;
  marketSnapshot?: import("../../../../shared/analysis-contract/sec-reader.ts").SecMarketSnapshot;
  /** notes: findings the review raised that did not hold publication back (editorialGate). */
  editorialReview?: { status: "passed"; reviewedAt: string; notes?: string[] };
  fiscalPeriod?: import("../../../../shared/analysis-contract/report.ts").SecFiscalPeriod | null;
  discovery?: import("../../../../shared/analysis-contract/report.ts").SecDiscovery;
  publication?: { filing: import("./sec.ts").SecFiling; summary: import("./sec.ts").SecFilingSummary };
  presentation?: SecPresentation;
  sourceMaterials?: SecSourceMaterial[];
  ticker: string;
  periodId: string;
  reportVersion: string;
  headline: string;
  keyMetrics: Array<{
    metricKey: string;
    currentValue: string;
    unit?: string;
    currency?: string;
    definition?: string;
    qoq?: string;
    yoy?: string;
    status: "verified" | "derived" | "not_comparable" | "not_disclosed";
    evidenceIds: string[];
  }>;
  changes: {
    qoq: ComparisonResult["narrativeDeltas"];
    yoy: ComparisonResult["narrativeDeltas"];
    guidance: AnalysisClaim[];
    risks: AnalysisClaim[];
  };
  dataQuality: {
    coverage: number;
    verificationStatus: "verified" | "partial" | "failed";
    warnings: string[];
    analysisStatus?: "complete" | "partial";
    unresolvedQuestions?: string[];
    failedNodeIds?: string[];
    stopReason?: ManagerReview["stopReason"];
    managerCoverageScore?: number;
  };
};

export function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
