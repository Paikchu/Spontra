import { test } from "node:test";
import assert from "node:assert/strict";
import type { BusinessFlowQuarter } from "../../../shared/analysis-contract/business-flow.ts";
import type { BalanceSheet, CapitalQuarter, CashFlowStatement } from "../../../shared/analysis-contract/capital-structure.ts";
import { STATEMENT_METRICS, STATEMENT_RULES } from "../../../shared/analysis-contract/statement-analysis.ts";
import { findingRefSchema, refLabel, resolveRef, shiftPeriod, type FindingData } from "../../../shared/analysis-runtime/findings.ts";
import { higherIsBetter, ratioForm, refView } from "../../../shared/analysis-runtime/highlights.ts";
import { assessStatements, cashBridge, capitalChain, flagFigures, formatMetric, formatMetricChange, peerRanks, ruleThreshold, thresholdsOf } from "../../../shared/analysis-runtime/statement-analysis.ts";
import { peerQuartersFrom } from "../../../shared/analysis-runtime/peers.ts";
import { verifyFindings } from "../../../shared/analysis-runtime/findings.ts";
import type { FindingsPublication } from "../../../shared/analysis-contract/findings.ts";
import { buildLedger } from "../src/findings/ledger.ts";
import { planFinding } from "../src/analyst/plan.ts";

/* ---------- Fixtures: sixteen quarters of a made-up company, in three presentations ---------- */

const QUARTERS = 16, PERIOD = "2026-06-30";
const ENDS = Array.from({ length: QUARTERS }, (_, i) => shiftPeriod(PERIOD, -3 * (QUARTERS - 1 - i)));
const M = 1e6;
const amount = (v: number) => ({ value: String(v), basis: "reported" as const, definition: "", comparabilityKey: null, sourceIds: ["s1"] });
const source = (end: string) => ({ accession: `acc-${end}`, url: "https://www.sec.gov/x", filedAt: end, form: "10-Q" });
const line = <G extends string>(id: string, group: G, value: number, concept = "x") => ({ id, label: id, concept, group, value: String(value * M) });

type Shape = "standard" | "financial" | "insurance";
type Options = { shape: Shape; capexLate?: number; debtIssuedLate?: number; cashStart?: number; debtStart?: number };

/** Income-statement figures of quarter `i` in millions: revenue grows 3% a quarter, margins fixed, interest expense 10. */
function income(i: number) {
  const revenue = 1000 * 1.03 ** i, operating = 0.3 * revenue, pretax = operating - 10, tax = 0.2 * pretax;
  return { revenue, gross: 0.6 * revenue, operating, pretax, tax, net: pretax - tax };
}

function flowQuarter(end: string, i: number, shape: Shape): BusinessFlowQuarter {
  const f = income(i);
  const figures = shape === "standard"
    ? { revenue: amount(f.revenue), cost: amount(0.4 * f.revenue), gross: amount(f.gross), research: amount(0.1 * f.revenue), sales: amount(0.1 * f.revenue), administration: amount(0.1 * f.revenue), operating: amount(f.operating), other: amount(-10), pretax: amount(f.pretax), tax: amount(f.tax), net: amount(f.net) }
    : { revenue: amount(f.revenue), pretax: amount(f.pretax), tax: amount(f.tax), net: amount(f.net) };
  return {
    id: end, label: end, periodStart: shiftPeriod(end, -3), periodEnd: end, periodType: "3M", currency: "USD", scale: M, basisLabel: "", reportedAt: null,
    incomeModel: shape === "standard" ? "standard" : shape, figures,
    segments: [{ id: "cloud", name: "Cloud", revenue: amount(0.4 * f.revenue), description: "", products: [], customers: null, monetization: null, disclosure: "", sourceIds: ["s1"] }],
    segmentsComplete: true, otherComponents: shape === "standard" ? [{ id: "int", name: "Interest expense", amount: amount(-10) }] : undefined,
    sources: [{ id: "s1", title: "10-Q", url: "https://www.sec.gov/x", publishedAt: null }],
  };
}

/** Cash-flow lines of quarter `i`: the late quarters (10–15) spend `capexLate` and borrow `debtIssuedLate`; before that capex 60 and no borrowing. */
function flows(i: number, o: Options) {
  const f = income(i), late = i >= 10;
  const capex = late ? o.capexLate ?? 150 : 60, debtIssued = late ? o.debtIssuedLate ?? 200 : 0;
  const nonCash = 70, workingCapital = -30, operating = f.net + nonCash + workingCapital;
  const financing = debtIssued - 20 - 30 - 10 - 5;
  return { net: f.net, nonCash, workingCapital, operating, capex, debtIssued, financing, netChange: operating - capex + financing };
}

function cashFlow(end: string, i: number, o: Options): CashFlowStatement {
  const c = flows(i, o);
  const investing = o.shape === "financial" ? { total: String(-c.capex * M), lines: null }
    : { total: String(-c.capex * M), lines: [line("capex", "capex", -c.capex)] };
  return {
    periodStart: shiftPeriod(end, -3), periodEnd: end, currency: "USD", basis: "reported",
    operating: { total: String(c.operating * M), lines: [line("ni", "netIncome", c.net), line("da", "nonCash", 50, "DepreciationDepletionAndAmortization"), line("sbc", "nonCash", 20, "ShareBasedCompensation"), line("wc", "workingCapital", c.workingCapital)] },
    investing,
    financing: { total: String(c.financing * M), lines: [line("di", "debtIssued", c.debtIssued), line("dr", "debtRepaid", -20), line("bb", "buybacks", -30), line("dv", "dividends", -10), line("lp", "leasePrincipal", -5)] },
    fxEffect: null, netChange: String(c.netChange * M), supplemental: [line("ip", "interestPaid", 10)], sources: [source(end)],
  } as CashFlowStatement;
}

function balanceSheet(end: string, i: number, o: Options): BalanceSheet {
  const cash = (o.cashStart ?? 500) + Array.from({ length: i + 1 }, (_, j) => flows(j, o).netChange).reduce((a, b) => a + b, 0);
  const debt = (o.debtStart ?? 2000) + Array.from({ length: i + 1 }, (_, j) => flows(j, o).debtIssued - 20).reduce((a, b) => a + b, 0);
  const productive = 2000 + Array.from({ length: i + 1 }, (_, j) => flows(j, o).capex).reduce((a, b) => a + b, 0);
  const receivables = 300 * 1.08 ** i, equity = 3000 + 100 * i, assets = 8000 + 200 * i;
  return {
    asOf: end, currency: "USD",
    assets: [line("cash", "cash", cash), line("ar", "receivables", receivables), line("ppe", "productive", productive)],
    liabilities: [line("debt", "debt", debt), line("lease", "leases", 100)],
    equity: [line("eq", "paidIn", equity)],
    totals: { assets: String(assets * M), liabilities: String((assets - equity) * M), equity: String(equity * M), currentAssets: String(1500 * M), currentLiabilities: String(1200 * M) },
    source: source(end),
  };
}

function capitalQuarter(end: string, i: number, o: Options): CapitalQuarter {
  // An insurer's sheet reconciles only every other quarter; the newest and the one a year earlier are among those held.
  const held = o.shape !== "insurance" || (QUARTERS - 1 - i) % 2 === 0;
  return {
    periodEnd: end, cashFlow: cashFlow(end, i, o), yearToDate: null, balanceSheet: held ? balanceSheet(end, i, o) : null,
    schedules: i === QUARTERS - 1 ? [{ kind: "debtMaturities", asOf: end, currency: "USD", total: String(9000 * M), buckets: [{ from: 0, to: 12, amount: String(8000 * M) }, { from: 12, to: null, amount: String(1000 * M) }], source: source(end) }] : [],
  };
}

function company(o: Options): FindingData {
  const series = (metricKey: string, unitFamily: "per_share" | "multiple", category: "per_share" | "valuation", at: (i: number) => number) => ({
    metricKey, label: metricKey, category, unitFamily, currency: "USD", available: true, points: ENDS.map((end, i) => ({ periodEnd: end, valueDecimal: String(at(i)) })),
  });
  return {
    quarters: ENDS.map((end, i) => flowQuarter(end, i, o.shape)), history: null,
    capital: { schemaVersion: "capital-structure.v1", ticker: "TEST", quarters: ENDS.map((end, i) => capitalQuarter(end, i, o)) },
    fundamentals: { series: [series("diluted_eps", "per_share", "per_share", i => 1 + 0.05 * i), series("pe_ratio", "multiple", "valuation", () => 25)] as never },
    guidance: null,
  };
}

const standard = company({ shape: "standard" });
const sumLate = (o: Options, pick: (i: number) => number) => [12, 13, 14, 15].map(pick).reduce((a, b) => a + b, 0);

/* ---------- Derived references ---------- */

test("derived references resolve by their formulas and carry labels in both languages", () => {
  const f = income(15);
  const ebitda = resolveRef(standard, { derived: "ebitda" }, PERIOD, "quarter")!;
  assert.equal(Math.round(ebitda.value / M), Math.round(f.operating + 50));
  assert.equal(ebitda.unit, "USD");
  const nopat = resolveRef(standard, { derived: "nopat" }, PERIOD, "quarter")!;
  assert.ok(Math.abs(nopat.value / M - f.operating * 0.8) < 1e-6, "a 20% effective rate leaves 80% of operating income");
  const b = balanceSheet(PERIOD, 15, { shape: "standard" });
  const debt = Number(b.liabilities[0]!.value), cash = Number(b.assets[0]!.value);
  assert.equal(resolveRef(standard, { derived: "netDebt" }, PERIOD, "quarter")!.value, debt + 100 * M - cash);
  assert.equal(resolveRef(standard, { derived: "investedCapital" }, PERIOD, "quarter")!.value, debt + 100 * M + Number(b.totals.equity) - cash);
  assert.equal(resolveRef(standard, { derived: "interestExpense" }, PERIOD, "fiscal_year")!.value, 40 * M);
  assert.equal(resolveRef(standard, { derived: "workingCapitalChange" }, PERIOD, "fiscal_year")!.value, -120 * M);
  assert.equal(resolveRef(standard, { derived: "nonCashCharges" }, PERIOD, "quarter")!.value, 70 * M);
  const funding = resolveRef(standard, { derived: "netExternalFunding" }, PERIOD, "fiscal_year")!;
  assert.equal(funding.value, 4 * (200 - 20) * M);
  // Cash runway is a figure only for a company burning cash.
  assert.equal(resolveRef(standard, { derived: "cashRunwayMonths" }, PERIOD, "quarter"), null);
  const accruals = resolveRef(standard, { derived: "accruals" }, PERIOD, "fiscal_year")!;
  assert.equal(accruals.unit, "ratio");
  assert.ok(accruals.value < 0, "operating cash flow above profit reads as negative accruals");
  assert.equal(refLabel(standard, { derived: "netDebt" }), "Net debt");
  assert.equal(refLabel(standard, { derived: "netDebt" }, "zh-CN"), "净债务");
  assert.ok(findingRefSchema.safeParse({ derived: "ebitda" }).success);
  assert.ok(!findingRefSchema.safeParse({ derived: "magic" }).success);
});

test("derived references know their statement, their form and which way is good", () => {
  assert.equal(refView({ derived: "ebitda" }), "profit");
  assert.equal(refView({ derived: "accruals" }), "cash");
  assert.equal(refView({ derived: "netDebt" }), "balance");
  assert.equal(ratioForm({ derived: "accruals" }), "percent");
  assert.equal(ratioForm({ ratio: { numerator: { derived: "nopat" }, denominator: { derived: "averageInvestedCapital" } } }), "percent");
  assert.equal(ratioForm({ ratio: { numerator: { derived: "netDebt" }, denominator: { derived: "ebitda" } } }), "multiple");
  assert.ok(higherIsBetter({ ratio: { numerator: { metric: "net" }, denominator: { derived: "averageEquity" } } }));
  assert.ok(!higherIsBetter({ derived: "netDebt" }));
});

/* ---------- The catalogue and the rules ---------- */

test("every rule names metrics of the catalogue, and every metric id is unique", () => {
  const ids = new Set(STATEMENT_METRICS.map(m => m.id));
  assert.equal(ids.size, STATEMENT_METRICS.length);
  for (const rule of STATEMENT_RULES) {
    assert.ok(ids.has(rule.metric), `${rule.id} files under ${rule.metric}`);
    for (const c of rule.all) assert.ok(ids.has(c.metric), `${rule.id} tests ${c.metric}`);
    assert.ok(rule.all.some(c => c.metric === rule.metric), `${rule.id} tests the metric it files under`);
  }
});

test("a threshold reads as a formula in the metric's units, in either language", () => {
  const rule = (id: string) => STATEMENT_RULES.find(r => r.id === id)!;
  assert.equal(ruleThreshold(rule("cash-below-profit")), "< 0.8×");
  assert.equal(ruleThreshold(rule("cash-below-profit"), "zh-CN"), "< 0.8倍");
  assert.equal(ruleThreshold(rule("receivables-outrun")), "> 15 pp, 2 quarters");
  assert.equal(ruleThreshold(rule("receivables-outrun"), "zh-CN"), "> 15个百分点，连续 2 季");
  assert.equal(ruleThreshold(rule("margin-compression")), "YoY change < -2 pp, 2 quarters");
  assert.equal(ruleThreshold(rule("returns-below-cost")), "< 8%, and Capex over depreciation > 1.5×");
  assert.equal(ruleThreshold(rule("fcf-turned-positive")), "turned positive vs. a year ago");
  assert.equal(ruleThreshold(rule("growth-decelerating")), "falling 3 quarters, and YoY change < -10 pp");
  assert.equal(ruleThreshold(rule("runway-short"), "zh-CN"), "< 18 个月");
});

/* ---------- A standard presentation in a capex cycle ---------- */

test("a standard company resolves the full catalogue, with the margins and multiples the fixture was built from", () => {
  const a = assessStatements(standard, PERIOD);
  assert.equal(a.model, "standard");
  const metric = (id: string) => a.dimensions.flatMap(d => d.metrics).find(m => m.id === id);
  assert.ok(Math.abs(metric("operating-margin")!.current.value - 30) < 1e-9);
  assert.ok(Math.abs(metric("gross-margin")!.current.value - 60) < 1e-9);
  assert.ok(Math.abs(metric("tax-rate")!.current.value - 20) < 1e-9);
  // Capex of the late quarters is 150 against depreciation of 50: three times, over the four quarters.
  assert.ok(Math.abs(metric("capex-to-depreciation")!.current.value - 3) < 1e-9);
  assert.ok(Math.abs(metric("revenue-growth")!.current.value - (1.03 ** 4 - 1) * 100) < 1e-9);
  // Operating income grows exactly as fast as revenue, so the spread is zero.
  assert.ok(Math.abs(metric("operating-leverage")!.current.value) < 1e-9);
  assert.ok(Math.abs(metric("eps-growth")!.current.value - (1.75 / 1.55 - 1) * 100) < 1e-9);
  assert.equal(metric("pe")!.current.value, 25);
  assert.equal(metric("cash-runway"), undefined, "no runway while free cash flow is positive");
  const expectedConversion = sumLate(standard as never as Options, i => flows(i, { shape: "standard" }).operating) / sumLate(standard as never as Options, i => income(i).net);
  assert.ok(Math.abs(metric("cash-conversion")!.current.value - expectedConversion) < 1e-9);
  assert.equal(metric("operating-margin")!.series.length, 9);
  assert.equal(metric("operating-margin")!.series.at(-1)!.periodEnd, PERIOD);
  assert.equal(metric("operating-margin")!.yoy, 0);
  // Everything resolves except what the fixture does not state (no RPO, no inventory), a runway while cash is generated,
  // and a return on added capital while invested capital shrinks (cash grows faster than debt and equity).
  const uncovered = { growth: ["rpo-to-revenue"], earningsQuality: ["inventory-vs-revenue"], capitalEfficiency: ["incremental-return"], safety: ["cash-runway"], valuation: ["ev-to-ebitda", "ev-to-revenue", "price-to-sales", "price-to-book"] } as Record<string, string[]>;
  for (const d of a.dimensions) {
    assert.equal(d.covered, d.total - (uncovered[d.id]?.length ?? 0), `${d.id} coverage`);
    for (const id of uncovered[d.id] ?? []) assert.equal(metric(id), undefined, `${id} is not stated`);
  }
});

test("the capex cycle, the fast receivables and the maturity wall are flagged; the strong return is noted", () => {
  const a = assessStatements(standard, PERIOD);
  const flag = (id: string) => a.flags.find(f => f.ruleId === id);
  const capex = flag("capex-cycle")!;
  assert.equal(capex.level, "watch");
  assert.ok(Math.abs(capex.value - 3) < 1e-9);
  // Capex of 150 began six quarters ago; the four-quarter multiple passed 2× a year before the report (2.1× then), not five quarters before (1.65×).
  assert.equal(capex.since, shiftPeriod(PERIOD, -12));
  assert.equal(capex.anchors.view, "cash");
  assert.deepEqual(capex.anchors.capital, ["capex", "depreciation"], "the derived figure lights the statement lines it stands for");
  assert.deepEqual(capex.evidence, [{ ref: { ratio: { numerator: { capital: "capex" }, denominator: { derived: "depreciationAmortization" } } }, periodEnd: PERIOD, span: "fiscal_year", compare: "yoy" }]);
  assert.equal(flag("receivables-outrun")!.level, "watch");
  assert.equal(flag("maturity-wall")!.level, "alert");
  assert.equal(flag("returns-strong")!.level, "note");
  // Revenue growth is constant, so a year-over-year change of floating-point size never reads as a slowdown.
  assert.equal(flag("capex-unmatched"), undefined);
  assert.equal(flag("cash-below-profit"), undefined);
  assert.equal(flag("fcf-negative"), undefined);
  assert.equal(flag("leverage-high"), undefined, "cash exceeds debt, so net debt is negative");
  // Alerts first, then watches, then notes.
  const levels = a.flags.map(f => f.level);
  assert.deepEqual(levels, [...levels].sort((x, y) => ({ alert: 0, watch: 1, note: 2 })[x] - ({ alert: 0, watch: 1, note: 2 })[y]));
  assert.equal(a.flags.find(f => f.level === "alert")!.threshold, "< 1×");
});

test("a company burning cash on capex funded by debt trips the funding and cash-flow rules", () => {
  const burning = company({ shape: "standard", capexLate: 600, debtIssuedLate: 500 });
  const a = assessStatements(burning, PERIOD);
  const flag = (id: string) => a.flags.find(f => f.ruleId === id);
  assert.equal(flag("fcf-negative")!.level, "watch");
  assert.equal(flag("fcf-turned-negative")!.level, "watch");
  assert.equal(flag("external-funding")!.level, "alert");
  assert.ok(Math.abs(flag("external-funding")!.value - 4 * (500 - 20) / 2400 * 100) < 1e-9);
  const runway = a.dimensions.find(d => d.id === "safety")!.metrics.find(m => m.id === "cash-runway")!;
  assert.ok(runway.current.value > 0);
  // Borrowing outruns the cash it leaves, so capital was added and its return can be read.
  const added = a.dimensions.find(d => d.id === "capitalEfficiency")!.metrics.find(m => m.id === "incremental-return")!;
  assert.ok(Number.isFinite(added.current.value));
  assert.equal(flag("capex-cycle")!.level, "watch");
});

/* ---------- Other presentations ---------- */

test("a financial presentation keeps only the metrics a bank states, and never trips a capex rule", () => {
  const a = assessStatements(company({ shape: "financial" }), PERIOD);
  assert.equal(a.model, "financial");
  const ids = new Set(a.dimensions.flatMap(d => d.metrics).map(m => m.id));
  for (const absent of ["gross-margin", "operating-margin", "roic", "capex-to-depreciation", "current-ratio", "free-cash-flow", "net-debt-to-ebitda"]) assert.ok(!ids.has(absent), `${absent} is not a bank metric`);
  for (const present of ["net-margin", "tax-rate", "roe", "roa", "cash-to-debt", "eps-growth", "cash-conversion"]) assert.ok(ids.has(present), `${present} resolves for a bank`);
  assert.ok(!a.flags.some(f => f.ruleId.startsWith("capex") || f.ruleId === "returns-below-cost"));
  assert.equal(a.chain, null);
  // The investing section's lines do not reconcile, so the bridge carries investing as one step and still closes.
  const bridge = a.bridge.quarter!;
  assert.ok(bridge.steps.some(s => s.id === "investing"));
  assert.ok(!bridge.steps.some(s => s.id === "capex"));
  assert.ok(bridge.closes);
});

test("an insurer whose sheet reconciles every other quarter keeps the quarters it has and counts the rest as uncovered", () => {
  const a = assessStatements(company({ shape: "insurance" }), PERIOD);
  const safety = a.dimensions.find(d => d.id === "safety")!;
  const cashToDebt = safety.metrics.find(m => m.id === "cash-to-debt")!;
  // Nine shown quarters, every other one held: five points, the newest among them.
  assert.equal(cashToDebt.series.length, 5);
  assert.equal(cashToDebt.series.at(-1)!.periodEnd, PERIOD);
  const roe = a.dimensions.find(d => d.id === "capitalEfficiency")!.metrics.find(m => m.id === "roe");
  assert.ok(roe, "ROE needs the newest sheet and the one a year earlier, both held");
  assert.ok(safety.covered < safety.total);
  assert.ok(!a.dimensions.flatMap(d => d.metrics).some(m => m.id === "gross-margin"));
});

/* ---------- Bridge and chain ---------- */

test("the profit-to-cash bridge walks the statement's groups and closes on its net change", () => {
  const bridge = cashBridge(standard, PERIOD, "quarter")!;
  const c = flows(15, { shape: "standard" });
  const ids = bridge.steps.map(s => s.id);
  assert.deepEqual(ids, ["netIncome", "nonCash", "workingCapital", "operating", "capex", "freeCashFlow", "debtIssued", "debtRepaid", "buybacks", "dividends", "leasePrincipal", "netChange"]);
  const step = (id: string) => bridge.steps.find(s => s.id === id)!;
  assert.ok(Math.abs(step("netIncome").value / M - c.net) < 1e-6);
  assert.equal(step("nonCash").value, 70 * M);
  assert.equal(step("capex").value, -150 * M);
  assert.ok(step("operating").total && step("freeCashFlow").total && step("netChange").total);
  assert.ok(Math.abs(step("freeCashFlow").value / M - (c.operating - 150)) < 1e-6);
  assert.ok(bridge.closes);
  assert.equal(bridge.closingCash, resolveRef(standard, { capital: "cash" }, PERIOD, "quarter")!.value);
  assert.equal(bridge.openingCash, resolveRef(standard, { capital: "cash" }, shiftPeriod(PERIOD, -3), "quarter")!.value);
  const year = cashBridge(standard, PERIOD, "fiscal_year")!;
  assert.equal(year.steps.find(s => s.id === "capex")!.value, -600 * M);
  assert.ok(year.closes);
  assert.equal(cashBridge(standard, PERIOD, "quarter", "zh-CN")!.steps[0]!.label, "净利润");
});

test("the capital chain indexes capex, assets, revenue and cash to the oldest quarter all four answer", () => {
  const chain = capitalChain(standard, PERIOD)!;
  assert.equal(chain.series.length, 4);
  for (const s of chain.series) {
    assert.equal(s.points[0]!.index, 100);
    assert.equal(s.points.length, 8);
    assert.equal(s.points.at(-1)!.periodEnd, PERIOD);
  }
  const capex = chain.series.find(s => s.id === "capex")!;
  assert.ok(capex.points.at(-1)!.index > capex.points[0]!.index, "late capex lifts the index");
  assert.equal(capitalChain({ ...standard, capital: null }, PERIOD), null);
});

/* ---------- Reading the checkup: formatting, ranks, the ledger and the analyst ---------- */

test("a metric reads in its own units in either language", () => {
  assert.equal(formatMetric(12.345, "percent"), "12.3%");
  assert.equal(formatMetric(-0.5, "percent"), "−0.5%");
  assert.equal(formatMetric(15.2, "points"), "+15.2 pp");
  assert.equal(formatMetric(15.2, "points", "zh-CN"), "+15.2个百分点");
  assert.equal(formatMetric(2.6, "multiple"), "2.60×");
  assert.equal(formatMetric(2.6, "multiple", "zh-CN"), "2.60倍");
  assert.equal(formatMetric(75.7e9, "money"), "$75.7B");
  assert.equal(formatMetric(12.04, "months", "zh-CN"), "12.0 个月");
  assert.equal(formatMetricChange(-1.25, "percent"), "−1.3 pp");
  assert.equal(formatMetricChange(0.4, "multiple"), "+0.40×");
  assert.equal(formatMetricChange(25, "money"), "+25.0%");
  assert.deepEqual(thresholdsOf({ ruleId: "capex-cycle", metricId: "capex-to-depreciation" }), [2]);
  assert.deepEqual(thresholdsOf({ ruleId: "capex-unmatched", metricId: "asset-formation" }), [], "a rule testing only the metric's change draws no level");
  assert.deepEqual(flagFigures({ metricId: "capex-to-depreciation" }), { metrics: [], capital: ["capex"] });
  assert.deepEqual(flagFigures({ metricId: "operating-margin" }), { metrics: ["operating"], capital: [] });
  assert.deepEqual(flagFigures({ metricId: "net-debt-to-ebitda" }), { metrics: [], capital: ["debt"] });
});

test("peers rank the company on the ratios they can answer, best first by the metric's direction", () => {
  const peer = (ticker: string, o: Options) => ({ ticker, categories: ["cloud"], newestQuarter: PERIOD, quarters: peerQuartersFrom(company(o)) });
  const unit = (ticker: string) => ({ ticker, unitKey: `${ticker}|all`, name: ticker, flowNodeId: "reported-company-total", sectors: ["cloud"], periodEnd: PERIOD, revenue: null, exposure: 1 });
  const facet = { value: "same" as const, score: 1, leftTag: null, rightTag: null };
  const pair = (other: string, basis: "company" | "unit") => ({ left: "TEST|all", right: `${other}|all`, tier: "direct" as const, sector: "cloud", basis, facets: { offering: facet, customers: facet, contract: facet, cost: facet } });
  const peers = { schemaVersion: "peers.v1" as const, generatedAt: "now", companies: [
    { ...peer("TEST", { shape: "standard" }), categories: ["cloud"] },
    peer("HEAVY", { shape: "standard", capexLate: 600, debtIssuedLate: 500 }),
    peer("LIGHT", { shape: "standard", capexLate: 60 }),
    peer("PART", { shape: "standard", capexLate: 30 }),
    peer("SAMECAT", { shape: "standard", capexLate: 30 }),
  ], units: ["TEST", "HEAVY", "LIGHT", "PART"].map(unit), pairs: [pair("HEAVY", "company"), pair("LIGHT", "company"), pair("PART", "unit")] };
  const a = assessStatements(standard, PERIOD);
  const ranks = peerRanks({ ...standard, peers }, a, "TEST");
  const self = ranks["self-funding"]!;
  assert.deepEqual(self.rows.map(r => r.ticker), ["LIGHT", "TEST", "HEAVY"], "operating cash over capex: the lightest spender funds itself best");
  assert.equal(self.rank, 2);
  assert.equal(self.of, 3);
  assert.equal(ranks["free-cash-flow"], undefined, "amounts are not ranked");
  assert.equal(ranks["roe"], undefined, "a derived figure has no peer reading");
  assert.ok(ranks["current-ratio"], "current assets and liabilities travel in the projection");
  assert.deepEqual(peerRanks({ ...standard, peers: null }, a, "TEST"), {});
  assert.ok(!self.rows.some(r => r.ticker === "PART" || r.ticker === "SAMECAT"), "a unit-basis pair or a shared category alone is not ranked against");
  assert.deepEqual(peerRanks({ ...standard, peers: { ...peers, units: undefined, pairs: undefined } }, a, "TEST"), {}, "categories alone rank nothing");
});

test("the ledger carries derived rows and the checkup's flags for the findings writer", () => {
  const ledger = buildLedger(standard, PERIOD, []);
  const row = (ref: object, span = "fiscal_year") => ledger.rows.find(r => JSON.stringify(r.ref) === JSON.stringify(ref) && r.periodEnd === PERIOD && r.span === span);
  assert.ok(row({ derived: "ebitda" }), "EBITDA over the four quarters");
  assert.ok(row({ derived: "netDebt" }, "quarter"), "net debt at the report");
  assert.ok(row({ ratio: { numerator: { derived: "nopat" }, denominator: { derived: "averageInvestedCapital" } } }), "ROIC");
  assert.match(row({ ratio: { numerator: { derived: "nopat" }, denominator: { derived: "averageInvestedCapital" } } })!.value, /^\d+(\.\d)?%$/, "a return reads as a percentage");
  assert.ok(!ledger.rows.some(r => "derived" in r.ref && r.ref.derived === "cashRunwayMonths"), "months have no ledger form");
  const capex = ledger.flags.find(f => f.rule === "capex-cycle")!;
  assert.deepEqual(capex, { rule: "capex-cycle", level: "watch", metric: "Capex over depreciation", value: "3.00×", threshold: "> 2×", since: shiftPeriod(PERIOD, -12), ref: { ratio: { numerator: { capital: "capex" }, denominator: { derived: "depreciationAmortization" } } }, span: "fiscal_year" });
  assert.equal(ledger.flags[0]!.level, "alert");
  // A finding may cite the flag's ref: the verifier resolves it like any ledger row.
  const publication: FindingsPublication = { schemaVersion: "findings.v1", ticker: "TEST", periodEnd: PERIOD, generatedAt: "now", model: "test", sources: [{ id: "s1", title: "10-Q", url: "https://www.sec.gov/x", kind: "sec", publishedAt: null }], findings: [{
    id: "capex", kind: "risk", severity: 3, title: "Capex runs at 3x depreciation",
    judgment: { text: "Capex over the trailing four quarters ran at 3x depreciation and amortization, so the asset base is being rebuilt far faster than it wears out. The next report should show whether revenue follows the assets.", sourceIds: ["s1"] },
    evidence: [{ ref: capex.ref, periodEnd: PERIOD, span: "fiscal_year", compare: "yoy" }], anchors: { view: "cash", nodeIds: [], metrics: [], capital: ["capex"] }, lens: { type: "trend", refs: [capex.ref], span: "fiscal_year" },
  }] };
  assert.equal(verifyFindings(publication, standard).verified.length, 1);
});

test("the analyst opens its lines from the same flags the page shows", () => {
  const publication: FindingsPublication = { schemaVersion: "findings.v1", ticker: "TEST", periodEnd: PERIOD, generatedAt: "now", model: "test", sources: [{ id: "s1", title: "10-Q", url: "https://www.sec.gov/x", kind: "sec", publishedAt: null }], findings: [{
    id: "margin", kind: "shift", severity: 2, title: "Operating income keeps pace with revenue",
    judgment: { text: "Operating income grew in step with revenue on the year, so the margin did not move while the business kept growing. The next report should confirm that the margin holds as the asset base grows.", sourceIds: ["s1"] },
    evidence: [{ ref: { metric: "operating" }, periodEnd: PERIOD, span: "quarter", compare: "yoy" }], anchors: { view: "profit", nodeIds: [], metrics: ["operating"] }, lens: { type: "trend", refs: [{ metric: "operating" }], span: "quarter" },
  }] };
  const f = verifyFindings(publication, standard).verified[0];
  assert.ok(f, "the finding verifies");
  const plan = planFinding(f, standard, []);
  const capital = plan.lines.find(l => l.key === "capital_intensity")!;
  assert.match(capital.why, /^checkup flags capex-cycle \(3\.00× against > 2×\)/, "a profit finding still opens capital intensity when the checkup flags capex");
  assert.ok(plan.lines.find(l => l.key === "funding_commitments")?.why.includes("maturity-wall"));
  assert.ok(!plan.lines.some(l => l.key === "margin_mix"), "no margin rule trips and the finding cites no margin ratio");
  const quiet = planFinding(f, { ...standard, capital: null }, []);
  assert.ok(!quiet.lines.some(l => l.key === "capital_intensity"), "without the statements no capital rule trips");
});

test("a span whose operating lines do not reconcile stands operating cash flow as one total, and still closes", () => {
  const unlined: FindingData = { ...standard, capital: { ...standard.capital!, quarters: standard.capital!.quarters.map(q => ({ ...q, cashFlow: q.cashFlow && { ...q.cashFlow, operating: { ...q.cashFlow.operating, lines: null } } })) } };
  const bridge = cashBridge(unlined, PERIOD, "fiscal_year")!;
  assert.equal(bridge.steps.filter(s => s.id === "operating").length, 1);
  assert.ok(bridge.steps[0]!.total && bridge.steps[0]!.id === "operating");
  assert.ok(bridge.closes);
});

test("a ratio over a loss has no value, so a loss-making company never reads as cash below profit", () => {
  const losing: FindingData = { ...standard, quarters: standard.quarters.map(q => ({ ...q, figures: { ...q.figures, net: { ...q.figures.net!, value: String(-50) } } })) };
  const a = assessStatements(losing, PERIOD);
  assert.equal(a.dimensions.flatMap(d => d.metrics).find(m => m.id === "cash-conversion"), undefined);
  assert.ok(!a.flags.some(f => f.ruleId === "cash-below-profit" || f.ruleId === "cash-above-profit"));
});

test("depreciation and stock compensation fall back to the SEC series where the statement's lines do not reconcile", () => {
  const series = (metricKey: string, value: number) => ({ metricKey, label: metricKey, category: "cash_flow", unitFamily: "currency", currency: "USD", available: true, points: ENDS.map(end => ({ periodEnd: end, valueDecimal: String(value) })) });
  const unlined: FindingData = { ...standard, fundamentals: { series: [series("depreciation_and_amortization", 40e6), series("stock_based_compensation", 15e6)] as never },
    capital: { ...standard.capital!, quarters: standard.capital!.quarters.map(q => ({ ...q, cashFlow: q.cashFlow && { ...q.cashFlow, operating: { ...q.cashFlow.operating, lines: null } } })) } };
  assert.equal(resolveRef(unlined, { capital: "depreciation" }, PERIOD, "fiscal_year"), null, "the statement alone cannot answer");
  assert.equal(resolveRef(unlined, { derived: "depreciationAmortization" }, PERIOD, "fiscal_year")!.value, 160e6);
  assert.equal(resolveRef(standard, { derived: "depreciationAmortization" }, PERIOD, "fiscal_year")!.value, 200e6, "the statement's own lines come first");
  const capexDa = assessStatements(unlined, PERIOD).dimensions.flatMap(d => d.metrics).find(m => m.id === "capex-to-depreciation")!;
  assert.ok(Math.abs(capexDa.current.value - 600 / 160) < 1e-9);
  assert.equal(resolveRef(unlined, { derived: "stockCompensationExpense" }, PERIOD, "quarter")!.value, 15e6);
});

/* ---------- Checkup notes: what a written analysis may state ---------- */

import { earlierMaterial, noteFigures, noteIssues, verifyNote } from "../../../shared/analysis-runtime/checkup-notes.ts";
import type { FindingMaterial, FindingPassage } from "../../../shared/analysis-contract/findings.ts";
import { runNote, NOTE_TOOLS } from "../src/checkup/agent.ts";
import type { AnalysisEnv } from "../src/operations.ts";

const capexMetric = () => assessStatements(standard, PERIOD).dimensions.flatMap(d => d.metrics).find(m => m.id === "capex-to-depreciation")!;
const capexFlags = () => assessStatements(standard, PERIOD).flags.filter(f => f.metricId === "capex-to-depreciation");
const passage = (id: string, report: string, text: string): FindingPassage => ({ passageId: id, documentId: `d-${report}`, title: `TEST 10-Q ${report}`, form: "10-Q", filedAt: report, url: "https://www.sec.gov/x", path: ["MD&A", "Liquidity"], text, table: null });
const material = (id: string, p: FindingPassage): FindingMaterial => ({ id, kind: "sec", title: p.title, url: p.url, publishedAt: p.filedAt, passageId: p.passageId, documentId: p.documentId, form: p.form, path: p.path });
const now = passage("p1", PERIOD, "We expect capital expenditures to remain elevated as we add data center capacity for contracted demand.");
const before = passage("p2", "2025-12-31", "We plan to increase capital expenditures over the next several quarters to expand capacity.");
const materials = [material("m1", now), material("m2", before)];
const goodText = "Capex has run at 3x depreciation over the trailing four quarters, up from 2.1x a year earlier, because the company is adding capacity faster than its existing assets wear out. The earlier report already said spending would rise over the next several quarters; the current one ties the build to contracted demand, so the step-up is a plan being executed rather than a surprise.";

test("a note may state the metric's figures, its parts and its thresholds, and nothing else", () => {
  const figures = noteFigures(standard, capexMetric(), capexFlags());
  assert.ok(figures.lines.some(l => l.startsWith("Capex over depreciation (trailing four quarters), by quarter:")));
  assert.ok(figures.lines.some(l => l.startsWith("rule capex-cycle (watch): > 2×")));
  assert.ok(figures.lines.some(l => /^Capex \(/.test(l)), "the numerator is listed");
  const ok = noteIssues({ paragraphs: [{ text: goodText, sourceIds: ["m1", "m2"] }], quotes: [{ kind: "quote", materialId: "m1", text: "capital expenditures to remain elevated as we add data center capacity" }, { kind: "quote", materialId: "m2", text: "increase capital expenditures over the next several quarters" }] }, figures, materials, [now, before], PERIOD, true);
  assert.deepEqual(ok, []);
  const bad = noteIssues({ paragraphs: [{ text: goodText.replace("3x", "4.7x"), sourceIds: ["m9"] }], quotes: [{ kind: "quote", materialId: "m1", text: "capital expenditures will double next year" }] }, figures, materials, [now, before], PERIOD, true);
  assert.ok(bad.some(i => i.includes("numbers 4.7")));
  assert.ok(bad.some(i => i.includes("sourceIds")));
  assert.ok(bad.some(i => i.includes("not found verbatim")));
  assert.ok(bad.some(i => i.includes("no quote from an earlier report")));
  const onlyCurrent = noteIssues({ paragraphs: [{ text: goodText, sourceIds: ["m1"] }], quotes: [{ kind: "quote", materialId: "m1", text: "capital expenditures to remain elevated as we add data center capacity" }] }, figures, materials, [now, before], PERIOD, false);
  assert.deepEqual(onlyCurrent, [], "without an earlier report in the library, a current quote is enough");
  assert.ok(earlierMaterial(materials[1]!, PERIOD));
  assert.ok(!earlierMaterial(materials[0]!, PERIOD));
});

test("the page shows only the paragraphs whose numbers hold and the quotes found in their passages", () => {
  const note = { metricId: "capex-to-depreciation", ruleIds: ["capex-cycle"], paragraphs: [{ text: goodText, sourceIds: ["c:m1"] }, { text: "Capex reached 9.9x depreciation, a level the figures do not show.", sourceIds: ["c:m1"] }],
    quotes: [{ kind: "quote" as const, materialId: "c:m2", text: "increase capital expenditures over the next several quarters" }, { kind: "quote" as const, materialId: "c:m1", text: "words the filing never said at all" }] };
  const served = [{ ...materials[0]!, id: "c:m1" }, { ...materials[1]!, id: "c:m2" }];
  const verified = verifyNote(note, { ...standard, passages: [now, before] }, capexMetric(), capexFlags(), served)!;
  assert.equal(verified.paragraphs.length, 1);
  assert.equal(verified.quotes.length, 1);
  assert.ok(verified.quotes[0]!.earlier, "the quote from the December report is marked as an earlier report's");
  assert.equal(verifyNote({ ...note, paragraphs: [note.paragraphs[1]!] }, { ...standard, passages: [now, before] }, capexMetric(), capexFlags(), served), null);
});

test("the writer's finish is held to the same check, and a model that never reads gets no note", async () => {
  assert.deepEqual(NOTE_TOOLS.map(t => t.name), ["find_sections", "read_section", "finish"]);
  let calls = 0;
  const outcome = await runNote({
    env: { DB: undefined } as unknown as AnalysisEnv, ticker: "TEST", metric: capexMetric(), flags: capexFlags(), data: standard, documents: [],
    act: async () => ({ content: [{ type: "tool_use", id: `t${++calls}`, name: "finish", input: { paragraphs: [{ text: goodText, sourceIds: ["m1"] }], quotes: [] } }], stopReason: "tool_use" }),
    stage: (_, cb) => cb(), reserveTurn: async () => true, budget: { turns: 3, reads: 1, finds: 1 },
  });
  assert.equal(outcome.note, null);
  assert.equal(calls, 3);
  assert.ok(outcome.issues.some(i => i.includes("sourceIds")), "citing a material it never read is refused");
  assert.ok(outcome.issues.some(i => i.includes("at least two quotes")));
});

test("an escaped character in a note's text is read as the character it names", async () => {
  const { unescaped } = await import("../src/checkup/agent.ts");
  assert.equal(unescaped("fell to 3.59\\u00d7 from 4.28\\u00d7"), "fell to 3.59× from 4.28×");
  assert.equal(unescaped("plain 3.59× stays"), "plain 3.59× stays");
  assert.equal(unescaped('a loss of """−$176M'), "a loss of −$176M");
});
