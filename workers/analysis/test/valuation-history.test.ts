import assert from "node:assert/strict";
import test from "node:test";
import { evaluateHistory, historyAssumptionsSchema, historyRequest, readHistoryInput, type HistoryInput, type HistoryOutcome } from "../../../shared/analysis-runtime/valuation/history.ts";

const hash = "a".repeat(64);
function fixture(): HistoryInput {
  return {
    schemaVersion: "valuation-history-input.v1", ticker: "TEST", currency: "USD", cutoff: "2025-12-12T21:00:00Z", financialPeriodEnd: "2025-11-30", cutoffPolicy: "after filing",
    sources: [{ id: "filing", kind: "sec_filing", url: "https://example.org/filing", availableAt: "2025-12-11T21:07:00Z", path: "filing.html", sha256: hash }, { id: "market", kind: "market_daily", url: "https://example.org/prices", availableAt: "2025-12-12T21:00:00Z", path: "prices.json", sha256: hash }],
    facts: [{ id: "shares_outstanding", label: "shares", value: 100, unit: "shares", currency: null, periodType: "instant", periodStart: null, periodEnd: "2025-11-30", basis: "reported", formula: null, sourceRefs: ["filing"], rationale: null }],
    management: null,
    market: { quote: { price: 100, priceDate: "2025-12-12", sourceId: "market" }, riskFree: { value: 0.04, date: "2025-12-12", sourceId: "market" }, beta: null, series: [{ symbol: "TEST", sourceId: "market", bars: [{ date: "2025-12-12", closeAt: "2025-12-12T21:00:00Z", close: 100, dividend: 0 }] }] },
    peers: [], researchMaterials: [{ sourceId: "filing", title: "Filing", text: "Demand grew, but capital expenditures increased.", sha256: hash }], missing: [], limitations: [],
  };
}
function assumptions() {
  const scenario = { narrative: "A disclosed-data scenario", probability: null, triggers: ["Demand continues"], invalidation: ["Demand falls"], evidenceIds: ["e0123456789"], drivers: { modelType: "fcff", revenue0: 1000, path: { revenueGrowth: [0.1, 0.1, 0.05, 0.03, 0.02], operatingMargin: [0.2, 0.2, 0.2, 0.2, 0.2], taxRate: [0.2, 0.2, 0.2, 0.2, 0.2], salesToCapital: [2, 2, 2, 2, 2] }, terminalGrowth: 0.02, terminalRoic: 0.15 } };
  return historyAssumptionsSchema.parse({
    schemaVersion: "valuation-history-assumptions.v1", kind: "agent_reconstruction", ticker: "TEST", cutoff: "2025-12-12T21:00:00Z", inputSha256: hash, producedAt: "2026-11-02T00:00:00Z", model: "test-model", promptSha256: hash, transcriptPath: "agent-transcript.json", shareBasisFactId: "shares_outstanding",
    request: { modelType: "fcff", currency: "USD", discountRate: { value: 0.1, basis: "wacc", components: { riskFree: 0.04, beta: 1, equityRiskPremium: 0.05, costOfEquity: 0.09, costOfDebt: 0.06, taxRate: 0.2, equityWeight: 0.8 }, rationale: "test assumptions", sourceRefs: ["market"] }, shares: { base: 100, dilutionReserve: 0, basis: "shares_outstanding" }, bridge: { nonOperatingAssets: 20, debtAndClaims: 30, nonOperatingEquityAdjustment: 0, notes: [] }, price: 999, scenarios: { bear: scenario, base: scenario, bull: scenario }, context: { facts: [{ id: "wrong", value: 10, unit: "USD" }] } },
    evidence: [{ evidenceId: "e0123456789", kind: "sec", title: "Filing", url: "https://example.org/filing", documentId: "snapshot:filing", passageId: "p1", form: "10-Q", publishedAt: "2025-12-11", fetchedAt: "2026-11-02T00:00:00Z", excerpt: "Demand grew, but capital expenditures increased.", contentSha256: hash, path: "snapshot" }],
    operatingForecasts: [{ metric: "revenue", periodStart: "2025-12-01", periodEnd: "2026-02-28", value: 1200, unit: "USD", basis: "gaap" }],
  });
}
function outcome(): HistoryOutcome {
  return { schemaVersion: "valuation-history-outcome.v1", ticker: "TEST", cutoff: "2025-12-12T21:00:00Z", inputSha256: hash, evaluationAsOf: "2026-02-01T00:00:00Z", market: [{ date: "2026-01-12", closeAt: "2026-01-12T21:00:00Z", close: 110, dividend: 1 }], benchmark: [{ date: "2025-12-12", closeAt: "2025-12-12T21:00:00Z", close: 100, dividend: 0 }, { date: "2026-01-12", closeAt: "2026-01-12T21:00:00Z", close: 105, dividend: 0 }], actuals: [{ metric: "revenue", periodStart: "2025-12-01", periodEnd: "2026-02-28", value: 1150, unit: "USD", basis: "gaap", availableAt: "2026-03-10T21:00:00Z", sourceId: "future-filing" }] };
}

test("historical input rejects future sources and future management plans", () => {
  const input = fixture(); input.sources[0]!.availableAt = "2025-12-13T00:00:00Z";
  assert.throws(() => readHistoryInput(input), /Future source/);
  const next = fixture(); next.management = { ticker: "TEST", fiscalYearEndMonth: 5, asOf: "2026-10-28", sources: [{ id: "filing", title: "new plan", date: "2026-10-28", url: "https://example.org/filing" }], targets: [{ metric: "revenue", fiscalYear: 2027, value: 100, unit: "currency", basis: "gaap", kind: "target", sourceIds: ["filing"] }] };
  assert.throws(() => readHistoryInput(next), /Future or mismatched management/);
});

test("a bar dated before the cutoff but closing after it is not available", () => {
  const input = fixture(); input.market.series[0]!.bars[0]!.closeAt = "2025-12-15T21:00:00Z";
  assert.throws(() => readHistoryInput(input), /Future market bar/);
});

test("future actuals remain pending until disclosed and target returns wait for maturity", () => {
  const result = evaluateHistory(readHistoryInput(fixture()), assumptions(), outcome(), hash);
  assert.equal(result.operating[0]!.status, "pending");
  assert.equal(result.market.find(x => x.months === 12)!.status, "pending");
  const first = result.market[0]!;
  assert.equal(first.status, "observed");
  assert.ok("totalReturn" in first && first.totalReturn != null && Math.abs(first.totalReturn - 0.11) < 1e-9);
  const later = outcome(); later.evaluationAsOf = "2026-03-11T00:00:00Z";
  assert.equal(evaluateHistory(readHistoryInput(fixture()), assumptions(), later, hash).operating[0]!.status, "observed");
});

test("facts cannot cite a source outside their frozen snapshot", () => {
  const input = fixture(); input.facts[0]!.sourceRefs = ["latest-quarter"];
  assert.throws(() => readHistoryInput(input), /Unresolved historical source/);
});

test("registered Agent evidence must resolve to eligible source text and context stays frozen", () => {
  const seed = fixture();
  seed.sources.unshift({ id: "same-filing-facts", kind: "sec_fact_extract", url: "https://example.org/filing", availableAt: "2025-12-11T21:07:00Z", path: "fact-extract.json", sha256: hash });
  const input = readHistoryInput(seed), agent = assumptions();
  const request = historyRequest(input, agent, hash);
  assert.equal(request.price, 100);
  assert.equal(request.context?.facts?.[0]?.id, "shares_outstanding");
  agent.evidence[0]!.excerpt = "Revenue doubled next year";
  assert.throws(() => historyRequest(input, agent, hash), /excerpt is absent/);
  assert.throws(() => historyRequest(input, assumptions(), "b".repeat(64)), /do not belong/);
});

test("a stale last close is not an observed target-date result", () => {
  const data = outcome(); data.market[0] = { date: "2025-12-15", closeAt: "2025-12-15T21:00:00Z", close: 110, dividend: 0 };
  assert.equal(evaluateHistory(readHistoryInput(fixture()), assumptions(), data, hash).market[0]!.status, "pending");
});
