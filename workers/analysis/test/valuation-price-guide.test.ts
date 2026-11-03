import assert from "node:assert/strict";
import { test } from "node:test";
import { VALUATION_DIMENSIONS, type FairValueBasis, type ModelDrivers, type NormalCaseInput, type ReferenceQuote, type ScenarioAssumptions, type ValuationPublication } from "../../../shared/analysis-contract/valuation.ts";
import { calculateValuation, type CalcRequest } from "../../../shared/analysis-runtime/valuation/calculator.ts";
import { priceGuideOf, readPriceGuide } from "../../../shared/analysis-runtime/valuation/price-guide.ts";

const evidenceId = "eabcdef1234";
const asOf = "2026-11-03T00:00:00.000Z";
const path = (growth: number, margin: number): ModelDrivers => ({ modelType: "fcff", revenue0: 1000, path: { revenueGrowth: Array(5).fill(growth), operatingMargin: Array(5).fill(margin), taxRate: Array(5).fill(0.2), salesToCapital: Array(5).fill(2) }, terminalGrowth: 0.02, terminalRoic: 0.15 });
const scenario = (growth: number, margin: number, probability: number): ScenarioAssumptions => ({ drivers: path(growth, margin), probability, narrative: "A researched operating path.", triggers: ["Demand follows the plan."], invalidation: ["Demand changes structurally."], evidenceIds: [evidenceId] });
const normal = (growth: number, margin: number): NormalCaseInput => ({ drivers: path(growth, margin), narrative: "Ordinary renewal and utilization variation.", triggers: ["Renewals hold."], invalidation: ["A structural demand shock."], evidenceIds: [evidenceId], assumptions: { revenue: { rationale: "Renewal volumes stay within the disclosed range.", evidenceIds: [evidenceId] }, margin: { rationale: "Utilization stays in the normal range.", evidenceIds: [evidenceId] }, capex: { rationale: "Investment follows the operating plan.", evidenceIds: [evidenceId] } } });
const fairValueBasis = (): FairValueBasis => ({ status: "available", kind: "normal_cases", lower: normal(0.08, 0.24), upper: normal(0.12, 0.26), rationale: "Independently evidenced ordinary renewal and utilization variation sets the normal operating bounds.", evidenceIds: [evidenceId] });
const request = (): CalcRequest => ({ modelType: "fcff", currency: "USD", discountRate: { value: 0.1, basis: "wacc", components: { riskFree: 0.045, beta: 1, equityRiskPremium: 0.05, costOfEquity: 0.095, costOfDebt: 0.06, taxRate: 0.2, equityWeight: 0.9 }, rationale: "Sourced components.", sourceRefs: [] }, shares: { base: 100, dilutionReserve: 0, basis: "shares_outstanding" }, bridge: { nonOperatingAssets: 50, debtAndClaims: 100, nonOperatingEquityAdjustment: 0, notes: [] }, price: 30, scenarios: { bear: scenario(0.02, 0.2, 0.25), base: scenario(0.1, 0.25, 0.5), bull: scenario(0.18, 0.3, 0.25) }, fairValueBasis: fairValueBasis() });
const quote = (patch: Partial<ReferenceQuote> = {}): ReferenceQuote => ({ price: 30, currency: "USD", priceDate: "2026-11-02", source: "Fixture close", sourceUrl: "https://example.test/history", fetchedAt: asOf, usable: true, limitations: [], ...patch });
function report(): ValuationPublication {
  return { schemaVersion: "valuation.v1", ticker: "TST", cik: null, companyName: "Test company", currency: "USD", researchAsOf: "2026-11-02T00:00:00.000Z", financialPeriodEnd: "2026-08-31", generatedAt: "2026-11-02T00:00:00.000Z", methodVersion: "valuation.v6", calculatorVersion: "valuation.calc.v5", baseInputFingerprint: "input", evidenceSetHash: "evidence", reportStatus: "ready", verdict: "not_supported", weightedScore: 5, confidence: "medium", dimensions: VALUATION_DIMENSIONS.map(key => ({ key, score: 5, confidence: "medium", rationale: "The reviewed evidence supports the operating assumptions.", supportingEvidenceIds: [evidenceId], counterEvidenceIds: [], gaps: [], nextCheck: "Next quarterly release." })), quote: quote({ price: 25, priceDate: "2026-10-30", fetchedAt: "2026-11-02T00:00:00.000Z" }), model: calculateValuation(request()), facts: [{ id: "revenue_ttm", label: "Revenue", value: 1000, unit: "USD", currency: "USD", periodType: "ttm", periodStart: null, periodEnd: "2026-08-31", basis: "reported", formula: null, sourceRefs: [evidenceId], rationale: null }], diagnostics: [{ key: "roic", label: "Return on invested capital", value: 0.15, unit: "percent", periodEnd: "2026-08-31", note: null }], distributions: [], sections: { summary: "Reviewed normal operating bounds.", thesis: "Operating conditions are stable.", expectationsGap: "No exceptional opportunity inferred.", catalysts: [], counterEvidence: [], nextChecks: [], modelNotes: "" }, evidence: [{ evidenceId, kind: "sec", title: "Test filing", url: "https://example.test/filing", documentId: "filing", passageId: "passage", form: "10-Q", publishedAt: "2026-09-15", fetchedAt: "2026-11-02", excerpt: "Renewals and utilization remained in their normal ranges.", contentSha256: "content", path: "Operations" }], gaps: [], versionId: "immutable-report" };
}
function fairOf(r: ValuationPublication) { const fair = r.model?.fairValueRange; assert.ok(fair?.status === "available"); return fair; }
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
const reasonOf = (r: ValuationPublication | null, q: ReferenceQuote | null, at = asOf, outdated = false) => { const guide = priceGuideOf({ report: r, quote: q, asOf: at, outdated }); assert.equal(guide.status, "unavailable"); return guide.status === "unavailable" ? guide.reason : null; };

// Prices and operating paths here are synthetic test data, never a company valuation.
test("price guide includes both fair-value boundaries and uses explicit price/valuation denominators", () => {
  const r = report(), fair = fairOf(r);
  for (const [price, position] of [[fair.low - 0.01, "below"], [fair.low, "within"], [fair.base, "within"], [fair.high, "within"], [fair.high + 0.01, "above"]] as const) {
    const guide = priceGuideOf({ report: r, quote: quote({ price }), asOf });
    assert.ok(guide.status === "available");
    assert.equal(guide.position, position);
    assert.equal(guide.reportVersionId, r.versionId);
    close(guide.gapToLow, fair.low / price - 1);
    close(guide.gapToBase, fair.base / price - 1);
    close(guide.gapToHigh, fair.high / price - 1);
    close(guide.discountToBase, 1 - price / fair.base);
  }
  assert.equal(r.verdict, "not_supported", "investment verdict is independent from the price classification");
});

test("old reports and explicit unavailable normal bounds do not borrow bear/bull or consensus values", () => {
  assert.equal(reasonOf(null, quote()), "no_range");
  const legacy = report(); assert.ok(legacy.model); delete legacy.model.fairValueRange;
  assert.equal(reasonOf(legacy, quote()), "no_range");
  legacy.model.fairValueRange = { status: "unavailable", reason: "Normal capital requirements cannot yet be established.", evidenceIds: [] };
  assert.equal(reasonOf(legacy, quote()), "no_range");
});

test("price guide rejects missing/unknown endpoint evidence and incomplete or contradicted research", () => {
  const missing = report(); fairOf(missing).lower.assumptions.capex.evidenceIds = [];
  assert.equal(reasonOf(missing, quote()), "unresolved_evidence");
  const unknown = report(); fairOf(unknown).upper.evidenceIds = ["e0000000000"];
  assert.equal(reasonOf(unknown, quote()), "unresolved_evidence");
  const noSource = report(); noSource.evidence = [];
  assert.equal(reasonOf(noSource, quote()), "unresolved_evidence");
  const incomplete = report(); incomplete.reportStatus = "insufficient";
  assert.equal(reasonOf(incomplete, quote()), "incomplete_research");
  for (const code of ["identity_mismatch", "conflicting_sources", "calculation_rejected", "review_incomplete", "unresolved_counter_evidence"] as const) {
    const r = report(); r.gaps.push({ code, message: "Unresolved review finding.", evidenceIds: [evidenceId] });
    assert.equal(reasonOf(r, quote()), "unresolved_evidence", code);
  }
  const failed = report(); assert.ok(failed.model); failed.model.gates = [{ key: "cited_inputs", status: "fail", detail: "Financial inputs do not match.", value: 900, limit: 1000 }];
  assert.equal(reasonOf(failed, quote()), "unresolved_evidence");
});

test("price guide recognizes the registered facts and diagnostic keys accepted by the valuation tool", () => {
  const fact = report(); fairOf(fact).lower.assumptions.revenue.evidenceIds = ["revenue_ttm"];
  assert.equal(priceGuideOf({ report: fact, quote: quote(), asOf }).status, "available");
  const diagnostic = report(); fairOf(diagnostic).upper.assumptions.capex.evidenceIds = ["roic"];
  assert.equal(priceGuideOf({ report: diagnostic, quote: quote(), asOf }).status, "available", "tools.checkIds accepts recorded diagnostic keys as sources");
});

test("price guide rejects missing, unusable, stale, future and mismatched-currency quotes", () => {
  const r = report();
  assert.equal(reasonOf(r, null), "no_quote");
  assert.equal(reasonOf(r, quote({ usable: false })), "unusable_quote");
  for (const price of [0, -1, NaN, Infinity]) assert.equal(reasonOf(r, quote({ price })), "unusable_quote");
  assert.equal(reasonOf(r, quote({ currency: "EUR" })), "currency_mismatch");
  const wrongModelCurrency = report(); assert.ok(wrongModelCurrency.model); wrongModelCurrency.model.currency = "EUR";
  assert.equal(reasonOf(wrongModelCurrency, quote()), "currency_mismatch");
  assert.equal(priceGuideOf({ report: r, quote: quote({ priceDate: "2026-10-27" }), asOf }).status, "available", "seven days is the inclusive freshness boundary");
  assert.equal(reasonOf(r, quote({ priceDate: "2026-10-26" })), "stale_quote");
  assert.equal(reasonOf(r, quote({ priceDate: "2026-11-04" })), "stale_quote");
  assert.equal(reasonOf(r, quote({ priceDate: "not-a-date" })), "stale_quote");
});

test("historical asOf uses the historical close and report, while a report being updated has no price classification", () => {
  const historical = report(); historical.researchAsOf = "2026-09-16T00:00:00.000Z"; historical.generatedAt = asOf;
  const historicalQuote = quote({ priceDate: "2026-09-15", fetchedAt: asOf });
  assert.equal(priceGuideOf({ report: historical, quote: historicalQuote, asOf: historical.researchAsOf }).status, "available", "retrieving historical closes later does not change their dated meaning");
  assert.equal(reasonOf(historical, historicalQuote), "stale_quote", "today's classification cannot use that historical close");
  assert.equal(reasonOf(report(), quote(), asOf, true), "report_updating");
  const futureResearch = report(); futureResearch.researchAsOf = "2026-11-04T00:00:00.000Z";
  assert.equal(reasonOf(futureResearch, quote()), "incomplete_research", "research unavailable by asOf cannot classify a past price");
});

test("new quotes produce new comparisons without changing the immutable report or its frozen market inputs", () => {
  const r = report(), fair = fairOf(r), before = JSON.stringify(r);
  const freeze = (value: unknown): void => { if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } };
  freeze(r);
  const below = priceGuideOf({ report: r, quote: quote({ price: fair.low - 1 }), asOf });
  const above = priceGuideOf({ report: r, quote: quote({ price: fair.high + 1 }), asOf });
  assert.ok(below.status === "available" && above.status === "available");
  assert.equal(below.position, "below"); assert.equal(above.position, "above");
  assert.equal(below.reportVersionId, above.reportVersionId);
  assert.equal(JSON.stringify(r), before);
  assert.equal(r.quote?.price, 25); assert.equal(r.model?.range.price, 30);
  assert.deepEqual(readPriceGuide(JSON.parse(JSON.stringify(below))), below);
  assert.equal(readPriceGuide({ ...below, position: "buy" }), undefined);
  assert.equal(readPriceGuide({ ...below, quote: { ...below.quote, priceDate: "not-a-date" } }), undefined);
  assert.equal(readPriceGuide({ ...below, gapToBase: Infinity }), undefined);
});
