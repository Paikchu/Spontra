import { z } from "zod";
import { GAP_CODES, VALUATION_DIMENSIONS, VALUATION_MODEL_TYPES, type ValuationPublication } from "../../analysis-contract/valuation.ts";

/** The stored publication as the read API and the page accept it; anything else reads as absent rather than half-drawn. */
const finite = z.number().finite();
const nullableFinite = finite.nullable();
const confidence = z.enum(["high", "medium", "low"]);
const strings = z.array(z.string());
const gap = z.object({ code: z.enum(GAP_CODES), field: z.string().optional(), period: z.string().optional(), message: z.string(), evidenceIds: strings });
const dimension = z.object({ key: z.enum(VALUATION_DIMENSIONS), score: nullableFinite, confidence, rationale: z.string(), supportingEvidenceIds: strings, counterEvidenceIds: strings, gaps: strings, nextCheck: z.string() });
const fact = z.object({ id: z.string(), label: z.string(), value: finite, unit: z.string(), currency: z.string().nullable(), periodType: z.enum(["quarter", "ttm", "fiscal_year", "instant"]), periodStart: z.string().nullable(), periodEnd: z.string().nullable(), basis: z.enum(["reported", "derived", "company_guidance", "assumption"]), formula: z.string().nullable(), sourceRefs: strings, rationale: z.string().nullable() });
const evidence = z.object({ evidenceId: z.string(), kind: z.enum(["sec", "web", "fact"]), title: z.string(), url: z.string().nullable(), documentId: z.string().nullable(), passageId: z.string().nullable(), form: z.string().nullable(), publishedAt: z.string().nullable(), fetchedAt: z.string().nullable(), excerpt: z.string(), contentSha256: z.string(), path: z.string().nullable() });
const yearRow = z.object({ year: z.number(), revenue: nullableFinite, nopat: nullableFinite, reinvestment: nullableFinite, cashFlow: finite, discountFactor: finite, presentValue: finite });
const scenarioResult = z.object({ perShare: finite, equityValue: finite, enterpriseValue: nullableFinite, pvExplicit: nullableFinite, pvTerminal: nullableFinite, terminalShare: nullableFinite, yearly: z.array(yearRow), notes: strings });
const scenario = z.object({ narrative: z.string(), probability: nullableFinite, triggers: strings, invalidation: strings, evidenceIds: strings, drivers: z.looseObject({ modelType: z.enum(VALUATION_MODEL_TYPES) }), result: scenarioResult });
const model = z.object({
  calculatorVersion: z.string(), modelType: z.enum(VALUATION_MODEL_TYPES), currency: z.string(),
  discountRate: z.object({ value: finite, basis: z.enum(["wacc", "cost_of_equity"]), components: z.object({ riskFree: nullableFinite, beta: nullableFinite, equityRiskPremium: nullableFinite, costOfEquity: nullableFinite, costOfDebt: nullableFinite, taxRate: nullableFinite, equityWeight: nullableFinite }), rationale: z.string(), sourceRefs: strings }),
  shares: z.object({ base: finite, dilutionReserve: finite, economic: finite, basis: z.string() }),
  bridge: z.object({ nonOperatingAssets: finite, debtAndClaims: finite, nonOperatingEquityAdjustment: finite, notes: strings }),
  scenarios: z.object({ bear: scenario, base: scenario, bull: scenario }),
  range: z.object({ low: finite, high: finite, base: finite, expected: nullableFinite, price: nullableFinite, marginOfSafety: nullableFinite, downsideCoverage: nullableFinite, expectedUpside: nullableFinite, baseUpside: nullableFinite }),
  sensitivities: z.array(z.object({ factor: z.string(), step: z.string(), perShare: finite, changePercent: finite })),
  implied: z.object({ factor: z.literal("revenueGrowth"), implied: finite, baseAverage: finite, gap: finite, converged: z.boolean() }).nullable(),
  limitations: strings,
});
const sections = z.object({ summary: z.string(), thesis: z.string(), expectationsGap: z.string(), catalysts: strings, counterEvidence: strings, nextChecks: strings, modelNotes: z.string() });
const publication = z.object({
  schemaVersion: z.literal("valuation.v1"), ticker: z.string(), cik: z.string().nullable(), companyName: z.string(), currency: z.string(),
  researchAsOf: z.string(), financialPeriodEnd: z.string(), generatedAt: z.string(), methodVersion: z.string(), calculatorVersion: z.string(),
  baseInputFingerprint: z.string(), evidenceSetHash: z.string(), reportStatus: z.enum(["ready", "insufficient"]), verdict: z.enum(["supported", "not_supported", "pending"]),
  weightedScore: nullableFinite, confidence, dimensions: z.array(dimension),
  quote: z.object({ price: finite, currency: z.string(), priceDate: z.string(), source: z.string(), sourceUrl: z.string(), fetchedAt: z.string(), usable: z.boolean(), limitations: strings }).nullable(),
  model: model.nullable(), facts: z.array(fact),
  diagnostics: z.array(z.object({ key: z.string(), label: z.string(), value: nullableFinite, unit: z.enum(["ratio", "percent", "years", "currency", "x"]), periodEnd: z.string().nullable(), note: z.string().nullable() })),
  distributions: z.array(z.object({ factor: z.string(), periods: z.array(z.object({ periodEnd: z.string(), value: finite })), min: finite, p25: finite, median: finite, p75: finite, max: finite })),
  sections, evidence: z.array(evidence), gaps: z.array(gap), versionId: z.string(),
});

/** A stored report for the ticker, or null when it does not match the contract. */
export function readValuationPublication(value: unknown, ticker: string): ValuationPublication | null {
  const parsed = publication.safeParse(value);
  if (!parsed.success || parsed.data.ticker !== ticker.trim().toUpperCase()) return null;
  if (parsed.data.dimensions.length !== VALUATION_DIMENSIONS.length || new Set(parsed.data.dimensions.map(d => d.key)).size !== VALUATION_DIMENSIONS.length) return null;
  return parsed.data as ValuationPublication;
}
