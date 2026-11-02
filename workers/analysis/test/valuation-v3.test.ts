import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelDrivers, ScenarioAssumptions, ValuationPublication } from "../../../shared/analysis-contract/valuation.ts";
import type { PeersPublication } from "../../../shared/analysis-contract/peers.ts";
import { calculateValuation, peerMultiplesOf, scenarioValue, ValuationCalcError, distributionOf, type CalcRequest } from "../../../shared/analysis-runtime/valuation/calculator.ts";
import { forecastYearOf, managementBuildCapex, managementCapexShape, managementDrivers, managementFactsOf, managementGate, managementRevenueGrowth } from "../../../shared/analysis-runtime/valuation/management.ts";
import { selectPeers, weightedQuantile } from "../../../shared/analysis-runtime/valuation/peers.ts";
import { priorRequest } from "../../../shared/analysis-runtime/valuation/prior.ts";
import { readValuationPublication } from "../../../shared/analysis-runtime/valuation/read.ts";
import { equityGroupOf } from "../../../shared/analysis-runtime/financial-data/capital-structure.ts";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { managementTargetSet, MANAGEMENT_TARGETS_MAX_AGE_DAYS, parsePeers, parseTargets, readValuationCompanyInputs, writeValuationCompanyInputs } from "../src/valuation/curated.ts";
import inputs from "./fixtures/valuation-inputs.json" with { type: "json" };
import { buildPeerFundamentals } from "../src/valuation/input.ts";
import { methodChangeHeldBack, reassessTickers } from "../src/valuation/reassess.ts";
import { gateGaps } from "../src/valuation/tools.ts";

const close = (actual: number, expected: number, digits = 2) => assert.equal(Number(actual.toFixed(digits)) + 0, Number(expected.toFixed(digits)) + 0);
const fill = (n: number, v: number) => new Array<number>(n).fill(v);
const bridge = { nonOperatingAssets: 0, debtAndClaims: 0, nonOperatingEquityAdjustment: 0, notes: [] };
const scenario = (drivers: ModelDrivers): ScenarioAssumptions => ({ narrative: "", probability: null, triggers: [], invalidation: [], evidenceIds: [], drivers });
const rate = (value: number) => ({ value, basis: "wacc" as const, components: { riskFree: null, beta: null, equityRiskPremium: null, costOfEquity: null, costOfDebt: null, taxRate: null, equityWeight: null }, rationale: "", sourceRefs: [] });
const fcff = (years: number, growth: number, margin = 0.2, path: Partial<Extract<ModelDrivers, { modelType: "fcff" }>["path"]> = {}): Extract<ModelDrivers, { modelType: "fcff" }> =>
  ({ modelType: "fcff", revenue0: 1000, path: { revenueGrowth: fill(years, growth), operatingMargin: fill(years, margin), taxRate: fill(years, 0.2), salesToCapital: fill(years, 2), ...path }, terminalGrowth: 0.03, terminalRoic: 0.15 });

/* ---- peers ---- */

const facet = { value: "same" as const, score: 1, leftTag: null, rightTag: null };
const quarters = (operating: number, depreciation: number, debt = 100, cash = 50) => Array.from({ length: 4 }, (_, i) => ({ periodEnd: `2026-0${9 - 3 * Math.min(i, 2)}-30`.replace("-09-30", i === 0 ? "-09-30" : "-06-30"), accessions: [], figures: { operatingIncome: String(operating), depreciation: String(depreciation), debt: String(debt), cash: String(cash) } }));
const company = (ticker: string, categories: string[], operating = 100, depreciation = 20) => ({ ticker, categories, newestQuarter: "2026-09-30", quarters: quarters(operating, depreciation) });
const unit = (ticker: string, key: string, exposure: number | null) => ({ ticker, unitKey: `${ticker}|${key}`, name: key, flowNodeId: key, sectors: ["cloud"], periodEnd: "2026-09-30", revenue: null, exposure });
const pair = (left: string, right: string, tier: "direct" | "partial" | "adjacent", basis: "company" | "unit") => ({ left, right, tier, sector: "cloud", basis, facets: { offering: facet, customers: facet, contract: facet, cost: facet } });
const projection: PeersPublication = {
  schemaVersion: "peers.v1", generatedAt: "now",
  companies: [company("SUBJ", ["cloud"]), company("PA", ["cloud"]), company("PB", ["cloud", "ads"]), company("PC", ["ads"]), company("LOSS", ["cloud"], -10, 5), company("NODA", ["cloud"])],
  units: [unit("SUBJ", "infra", 0.3), unit("SUBJ", "apps", 0.7), unit("PA", "cloud", 0.12), unit("PB", "all", 1), unit("LOSS", "all", 1), unit("PC", "all", 1)],
  pairs: [pair("SUBJ|infra", "PA|cloud", "direct", "unit"), pair("SUBJ|infra", "LOSS|all", "partial", "unit"), pair("SUBJ|apps", "PB|all", "partial", "unit"), pair("SUBJ|infra", "PC|all", "adjacent", "unit")],
};

test("peer selection: the curated map first (only tickers in the projection), then direct/partial pairs weighted by both exposures, then shared categories", () => {
  const curated = selectPeers(projection, "SUBJ", ["PA", "PB", "ZZZ"]);
  assert.equal(curated.basis, "curated");
  assert.deepEqual(curated.tickers, ["PA", "PB"]);
  close(curated.weights.PA!, 0.5);
  assert.ok(curated.notes.some(n => n.includes("ZZZ")));
  // One curated peer is too few: the pairs follow. infra×PA direct 1 × 0.3 × 0.12 = 0.036; infra×LOSS partial 0.5 × 0.3 × 1 = 0.15; apps×PB partial 0.5 × 0.7 × 1 = 0.35; adjacent PC carries nothing.
  const pairs = selectPeers(projection, "SUBJ", ["PA"]);
  assert.equal(pairs.basis, "unit");
  assert.deepEqual(pairs.tickers, ["PB", "LOSS", "PA"]);
  close(pairs.weights.PB!, 0.35 / 0.536, 4); close(pairs.weights.PA!, 0.036 / 0.536, 4);
  // Whole-company pairs read as the ranking basis at full weight.
  const ranking = selectPeers({ ...projection, pairs: [pair("SUBJ|infra", "PA|cloud", "direct", "company"), pair("SUBJ|apps", "PB|all", "direct", "company")] }, "SUBJ", null);
  assert.equal(ranking.basis, "ranking"); close(ranking.weights.PA!, 0.5);
  // Without pairs, the shared category.
  const category = selectPeers({ ...projection, pairs: [], units: [] }, "SUBJ", null);
  assert.equal(category.basis, "category"); assert.deepEqual(category.tickers, ["LOSS", "NODA", "PA", "PB"]);
  assert.equal(selectPeers({ ...projection, pairs: [], units: [], companies: [company("SUBJ", ["x"]), company("PA", ["y"])] }, "SUBJ", null).basis, "none");
  assert.equal(selectPeers(null, "SUBJ", ["PA", "PB"]).basis, "none");
});

test("weighted quantiles: equal weights reproduce the linear quartiles; a heavier peer pulls the median toward it", () => {
  const values = [10, 12, 15, 20];
  const d = distributionOf("m", values.map((value, i) => ({ periodEnd: String(i), value })))!;
  const equal = values.map(value => ({ value, weight: 1 }));
  close(weightedQuantile(equal, 0.25), d.p25, 8); close(weightedQuantile(equal, 0.5), d.median, 8); close(weightedQuantile(equal, 0.75), d.p75, 8);
  const heavy = [{ value: 10, weight: 1 }, { value: 12, weight: 1 }, { value: 15, weight: 6 }, { value: 20, weight: 1 }];
  assert.ok(weightedQuantile(heavy, 0.5) > d.median && weightedQuantile(heavy, 0.5) < 15, `median ${weightedQuantile(heavy, 0.5)}`);
  close(weightedQuantile([{ value: 1, weight: 1 }, { value: 3, weight: 1 }], 0.5), 2, 8);
  assert.equal(weightedQuantile([{ value: 7, weight: 2 }], 0.5), 7);
  const m = peerMultiplesOf([{ ticker: "A", price: 10, shares: 10, ebitda: 10, coreEarnings: 5, netDebt: 0, weight: 0.7 }, { ticker: "B", price: 10, shares: 10, ebitda: 5, coreEarnings: 2, netDebt: 0, weight: 0.3 }, { ticker: "C", price: null, shares: 1, ebitda: 1, coreEarnings: 1, netDebt: 0, weight: 0.5 }], "2026-11-01", "unit")!;
  assert.equal(m.basis, "unit"); assert.deepEqual(m.peers, ["A", "B"]);
  close(m.weights!.A!, 0.7); close(m.weights!.B!, 0.3);
  assert.equal(m.evToEbitda!.count, 2);
});

test("peer fundamentals: loss-making peers, peers without positive EBITDA and peers with incomplete figures are dropped with a note; weights renormalize", async () => {
  const shares = async (peer: string) => peer === "NODA" ? null : 10;
  const built = await buildPeerFundamentals({} as D1Database, "SUBJ", { ...projection, pairs: [], units: [] }, ["PA", "PB", "LOSS", "NODA"], shares);
  assert.equal(built.basis, "curated");
  assert.deepEqual(built.peers.map(p => p.ticker), ["PA", "PB"]);
  close(built.peers[0]!.weight, 0.5);
  assert.ok(built.notes.some(n => n.startsWith("LOSS: loss-making")));
  assert.ok(built.notes.some(n => n.startsWith("NODA: incomplete figures") && n.includes("shares")));
  assert.equal(built.peers[0]!.ebitda, 4 * 100 + 4 * 20);
  const none = await buildPeerFundamentals({} as D1Database, "SUBJ", null, ["PA"], shares);
  assert.equal(none.basis, "none");
});

/** D1 over node:sqlite with every migration applied. */
function database(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(file, dir), "utf8").replace(/--> statement-breakpoint/g, ""));
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    run: async () => { sqlite.prepare(sql).run(...values as never[]); return { success: true }; },
    first: async <T>() => (sqlite.prepare(sql).get(...values as never[]) ?? null) as T | null,
  });
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}

test("valuation inputs: the admin's peers and targets validate on write; the migration carries the former files over unchanged", async () => {
  const db = database();
  for (const [ticker, row] of Object.entries(inputs as Record<string, { peers?: string[]; targets?: unknown }>)) {
    const stored = await readValuationCompanyInputs(db, ticker);
    assert.deepEqual(stored.peers, row.peers ?? null, ticker);
    assert.deepEqual(stored.targets, row.targets ? parseTargets(row.targets) : null, ticker);
  }
  assert.deepEqual(await readValuationCompanyInputs(db, "ZZZZ"), { ticker: "ZZZZ", peers: null, targets: null, updatedAt: null });
  const targets = parseTargets(inputs.ORCL.targets);
  assert.throws(() => parsePeers("AAA", ["AAA", "BBB"]), /自己/);
  assert.throws(() => parsePeers("AAA", []), /可比公司/);
  assert.throws(() => parseTargets({ ...targets, targets: [{ ...targets.targets[0]!, sourceIds: ["nope"] }] }), /不存在的来源/);
  assert.throws(() => parseTargets({ ...targets, fiscalYearEndMonth: 5 }), /管理层目标/);
  const saved = await writeValuationCompanyInputs(db, "NEWCO", { peers: ["AAA", "BBB", "AAA"], targets: null }, "2026-11-02T00:00:00.000Z");
  assert.deepEqual(saved.peers, ["AAA", "BBB"]);
  assert.deepEqual((await readValuationCompanyInputs(db, "NEWCO")).peers, ["AAA", "BBB"]);
  await assert.rejects(writeValuationCompanyInputs(db, "NEWCO", { peers: ["NEWCO"], targets: null }, "2026-11-02T00:00:00.000Z"), /自己/);
  await writeValuationCompanyInputs(db, "NEWCO", { peers: null, targets: null }, "2026-11-02T00:00:00.000Z");
  assert.equal((await readValuationCompanyInputs(db, "NEWCO")).updatedAt, null);
});

test("management targets: the fiscal-year end comes from the filings, and a set past the age limit is not used", () => {
  const stored = parseTargets(inputs.ORCL.targets);
  const used = managementTargetSet("ORCL", stored, 5, "2026-11-01T00:00:00.000Z");
  assert.equal(used.set?.fiscalYearEndMonth, 5);
  assert.equal(used.set?.targets.find(t => t.metric === "revenue" && t.fiscalYear === 2030)!.value, 225e9);
  assert.equal(used.set?.targets.find(t => t.metric === "operating_margin")!.basis, "non_gaap");
  assert.deepEqual(managementTargetSet("ORCL", null, 5, "2026-11-01"), { set: null, notes: [] });
  const unplaced = managementTargetSet("ORCL", stored, null, "2026-11-01");
  assert.equal(unplaced.set, null);
  assert.match(unplaced.notes[0]!, /fiscal-year end/);
  const late = new Date(Date.parse(stored.asOf) + (MANAGEMENT_TARGETS_MAX_AGE_DAYS + 1) * 86_400_000).toISOString();
  const stale = managementTargetSet("ORCL", stored, 5, late);
  assert.equal(stale.set, null);
  assert.match(stale.notes[0]!, /day limit/);
  assert.ok(managementTargetSet("ORCL", stored, 5, new Date(Date.parse(stored.asOf) + MANAGEMENT_TARGETS_MAX_AGE_DAYS * 86_400_000).toISOString()).set);
});

/* ---- management case ---- */

const orcl = managementTargetSet("ORCL", parseTargets(inputs.ORCL.targets), 5, "2026-11-01").set!;
const orclFacts = [["revenue_ttm", 71.777e9], ["operating_margin_ttm", 0.3212], ["sbc_ttm", 4.814e9], ["da_ttm", 9.428e9], ["capex_ttm", 75.66e9]].map(([id, value]) => ({ id: id as string, value: value as number }));

test("management case: fiscal years land on forecast years, revenue runs through the targets then fades, the margin converts non-GAAP by the stock-compensation share, build capex peaks in year two and ends", () => {
  // Period end 2026-08-31 (Q1 FY27): FY27 ends 2027-05-31 → year 1; FY30 → year 4; FY26 is past; FY34 is beyond seven years.
  assert.equal(forecastYearOf(2027, orcl, "2026-08-31", 7), 1); assert.equal(forecastYearOf(2030, orcl, "2026-08-31", 7), 4);
  assert.equal(forecastYearOf(2026, orcl, "2026-08-31", 7), 0); assert.equal(forecastYearOf(2034, orcl, "2026-08-31", 7), null);
  assert.equal(forecastYearOf(2027, orcl, "2026-05-31", 7), 1);
  const revenue = managementRevenueGrowth(orcl, "2026-08-31", 7, 71.777e9, 0.03)!;
  close(revenue.growth[0]!, 90 / 71.777 - 1, 4);
  const cagr = (225 / 90) ** (1 / 3) - 1;
  close(revenue.growth[1]!, cagr, 6); close(revenue.growth[3]!, cagr, 6);
  close(revenue.growth[6]!, 0.03, 6);
  assert.ok(revenue.growth[4]! < cagr && revenue.growth[5]! < revenue.growth[4]!);
  assert.deepEqual(revenue.anchors.map(a => [a.fiscalYear, a.year]), [[2027, 1], [2030, 4]]);
  const base = fcff(7, 0.1, 0.3212, { taxRate: fill(7, 0.13), salesToCapital: fill(7, 1.44), buildCapex: [60e9, 45e9, 30e9, 15e9, 0, 0, 0] });
  const built = managementDrivers({ ...base, revenue0: 71.777e9 }, orcl, "2026-08-31", managementFactsOf(orclFacts, 71.777e9))!;
  const path = built.drivers.path;
  // 40% non-GAAP less 6.7% stock compensation = 33.3% by year four, held after; interpolated from the trailing 32.1%.
  const target = 0.4 - 4.814 / 71.777;
  close(path.operatingMargin[3]!, target, 6); close(path.operatingMargin[6]!, target, 6);
  assert.ok(path.operatingMargin[0]! > 0.3212 && path.operatingMargin[0]! < target);
  // Capex 92.5B in years one and two, then the FY29 cash-flow floor, then nothing: the build is not monotone and ends inside the horizon.
  assert.ok(path.buildCapex![1]! > path.buildCapex![2]!, "year two still at the peak, year three steps down");
  assert.ok(path.buildCapex![0]! > 0 && path.buildCapex![1]! > 0);
  assert.equal(path.buildCapex![3], 0); assert.equal(path.buildCapex![6], 0);
  assert.ok(built.anchors.some(a => a.metric === "fcf" && a.fiscalYear === 2029 && a.year === 3));
  assert.ok(built.notes.some(n => n.includes("non-GAAP margin 40%")));
  // Year three: the growth reinvestment alone would leave 17B, so sales-to-capital rises and the cash flow meets the 30B floor.
  const result = scenarioValue(built.drivers, 0.106, 3e9, bridge);
  close(result.yearly[2]!.cashFlow / 1e9, 30, 6);
  assert.ok(path.salesToCapital[2]! > 1.44 && path.salesToCapital[1] === 1.44);
  assert.ok(built.notes.some(n => n.includes("sales-to-capital raised")));
  assert.equal(managementDrivers(base, { ...orcl, targets: orcl.targets.filter(t => t.metric !== "revenue") }, "2026-08-31", managementFactsOf(orclFacts, 1000)), null);
  const shape = managementCapexShape(orcl, "2026-08-31", 7, managementFactsOf(orclFacts, 71.777e9))!;
  close(shape[0]!, (92.5e9 - 1.5 * 9.428e9) / (75.66e9 - 1.5 * 9.428e9), 4); close(shape[1]!, shape[0]!, 6); close(shape[2]!, shape[1]! / 2, 6); assert.equal(shape[3], 0);
  const build = managementBuildCapex(orcl, "2026-08-31", { revenue: fill(7, 100e9), nopat: fill(7, 10e9), reinvestment: fill(7, 1e9) }, managementFactsOf(orclFacts, 71.777e9))!;
  assert.ok(build.notes.some(n => n.includes("free-cash-flow floor")), "a path that cannot reach the floor is noted");
  assert.equal(build.buildCapex[2], 0);
});

test("management gate: a base revenue path more than 25% under a target, or above it beyond 10%, is flagged with the figures; inside the band it passes", () => {
  const near = managementGate({ ...fcff(7, 0.3), revenue0: 71.777e9 }, orcl, "2026-08-31")!;
  assert.equal(near.key, "management_targets"); assert.equal(near.status, "pass");
  const low = managementGate({ ...fcff(7, 0.1), revenue0: 71.777e9 }, orcl, "2026-08-31")!;
  assert.equal(low.status, "flag"); assert.ok(low.detail.includes("FY2030") && low.detail.includes("discounts"));
  assert.ok(low.value! < -0.25); assert.equal(low.limit, -0.25);
  const high = managementGate({ ...fcff(7, 0.45), revenue0: 71.777e9 }, orcl, "2026-08-31")!;
  assert.equal(high.status, "flag"); assert.ok(high.detail.includes("above"));
  assert.equal(managementGate(fcff(7, 0.1), { ...orcl, targets: orcl.targets.filter(t => t.metric !== "revenue") }, "2026-08-31"), null);
  assert.deepEqual(gateGaps([low]).map(g => g.code), ["management_target_gap"]);
});

test("calculateValuation with management targets: the management scenario rides on the result with its own triangulation, the gate is among the gates, and a payload with it reads back", () => {
  const facts = [...orclFacts.map(f => ({ ...f, unit: f.id === "operating_margin_ttm" ? "ratio" : "USD" })), { id: "shares_outstanding", value: 3e9, unit: "shares" }];
  const peers = { peers: ["A", "B"], asOf: "2026-11-01", evToEbitda: { p25: 17, median: 18.6, p75: 22, count: 2 }, peRatio: { p25: 29, median: 31, p75: 36, count: 2 }, notes: [], basis: "curated" as const, weights: { A: 0.5, B: 0.5 } };
  const drivers = (g: number, m: number) => ({ ...fcff(7, g, m, { taxRate: fill(7, 0.13), salesToCapital: fill(7, 1.44), buildCapex: [60e9, 45e9, 30e9, 15e9, 0, 0, 0] }), revenue0: 71.777e9, terminalRoic: 0.111 });
  const request: CalcRequest = {
    modelType: "fcff", currency: "USD", discountRate: rate(0.106), shares: { base: 3e9, dilutionReserve: 0, basis: "x" }, bridge: { ...bridge, nonOperatingAssets: 37e9, debtAndClaims: 161e9 }, price: 130.67,
    scenarios: { bear: scenario(drivers(0.15, 0.28)), base: scenario(drivers(0.2, 0.3212)), bull: scenario(drivers(0.3, 0.34)) },
    context: { facts, riskFree: 0.049, peers, trailing: { ebitda: 32.5e9, da: 9.428e9, interestExpense: 5.1e9 }, lifecycle: "build", management: orcl, periodEnd: "2026-08-31" },
  };
  const result = calculateValuation(request);
  const ref = result.managementScenario!;
  assert.equal(ref.label, "Management scenario (cited targets)");
  assert.ok(ref.result.perShare > result.scenarios.base.result.perShare, `management ${ref.result.perShare} above base DCF ${result.scenarios.base.result.perShare}`);
  assert.ok(ref.valuation && ref.valuation.perShare > ref.result.perShare, "the management path's weighted value carries the multiples");
  assert.equal(result.references, undefined, "the reference list is superseded by the management scenario");
  assert.ok(ref.triangulation && ref.triangulation.base > ref.result.perShare, "the multiples on the management path exceed its DCF");
  assert.equal(ref.methods.length, 3);
  assert.equal(ref.sources.length, orcl.sources.length);
  const gate = result.gates!.find(g => g.key === "management_targets")!;
  assert.equal(gate.status, "flag", gate.detail);
  // Without a period end there is no reference and no gate; the rest is unchanged.
  const plain = calculateValuation({ ...request, context: { ...request.context, management: null } });
  assert.equal(plain.managementScenario, null); assert.equal(plain.managementComparison, null); assert.ok(!plain.gates!.some(g => g.key === "management_targets"));
  close(plain.range.base, result.range.base, 8);
  const publication = { schemaVersion: "valuation.v1", ticker: "ORCL", cik: null, companyName: "Oracle", currency: "USD", researchAsOf: "2026-11-01", financialPeriodEnd: "2026-08-31", generatedAt: "2026-11-01", methodVersion: "valuation.v4", calculatorVersion: result.calculatorVersion, baseInputFingerprint: "f", evidenceSetHash: "h", reportStatus: "ready", verdict: "pending", weightedScore: 6, confidence: "medium",
    dimensions: ["businessQuality", "growthExecution", "valuationSafety", "mispricingCatalysts", "financialResilience"].map(key => ({ key, score: 6, confidence: "medium", rationale: "r", supportingEvidenceIds: [], counterEvidenceIds: [], gaps: [], nextCheck: "n" })),
    quote: null, model: result, facts: [], diagnostics: [], distributions: [], sections: { summary: "", thesis: "", expectationsGap: "", catalysts: [], counterEvidence: [], nextChecks: [], modelNotes: "" }, evidence: [], gaps: gateGaps(result.gates!), versionId: "v" } as unknown as ValuationPublication;
  const read = readValuationPublication(JSON.parse(JSON.stringify(publication)), "ORCL")!;
  assert.equal(read.model!.managementScenario!.anchors.length, ref.anchors.length);
  assert.equal(read.model!.managementComparison!.rows.length, 2);
  assert.equal(read.model!.peers!.weights!.A, 0.5);
});

/* ---- calculator and prior ---- */

test("build capex may peak in any year but must end inside the horizon", () => {
  const peak = scenarioValue(fcff(7, 0.05, 0.2, { buildCapex: [60, 90, 40, 0, 0, 0, 0] }), 0.09, 100, bridge);
  assert.deepEqual(peak.yearly.map(y => y.buildCapex), [60, 90, 40, 0, 0, 0, 0]);
  assert.throws(() => scenarioValue(fcff(7, 0.05, 0.2, { buildCapex: fill(7, 10) }), 0.09, 100, bridge), (e: unknown) => e instanceof ValuationCalcError && /end inside the horizon/.test(e.message));
  assert.throws(() => scenarioValue(fcff(5, 0.05, 0.2, { buildCapex: [50, 40, 30, 20, 10] }), 0.09, 100, bridge), ValuationCalcError);
});

test("prior: a cited capex timing replaces the four-year taper, scaled to its total, padded with zeros and forced to end", () => {
  const facts = [["revenue_ttm", 71.777e9, "USD"], ["operating_income_ttm", 23.056e9, "USD"], ["capex_ttm", 75.66e9, "USD"], ["da_ttm", 9.428e9, "USD"], ["cash", 37e9, "USD"], ["debt", 125e9, "USD"], ["equity", 67e9, "USD"], ["shares_diluted_weighted", 3e9, "shares"], ["fcf_ttm", -28.7e9, "USD"]].map(([id, value, unit]) => ({ id: id as string, value: value as number, unit: unit as string }));
  const distribution = (factor: string, values: number[]) => ({ factor, periods: values.map((value, i) => ({ periodEnd: `20${20 + i}-05-31`, value })), min: values[0]!, p25: values[1]!, median: values[2]!, p75: values[3]!, max: values[4]! });
  const input = { currency: "USD", facts, distributions: [distribution("revenueGrowth", [0.06, 0.097, 0.149, 0.175, 0.216]), distribution("operatingMargin", [0.257, 0.283, 0.304, 0.306, 0.321]), distribution("capexToRevenue", [0.106, 0.13, 0.174, 0.37, 0.826])], diagnostics: [{ key: "capexToDa", value: 8 }, { key: "roic", value: 0.108 }], rpo: null, riskFree: 0.05, beta: 1.8, price: 130 };
  const excess = 75.66e9 - 1.5 * 9.428e9;
  const taper = priorRequest(input)!, shaped = priorRequest({ ...input, capexShape: [1.2, 1.2, 0.6] })!, open = priorRequest({ ...input, capexShape: fill(7, 1) })!;
  const build = (r: CalcRequest) => (r.scenarios.base.drivers as Extract<ModelDrivers, { modelType: "fcff" }>).path.buildCapex!;
  close(build(taper)[1]! / excess, 0.75, 6);
  // [1.2, 1.2, 0.6] sums to 3.0 and the taper to 2.5: the timing is kept, the total is the taper's.
  close(build(shaped)[0]! / excess, 1.0, 6); close(build(shaped)[1]! / excess, 1.0, 6); close(build(shaped)[2]! / excess, 0.5, 6); assert.equal(build(shaped)[3], 0); assert.equal(build(shaped).length, 7);
  close(build(shaped).reduce((a, b) => a + b, 0), build(taper).reduce((a, b) => a + b, 0), 0);
  assert.equal(build(open)[6], 0, "the last year is forced to zero");
  assert.ok(shaped.bridge.notes.some(n => n.includes("capex plan")));
  assert.doesNotThrow(() => calculateValuation(shaped));
});

/* ---- capital structure ---- */

test("equity lines: nonredeemable (or issuer-option) convertible preferred is permanent paid-in equity; temporary equity and holder-redeemable preferred stay redeemable", () => {
  assert.equal(equityGroupOf("us-gaap:ConvertiblePreferredStockNonredeemableOrRedeemableIssuerOptionValue", "Series A and Series B preferred stock and additional paid-in capital"), "paidIn");
  assert.equal(equityGroupOf("us-gaap:TemporaryEquityCarryingAmountAttributableToParent", "Redeemable convertible preferred stock"), "redeemable");
  assert.equal(equityGroupOf("us-gaap:RedeemableNoncontrollingInterestEquityCarryingAmount", "Redeemable noncontrolling interests"), "redeemable");
  assert.equal(equityGroupOf("x:Custom", "Redeemable convertible preferred stock, Series B"), "redeemable");
  assert.equal(equityGroupOf("us-gaap:PreferredStockValue", "Preferred stock"), "paidIn");
  assert.equal(equityGroupOf("us-gaap:MinorityInterest", "Noncontrolling interests"), "noncontrolling");
});

/* ---- reassessment on a method change ---- */

test("method change held back: an older report on unchanged material waits unless the company is listed; new material, a listed company, '*' or no report run", () => {
  const published = { methodVersion: "valuation.v3", calculatorVersion: "valuation.calc.v1", financialPeriodEnd: "2026-08-31" };
  const current = { methodVersion: "valuation.v4", calculatorVersion: "valuation.calc.v2", financialPeriodEnd: "2026-08-31" };
  assert.deepEqual(reassessTickers({ VALUATION_REASSESS_TICKERS: "ORCL, msft" }), ["MSFT", "ORCL"]);
  assert.equal(reassessTickers({ VALUATION_REASSESS_TICKERS: "*" }), "*");
  assert.deepEqual(reassessTickers({}), []);
  assert.deepEqual(reassessTickers({ VALUATION_REASSESS_TICKERS: "not a ticker!" }), []);
  const held = methodChangeHeldBack({ VALUATION_REASSESS_TICKERS: "ORCL" }, published, current, "GOOGL");
  assert.ok(held && held.reason.includes("valuation.v3/valuation.calc.v1 → valuation.v4/valuation.calc.v2") && held.reason.includes("GOOGL"));
  assert.equal(methodChangeHeldBack({ VALUATION_REASSESS_TICKERS: "ORCL" }, published, current, "ORCL"), null);
  assert.equal(methodChangeHeldBack({ VALUATION_REASSESS_TICKERS: "*" }, published, current, "GOOGL"), null);
  assert.equal(methodChangeHeldBack({}, published, { ...current, financialPeriodEnd: "2026-11-30" }, "GOOGL"), null, "a new period runs");
  assert.equal(methodChangeHeldBack({}, null, current, "GOOGL"), null, "a first run is not a reassessment");
  assert.equal(methodChangeHeldBack({}, { ...published, methodVersion: "valuation.v4", calculatorVersion: "valuation.calc.v2" }, current, "GOOGL"), null, "same method: the fingerprint decides");
  assert.ok(methodChangeHeldBack({}, published, current, "GOOGL"), "unset list holds everyone");
});
