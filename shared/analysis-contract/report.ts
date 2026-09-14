import type { SecPresentation, SecSourceMaterial } from "./sec-presentation.ts";
export type SecComparisonType = "qoq" | "yoy" | "guidance_revision" | "disclosure_change";

export type AnalysisFact = {
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

export type AnalysisClaim = {
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

export type SecDisclosure = {
  id: string; title: string; quote: string; start: number; end: number; evidenceIds: string[];
  whyItMatters: string; question: string; materiality: "high" | "medium" | "low";
  polarity: "positive" | "negative" | "mixed" | "neutral";
};
export type SecDiscovery = {
  version: "sec-discovery.v1"; totalCharacters: number; scannedCharacters: number;
  failedChunks: number[]; disclosures: SecDisclosure[]; warnings: string[];
};

export type PublishedSecReport = {
  fiscalPeriod?: import("./report.ts").SecFiscalPeriod | null;
  discovery?: SecDiscovery;
  publication?: { filing: SecFiling; summary: SecFilingSummary };
  presentation?: SecPresentation;
  sourceMaterials?: SecSourceMaterial[];
  ticker: string;
  periodId: string;
  reportVersion: string;
  headline: string;
  keyMetrics: Array<{
    metricKey: string;
    currentValue: string;
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
    stopReason?: "complete" | "max_rounds" | "no_progress" | "analysis_incomplete" | null;
    managerCoverageScore?: number;
  };
};

export type SecSummaryImportance = "high" | "medium" | "low";

export type SecEventCategory = "earnings_update" | "guidance" | "m&a" | "executive" | "legal" | "other";

export type SecSummaryBullet = {
  label: string;
  detail: string;
  importance: SecSummaryImportance;
};

export type PublicFilingEvidence = {
  start: number;
  end: number;
  score: number;
  reasons: string[];
  excerpt: string;
};

export type SecNodeResult = {
  id: string;
  title: string;
  status: "complete" | "empty" | "error";
  findings: SecSummaryBullet[];
  narrative: string;
  facts?: AnalysisFact[];
  evidence: PublicFilingEvidence[];
  evidenceIds?: string[];
  error?: string;
};

export type SecEarningsGroup = {
  id: string;
  periodEnd: string;
  earningsDate: string;
  canonicalAccession: string;
  inputKey: string;
  sources: Omit<SecFiling, "earningsGroup">[];
};

export type SecFiling = {
  earningsGroup?: SecEarningsGroup;
  ticker: string;
  cik: string;
  cikNumber: number;
  companyName: string;
  form: string;
  filingDate: string;
  reportDate: string;
  accessionNumber: string;
  primaryDocument: string;
  description: string;
  items: string;
  documentUrl: string;
  indexUrl: string;
};

export type SecFilingSummary = {
  discovery?: SecDiscovery;
  earningsGroup?: SecEarningsGroup;
  ticker: string;
  form: string;
  filingDate: string;
  accessionNumber: string;
  headline: string;
  bullets: SecSummaryBullet[];
  analystView: string;
  /** Event filings only: what kind of 8-K/6-K this is. */
  eventCategory?: SecEventCategory;
  report?: string;
  version?: number;
  nodes?: SecNodeResult[];
  repairRounds?: number;
  source: "deepseek" | "error";
  generatedAt: string;
  error?: string;
};

export type SecFilingWithSummary = SecFiling & {
  summary: SecFilingSummary | null;
  analysis?: PublishedSecReport | null;
};

/** Fiscal focus explicitly reported in SEC DEI, independent of analysis text. */
export type SecFiscalPeriod = {
  fiscalYear: number;
  fiscalPeriod: "FY" | "Q1" | "Q2" | "Q3" | "Q4" | "H1" | "H2" | "M9";
  periodEnd: string;
  source: "sec_dei" | "ai_source_review";
  evidenceQuote?: string;
  conflictExplanation?: string;
  sourceAccession: string;
  sourceUrl: string;
};
