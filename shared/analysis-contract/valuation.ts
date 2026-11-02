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

export const CONFIDENCES = ["high", "medium", "low"] as const;
export type Confidence = typeof CONFIDENCES[number];
export const VERDICTS = ["supported", "not_supported", "pending"] as const;
export type ValuationVerdict = typeof VERDICTS[number];
export const REPORT_STATUSES = ["ready", "insufficient"] as const;
export type ReportStatus = typeof REPORT_STATUSES[number];
export type ScenarioKey = "bear" | "base" | "bull";
export const SCENARIO_KEYS: readonly ScenarioKey[] = ["bear", "base", "bull"];
/** The scenarios the expected value weighs: the three researched ones and the management scenario computed from cited targets. */
export const EXTENDED_SCENARIO_KEYS = ["bear", "base", "management", "bull"] as const;
export type ExtendedScenarioKey = typeof EXTENDED_SCENARIO_KEYS[number];
export const DISCOUNT_RATE_BASES = ["wacc", "cost_of_equity"] as const;
export type DiscountRateBasis = typeof DISCOUNT_RATE_BASES[number];
export const VALUATION_MODEL_TYPES = ["fcff", "fcfe", "revenue_fcfe", "residual_income", "earnings_multiple", "reported_earnings_multiple", "proforma_earnings_multiple", "asset_nav", "affo_multiple", "affo_dcf"] as const;
export type ValuationModelType = typeof VALUATION_MODEL_TYPES[number];

export const GAP_CODES = ["missing_inputs", "unsupported_model", "missing_quote", "stale_quote", "identity_mismatch", "conflicting_sources", "unverified_consensus", "unreadable_source", "research_budget_exhausted",
  "assumption_out_of_history_range", "tv_share_high", "reinvestment_inconsistent", "discount_rate_unsourced", "calculation_rejected",
  // valuation.calc.v2 gates (docs/valuation-v2-SPEC.md): flagged, never forced.
  "cited_input_mismatch", "consensus_divergence", "method_dispersion", "rpo_floor_breached", "negative_scenario", "terminal_growth_high", "implied_multiple_outside_history", "peers_unavailable",
  // The base path against management's cited targets: a discount or premium beyond the limit is named, never forced.
  "management_target_gap",
  // valuation.calc.v4 (docs/valuation-v2-SPEC.md, "v3: judged weights and the management scenario"): a method the model weighted
  // could not be applied, a usable method was given no weight, or no consensus target could be cited.
  "method_unavailable", "method_zero_weight"] as const;
export type GapCode = typeof GAP_CODES[number];
export type ValuationGap = { code: GapCode; field?: string; period?: string; message: string; evidenceIds: string[] };

/** A fact the calculator may use: reported from a registered source, derived by code from reported facts, or assumed by the researcher with a reason. */
export const FACT_BASES = ["reported", "derived", "company_guidance", "assumption"] as const;
export type FactBasis = typeof FACT_BASES[number];
export const PERIOD_TYPES = ["quarter", "ttm", "fiscal_year", "instant"] as const;
export type PeriodType = typeof PERIOD_TYPES[number];
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

/**
 * One year of a driver path; the same shape for every scenario so scenarios differ only in the numbers. Five to ten years,
 * every array the same length. `buildCapex` is capital spent ahead of revenue (capacity under construction), in currency
 * units per year: reinvestment the sales-to-capital term does not see, so a build phase is not read as a steady state.
 */
export type DriverPath = { revenueGrowth: number[]; operatingMargin: number[]; taxRate: number[]; salesToCapital: number[]; normalization?: number[]; buildCapex?: number[] };
/** A judgement the model made and the registered evidence it rests on. */
export type Judgement = { rationale: string; evidenceIds: string[] };
/** Why a scenario's revenue, margin and capex paths run as they do; the figures are in `drivers`, the reasons here. */
export type PathAssumptions = { revenue: Judgement; margin: Judgement; capex: Judgement };
export type ScenarioAssumptions = {
  narrative: string;
  probability: number | null;
  triggers: string[];
  invalidation: string[];
  evidenceIds: string[];
  drivers: ModelDrivers;
  /** valuation.calc.v4: the reasons behind the key paths; absent on older payloads. */
  assumptions?: PathAssumptions;
};
/** The per-scenario inputs of each model; the discount rate, shares and bridge are report-level and shared. */
export type ModelDrivers =
  /** `terminalOperatingMargin`: the normalized margin the terminal NOPAT is taken from when the last forecast year still carries build-phase costs. */
  | { modelType: "fcff"; revenue0: number; path: DriverPath; terminalGrowth: number; terminalRoic: number; terminalOperatingMargin?: number }
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
export const DISCOUNT_RATE_COMPONENTS = ["riskFree", "beta", "equityRiskPremium", "costOfDebt", "taxRate", "equityWeight"] as const;
export type DiscountRateComponent = typeof DISCOUNT_RATE_COMPONENTS[number];
/** Where each discount-rate component came from: a named source and the registered evidence or fact ids behind it. */
export type DiscountRateSources = Record<DiscountRateComponent, { source: string; evidenceIds: string[] }>;
export type DiscountRate = {
  value: number; basis: DiscountRateBasis;
  components: { riskFree: number | null; beta: number | null; equityRiskPremium: number | null; costOfEquity: number | null; costOfDebt: number | null; taxRate: number | null; equityWeight: number | null };
  rationale: string;
  sourceRefs: string[];
  /** valuation.calc.v4: a source per component; absent on older payloads. */
  sources?: DiscountRateSources;
};

export type YearRow = { year: number; revenue: number | null; nopat: number | null; reinvestment: number | null; cashFlow: number; discountFactor: number; presentValue: number; buildCapex?: number | null };
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
/**
 * The range the report headlines. Under valuation.calc.v4 `low`, `base` and `high` are the bear, base and bull scenarios'
 * method-weighted per-share values (DCF and the forward multiples at the judged weights; `ScenarioValuation`), `expected` the
 * probability-weighted value over bear, base, management and bull; older payloads carry the DCF values and the three-scenario expectation.
 */
export type ValuationRange = {
  low: number; high: number; base: number; expected: number | null;
  price: number | null; marginOfSafety: number | null; downsideCoverage: number | null; expectedUpside: number | null; baseUpside: number | null;
};
/* ---- valuation.calc.v2: cross-checks, gates and anchors (docs/valuation-v2-SPEC.md). All optional; a v1 payload still reads. ---- */

export const VALUATION_METHODS = ["dcf", "ev_ebitda_forward", "pe_forward"] as const;
export type ValuationMethodKey = typeof VALUATION_METHODS[number];
/** One method's football-field bar: per-share low / base / high, null where the method could not be applied. */
export type MethodValuation = { method: ValuationMethodKey; label: string; low: number | null; base: number | null; high: number | null; weight: number; basis: string; notes: string[] };
/** The weighted football field over the applicable methods; `dispersion` is max/min of the method bases (null when a base is not positive). */
export type Triangulation = { low: number; base: number; high: number; dispersion: number | null; weights: Record<ValuationMethodKey, number> };
/**
 * One scenario's value by method on its own path (the forward multiples at the peers' median), and the per-share value at
 * the judged weights renormalized over the methods that applied; `perShare` is what the range and the expected value use.
 */
export type ScenarioValuation = { methods: Record<ValuationMethodKey, number | null>; weights: Record<ValuationMethodKey, number>; perShare: number };
/** The model's judged weight of one method, with the reasons (business, life cycle, build phase, backlog, margin path, industry outlook) and evidence. */
export type MethodWeightJudgement = Judgement & { weight: number };
export type MethodWeights = Record<ValuationMethodKey, MethodWeightJudgement>;
/** The model's judged probability of one scenario, with the reasons and evidence; the four sum to 1. */
export type ScenarioProbability = Judgement & { probability: number };
export type ScenarioProbabilities = Record<ExtendedScenarioKey, ScenarioProbability>;
/** The base path against management's cited targets, one row per target the horizon covers, and the model's explanation of the gap. */
export type ManagementComparisonRow = { metric: ManagementTargetMetric; fiscalYear: number; year: number; target: number; base: number; gap: number };
export type ManagementComparison = { rows: ManagementComparisonRow[]; explanation: string; evidenceIds: string[] };
/** Whether a sell-side consensus could be cited: its source when it could, the reason when it could not. */
export type ConsensusNote = { status: "cited" | "unavailable"; source: string | null; reason: string | null };
export const GATE_STATUSES = ["pass", "flag", "fail"] as const;
export type GateStatus = typeof GATE_STATUSES[number];
/** A sanity gate: `fail` rejects the calculation, `flag` annotates it; `value` and `limit` are the figures compared. */
export type SanityGate = { key: string; status: GateStatus; detail: string; value: number | null; limit: number | null };
/** Contracted revenue by forecast year from the RPO buckets: a floor the revenue path should not fall under. */
export type RevenueAnchor = { source: "rpo"; asOf: string; total: number; floor: number[]; floorToRevenue0: number[]; notes: string[] };
export type InputCheck = { field: string; cited: number; expected: number | null; factIds: string[]; tolerance: number; status: GateStatus; detail: string };
/** The cited inputs checked against the registered facts: revenue, shares, the bridge against debt, leases, preferred and minority claims. */
export type InputVerification = { checks: InputCheck[]; ok: boolean };
export type MultipleQuartiles = { p25: number; median: number; p75: number; count: number };
/**
 * Where the comparable set came from, in priority order: the curated peer map in the repository, whole-company
 * business-tag pairs, segment-level (unit) pairs weighted by exposure, companies sharing a category, or none.
 */
export const PEER_SELECTION_BASES = ["curated", "ranking", "unit", "category", "none"] as const;
export type PeerSelectionBasis = typeof PEER_SELECTION_BASES[number];
/** The peers' trailing multiples at their reference closes; `peers` lists the tickers that answered, `weights` their share of the weighted quartiles (sum 1). */
export type PeerMultiples = { peers: string[]; asOf: string; evToEbitda: MultipleQuartiles | null; peRatio: MultipleQuartiles | null; notes: string[]; basis?: PeerSelectionBasis; weights?: Record<string, number> };
/** A sell-side consensus target the research registered with its evidence; compared, never copied. */
export type ConsensusTarget = { mean: number; low: number | null; high: number | null; count: number | null; asOf: string | null; evidenceId: string | null };

/* ---- Management targets: cited public statements by the company, stored as curated data and compared, never copied. ---- */

export const MANAGEMENT_TARGET_METRICS = ["revenue", "segment_revenue", "operating_margin", "eps", "capex", "fcf", "rpo"] as const;
export type ManagementTargetMetric = typeof MANAGEMENT_TARGET_METRICS[number];
export type ManagementTargetSource = { id: string; title: string; url: string; date: string };
/**
 * One target management stated for one fiscal year: a floor ("at least"), a ceiling ("at most"), a point target, or a
 * figure derived from stated ones (the derivation in `note`). Amounts in the company's currency base unit; margins as
 * 0–1 decimals; EPS per share. `basis` says whether the figure is GAAP or the company's non-GAAP presentation.
 */
export type ManagementTarget = {
  metric: ManagementTargetMetric;
  /** The segment or product line a `segment_revenue` target names. */
  segment?: string;
  fiscalYear: number;
  value: number;
  unit: "currency" | "ratio" | "per_share";
  basis: "gaap" | "non_gaap";
  kind: "target" | "floor" | "ceiling" | "derived";
  /** Source ids from the set's `sources`. */
  sourceIds: string[];
  note?: string;
};
export type ManagementTargetSet = {
  ticker: string;
  /** The month the fiscal year ends in (1–12), to place a fiscal-year target on a forecast year. */
  fiscalYearEndMonth: number;
  /** The date of the newest statement the set reflects. */
  asOf: string;
  sources: ManagementTargetSource[];
  targets: ManagementTarget[];
};
/** A reference scenario computed by code from cited inputs (the management case), shown beside the researched scenarios and never part of the range. */
export type ReferenceScenario = {
  key: "management";
  label: string;
  drivers: ModelDrivers;
  result: ScenarioResult;
  /** The weighted football field with the reference path as the base, when peer multiples were available. */
  triangulation: Triangulation | null;
  methods: MethodValuation[];
  /** The fiscal-year targets and the forecast year each landed on. */
  anchors: Array<{ metric: ManagementTargetMetric; fiscalYear: number; year: number; target: number; path: number | null }>;
  sources: ManagementTargetSource[];
  notes: string[];
};

/** A scenario as the model publishes it: the assumptions, the DCF result and (valuation.calc.v4) its method-weighted value. */
export type ScenarioEntry = ScenarioAssumptions & { result: ScenarioResult; valuation?: ScenarioValuation };
/**
 * The management scenario (valuation.calc.v4): drivers computed by code from management's cited targets on the model's own
 * rate, shares, bridge, horizon, tax and sales-to-capital, valued like the researched scenarios, with the probability the
 * model judged for it. It is part of the expected value, never the base.
 */
export type ManagementScenario = ScenarioEntry & {
  label: string;
  /** The weighted football field with the management path as the base, when peer multiples were available. */
  triangulation: Triangulation | null;
  methods: MethodValuation[];
  anchors: Array<{ metric: ManagementTargetMetric; fiscalYear: number; year: number; target: number; path: number | null }>;
  sources: ManagementTargetSource[];
  notes: string[];
};

export type ValuationModelResult = {
  calculatorVersion: string;
  modelType: ValuationModelType;
  currency: string;
  discountRate: DiscountRate;
  shares: ShareCount;
  bridge: EquityBridge;
  scenarios: Record<ScenarioKey, ScenarioEntry>;
  range: ValuationRange;
  sensitivities: Sensitivity[];
  implied: ImpliedPath | null;
  limitations: string[];
  /** Forecast years of the base path (5–10); absent on v1 payloads, which are five. */
  horizonYears?: number;
  midYear?: boolean;
  methods?: MethodValuation[];
  triangulation?: Triangulation | null;
  gates?: SanityGate[];
  anchors?: { revenue: RevenueAnchor | null };
  verification?: InputVerification | null;
  peers?: PeerMultiples | null;
  consensus?: ConsensusTarget | null;
  /** Reference scenarios computed from cited inputs beside the researched model (management case); written by valuation.calc.v2–v3, superseded by `managementScenario`. */
  references?: ReferenceScenario[];
  /* ---- valuation.calc.v4: judged weights and probabilities, the management scenario, the comparison and the consensus note. All optional; older payloads still read. ---- */
  methodWeights?: MethodWeights;
  scenarioProbabilities?: ScenarioProbabilities;
  managementScenario?: ManagementScenario | null;
  managementComparison?: ManagementComparison | null;
  consensusNote?: ConsensusNote | null;
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

export const EVIDENCE_KINDS = ["sec", "web", "fact"] as const;
export type EvidenceKind = typeof EVIDENCE_KINDS[number];
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
export const DIAGNOSTIC_UNITS = ["ratio", "percent", "years", "currency", "x"] as const;
export type DiagnosticMetric = { key: string; label: string; value: number | null; unit: typeof DIAGNOSTIC_UNITS[number]; periodEnd: string | null; note: string | null };

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
