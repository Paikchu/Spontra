import { z } from "zod";
import { CONFIDENCES, DIAGNOSTIC_UNITS, DISCOUNT_RATE_BASES, EVIDENCE_KINDS, FACT_BASES, GAP_CODES, GATE_STATUSES, MANAGEMENT_TARGET_METRICS, PEER_SELECTION_BASES, PERIOD_TYPES, REPORT_STATUSES, VALUATION_DIMENSIONS, VALUATION_METHODS, VALUATION_MODEL_TYPES, VERDICTS, type ModelDrivers, type ValuationPublication } from "../../analysis-contract/valuation.ts";

/** The stored publication as the read API and the page accept it; anything else reads as absent rather than half-drawn. */
const finite = z.number().finite();
const nullableFinite = finite.nullable();
const confidence = z.enum(CONFIDENCES);
const strings = z.array(z.string());
const gap = z.object({ code: z.enum(GAP_CODES), field: z.string().optional(), period: z.string().optional(), message: z.string(), evidenceIds: strings });
const dimension = z.object({ key: z.enum(VALUATION_DIMENSIONS), score: nullableFinite, confidence, rationale: z.string(), supportingEvidenceIds: strings, counterEvidenceIds: strings, gaps: strings, nextCheck: z.string() });
const fact = z.object({ id: z.string(), label: z.string(), value: finite, unit: z.string(), currency: z.string().nullable(), periodType: z.enum(PERIOD_TYPES), periodStart: z.string().nullable(), periodEnd: z.string().nullable(), basis: z.enum(FACT_BASES), formula: z.string().nullable(), sourceRefs: strings, rationale: z.string().nullable() });
const evidence = z.object({ evidenceId: z.string(), kind: z.enum(EVIDENCE_KINDS), title: z.string(), url: z.string().nullable(), documentId: z.string().nullable(), passageId: z.string().nullable(), form: z.string().nullable(), publishedAt: z.string().nullable(), fetchedAt: z.string().nullable(), excerpt: z.string(), contentSha256: z.string(), path: z.string().nullable() });
const numbers = z.array(finite);
const driverPath = z.object({ revenueGrowth: numbers, operatingMargin: numbers, taxRate: numbers, salesToCapital: numbers, normalization: numbers.optional(), buildCapex: numbers.optional() });
const drivers = z.discriminatedUnion("modelType", [
  z.object({ modelType: z.literal("fcff"), revenue0: finite, path: driverPath, terminalGrowth: finite, terminalRoic: finite, terminalOperatingMargin: finite.optional() }),
  z.object({ modelType: z.literal("fcfe"), cfo: finite, capex: finite, sbc: finite, normalization: finite, netBorrowing: finite, growth: numbers, terminalGrowth: finite }),
  z.object({ modelType: z.literal("revenue_fcfe"), revenue0: finite, growth: numbers, afterSbcEquityCashMargin: numbers, terminalGrowth: finite }),
  z.object({ modelType: z.literal("residual_income"), bookEquity0: finite, roe: numbers, payout: numbers, terminalRoe: finite, terminalGrowth: finite }),
  z.object({ modelType: z.literal("earnings_multiple"), epsLow: finite, epsHigh: finite, weight: finite, multiple: finite, horizonYears: finite }),
  z.object({ modelType: z.literal("reported_earnings_multiple"), commonEarnings: finite, earningsScale: finite, multiple: finite, horizonYears: finite }),
  z.object({ modelType: z.literal("proforma_earnings_multiple"), commonEarnings: finite, earningsScale: finite, multiple: finite, horizonYears: finite }),
  z.object({ modelType: z.literal("asset_nav"), assets: z.array(z.object({ units: finite, price: finite, costBasis: finite, taxRate: finite })), otherNetAssets: finite, debtClaims: finite, preferredClaims: finite, operatingReserve: finite }),
  z.object({ modelType: z.literal("affo_multiple"), affoLow: finite, affoHigh: finite, weight: finite, recurringCostPerShare: finite, multiple: finite, horizonYears: finite }),
  z.object({ modelType: z.literal("affo_dcf"), annualAffo: finite, recurringCost: finite, growth: numbers, terminalGrowth: finite }),
]) satisfies z.ZodType<ModelDrivers>;
const yearRow = z.object({ year: z.number(), revenue: nullableFinite, nopat: nullableFinite, reinvestment: nullableFinite, cashFlow: finite, discountFactor: finite, presentValue: finite, buildCapex: nullableFinite.optional() });
// valuation.calc.v2 additions, all optional so a v1 payload still reads (docs/valuation-v2-SPEC.md).
const gateStatus = z.enum(GATE_STATUSES);
const quartiles = z.object({ p25: finite, median: finite, p75: finite, count: z.number() });
const method = z.object({ method: z.enum(VALUATION_METHODS), label: z.string(), low: nullableFinite, base: nullableFinite, high: nullableFinite, weight: finite, basis: z.string(), notes: strings });
const triangulation = z.object({ low: finite, high: finite, base: finite, dispersion: nullableFinite, weights: z.record(z.enum(VALUATION_METHODS), finite) });
const gateRow = z.object({ key: z.string(), status: gateStatus, detail: z.string(), value: nullableFinite, limit: nullableFinite });
const anchor = z.object({ source: z.literal("rpo"), asOf: z.string(), total: finite, floor: z.array(finite), floorToRevenue0: z.array(finite), notes: strings });
const verification = z.object({ checks: z.array(z.object({ field: z.string(), cited: finite, expected: nullableFinite, factIds: strings, tolerance: finite, status: gateStatus, detail: z.string() })), ok: z.boolean() });
const peers = z.object({ peers: strings, asOf: z.string(), evToEbitda: quartiles.nullable(), peRatio: quartiles.nullable(), notes: strings, basis: z.enum(PEER_SELECTION_BASES).optional(), weights: z.record(z.string(), finite).optional() });
const managementSource = z.object({ id: z.string(), title: z.string(), url: z.string(), date: z.string() });
const reference = z.object({
  key: z.literal("management"), label: z.string(), drivers, result: z.lazy(() => scenarioResult), triangulation: z.lazy(() => triangulation).nullable(), methods: z.array(z.lazy(() => method)),
  anchors: z.array(z.object({ metric: z.enum(MANAGEMENT_TARGET_METRICS), fiscalYear: z.number(), year: z.number(), target: finite, path: nullableFinite })), sources: z.array(managementSource), notes: strings,
});
const consensus = z.object({ mean: finite, low: nullableFinite, high: nullableFinite, count: z.number().nullable(), asOf: z.string().nullable(), evidenceId: z.string().nullable() });
const scenarioResult = z.object({ perShare: finite, equityValue: finite, enterpriseValue: nullableFinite, pvExplicit: nullableFinite, pvTerminal: nullableFinite, terminalShare: nullableFinite, yearly: z.array(yearRow), notes: strings });
const scenario = z.object({ narrative: z.string(), probability: nullableFinite, triggers: strings, invalidation: strings, evidenceIds: strings, drivers, result: scenarioResult });
const model = z.object({
  calculatorVersion: z.string(), modelType: z.enum(VALUATION_MODEL_TYPES), currency: z.string(),
  discountRate: z.object({ value: finite, basis: z.enum(DISCOUNT_RATE_BASES), components: z.object({ riskFree: nullableFinite, beta: nullableFinite, equityRiskPremium: nullableFinite, costOfEquity: nullableFinite, costOfDebt: nullableFinite, taxRate: nullableFinite, equityWeight: nullableFinite }), rationale: z.string(), sourceRefs: strings }),
  shares: z.object({ base: finite, dilutionReserve: finite, economic: finite, basis: z.string() }),
  bridge: z.object({ nonOperatingAssets: finite, debtAndClaims: finite, nonOperatingEquityAdjustment: finite, notes: strings }),
  scenarios: z.object({ bear: scenario, base: scenario, bull: scenario }),
  range: z.object({ low: finite, high: finite, base: finite, expected: nullableFinite, price: nullableFinite, marginOfSafety: nullableFinite, downsideCoverage: nullableFinite, expectedUpside: nullableFinite, baseUpside: nullableFinite }),
  sensitivities: z.array(z.object({ factor: z.string(), step: z.string(), perShare: finite, changePercent: finite })),
  implied: z.object({ factor: z.literal("revenueGrowth"), implied: finite, baseAverage: finite, gap: finite, converged: z.boolean() }).nullable(),
  limitations: strings,
  horizonYears: z.number().optional(), midYear: z.boolean().optional(),
  methods: z.array(method).optional(), triangulation: triangulation.nullable().optional(), gates: z.array(gateRow).optional(),
  anchors: z.object({ revenue: anchor.nullable() }).optional(), verification: verification.nullable().optional(), peers: peers.nullable().optional(), consensus: consensus.nullable().optional(),
  references: z.array(reference).optional(),
});
const sections = z.object({ summary: z.string(), thesis: z.string(), expectationsGap: z.string(), catalysts: strings, counterEvidence: strings, nextChecks: strings, modelNotes: z.string() });
const publication = z.object({
  schemaVersion: z.literal("valuation.v1"), ticker: z.string(), cik: z.string().nullable(), companyName: z.string(), currency: z.string(),
  researchAsOf: z.string(), financialPeriodEnd: z.string(), generatedAt: z.string(), methodVersion: z.string(), calculatorVersion: z.string(),
  baseInputFingerprint: z.string(), evidenceSetHash: z.string(), reportStatus: z.enum(REPORT_STATUSES), verdict: z.enum(VERDICTS),
  weightedScore: nullableFinite, confidence, dimensions: z.array(dimension),
  quote: z.object({ price: finite, currency: z.string(), priceDate: z.string(), source: z.string(), sourceUrl: z.string(), fetchedAt: z.string(), usable: z.boolean(), limitations: strings }).nullable(),
  model: model.nullable(), facts: z.array(fact),
  diagnostics: z.array(z.object({ key: z.string(), label: z.string(), value: nullableFinite, unit: z.enum(DIAGNOSTIC_UNITS), periodEnd: z.string().nullable(), note: z.string().nullable() })),
  distributions: z.array(z.object({ factor: z.string(), periods: z.array(z.object({ periodEnd: z.string(), value: finite })), min: finite, p25: finite, median: finite, p75: finite, max: finite })),
  sections, evidence: z.array(evidence), gaps: z.array(gap), versionId: z.string(),
}) satisfies z.ZodType<ValuationPublication>;

/** A stored report for the ticker, or null when it does not match the contract. */
export function readValuationPublication(value: unknown, ticker: string): ValuationPublication | null {
  const parsed = publication.safeParse(value);
  if (!parsed.success || parsed.data.ticker !== ticker.trim().toUpperCase()) return null;
  if (parsed.data.dimensions.length !== VALUATION_DIMENSIONS.length || new Set(parsed.data.dimensions.map(d => d.key)).size !== VALUATION_DIMENSIONS.length) return null;
  return parsed.data;
}
