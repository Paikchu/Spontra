/**
 * The valuation assessment (docs/valuation-assessment-design.md, docs/valuation-assessment-implementation.md,
 * docs/valuation-methodology-optimization.md): five researched dimensions, one calculated model over three scenarios
 * that share a discount rate, the market-implied path, and the evidence every claim rests on. Every number in a
 * publication was produced by the calculator or copied from a registered fact; the model only chooses, reasons and
 * assumes. Amounts are in the valuation currency's base unit; shares in base units; rates as 0–1 decimals.
 */
export const VALUATION_DIMENSIONS = ["businessQuality", "growthExecution", "valuationSafety", "mispricingCatalysts", "financialResilience"] as const;
export type ValuationDimensionKey = typeof VALUATION_DIMENSIONS[number];
export const DIMENSION_WEIGHTS: Record<ValuationDimensionKey, number> = { businessQuality: 0.2, growthExecution: 0.2, valuationSafety: 0.3, mispricingCatalysts: 0.2, financialResilience: 0.1 };

export type Confidence = "high" | "medium" | "low";
export type ValuationVerdict = "supported" | "not_supported" | "pending";
export type ReportStatus = "ready" | "insufficient";
export type ScenarioKey = "bear" | "base" | "bull";
export const SCENARIO_KEYS: readonly ScenarioKey[] = ["bear", "base", "bull"];
export type DiscountRateBasis = "wacc" | "cost_of_equity";
export const VALUATION_MODEL_TYPES = ["fcff", "fcfe", "revenue_fcfe", "residual_income", "earnings_multiple", "reported_earnings_multiple", "proforma_earnings_multiple", "asset_nav", "affo_multiple", "affo_dcf"] as const;
export type ValuationModelType = typeof VALUATION_MODEL_TYPES[number];

export const GAP_CODES = ["missing_inputs", "unsupported_model", "missing_quote", "stale_quote", "identity_mismatch", "conflicting_sources", "unverified_consensus", "unreadable_source", "research_budget_exhausted",
  "assumption_out_of_history_range", "tv_share_high", "reinvestment_inconsistent", "discount_rate_unsourced", "calculation_rejected"] as const;
export type GapCode = typeof GAP_CODES[number];
export type ValuationGap = { code: GapCode; field?: string; period?: string; message: string; evidenceIds: string[] };

/** A fact the calculator may use: reported from a registered source, derived by code from reported facts, or assumed by the researcher with a reason. */
export type FactBasis = "reported" | "derived" | "company_guidance" | "assumption";
export type PeriodType = "quarter" | "ttm" | "fiscal_year" | "instant";
export type ValuationFact = {
  id: string;
  label: string;
  value: number;
  unit: string;
  currency: string | null;
  periodType: PeriodType;
  periodStart: string | null;
  periodEnd: string | null;
  basis: FactBasis;
  /** The arithmetic a derived fact came from, in terms of other fact ids. */
  formula: string | null;
  /** Evidence ids (SEC passages, web pages) or XBRL concept references the fact rests on. */
  sourceRefs: string[];
  rationale: string | null;
};

/** One year of a driver path; the same shape for every scenario so scenarios differ only in the numbers. */
export type DriverPath = { revenueGrowth: number[]; operatingMargin: number[]; taxRate: number[]; salesToCapital: number[]; normalization?: number[] };
export type ScenarioAssumptions = {
  narrative: string;
  probability: number | null;
  triggers: string[];
  invalidation: string[];
  evidenceIds: string[];
  drivers: ModelDrivers;
};
/** The per-scenario inputs of each model; the discount rate, shares and bridge are report-level and shared. */
export type ModelDrivers =
  | { modelType: "fcff"; revenue0: number; path: DriverPath; terminalGrowth: number; terminalRoic: number }
  | { modelType: "fcfe"; cfo: number; capex: number; sbc: number; normalization: number; netBorrowing: number; growth: number[]; terminalGrowth: number }
  | { modelType: "revenue_fcfe"; revenue0: number; growth: number[]; afterSbcEquityCashMargin: number[]; terminalGrowth: number }
  | { modelType: "residual_income"; bookEquity0: number; roe: number[]; payout: number[]; terminalRoe: number; terminalGrowth: number }
  | { modelType: "earnings_multiple"; epsLow: number; epsHigh: number; weight: number; multiple: number; horizonYears: number }
  | { modelType: "reported_earnings_multiple"; commonEarnings: number; earningsScale: number; multiple: number; horizonYears: number }
  | { modelType: "proforma_earnings_multiple"; commonEarnings: number; earningsScale: number; multiple: number; horizonYears: number }
  | { modelType: "asset_nav"; assets: Array<{ units: number; price: number; costBasis: number; taxRate: number }>; otherNetAssets: number; debtClaims: number; preferredClaims: number; operatingReserve: number }
  | { modelType: "affo_multiple"; affoLow: number; affoHigh: number; weight: number; recurringCostPerShare: number; multiple: number; horizonYears: number }
  | { modelType: "affo_dcf"; annualAffo: number; recurringCost: number; growth: number[]; terminalGrowth: number };

export type EquityBridge = {
  /** Cash, investments and other non-operating assets attributable to common equity, after any tax or claims. */
  nonOperatingAssets: number;
  /** Debt, leases, preferred, minority interests and other claims ahead of common equity. */
  debtAndClaims: number;
  /** For equity-cash-flow models: the net non-operating adjustment not already in the forecast cash flows. */
  nonOperatingEquityAdjustment: number;
  notes: string[];
};
export type ShareCount = { base: number; dilutionReserve: number; economic: number; basis: string };
export type DiscountRate = {
  value: number; basis: DiscountRateBasis;
  components: { riskFree: number | null; beta: number | null; equityRiskPremium: number | null; costOfEquity: number | null; costOfDebt: number | null; taxRate: number | null; equityWeight: number | null };
  rationale: string;
  sourceRefs: string[];
};

export type YearRow = { year: number; revenue: number | null; nopat: number | null; reinvestment: number | null; cashFlow: number; discountFactor: number; presentValue: number };
export type ScenarioResult = {
  perShare: number;
  equityValue: number;
  /** Operating (enterprise) value before the bridge; null for equity-level models. */
  enterpriseValue: number | null;
  pvExplicit: number | null;
  pvTerminal: number | null;
  terminalShare: number | null;
  yearly: YearRow[];
  notes: string[];
};
export type Sensitivity = { factor: string; step: string; perShare: number; changePercent: number };
export type ImpliedPath = { factor: "revenueGrowth"; implied: number; baseAverage: number; gap: number; converged: boolean };
export type ValuationRange = {
  low: number; high: number; base: number; expected: number | null;
  price: number | null; marginOfSafety: number | null; downsideCoverage: number | null; expectedUpside: number | null; baseUpside: number | null;
};
export type ValuationModelResult = {
  calculatorVersion: string;
  modelType: ValuationModelType;
  currency: string;
  discountRate: DiscountRate;
  shares: ShareCount;
  bridge: EquityBridge;
  scenarios: Record<ScenarioKey, ScenarioAssumptions & { result: ScenarioResult }>;
  range: ValuationRange;
  sensitivities: Sensitivity[];
  implied: ImpliedPath | null;
  limitations: string[];
};

export type ValuationDimension = {
  key: ValuationDimensionKey;
  score: number | null;
  confidence: Confidence;
  rationale: string;
  supportingEvidenceIds: string[];
  counterEvidenceIds: string[];
  gaps: string[];
  nextCheck: string;
};

export type EvidenceKind = "sec" | "web" | "fact";
/** A source the report cites: the snapshot stored with the version, never a live re-read. */
export type ValuationEvidence = {
  evidenceId: string;
  kind: EvidenceKind;
  title: string;
  url: string | null;
  documentId: string | null;
  passageId: string | null;
  form: string | null;
  publishedAt: string | null;
  fetchedAt: string | null;
  excerpt: string;
  contentSha256: string;
  path: string | null;
};

export type ReferenceQuote = { price: number; currency: string; priceDate: string; source: string; sourceUrl: string; fetchedAt: string; usable: boolean; limitations: string[] };

/** A factor's historical distribution, for placing an assumption; computed by code from validated facts. */
export type FactorDistribution = { factor: string; periods: Array<{ periodEnd: string; value: number }>; min: number; p25: number; median: number; p75: number; max: number };
export type DiagnosticMetric = { key: string; label: string; value: number | null; unit: "ratio" | "percent" | "years" | "currency" | "x"; periodEnd: string | null; note: string | null };

export type ValuationSections = {
  summary: string;
  thesis: string;
  expectationsGap: string;
  catalysts: string[];
  counterEvidence: string[];
  nextChecks: string[];
  modelNotes: string;
};

export type ValuationPublication = {
  schemaVersion: "valuation.v1";
  ticker: string;
  cik: string | null;
  companyName: string;
  currency: string;
  researchAsOf: string;
  financialPeriodEnd: string;
  generatedAt: string;
  methodVersion: string;
  calculatorVersion: string;
  baseInputFingerprint: string;
  evidenceSetHash: string;
  reportStatus: ReportStatus;
  verdict: ValuationVerdict;
  weightedScore: number | null;
  confidence: Confidence;
  dimensions: ValuationDimension[];
  quote: ReferenceQuote | null;
  model: ValuationModelResult | null;
  facts: ValuationFact[];
  diagnostics: DiagnosticMetric[];
  distributions: FactorDistribution[];
  sections: ValuationSections;
  evidence: ValuationEvidence[];
  gaps: ValuationGap[];
  /** Content hash of the publication without generatedAt; the version id. */
  versionId: string;
};

export type ValuationAvailability = "hidden" | "preparing" | "ready" | "insufficient" | "failed";
export type ValuationAttempt = {
  runId: string;
  status: "queued" | "running" | "waiting" | "succeeded" | "empty" | "superseded" | "cancelled" | "failed";
  stage: string | null;
  updatedAt: string;
  reportStatus: ReportStatus | null;
  gaps: ValuationGap[];
  errorCode: string | null;
};
export type ValuationResponse = {
  schemaVersion: "valuation-response.v1";
  ticker: string;
  availability: ValuationAvailability;
  report: ValuationPublication | null;
  latestAttempt: ValuationAttempt | null;
  outdated: boolean;
  versions: Array<{ versionId: string; generatedAt: string; researchAsOf: string; reportStatus: ReportStatus; weightedScore: number | null; verdict: ValuationVerdict }>;
};
