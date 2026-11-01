/**
 * Valuation dry run on real public data, without a model call or a database (docs/valuation-v2-SPEC.md, acceptance).
 *
 *   node --experimental-strip-types --no-warnings workers/analysis/scripts/valuation-dry-run.ts \
 *     --data-dir /path/to/data --ticker ORCL --consensus 235.8,110,400,43,2026-10-31 --out ORCL.md --json ORCL.json
 *
 * Peers default to the curated map (src/valuation/curated); `--peers` overrides. When the company has curated management
 * targets, the management reference case and its gate are computed and written beside the prior.
 *
 * The data directory holds what the production run reads through its own routes: `{T}_fundamentals.json` and `{T}_capital.json`
 * from the public read API, `yh_{SYMBOL}.json` Yahoo chart answers (2y weekly; `%5ETNX`, `%5EGSPC`), `sec_{t}_shares.json`
 * or `cf_{T}.json` from SEC company facts, and optionally `{t}_before.json`, the published report. The script runs the v1-style
 * prior (five years, history medians) and the v2 prior (life cycle, RPO floor, build capex, cross-check, gates) through the
 * same calculator and writes both, so the two can be compared on identical inputs.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { FactorDistribution, ValuationModelResult } from "../../../shared/analysis-contract/valuation.ts";
import { calculateValuation, distributionOf, multipleHistoryOf, peerMultiplesOf, sanityGates, verifyCitedInputs, type CalcRequest } from "../../../shared/analysis-runtime/valuation/calculator.ts";
import { anchorOf, lifecycleOf, priorRequest, type PriorFact } from "../../../shared/analysis-runtime/valuation/prior.ts";
import { managementCapexShape, managementFactsOf } from "../../../shared/analysis-runtime/valuation/management.ts";
import { curatedPeersFor, managementTargetsFor } from "../src/valuation/curated.ts";
import { fetchBeta, fetchPeerQuotes, fetchReferenceQuote, fetchRiskFreeRate, fetchWeeklyCloses } from "../src/valuation/market.ts";

const { values: args } = parseArgs({ options: { "data-dir": { type: "string" }, ticker: { type: "string" }, peers: { type: "string", default: "" }, consensus: { type: "string" }, out: { type: "string" }, json: { type: "string" }, now: { type: "string", default: "2026-11-01T00:00:00.000Z" }, tax: { type: "string" } } });
const dir = args["data-dir"]!, ticker = args.ticker!.toUpperCase(), now = new Date(args.now!);
const read = (name: string) => JSON.parse(readFileSync(`${dir}/${name}`, "utf8")) as Record<string, unknown>;
const num = (v: unknown): number | null => { if (v == null || v === "") return null; const n = typeof v === "number" ? v : Number(v); return Number.isFinite(n) ? n : null; };

/** The chart endpoint answered from files: the production market reader runs unchanged over the saved answers. */
const fetcher: typeof fetch = async (input) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const symbol = url.pathname.split("/").at(-1)!;
  try { return new Response(readFileSync(`${dir}/yh_${symbol}.json`), { status: 200 }); } catch { return new Response("", { status: 404 }); }
};

type Series = { metricKey: string; points: Array<{ periodEnd: string; valueDecimal: string | null }> };
const fundamentals = (t: string): Series[] => ((read(`${t}_fundamentals.json`).fundamentals as { series: Series[] }).series);
const windows = (series: Series[], key: string): Array<{ periodEnd: string; value: number }> => {
  const pts = (series.find(s => s.metricKey === key)?.points ?? []).map(p => ({ periodEnd: p.periodEnd, value: num(p.valueDecimal) })).filter((p): p is { periodEnd: string; value: number } => p.value != null);
  return pts.slice(3).map((p, i) => ({ periodEnd: p.periodEnd, value: pts.slice(i, i + 4).reduce((a, b) => a + b.value, 0) })).filter((_, i) => pts.slice(i, i + 4).length === 4);
};
const ttm = (series: Series[], key: string) => windows(series, key).at(-1)?.value ?? null;
const last = (series: Series[], key: string) => { const p = (series.find(s => s.metricKey === key)?.points ?? []).filter(p => p.valueDecimal != null).at(-1); return p ? num(p.valueDecimal) : null; };

type Line = { id: string; concept: string; group: string; value: string };
type Quarter = { periodEnd: string; rpo?: { asOf: string; total: string; buckets: Array<{ start: string | null; months: number | null; share: string | null }> } | null; balanceSheet: { asOf: string; assets: Line[]; liabilities: Line[]; equity: Line[] } | null };
const capital = (t: string): Quarter[] => { try { return (read(`${t}_capital.json`).capital as { quarters: Quarter[] }).quarters; } catch { return []; } };
const group = (lines: Line[], g: string) => lines.filter(l => l.group === g).reduce((sum, l) => sum + (num(l.value) ?? 0), 0);
const byConcept = (lines: Line[], re: RegExp) => lines.filter(l => re.test(l.concept) || re.test(l.id)).reduce((sum, l) => sum + (num(l.value) ?? 0), 0);

/** Shares outstanding from SEC company facts: the single-class concept file, or the company-facts file summed over classes at the newest date. */
function sharesOf(t: string): number | null {
  const newestSum = (units: Array<{ end: string; val: number }>) => { const byEnd = new Map<string, number>(); for (const u of units) byEnd.set(u.end, (byEnd.get(u.end) ?? 0) + u.val); const end = [...byEnd.keys()].sort().at(-1); return end ? byEnd.get(end)! : null; };
  try { return newestSum((read(`sec_${t.toLowerCase()}_shares.json`).units as { shares: Array<{ end: string; val: number }> }).shares); } catch { /* fall through */ }
  try { const facts = read(`cf_${t}.json`).facts as Record<string, Record<string, { units: { shares: Array<{ end: string; val: number }> } }>>; return newestSum(facts["us-gaap"]!.CommonStockSharesOutstanding?.units.shares ?? facts["us-gaap"]!.WeightedAverageNumberOfDilutedSharesOutstanding!.units.shares); } catch { return null; }
}

// ---- The company's material pack from the public answers, with the same fact ids the worker builds.
const series = fundamentals(ticker), quarters = capital(ticker);
const newest = quarters[0] ?? null, sheet = newest?.balanceSheet ?? null;
const report = (() => { try { return (read(`${ticker.toLowerCase()}_before.json`).report as { facts: PriorFact[]; distributions: FactorDistribution[]; model: ValuationModelResult & { scenarios: Record<string, { drivers: unknown; narrative: string; probability: number | null; triggers: string[]; invalidation: string[]; evidenceIds: string[] }> }; quote: { price: number } } | null) ?? null; } catch { return null; } })();
const reportFact = (id: string) => report?.facts.find(f => f.id === id)?.value ?? null;
const revenue = ttm(series, "total_revenue")!, operating = ttm(series, "operating_income")!, da = ttm(series, "depreciation_and_amortization"), capex = ttm(series, "capital_expenditure"), cfo = ttm(series, "operating_cash_flow");
const interest = ttm(series, "nonoperating_interest_expense"), sbc = ttm(series, "stock_based_compensation"), net = ttm(series, "net_income");
const cash = sheet ? group(sheet.assets, "cash") : last(series, "cash_and_cash_equivalents"), investments = sheet ? group(sheet.assets, "investments") : 0;
const debt = sheet ? group(sheet.liabilities, "debt") : last(series, "long_term_debt"), leases = sheet ? group(sheet.liabilities, "leases") : 0;
const preferred = sheet ? byConcept(sheet.equity, /Preferred/i) : 0, minority = sheet ? byConcept(sheet.equity, /MinorityInterest|Noncontrolling/i) : 0;
const equity = last(series, "stockholders_equity"), shares = sharesOf(ticker) ?? reportFact("shares_diluted_weighted");
const tax = args.tax ? Number(args.tax) : reportFact("effective_tax_rate_ttm") ?? 0.21;
const nopat = operating * (1 - tax), invested = equity != null && debt != null && cash != null ? equity + debt + leases - cash - investments : null;
const facts: PriorFact[] = [
  ["revenue_ttm", revenue, "USD"], ["operating_income_ttm", operating, "USD"], ["net_income_ttm", net, "USD"], ["cfo_ttm", cfo, "USD"], ["capex_ttm", capex, "USD"], ["da_ttm", da, "USD"], ["sbc_ttm", sbc, "USD"], ["interest_expense_ttm", interest, "USD"],
  ["ebitda_ttm", da != null ? operating + da : null, "USD"], ["nopat_ttm", nopat, "USD"], ["cash", cash, "USD"], ["investments", investments, "USD"], ["debt", debt, "USD"], ["leases", leases, "USD"], ["preferred_stock", preferred > 0 ? preferred : null, "USD"], ["minority_interest", minority > 0 ? minority : null, "USD"],
  ["equity", equity, "USD"], ["invested_capital", invested, "USD"], ["shares_outstanding", shares, "shares"], ["operating_margin_ttm", operating / revenue, "ratio"], ["effective_tax_rate_ttm", tax, "ratio"], ["fcf_ttm", cfo != null && capex != null ? cfo - Math.abs(capex) : null, "USD"],
  ["rpo_total", newest?.rpo ? num(newest.rpo.total) : null, "USD"],
].flatMap(([id, value, unit]) => value != null ? [{ id: id as string, value: value as number, unit: unit as string }] : []);
if (report) for (const f of report.facts) if (f.id === "shares_diluted_weighted" && !facts.some(x => x.id === f.id)) facts.push({ id: f.id, value: f.value, unit: f.unit });
const revenueWindows = windows(series, "total_revenue");
// Growth year on year by quarter: the public series holds eight quarters, too few for trailing-window growth.
const revenuePoints = (series.find(s => s.metricKey === "total_revenue")?.points ?? []).map(p => ({ periodEnd: p.periodEnd, value: num(p.valueDecimal) })).filter((p): p is { periodEnd: string; value: number } => p.value != null);
const derivedDistributions: FactorDistribution[] = [
  distributionOf("revenueGrowth", revenuePoints.slice(4).map((p, i) => ({ periodEnd: p.periodEnd, value: p.value / revenuePoints[i]!.value - 1 }))),
  distributionOf("operatingMargin", windows(series, "operating_income").map(w => ({ periodEnd: w.periodEnd, value: w.value / revenueWindows.find(r => r.periodEnd === w.periodEnd)!.value }))),
  distributionOf("capexToRevenue", windows(series, "capital_expenditure").map(w => ({ periodEnd: w.periodEnd, value: Math.abs(w.value) / revenueWindows.find(r => r.periodEnd === w.periodEnd)!.value }))),
].filter((d): d is FactorDistribution => d != null);
// The published report carries the annual history where one exists; the quarterly windows stand in otherwise.
const distributions = report?.distributions.length ? report.distributions : derivedDistributions;
const priorRevenue = revenueWindows.at(-5)?.value ?? null;
const diagnostics = [{ key: "capexToDa", value: capex != null && da ? Math.abs(capex) / da : null }, { key: "roic", value: invested ? nopat / invested : null }, { key: "revenueGrowthTtm", value: priorRevenue ? revenue / priorRevenue - 1 : null }];
const rpo = newest?.rpo ? { asOf: newest.rpo.asOf, total: Number(newest.rpo.total), buckets: newest.rpo.buckets.map(b => ({ start: b.start, months: b.months, share: b.share == null ? null : Number(b.share) })) } : null;

// ---- Market inputs through the production reader, over the saved chart answers.
const [quote, riskFree, beta, closes] = await Promise.all([fetchReferenceQuote(ticker, "USD", fetcher, now), fetchRiskFreeRate("USD", fetcher, now), fetchBeta(ticker, "USD", fetcher, now), fetchWeeklyCloses(ticker, fetcher, now)]);
if (!quote || !riskFree || !beta) throw new Error(`market inputs missing: quote ${!!quote}, rf ${!!riskFree}, beta ${!!beta}`);
const peerTickers = args.peers ? args.peers.split(",").map(s => s.trim().toUpperCase()).filter(Boolean) : curatedPeersFor(ticker) ?? [];
const peerBasis = args.peers ? "ranking" as const : "curated" as const;
const management = managementTargetsFor(ticker);
const periodEnd = revenueWindows.at(-1)!.periodEnd;
const peerQuotes = await fetchPeerQuotes(peerTickers, "USD", fetcher, now);
const peerRows = peerTickers.map(t => {
  const s = fundamentals(t), q = capital(t)[0]?.balanceSheet ?? null;
  const op = ttm(s, "operating_income"), d = ttm(s, "depreciation_and_amortization");
  const pDebt = q ? group(q.liabilities, "debt") + group(q.liabilities, "leases") : last(s, "long_term_debt") ?? 0, pCash = q ? group(q.assets, "cash") : last(s, "cash_and_cash_equivalents") ?? 0;
  return { ticker: t, price: peerQuotes[t]?.usable ? peerQuotes[t]!.price : null, shares: sharesOf(t), ebitda: op != null && d != null ? op + d : null, coreEarnings: op != null ? op * (1 - 0.21) : null, netDebt: pDebt - pCash };
});
const peers = peerMultiplesOf(peerRows, now.toISOString().slice(0, 10), peerBasis);
const trailingQuarters = windows(series, "operating_income").flatMap(w => {
  const d = windows(series, "depreciation_and_amortization").find(x => x.periodEnd === w.periodEnd);
  const q = quarters.find(x => x.periodEnd === w.periodEnd)?.balanceSheet ?? null;
  const netDebt = q ? group(q.liabilities, "debt") + group(q.liabilities, "leases") - group(q.assets, "cash") : null;
  return d && netDebt != null ? [{ periodEnd: w.periodEnd, ebitdaTtm: w.value + d.value, netDebt }] : [];
});
const multipleHistory = closes && shares ? multipleHistoryOf(closes, shares, trailingQuarters) : null;
const consensus = args.consensus ? (([mean, low, high, count, asOf]) => ({ mean: Number(mean), low: low ? Number(low) : null, high: high ? Number(high) : null, count: count ? Number(count) : null, asOf: asOf ?? null, evidenceId: null }))(args.consensus.split(",")) : null;
const trailing = { ebitda: da != null ? operating + da : null, da, interestExpense: interest };
const lifecycle = lifecycleOf({ facts, diagnostics });

// ---- Before: the v1-style prior (five flat years from history medians, no anchor, no build capex, no cross-check).
const v1Prior = (): CalcRequest | null => {
  const growth = distributions.find(d => d.factor === "revenueGrowth"), margin = distributions.find(d => d.factor === "operatingMargin");
  if (!growth || !margin || !shares) return null;
  const marketCap = quote.price * shares, debtAll = (debt ?? 0) + leases, equityWeight = marketCap / (marketCap + debtAll);
  const costOfDebt = interest && debtAll > 0 ? Math.min(Math.max(interest / debtAll, riskFree.value), 0.15) : riskFree.value + 0.015;
  const costOfEquity = riskFree.value + beta.beta * 0.045, r = equityWeight * costOfEquity + (1 - equityWeight) * costOfDebt * (1 - tax);
  const capexRatio = distributions.find(d => d.factor === "capexToRevenue")?.median ?? 0.05, s2c = Math.min(Math.max(1 / Math.max(capexRatio * 4, 0.05), 0.5), 6);
  const roic = diagnostics.find(d => d.key === "roic")?.value ?? null, terminalRoic = Math.max(roic ?? r + 0.02, r + 0.005), g = Math.min(riskFree.value, Math.max(growth.median, 0));
  const scenario = (gr: number, mg: number) => ({ narrative: "", probability: null, triggers: [], invalidation: [], evidenceIds: [], drivers: { modelType: "fcff" as const, revenue0: revenue, path: { revenueGrowth: new Array<number>(5).fill(Math.max(gr, -0.3)), operatingMargin: new Array<number>(5).fill(mg), taxRate: new Array<number>(5).fill(tax), salesToCapital: new Array<number>(5).fill(s2c) }, terminalGrowth: g, terminalRoic } });
  return { modelType: "fcff", currency: "USD", discountRate: { value: r, basis: "wacc", components: { riskFree: riskFree.value, beta: beta.beta, equityRiskPremium: 0.045, costOfEquity, costOfDebt, taxRate: tax, equityWeight }, rationale: "v1 prior", sourceRefs: [] }, shares: { base: shares, dilutionReserve: 0, basis: "prior" }, bridge: { nonOperatingAssets: (cash ?? 0) + investments, debtAndClaims: debtAll, nonOperatingEquityAdjustment: 0, notes: [] }, price: quote.price,
    scenarios: { bear: scenario(growth.p25, margin.p25), base: scenario(growth.median, margin.median), bull: scenario(growth.p75, margin.p75) } };
};
const before = v1Prior();
const beforeResult = before ? calculateValuation(before) : null;
const beforeGates = beforeResult ? sanityGates({ result: beforeResult, riskFree: riskFree.value, anchor: null, consensus, triangulation: null, verification: null, impliedMultiple: trailing.ebitda && beforeResult.scenarios.base.result.enterpriseValue != null ? beforeResult.scenarios.base.result.enterpriseValue / trailing.ebitda : null, multipleHistory, peers: null }) : [];

// ---- The published report, recomputed on its own drivers (the calculator must still reproduce it) and judged by the v2 gates.
let published: { stored: number; recomputed: number; gates: ReturnType<typeof sanityGates>; verification: ReturnType<typeof verifyCitedInputs> } | null = null;
if (report?.model) {
  const m = report.model;
  const request: CalcRequest = { modelType: m.modelType, currency: m.currency, discountRate: m.discountRate, shares: { base: m.shares.base, dilutionReserve: m.shares.dilutionReserve, basis: m.shares.basis }, bridge: m.bridge, price: m.range.price, scenarios: Object.fromEntries((["bear", "base", "bull"] as const).map(k => [k, { narrative: m.scenarios[k]!.narrative, probability: m.scenarios[k]!.probability, triggers: m.scenarios[k]!.triggers, invalidation: m.scenarios[k]!.invalidation, evidenceIds: m.scenarios[k]!.evidenceIds, drivers: m.scenarios[k]!.drivers }])) as CalcRequest["scenarios"] };
  const recomputed = calculateValuation(request);
  const verification = verifyCitedInputs(request, report.facts.map(f => ({ id: f.id, value: f.value, unit: f.unit })).concat(facts.filter(f => (f.id === "preferred_stock" || f.id === "minority_interest") && !report.facts.some(x => x.id === f.id))));
  const gates = sanityGates({ result: recomputed, riskFree: m.discountRate.components.riskFree, anchor: rpo ? anchorOf(rpo, 5, revenue) : null, consensus, triangulation: null, verification, impliedMultiple: trailing.ebitda && recomputed.scenarios.base.result.enterpriseValue != null ? recomputed.scenarios.base.result.enterpriseValue / trailing.ebitda : null, multipleHistory, peers: null });
  published = { stored: m.range.base, recomputed: recomputed.range.base, gates, verification };
}

// ---- After: the v2 prior with its context, run twice to show the deterministic part does not drift.
// As the workflow does: the cited capex plan times the prior's build capex when the prior still passes every gate; the taper otherwise.
const priorWith = (capexShape: number[] | null) => { const r = priorRequest({ currency: "USD", facts, distributions, diagnostics, rpo, riskFree: riskFree.value, beta: beta.beta, price: quote.price, capexShape }); if (r) r.context = { ...r.context, peers, consensus, multipleHistory, trailing, management, periodEnd }; return r; };
const capexShape = management ? managementCapexShape(management, periodEnd, lifecycle === "build" ? 7 : 5, managementFactsOf(facts, revenue)) : null;
const tapered = priorWith(null), shaped = capexShape ? priorWith(capexShape) : null;
if (!tapered) throw new Error("the v2 prior could not be built");
const taperedResult = calculateValuation(tapered), shapedResult = shaped ? calculateValuation(shaped) : null;
const shapedPasses = !!shapedResult?.gates?.every(g => g.status !== "fail");
const after = shaped && shapedPasses ? shaped : tapered;
const afterResult = calculateValuation(after), rerun = calculateValuation(JSON.parse(JSON.stringify(after)) as CalcRequest);
const drift = Math.abs(rerun.range.base / afterResult.range.base - 1);

// ---- Report.
const money = (v: number | null | undefined) => v == null ? "n/a" : `$${v.toFixed(2)}`;
const pct = (v: number | null | undefined) => v == null ? "n/a" : `${(v * 100).toFixed(1)}%`;
const bn = (v: number | null | undefined) => v == null ? "n/a" : `${(v / 1e9).toFixed(1)}B`;
const base = (r: ValuationModelResult) => r.scenarios.base;
const lines: string[] = [];
lines.push(`# ${ticker} valuation dry run (deterministic, ${now.toISOString().slice(0, 10)})`, "");
lines.push(`Reference close ${money(quote.price)} on ${quote.priceDate}; risk-free ${pct(riskFree.value)} (${riskFree.date}); beta ${beta.beta.toFixed(2)} (${beta.observations} weeks); life cycle **${lifecycle}**; shares ${bn(shares)}.`, "");
lines.push(`Facts (TTM to ${revenueWindows.at(-1)?.periodEnd}): revenue ${bn(revenue)}, operating income ${bn(operating)} (${pct(operating / revenue)}), D&A ${bn(da)}, capex ${bn(capex)}, CFO ${bn(cfo)}, FCF ${bn(cfo != null && capex != null ? cfo - Math.abs(capex) : null)}, cash+securities ${bn(cash)}, other investments ${bn(investments)}, debt ${bn(debt)}, leases ${bn(leases)}, preferred ${bn(preferred)}, minority ${bn(minority)}, tax ${pct(tax)}${args.tax || reportFact("effective_tax_rate_ttm") != null ? "" : " (statutory assumption)"}.`, "");
if (rpo) lines.push(`RPO ${bn(rpo.total)} as of ${rpo.asOf}: ${rpo.buckets.map(b => `${pct(b.share)} from ${b.start ?? "period end"}${b.months ? ` over ${b.months} months` : ""}`).join("; ")}.`, "");
lines.push(`Peers (${peerBasis}: ${peerTickers.join(", ")}): ${peers ? `EV/EBITDA p25/median/p75 ${peers.evToEbitda ? `${peers.evToEbitda.p25.toFixed(1)}/${peers.evToEbitda.median.toFixed(1)}/${peers.evToEbitda.p75.toFixed(1)}` : "n/a"}; core P/E ${peers.peRatio ? `${peers.peRatio.p25.toFixed(1)}/${peers.peRatio.median.toFixed(1)}/${peers.peRatio.p75.toFixed(1)}` : "n/a"} (${peers.peers.join(", ")})${peers.notes.length ? `; ${peers.notes.join("; ")}` : ""}` : "none"}.`, "");
if (multipleHistory) lines.push(`Own trailing EV/EBITDA over ${multipleHistory.periods.length} weeks: ${multipleHistory.min.toFixed(1)}–${multipleHistory.max.toFixed(1)}x, median ${multipleHistory.median.toFixed(1)}x.`, "");
if (consensus) lines.push(`Consensus target: mean ${money(consensus.mean)}${consensus.low != null ? `, range ${money(consensus.low)}–${money(consensus.high)}` : ""}${consensus.count ? `, ${consensus.count} analysts` : ""}${consensus.asOf ? `, ${consensus.asOf}` : ""}.`, "");
lines.push("## Per-share values", "", "| Run | Bear | Base | Bull | Base vs price | Base vs consensus | Terminal share (base) | Horizon |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
const row = (label: string, r: ValuationModelResult | null) => r ? `| ${label} | ${money(r.range.low)} | ${money(r.range.base)} | ${money(r.range.high)} | ${pct(r.range.base / quote.price - 1)} | ${consensus ? pct(r.range.base / consensus.mean - 1) : "n/a"} | ${pct(base(r).result.terminalShare)} | ${r.horizonYears ?? 5}y |` : `| ${label} | n/a | n/a | n/a | | | | |`;
if (published) lines.push(`| Published report (main, LLM drivers), recomputed | ${money(report!.model.range.low)} | ${money(published.recomputed)} | ${money(report!.model.range.high)} | ${pct(published.recomputed / report!.quote.price - 1)} | ${consensus ? pct(published.recomputed / consensus.mean - 1) : "n/a"} | ${pct(report!.model.scenarios.base!.result.terminalShare)} | 5y |`);
const reference = afterResult.references?.[0] ?? null;
if (shapedResult) lines.push(row(after === shaped ? "After: v2 prior, four-year capex taper (for comparison)" : "After: v2 prior, cited capex timing (fails a gate, not chosen)", after === shaped ? taperedResult : shapedResult));
lines.push(row(`After: v2 prior (RPO floor, ${after === shaped ? "cited capex timing" : "four-year capex taper"}, 3% g cap)`, afterResult));
if (reference) lines.push(`| Management case (deterministic from cited targets) | — | ${money(reference.result.perShare)} | — | ${pct(reference.result.perShare / quote.price - 1)} | ${consensus ? pct(reference.result.perShare / consensus.mean - 1) : "n/a"} | ${pct(reference.result.terminalShare)} | ${reference.result.yearly.length}y |`);
lines.push("");
if (afterResult.triangulation) lines.push(`Weighted football field (DCF / EV/EBITDA / P/E): after ${money(afterResult.triangulation.low)}–${money(afterResult.triangulation.high)}, base ${money(afterResult.triangulation.base)}${reference?.triangulation ? `; management case ${money(reference.triangulation.low)}–${money(reference.triangulation.high)}, base ${money(reference.triangulation.base)}` : ""}.`, "");
if (published) lines.push(`Published base stored ${money(published.stored)}, recomputed ${money(published.recomputed)} (calculator reproduces v1 inputs). v2 gates on the published drivers: ${published.gates.map(g => `${g.key} **${g.status}**`).join(", ")}. Verification: ${published.verification.checks.filter(c => c.status !== "pass").map(c => c.detail).join("; ") || "all cited inputs match"}.`, "");
const ab = base(afterResult).drivers as Extract<CalcRequest["scenarios"]["base"]["drivers"], { modelType: "fcff" }>;
lines.push("## After: v2 prior drivers (base)", "", `WACC ${pct(afterResult.discountRate.value)}; revenue growth ${ab.path.revenueGrowth.map(pct).join(" → ")}; operating margin ${pct(ab.path.operatingMargin[0])}; sales-to-capital ${ab.path.salesToCapital[0]!.toFixed(2)}; build capex ${ab.path.buildCapex ? ab.path.buildCapex.map(bn).join(", ") : "none"}; terminal g ${pct(ab.terminalGrowth)}, terminal ROIC ${pct(ab.terminalRoic)}; bridge: non-operating ${bn(afterResult.bridge.nonOperatingAssets)}, claims ${bn(afterResult.bridge.debtAndClaims)}.`, "");
lines.push("| Year | Revenue | NOPAT | Reinvestment (incl. build) | FCFF | PV |", "| --- | --- | --- | --- | --- | --- |", ...base(afterResult).result.yearly.map(y => `| ${y.year} | ${bn(y.revenue)} | ${bn(y.nopat)} | ${bn(y.reinvestment)} | ${bn(y.cashFlow)} | ${bn(y.presentValue)} |`), "");
if (afterResult.anchors?.revenue) lines.push(`RPO floor by year: ${afterResult.anchors.revenue.floor.map(bn).join(", ")} (${afterResult.anchors.revenue.floorToRevenue0.map(pct).join(", ")} of trailing revenue). ${afterResult.anchors.revenue.notes.join("; ")}`, "");
lines.push("## After: method breakdown (football field)", "", "| Method | Low | Base | High | Weight | Basis |", "| --- | --- | --- | --- | --- | --- |", ...(afterResult.methods ?? []).map(m => `| ${m.label} | ${money(m.low)} | ${money(m.base)} | ${money(m.high)} | ${pct(m.weight)} | ${m.base != null ? m.basis : m.notes.join("; ")} |`), "");
if (afterResult.triangulation) lines.push(`Weighted range ${money(afterResult.triangulation.low)}–${money(afterResult.triangulation.high)}, base ${money(afterResult.triangulation.base)}; dispersion ${afterResult.triangulation.dispersion?.toFixed(2) ?? "n/a"}x.`, "");
lines.push("## After: gates", "", "| Gate | Status | Detail |", "| --- | --- | --- |", ...(afterResult.gates ?? []).map(g => `| ${g.key} | ${g.status} | ${g.detail} |`), "");
if (reference) {
  const rd = reference.drivers as Extract<CalcRequest["scenarios"]["base"]["drivers"], { modelType: "fcff" }>;
  lines.push("## Management case (computed by code from cited targets; a reference, never the base)", "");
  lines.push(`Targets: ${reference.anchors.map(a => `${a.metric} FY${a.fiscalYear} → year ${a.year}: ${a.metric === "operating_margin" ? pct(a.target) : bn(a.target)}${a.path != null ? ` (path ${a.metric === "operating_margin" ? pct(a.path) : bn(a.path)})` : ""}`).join("; ")}.`, "");
  lines.push(`Revenue growth ${rd.path.revenueGrowth.map(pct).join(" → ")}; operating margin ${rd.path.operatingMargin.map(pct).join(" → ")}; sales-to-capital ${rd.path.salesToCapital.map(v => v.toFixed(2)).join(", ")}; build capex ${rd.path.buildCapex ? rd.path.buildCapex.map(bn).join(", ") : "none"}; same WACC, shares, bridge, tax and terminal as the prior.`, "");
  lines.push("| Year | Revenue | NOPAT | Reinvestment (incl. build) | FCFF | PV |", "| --- | --- | --- | --- | --- | --- |", ...reference.result.yearly.map(y => `| ${y.year} | ${bn(y.revenue)} | ${bn(y.nopat)} | ${bn(y.reinvestment)} | ${bn(y.cashFlow)} | ${bn(y.presentValue)} |`), "");
  lines.push(`DCF ${money(reference.result.perShare)} per share (terminal share ${pct(reference.result.terminalShare)}); methods: ${reference.methods.map(m => `${m.label} ${m.base != null ? `${money(m.low)} / ${money(m.base)} / ${money(m.high)}` : "not applied"}`).join("; ")}${reference.triangulation ? `; weighted ${money(reference.triangulation.low)}–${money(reference.triangulation.high)}, base ${money(reference.triangulation.base)}, dispersion ${reference.triangulation.dispersion?.toFixed(2) ?? "n/a"}x` : ""}.`, "");
  lines.push(`Notes: ${reference.notes.join("; ")}.`, "", `Sources: ${reference.sources.map(s => `${s.title} (${s.date}) ${s.url}`).join("; ")}`, "");
}
lines.push("## Before: v2 gates applied to the v1 prior", "", beforeGates.map(g => `${g.key} **${g.status}**`).join(", "), "");
lines.push(`Implied constant revenue growth at the price: before ${pct(beforeResult?.implied?.implied)} (base avg ${pct(beforeResult?.implied?.baseAverage)}); after ${pct(afterResult.implied?.implied)} (base avg ${pct(afterResult.implied?.baseAverage)}).`, "");
lines.push(`Top sensitivities (after): ${afterResult.sensitivities.slice(0, 4).map(s => `${s.factor} ${s.step} ${s.changePercent >= 0 ? "+" : ""}${s.changePercent.toFixed(1)}%`).join("; ")}.`, "");
lines.push(`Rerun drift of the deterministic part: ${(drift * 100).toFixed(4)}%.`, "");
const out = lines.join("\n");
if (args.out) writeFileSync(args.out, out); else process.stdout.write(out);
if (args.json) writeFileSync(args.json, JSON.stringify({ ticker, quote, riskFree, beta, lifecycle, facts, diagnostics, rpo, peers, peerBasis, multipleHistory, consensus, management, before: beforeResult, beforeGates, published, tapered: taperedResult, shaped: shapedResult, shapedPasses, after: afterResult, afterRequest: after, drift }, null, 1));
