import type { FlowMetric } from "../analysis-contract/business-flow.ts";
import type { AnalysisFinding, CapitalMetric, DerivedMetric, FindingEvidence, FindingRef, FindingSpan } from "../analysis-contract/findings.ts";
import {
  STATEMENT_ANALYSIS_VERSION, STATEMENT_DIMENSIONS, STATEMENT_METRICS, STATEMENT_RULES,
  type AssessedDimension, type AssessedMetric, type CapitalChain, type CashBridge, type BridgeStep, type Flag, type FlagLevel, type IncomeModel, type PeerRank,
  type MetricForm, type RuleCondition, type StatementAssessment, type StatementMetricDef, type StatementRuleDef,
} from "../analysis-contract/statement-analysis.ts";
import { cashFlowSpan, operatingGroup, resolveEvidence, resolveRef, shiftPeriod, type FindingData, type ResolvedValue } from "./findings.ts";
import { refView } from "./highlights.ts";
import { comparablePeers } from "./peers.ts";
import type { PeersPublication } from "../analysis-contract/peers.ts";
import { compactMoney, multiple, perShare, points, type Locale } from "./locale.ts";

/**
 * The three-statement checkup over the data a page already holds (docs/three-statement-analysis-design.md). Pure:
 * the same call in the pipeline and in the browser gives the same metrics, the same flags and the same bridge, so
 * what a model is told matches what the reader sees. Every figure is resolved through the findings runtime and
 * nothing is assumed zero; a metric the data cannot answer is left out and counted as uncovered.
 */

/** Quarterly points a metric shows; four more are read behind them so every shown point has a year-earlier comparison. */
const SHOWN = 9, BEHIND = 4;
const LEVEL_ORDER: Record<FlagLevel, number> = { alert: 0, watch: 1, note: 2 };
const zh = (locale: Locale) => locale === "zh-CN";

/** The presentation the metrics are chosen for: the report's own, with "unknown" and an absent model read as standard. */
export function incomeModelAt(data: FindingData, periodEnd: string): IncomeModel {
  const q = [...data.quarters].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd)).find(q => Math.abs(Date.parse(q.periodEnd) - Date.parse(periodEnd)) <= 20 * 86_400_000) ?? data.quarters[0];
  const model = q?.incomeModel;
  return !model || model === "unknown" ? "standard" : model;
}
const enabledFor = (def: StatementMetricDef, model: IncomeModel) => def.models === "all" || def.models.includes(model);

/** A resolved figure in the metric's display units: a rate in percent, a multiple in turns, an amount as is. */
function display(form: MetricForm, r: ResolvedValue): number {
  if (form === "percent") return r.unit === "ratio" ? r.value * 100 : r.value;
  return r.value;
}
/** A comparison's delta in display units: points for a rate (a ratio's difference ×100), turns for a multiple, percent for an amount. */
function displayDelta(form: MetricForm, r: { current: ResolvedValue; delta: number | null }): number | null {
  if (r.delta == null) return null;
  return form === "percent" && r.current.unit === "ratio" ? r.delta * 100 : r.delta;
}

/** The metric's number at one quarter end, or null when the data cannot answer it there. */
function measureAt(data: FindingData, def: StatementMetricDef, end: string): { value: number; resolved: ResolvedValue } | null {
  if (def.measure === "value") {
    // A ratio over a loss, a deficit or a negative base reads backwards (cash over a net loss, net debt over negative EBITDA): no value.
    if ("ratio" in def.ref) { const base = resolveRef(data, def.ref.ratio.denominator, end, def.span); if (!base || base.value <= 0) return null; }
    const r = resolveRef(data, def.ref, end, def.span);
    return r && !r.range ? { value: display(def.form, r), resolved: r } : null;
  }
  // A growth measure is the comparison's delta: percent for an amount, points for a rate; a spread subtracts two such growths.
  const growth = (ref: FindingRef) => { const r = resolveEvidence(data, { ref, periodEnd: end, span: def.span, compare: def.measure === "qoq" ? "qoq" : "yoy" }); const value = r ? displayDelta(def.form, r) : null; return r && value != null ? { value, resolved: r.current } : null; };
  const own = growth(def.ref);
  if (!own) return null;
  if (def.measure !== "spread") return own;
  const against = def.against ? growth(def.against) : null;
  return against ? { value: own.value - against.value, resolved: own.resolved } : null;
}

/** Change of a display series between two of its points: points for a rate, turns for a multiple, percent growth for an amount (positive both times). */
function seriesChange(form: MetricForm, now: number | undefined, then: number | undefined): number | null {
  if (now == null || then == null) return null;
  if (form === "money" || form === "per_share") return now > 0 && then > 0 ? (now - then) / then * 100 : null;
  return now - then;
}

/** Flow and capital figures a reference rests on, for the three views to light; a derived figure names its inputs. */
const DERIVED_INPUTS: Record<DerivedMetric, { metrics?: FlowMetric[]; capital?: CapitalMetric[] }> = {
  ebitda: { metrics: ["operating"], capital: ["depreciation"] }, netDebt: { capital: ["debt", "leases", "cash"] }, investedCapital: { capital: ["debt", "leases", "equity", "cash"] },
  nopat: { metrics: ["operating", "tax", "pretax"] }, accruals: { metrics: ["net"], capital: ["operatingCashFlow", "totalAssets"] },
  nonCashCharges: { capital: ["operatingCashFlow", "depreciation", "stockCompensation"] }, workingCapitalChange: { capital: ["operatingCashFlow", "receivables", "inventory", "payables"] },
  averageEquity: { capital: ["equity"] }, averageAssets: { capital: ["totalAssets"] }, averageInvestedCapital: { capital: ["debt", "leases", "equity", "cash"] },
  incrementalReturn: { metrics: ["operating"], capital: ["debt", "leases", "equity", "cash"] }, interestExpense: { metrics: ["other"] },
  netExternalFunding: { capital: ["debtIssued", "debtRepaid", "equityIssued"] }, cashRunwayMonths: { capital: ["cash", "freeCashFlow"] }, debtDueCoverage: { capital: ["cash", "freeCashFlow", "debt"] },
  depreciationAmortization: { capital: ["depreciation"] }, stockCompensationExpense: { capital: ["stockCompensation"] },
};
function collect(ref: FindingRef, metrics: Set<FlowMetric>, capital: Set<CapitalMetric>) {
  if ("ratio" in ref) { collect(ref.ratio.numerator, metrics, capital); collect(ref.ratio.denominator, metrics, capital); return; }
  if ("metric" in ref) metrics.add(ref.metric);
  else if ("capital" in ref) capital.add(ref.capital);
  else if ("derived" in ref) { DERIVED_INPUTS[ref.derived].metrics?.forEach(m => metrics.add(m)); DERIVED_INPUTS[ref.derived].capital?.forEach(c => capital.add(c)); }
}
/** What a metric lights on the stage, in the shape a finding's anchors take; at most six of each, as the findings contract allows. */
export function metricAnchors(def: StatementMetricDef): AnalysisFinding["anchors"] {
  const metrics = new Set<FlowMetric>(), capital = new Set<CapitalMetric>();
  collect(def.ref, metrics, capital);
  if (def.against) collect(def.against, metrics, capital);
  const view = refView(def.ref) ?? "profit";
  return { view, nodeIds: [], metrics: [...metrics].slice(0, 6), ...(capital.size ? { capital: [...capital].slice(0, 6) } : {}) };
}

function metricEvidence(def: StatementMetricDef, periodEnd: string): FindingEvidence[] {
  const compare = def.measure === "qoq" ? "qoq" as const : "yoy" as const;
  const own: FindingEvidence = { ref: def.ref, periodEnd, span: def.span, compare };
  return def.measure === "spread" && def.against ? [own, { ref: def.against, periodEnd, span: def.span, compare }] : [own];
}

type Series = { def: StatementMetricDef; ends: string[]; values: Array<number | null>; resolved: Array<ResolvedValue | null> };

/** Every enabled metric read at the shown quarters and the four behind them, newest first. */
function readSeries(data: FindingData, periodEnd: string, model: IncomeModel): Series[] {
  const ends = Array.from({ length: SHOWN + BEHIND }, (_, i) => shiftPeriod(periodEnd, -3 * i));
  return STATEMENT_METRICS.filter(def => enabledFor(def, model)).map(def => {
    const points = ends.map(end => measureAt(data, def, end));
    return { def, ends, values: points.map(p => p?.value ?? null), resolved: points.map(p => p?.resolved ?? null) };
  });
}

/** Display units are percents, points and turns, so a difference this small is arithmetic noise, not a move. */
const EPSILON = 1e-6;
/** A condition at quarter index `k` (0 = the report) of a metric's newest-first series. */
function holds(c: RuleCondition, series: Map<string, Series>, k: number): boolean {
  const s = series.get(c.metric);
  if (!s) return false;
  const v = (i: number) => s.values[i] ?? undefined;
  if ("flipped" in c) { const now = v(k), then = v(k + 4); return now != null && then != null && (c.flipped === "toPositive" ? now > 0 && then < 0 : now < 0 && then > 0); }
  if ("falling" in c) { for (let i = 0; i < c.falling; i++) { const a = v(k + i), b = v(k + i + 1); if (a == null || b == null || !(a < b - EPSILON)) return false; } return true; }
  const x = c.on === "value" ? v(k) ?? null : seriesChange(s.def.form, v(k), v(k + (c.on === "yoy" ? 4 : 1)));
  return x != null && (c.op === "<" ? x < c.value - EPSILON : x > c.value + EPSILON);
}

const METRIC_BY_ID: ReadonlyMap<string, StatementMetricDef> = new Map(STATEMENT_METRICS.map(d => [d.id, d]));

/** A threshold in the metric's display form: "0.8×" / "0.8倍", "15 pp" / "15个百分点", "18 months" / "18 个月", "$0". */
function thresholdValue(form: MetricForm, value: number, locale: Locale): string {
  const n = Number(value.toFixed(2)).toString();
  switch (form) {
    case "percent": return `${n}%`;
    case "points": return zh(locale) ? `${n}个百分点` : `${n} pp`;
    case "multiple": return multiple(n, locale);
    case "months": return zh(locale) ? `${n} 个月` : `${n} months`;
    case "money": return compactMoney(value, "USD", locale);
    case "per_share": return n;
  }
}
/** The rule as a formula the reader can check: each condition in the metric's units, then the run it must hold for. */
export function ruleThreshold(rule: StatementRuleDef, locale: Locale = "en", defs: ReadonlyMap<string, StatementMetricDef> = METRIC_BY_ID): string {
  const parts = rule.all.map(c => {
    const def = defs.get(c.metric), name = c.metric === rule.metric || !def ? "" : `${def.label[zh(locale) ? 1 : 0]} `;
    if ("flipped" in c) return `${name}${zh(locale) ? (c.flipped === "toPositive" ? "由负转正（较上年同期）" : "由正转负（较上年同期）") : (c.flipped === "toPositive" ? "turned positive vs. a year ago" : "turned negative vs. a year ago")}`;
    if ("falling" in c) return `${name}${zh(locale) ? `连续 ${c.falling} 季下降` : `falling ${c.falling} quarters`}`;
    const on = c.on === "value" ? "" : zh(locale) ? (c.on === "yoy" ? "同比变动 " : "环比变动 ") : (c.on === "yoy" ? "YoY change " : "QoQ change ");
    const form: MetricForm = c.on === "value" ? def?.form ?? "multiple" : def?.form === "money" || def?.form === "per_share" ? "percent" : def?.form === "percent" ? "points" : def?.form ?? "multiple";
    return `${name}${on}${c.op} ${thresholdValue(form, c.value, locale)}`;
  });
  const run = rule.persist > 1 ? (zh(locale) ? `，连续 ${rule.persist} 季` : `, ${rule.persist} quarters`) : "";
  return parts.join(zh(locale) ? "，且 " : ", and ") + run;
}

/** How far past its first threshold the flagged metric sits, for ordering within a level; zero for sign flips and runs. */
function excess(rule: StatementRuleDef, value: number): number {
  const c = rule.all.find(c => c.metric === rule.metric && "on" in c && c.on === "value");
  return c && "on" in c ? Math.abs(value - c.value) / Math.max(1, Math.abs(c.value)) : 0;
}

function evaluateRules(series: Map<string, Series>, periodEnd: string, locale: Locale): Flag[] {
  const flags: Flag[] = [];
  for (const rule of STATEMENT_RULES) {
    const s = series.get(rule.metric);
    if (!s || s.values[0] == null) continue;
    const at = (k: number) => rule.all.every(c => holds(c, series, k));
    let run = 0;
    while (run < s.ends.length && at(run)) run++;
    if (run < rule.persist) continue;
    flags.push({
      ruleId: rule.id, level: rule.level, dimension: rule.dimension, metricId: rule.metric, value: s.values[0],
      threshold: ruleThreshold(rule, locale), since: s.ends[run - 1]!, anchors: metricAnchors(s.def), evidence: metricEvidence(s.def, periodEnd),
    });
  }
  return flags.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || excess(STATEMENT_RULES.find(r => r.id === b.ruleId)!, b.value) - excess(STATEMENT_RULES.find(r => r.id === a.ruleId)!, a.value));
}

/* ---------- Bridge and chain ---------- */

const STEP_LABEL: Record<string, [string, string]> = {
  netIncome: ["Net income", "净利润"], nonCash: ["Non-cash charges", "非现金项目"], workingCapital: ["Working-capital change", "营运资本变动"], otherOperating: ["Other operating items", "其他经营项目"],
  operating: ["Operating cash flow", "经营现金流"], capex: ["Capital expenditures", "资本开支"], freeCashFlow: ["Free cash flow", "自由现金流"],
  acquisitions: ["Acquisitions", "收购"], investments: ["Investments, net", "投资净额"], otherInvesting: ["Other investing", "其他投资活动"], investing: ["Investing cash flow", "投资现金流"],
  debtIssued: ["Debt issued", "新增借款"], debtRepaid: ["Debt repaid", "偿还债务"], equityIssued: ["Stock issued", "股权融资"], buybacks: ["Share buybacks", "回购"], dividends: ["Dividends", "分红"],
  leasePrincipal: ["Lease principal", "租赁本金"], otherFinancing: ["Other financing", "其他筹资活动"], financing: ["Financing cash flow", "筹资现金流"], fx: ["Exchange rate effect", "汇率影响"], netChange: ["Change in cash", "现金变动"],
};
const section = (lines: Array<{ group: string; value: string }> | null, group: string) => lines ? lines.filter(l => l.group === group).reduce((t, l) => t + Number(l.value), 0) : null;

/**
 * Net income to the change in cash, one step per economic group of the cash-flow statement; a section whose lines
 * do not reconcile contributes its total as one step. Running totals (operating, free cash flow, net change) are
 * marked, and `closes` says whether the steps add up to the statement's own net change.
 */
export function cashBridge(data: FindingData, periodEnd: string, span: FindingSpan, locale: Locale = "en"): CashBridge | null {
  const read = (pick: Parameters<typeof cashFlowSpan>[3]) => cashFlowSpan(data, periodEnd, span, pick);
  const total = read(c => Number(c.operating.total));
  if (!total) return null;
  const name = (id: string) => STEP_LABEL[id]![zh(locale) ? 1 : 0];
  const steps: BridgeStep[] = [];
  const step = (id: string, value: number | null, ref: FindingRef | null = null) => { if (value != null && Number.isFinite(value) && value !== 0) steps.push({ id, label: name(id), value, ref }); };
  const mark = (id: string, value: number, ref: FindingRef | null) => steps.push({ id, label: name(id), value, ref, total: true });
  // Without reconciled operating lines in every quarter of the span, operating cash flow stands as one total from zero.
  const operatingLines = read(c => operatingGroup(c, "netIncome"));
  if (operatingLines) {
    step("netIncome", operatingLines.value, { metric: "net" });
    step("nonCash", read(c => operatingGroup(c, "nonCash"))?.value ?? null, { derived: "nonCashCharges" });
    step("workingCapital", read(c => operatingGroup(c, "workingCapital"))?.value ?? null, { derived: "workingCapitalChange" });
    step("otherOperating", read(c => operatingGroup(c, "other"))?.value ?? null);
  }
  mark("operating", total.value, { capital: "operatingCashFlow" });
  const investingTotal = read(c => Number(c.investing.total)), capex = read(c => section(c.investing.lines, "capex"));
  if (capex) {
    step("capex", capex.value, { capital: "capex" });
    mark("freeCashFlow", total.value + capex.value, { capital: "freeCashFlow" });
    step("acquisitions", read(c => section(c.investing.lines, "acquisitions"))?.value ?? null, { capital: "acquisitions" });
    step("investments", read(c => section(c.investing.lines, "investments"))?.value ?? null, { capital: "investmentsNet" });
    step("otherInvesting", read(c => section(c.investing.lines, "other"))?.value ?? null);
  } else step("investing", investingTotal?.value ?? null);
  const financingTotal = read(c => Number(c.financing.total)), financingLines = read(c => c.financing.lines ? 1 : null);
  if (financingLines) {
    for (const [id, capital] of [["debtIssued", "debtIssued"], ["debtRepaid", "debtRepaid"], ["equityIssued", "equityIssued"], ["buybacks", "buybacks"], ["dividends", "dividends"], ["leasePrincipal", "leasePrincipal"]] as Array<[string, CapitalMetric]>) step(id, read(c => section(c.financing.lines, id))?.value ?? null, { capital });
    step("otherFinancing", read(c => section(c.financing.lines, "other"))?.value ?? null);
  } else step("financing", financingTotal?.value ?? null, { capital: "financing" });
  step("fx", read(c => c.fxEffect == null ? null : Number(c.fxEffect))?.value ?? null);
  const netChange = read(c => Number(c.netChange));
  if (!netChange) return null;
  mark("netChange", netChange.value, null);
  // Movements after operating cash flow, added to it, must reach the net change; the operating lines themselves sum to it by contract.
  const after = steps.slice(steps.findIndex(s => s.id === "operating") + 1).filter(s => !s.total);
  const moved = total.value + after.reduce((t, s) => t + s.value, 0);
  const tolerance = Math.max(2e6, 0.01 * Math.max(...steps.map(s => Math.abs(s.value))));
  const cash = (end: string) => resolveRef(data, { capital: "cash" }, end, "quarter")?.value ?? null;
  return { span, periodEnd: total.periodEnd, currency: total.currency ?? "USD", steps, openingCash: cash(shiftPeriod(periodEnd, span === "quarter" ? -3 : -12)), closingCash: cash(periodEnd), closes: Math.abs(moved - netChange.value) <= tolerance };
}

const CHAIN: Array<{ id: CapitalChain["series"][number]["id"]; label: [string, string]; ref: FindingRef; span: FindingSpan }> = [
  { id: "capex", label: ["Capex, four quarters", "资本开支（近四季）"], ref: { capital: "capex" }, span: "fiscal_year" },
  { id: "productive", label: ["Property and equipment", "固定资产"], ref: { capital: "productive" }, span: "quarter" },
  { id: "revenue", label: ["Revenue, four quarters", "营收（近四季）"], ref: { metric: "revenue" }, span: "fiscal_year" },
  { id: "operatingCashFlow", label: ["Operating cash flow, four quarters", "经营现金流（近四季）"], ref: { capital: "operatingCashFlow" }, span: "fiscal_year" },
];
/** Capex, the assets it became, and the revenue and cash that followed, each indexed to the oldest quarter all four answer. */
export function capitalChain(data: FindingData, periodEnd: string, locale: Locale = "en", quarters = 8): CapitalChain | null {
  const ends = Array.from({ length: quarters }, (_, i) => shiftPeriod(periodEnd, -3 * (quarters - 1 - i)));
  const raw = CHAIN.map(s => ({ ...s, values: ends.map(end => resolveRef(data, s.ref, end, s.span)?.value ?? null) }));
  const base = ends.findIndex((_, i) => raw.every(s => (s.values[i] ?? 0) > 0));
  if (base < 0 || ends.length - base < 2) return null;
  return { base: ends[base]!, series: raw.map(({ values, label, ...s }) => ({ ...s, label: label[zh(locale) ? 1 : 0], points: ends.flatMap((end, i) => i >= base && values[i] != null ? [{ periodEnd: end, value: values[i]!, index: values[i]! / values[base]! * 100 }] : []) })) };
}

/* ---------- Assessment ---------- */

export function assessStatements(data: FindingData, periodEnd: string, locale: Locale = "en"): StatementAssessment {
  const model = incomeModelAt(data, periodEnd);
  const all = readSeries(data, periodEnd, model);
  const byId = new Map(all.map(s => [s.def.id, s]));
  const flags = evaluateRules(byId, periodEnd, locale);
  const metrics: AssessedMetric[] = all.flatMap(s => {
    const current = s.resolved[0], value = s.values[0];
    if (!current || value == null) return [];
    const shown = s.ends.slice(0, SHOWN).map((end, i) => ({ end, value: s.values[i] })).filter((p): p is { end: string; value: number } => p.value != null).reverse();
    const { def } = s;
    return [{
      id: def.id, dimension: def.dimension, label: def.label[zh(locale) ? 1 : 0], ref: def.ref, measure: def.measure, form: def.form, span: def.span, better: def.better,
      series: shown.map(p => ({ periodEnd: p.end, value: p.value })), current: { value, resolved: current },
      yoy: seriesChange(def.form, value, s.values[4] ?? undefined), qoq: seriesChange(def.form, value, s.values[1] ?? undefined), evidence: metricEvidence(def, periodEnd)[0]!,
    }];
  });
  const dimensions: AssessedDimension[] = STATEMENT_DIMENSIONS.map(id => ({
    id, metrics: metrics.filter(m => m.dimension === id), flags: flags.filter(f => f.dimension === id),
    total: all.filter(s => s.def.dimension === id).length, covered: metrics.filter(m => m.dimension === id).length,
  }));
  const standard = model === "standard" || model === "direct_operating";
  return {
    version: STATEMENT_ANALYSIS_VERSION, periodEnd, model, dimensions, flags,
    bridge: { quarter: cashBridge(data, periodEnd, "quarter", locale), year: cashBridge(data, periodEnd, "fiscal_year", locale) },
    chain: standard ? capitalChain(data, periodEnd, locale) : null,
  };
}

/* ---------- Reading the checkup ---------- */

export const METRIC_DEFS: ReadonlyMap<string, StatementMetricDef> = new Map(STATEMENT_METRICS.map(d => [d.id, d]));
export const RULE_DEFS: ReadonlyMap<string, StatementRuleDef> = new Map(STATEMENT_RULES.map(r => [r.id, r]));

/** A metric's value as the page and the ledger write it: "12.3%", "+15.2 pp", "2.60×", "$75.7B", "18 months". */
export function formatMetric(value: number, form: MetricForm, locale: Locale = "en", currency: string | null = "USD"): string {
  if (!Number.isFinite(value)) return "—";
  const sign = value < 0 ? "−" : "";
  switch (form) {
    case "percent": return `${sign}${Math.abs(value).toFixed(1)}%`;
    case "points": return points(value, locale);
    case "multiple": return multiple(`${sign}${Math.abs(value).toFixed(2)}`, locale);
    case "money": return compactMoney(value, currency, locale);
    case "per_share": return perShare(value, currency, locale);
    case "months": return zh(locale) ? `${Math.abs(value).toFixed(1)} 个月` : `${Math.abs(value).toFixed(1)} months`;
  }
}
/** A change of a metric in its own terms: points for a rate, turns for a multiple, percent for an amount or a count of months. */
export function formatMetricChange(delta: number, form: MetricForm, locale: Locale = "en"): string {
  if (!Number.isFinite(delta)) return "—";
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
  if (form === "percent" || form === "points") return points(delta, locale);
  if (form === "multiple") return multiple(`${sign}${Math.abs(delta).toFixed(2)}`, locale);
  return `${sign}${Math.abs(delta).toFixed(1)}%`;
}

/** The levels a flagged metric is tested against, in its display units, for a chart's threshold lines. */
export function thresholdsOf(flag: Pick<Flag, "ruleId" | "metricId">): number[] {
  const rule = RULE_DEFS.get(flag.ruleId);
  return rule ? rule.all.flatMap(c => c.metric === flag.metricId && "on" in c && c.on === "value" ? [c.value] : []) : [];
}

/**
 * The statement figures a flag is about, for marking the tiles that show them: a ratio's numerator, a spread's own
 * figure, a derived figure's leading input. The denominator is context, not the subject.
 */
export function flagFigures(flag: Pick<Flag, "metricId">): { metrics: FlowMetric[]; capital: CapitalMetric[] } {
  const def = METRIC_DEFS.get(flag.metricId);
  const metrics = new Set<FlowMetric>(), capital = new Set<CapitalMetric>();
  const lead = (ref: FindingRef) => {
    if ("ratio" in ref) { lead(ref.ratio.numerator); return; }
    if ("metric" in ref) metrics.add(ref.metric);
    else if ("capital" in ref) capital.add(ref.capital);
    else if ("derived" in ref) { const inputs = DERIVED_INPUTS[ref.derived]; if (inputs.capital?.[0]) capital.add(inputs.capital[0]); else if (inputs.metrics?.[0]) metrics.add(inputs.metrics[0]); }
  };
  if (def) lead(def.ref);
  return { metrics: [...metrics], capital: [...capital] };
}

/** A reference read at a peer: the same figure or ratio through the peers projection; null when a side has no peer figure. */
function atPeer(ref: FindingRef, ticker: string): FindingRef | null {
  if ("ratio" in ref) {
    const n = atPeer(ref.ratio.numerator, ticker), d = atPeer(ref.ratio.denominator, ticker);
    return n && d && !("ratio" in n) && !("ratio" in d) ? { ratio: { numerator: n as never, denominator: d as never } } : null;
  }
  if ("metric" in ref) return { peer: { ticker, ref: { metric: ref.metric } } };
  if ("capital" in ref) return { peer: { ticker, ref: { capital: ref.capital } } };
  if ("fundamental" in ref) return { peer: { ticker, ref: { fundamental: ref.fundamental } } };
  // The projection's own figures already fall back to the SEC series the same way.
  if ("derived" in ref && ref.derived === "depreciationAmortization") return { peer: { ticker, ref: { capital: "depreciation" } } };
  if ("derived" in ref && ref.derived === "stockCompensationExpense") return { peer: { ticker, ref: { capital: "stockCompensation" } } };
  return null;
}

/**
 * The peers a company's whole-company ratios may be ranked against: business-tag pairs of basis company only. A shared
 * category alone (a bank beside a phone maker) or a pair comparable on one unit is not a basis for ranking.
 */
export const rankingPeers = (peers: PeersPublication | null | undefined, ticker: string): string[] =>
  (comparablePeers(peers, ticker) ?? []).filter(c => c.pair.basis === "company").map(c => c.ticker);

/**
 * Where the company stands on each ratio its ranking peers can answer: only level metrics with a direction, each peer
 * at its aligned quarter, and only when at least two peers answer. Amounts and months are not ranked; size is not a ratio.
 */
export function peerRanks(data: FindingData, assessment: StatementAssessment, ticker: string): Record<string, PeerRank> {
  const peers = rankingPeers(data.peers, ticker);
  const out: Record<string, PeerRank> = {};
  if (peers.length < 2) return out;
  for (const metric of assessment.dimensions.flatMap(d => d.metrics)) {
    if (metric.measure !== "value" || metric.better === "none" || metric.form === "money" || metric.form === "months") continue;
    const rows: PeerRank["rows"] = [{ ticker, value: metric.current.value, periodEnd: metric.current.resolved.periodEnd, own: true }];
    for (const peer of peers) {
      const ref = atPeer(metric.ref, peer);
      const r = ref ? resolveRef(data, ref, assessment.periodEnd, metric.span) : null;
      if (r && !r.range && Number.isFinite(r.value)) rows.push({ ticker: peer, value: display(metric.form, r), periodEnd: r.periodEnd, own: false });
    }
    if (rows.length < 3) continue;
    rows.sort((a, b) => metric.better === "high" ? b.value - a.value : a.value - b.value);
    out[metric.id] = { rank: rows.findIndex(r => r.own) + 1, of: rows.length, rows };
  }
  return out;
}

/** Counts of the flags at each level, for a company's line on the home page. */
export const flagCounts = (flags: Flag[]): Record<FlagLevel, number> => ({ alert: flags.filter(f => f.level === "alert").length, watch: flags.filter(f => f.level === "watch").length, note: flags.filter(f => f.level === "note").length });
