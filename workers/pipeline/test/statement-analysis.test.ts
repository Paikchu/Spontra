import { test } from "node:test";
import assert from "node:assert/strict";
import type { BusinessFlowQuarter } from "../../../shared/analysis-contract/business-flow.ts";
import type { BalanceSheet, CapitalQuarter, CashFlowStatement } from "../../../shared/analysis-contract/capital-structure.ts";
import { STATEMENT_METRICS, STATEMENT_RULES } from "../../../shared/analysis-contract/statement-analysis.ts";
import { findingRefSchema, refLabel, resolveRef, shiftPeriod, type FindingData } from "../../../shared/analysis-runtime/findings.ts";
import { higherIsBetter, ratioForm, refView } from "../../../shared/analysis-runtime/highlights.ts";
import { assessStatements, cashBridge, capitalChain, ruleThreshold } from "../../../shared/analysis-runtime/statement-analysis.ts";

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
  assert.deepEqual(capex.anchors.capital, ["capex", "depreciation"]);
  assert.deepEqual(capex.evidence, [{ ref: { ratio: { numerator: { capital: "capex" }, denominator: { capital: "depreciation" } } }, periodEnd: PERIOD, span: "fiscal_year", compare: "yoy" }]);
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
