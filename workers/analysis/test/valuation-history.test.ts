import assert from "node:assert/strict";
import test from "node:test";
import { evaluateHistory, historyAssumptionsSchema, historyOutcomeSchema, historyRequest, readHistoryInput, replayHistory, type HistoryInput, type HistoryOutcome } from "../../../shared/analysis-runtime/valuation/history.ts";

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
    operatingForecasts: [{ metric: "revenue", periodStart: "2025-12-01", periodEnd: "2026-02-28", value: 1200, unit: "USD", basis: "gaap", rationale: "The filing's disclosed demand supports this next-quarter estimate.", evidenceIds: ["e0123456789"] }],
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
  const unknownForecast = assumptions(); unknownForecast.operatingForecasts[0]!.evidenceIds = ["future-guidance"];
  assert.throws(() => historyRequest(input, unknownForecast, hash), /Unresolved Agent citation/);
  agent.evidence[0]!.excerpt = "Revenue doubled next year";
  assert.throws(() => historyRequest(input, agent, hash), /excerpt is absent/);
  assert.throws(() => historyRequest(input, assumptions(), "b".repeat(64)), /do not belong/);
});

test("a stale last close is not an observed target-date result", () => {
  const data = outcome(); data.market[0] = { date: "2025-12-15", closeAt: "2025-12-15T21:00:00Z", close: 110, dividend: 0 };
  assert.equal(evaluateHistory(readHistoryInput(fixture()), assumptions(), data, hash).market[0]!.status, "pending");
});

function explicitArtifact() {
  const agent = assumptions(), fill = (n: number) => Array.from({ length: 5 }, () => n);
  const plan = { capex: [100, 90, 80, 70, 60], depreciation: [30, 35, 40, 45, 50], workingCapitalChange: [15, -20, 10, 10, 10] };
  const drivers = (growth: number, margin: number) => ({ modelType: "fcff", revenue0: 1000, path: { revenueGrowth: fill(growth), operatingMargin: fill(margin), taxRate: fill(0.2), capitalPlan: plan }, terminalGrowth: 0.02, terminalRoic: 0.15 });
  const judgement = { rationale: "The frozen filing supports this normal operating path.", evidenceIds: ["e0123456789"] };
  const normal = (growth: number, margin: number) => ({ narrative: "Normal demand and investment execution.", triggers: ["Demand follows the disclosed path."], invalidation: ["Structural demand impairment."], evidenceIds: ["e0123456789"], drivers: drivers(growth, margin), assumptions: { revenue: judgement, margin: judgement, capex: judgement } });
  const component = { source: "Frozen market and filing inputs", evidenceIds: ["market"] };
  return {
    ...agent,
    request: {
      ...agent.request,
      discountRate: { ...agent.request.discountRate, sources: { riskFree: component, beta: component, equityRiskPremium: component, costOfDebt: component, taxRate: component, equityWeight: component } },
      scenarios: {
        bear: { ...agent.request.scenarios.bear, drivers: drivers(0.02, 0.2) },
        base: { ...agent.request.scenarios.base, drivers: drivers(0.1, 0.25) },
        bull: { ...agent.request.scenarios.bull, drivers: drivers(0.18, 0.3) },
      },
      fairValueBasis: { status: "available", kind: "normal_cases", lower: normal(0.08, 0.24), upper: normal(0.12, 0.26), rationale: "Normal renewal and capacity variation, independent of stress cases.", evidenceIds: ["e0123456789"] },
      context: { ...agent.request.context, methodWeights: { dcf: 1, ev_ebitda_forward: 0, pe_forward: 0 }, multipleHistory: { factor: "evToEbitda", periods: [{ periodEnd: "2025-11-28", value: 15 }], min: 15, p25: 15, median: 15, p75: 15, max: 15 } },
    },
  };
}

test("real artifact parsing and replay preserve normal fair values and explicit annual cash flows", () => {
  const raw = explicitArtifact();
  const parsed = historyAssumptionsSchema.parse(JSON.parse(JSON.stringify(raw)));
  assert.deepEqual(parsed.request.fairValueBasis, raw.request.fairValueBasis);
  assert.deepEqual(parsed.request.discountRate.sources, raw.request.discountRate.sources);
  assert.deepEqual(parsed.request.context?.multipleHistory, raw.request.context.multipleHistory);
  assert.deepEqual(parsed.operatingForecasts, raw.operatingForecasts);
  const replay = replayHistory(readHistoryInput(fixture()), parsed, hash), fair = replay.result.fairValueRange;
  assert.ok(fair?.status === "available");
  assert.ok(fair.low > replay.result.range.low && fair.high < replay.result.range.high);
  assert.equal(fair.base, replay.result.range.base);
  assert.equal("probability" in fair.lower, false);
  const base = replay.result.scenarios.base;
  assert.equal(base.drivers.modelType, "fcff");
  if (base.drivers.modelType !== "fcff") throw new Error("Expected FCFF");
  assert.deepEqual(base.drivers.path.capitalPlan, raw.request.scenarios.base.drivers.path.capitalPlan);
  const year1 = base.result.yearly[0]!;
  assert.equal(year1.capex, 100); assert.equal(year1.depreciation, 30); assert.equal(year1.workingCapitalChange, 15);
  assert.equal(year1.reinvestment, 85); assert.equal(year1.cashFlow, 135);
  assert.equal(base.result.yearly[1]!.workingCapitalChange, -20);
  assert.ok(fair.lower.drivers.modelType === "fcff");
  assert.deepEqual(fair.lower.drivers.path.capitalPlan, raw.request.fairValueBasis.lower.drivers.path.capitalPlan);
});

test("historical parser preserves explicit unavailable fair-value rationale", () => {
  const raw = { ...assumptions(), request: { ...assumptions().request, fairValueBasis: { status: "unavailable", reason: "Normal operating limits were not established in the source set.", evidenceIds: ["e0123456789"] } } };
  const parsed = historyAssumptionsSchema.parse(raw);
  assert.deepEqual(replayHistory(readHistoryInput(fixture()), parsed, hash).result.fairValueRange, raw.request.fairValueBasis);
});

test("historical parser rejects mixed investment modes and malformed normal bounds instead of stripping fields", () => {
  const mixed = explicitArtifact(); Object.assign(mixed.request.scenarios.base.drivers.path, { salesToCapital: [2, 2, 2, 2, 2] });
  assert.equal(historyAssumptionsSchema.safeParse(mixed).success, false);
  const mixedBuild = explicitArtifact(); Object.assign(mixedBuild.request.fairValueBasis.lower.drivers.path, { buildCapex: [0, 0, 0, 0, 0] });
  assert.equal(historyAssumptionsSchema.safeParse(mixedBuild).success, false);
  const wrongLength = explicitArtifact(); wrongLength.request.scenarios.base.drivers.path.capitalPlan.capex.pop();
  assert.equal(historyAssumptionsSchema.safeParse(wrongLength).success, false);
  const negative = explicitArtifact(); negative.request.scenarios.base.drivers.path.capitalPlan.depreciation[0] = -1;
  assert.equal(historyAssumptionsSchema.safeParse(negative).success, false);
  const extraProbability = explicitArtifact(); Object.assign(extraProbability.request.fairValueBasis.lower, { probability: 0.25 });
  assert.equal(historyAssumptionsSchema.safeParse(extraProbability).success, false);
  const badSource = explicitArtifact(); Object.assign(badSource.request.discountRate.sources.riskFree, { evidenceIds: 42 });
  assert.equal(historyAssumptionsSchema.safeParse(badSource).success, false);
  const unknownContext = explicitArtifact(); Object.assign(unknownContext.request.context, { uncheckedLiveFinancials: {} });
  assert.equal(historyAssumptionsSchema.safeParse(unknownContext).success, false);
  const implicit = assumptions(); implicit.request.scenarios.base.drivers.path.capitalPlan = null;
  assert.equal(historyAssumptionsSchema.safeParse(implicit).success, true);
});

function operatingLeaseFixture(): HistoryInput {
  const input = fixture(); input.valuationPolicy = { leaseTreatment: "operating_expense" };
  for (const [id, value] of [["debt", 30], ["finance_leases", 5], ["operating_leases", 90], ["leases", 95], ["cash", 20], ["investments", 10], ["preferred_stock", 2], ["minority_interest", 1], ["valuation_net_claims", 8]] satisfies Array<[string, number]>) {
    input.facts.push({ ...input.facts[0]!, id, label: id, value, unit: "USD", currency: "USD" });
  }
  input.peers = [{ ticker: "AAA", periodEnd: "2025-11-30", price: 10, shares: 100, ebitda: 20, coreEarnings: 10, netDebt: 8, sourceRefs: ["filing"], earningsBasis: "Operating leases remain expenses", facts: structuredClone(input.facts) }];
  return input;
}

test("operating-expense replay binds the bridge and peer claims to the same financing-lease basis", () => {
  const input = readHistoryInput(operatingLeaseFixture()), agent = assumptions();
  agent.request.bridge.leaseTreatment = "operating_expense";
  agent.request.bridge.debtAndClaims = 38;
  const parsed = historyAssumptionsSchema.parse(JSON.parse(JSON.stringify(agent)));
  assert.equal(parsed.request.bridge.leaseTreatment, "operating_expense");
  assert.deepEqual(historyRequest(input, parsed, hash).bridge, parsed.request.bridge);
  parsed.request.bridge.debtAndClaims = 128;
  assert.throws(() => historyRequest(input, parsed, hash), /bridge claims differ/);
  assert.throws(() => historyRequest(input, assumptions(), hash), /different lease treatments/);
  const badPeer = operatingLeaseFixture(); badPeer.peers[0]!.netDebt = 98;
  assert.throws(() => readHistoryInput(badPeer), /Peer claims do not match/);
});

test("missing peer lease classification or liquid investments disables EV rather than substituting zero", () => {
  const input = operatingLeaseFixture();
  input.peers[0]!.facts = input.peers[0]!.facts.filter(f => f.id !== "finance_leases");
  assert.throws(() => readHistoryInput(input), /Peer claims do not match/);
  input.peers[0]!.netDebt = null;
  assert.doesNotThrow(() => readHistoryInput(input));
  const missingInvestment = operatingLeaseFixture(); missingInvestment.peers[0]!.facts = missingInvestment.peers[0]!.facts.filter(f => f.id !== "investments");
  assert.throws(() => readHistoryInput(missingInvestment), /Peer claims do not match/);
  missingInvestment.peers[0]!.netDebt = null;
  assert.doesNotThrow(() => readHistoryInput(missingInvestment));
});

test("first-release outcome records retain and verify their source publication time", () => {
  const data = outcome();
  data.sources = [{ id: "future-filing", kind: "earnings_release", url: "https://example.org/earnings", availableAt: "2026-03-10T21:00:00Z", path: "earnings.html", sha256: hash }];
  assert.doesNotThrow(() => evaluateHistory(readHistoryInput(fixture()), assumptions(), data, hash));
  data.actuals[0]!.availableAt = "2026-03-01T00:00:00Z";
  assert.throws(() => evaluateHistory(readHistoryInput(fixture()), assumptions(), data, hash), /dated first-release source/);
});

test("the named SPY benchmark uses the same holding period and includes cash dividends", () => {
  const data = outcome(); data.actuals = [];
  data.benchmarkSymbol = "SPY"; data.benchmarkSourceId = "benchmark-SPY"; data.benchmarkReturnBasis = "cash_dividends_not_reinvested";
  data.sources = [{ id: "benchmark-SPY", kind: "market_daily", url: "https://example.org/SPY", availableAt: "2026-01-12T21:00:00Z", path: "spy-daily.json", sha256: hash }];
  data.benchmark[1]!.dividend = 2;
  const result = evaluateHistory(readHistoryInput(fixture()), assumptions(), historyOutcomeSchema.parse(data), hash);
  assert.equal(result.benchmarkSymbol, "SPY"); assert.equal(result.benchmarkSourceId, "benchmark-SPY");
  assert.equal(result.benchmarkReturnBasis, "cash_dividends_not_reinvested");
  const first = result.market[0]!;
  assert.ok("benchmarkReturn" in first && first.benchmarkReturn != null && Math.abs(first.benchmarkReturn - 0.07) < 1e-9);
  assert.ok("excessReturn" in first && first.excessReturn != null && Math.abs(first.excessReturn - 0.04) < 1e-9);
  data.benchmark[1]!.date = "2026-01-09"; data.benchmark[1]!.closeAt = "2026-01-09T21:00:00Z";
  const mismatched = evaluateHistory(readHistoryInput(fixture()), assumptions(), data, hash).market[0]!;
  assert.ok("benchmarkReturn" in mismatched && mismatched.benchmarkReturn === null);
  assert.equal(historyOutcomeSchema.safeParse({ ...data, benchmarkSourceId: undefined }).success, false);
  data.sources[0]!.availableAt = "2026-02-03T21:00:00Z";
  assert.throws(() => evaluateHistory(readHistoryInput(fixture()), assumptions(), data, hash), /eligible dated outcome source/);
});
