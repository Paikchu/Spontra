import type { FlowMetric } from "../analysis-contract/business-flow.ts";
import type { AnalysisFinding, CapitalMetric, DerivedMetric, FindingEvidence, FindingRef } from "../analysis-contract/findings.ts";
import {
  STATEMENT_ANALYSIS_VERSION, STATEMENT_DIMENSIONS, STATEMENT_METRICS, STATEMENT_RULES,
  type AssessedDimension, type AssessedMetric, type Flag, type FlagLevel, type IncomeModel, type MetricForm, type RuleCondition, type StatementAssessment, type StatementMetricDef, type StatementRuleDef,
} from "../analysis-contract/statement-analysis.ts";
import { resolveEvidence, resolveRef, shiftPeriod, type FindingData, type ResolvedValue } from "./findings.ts";
import { refView } from "./highlights.ts";
import { compactMoney, multiple, perShare, points, type Locale } from "./locale.ts";

/**
 * The three-statement checkup over the findings data. Pure: the same call gives the same metrics and the same flags. Every figure is resolved through the findings runtime and
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
    return r ? { value: display(def.form, r), resolved: r } : null;
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
function ruleThreshold(rule: StatementRuleDef, locale: Locale = "en", defs: ReadonlyMap<string, StatementMetricDef> = METRIC_BY_ID): string {
  return ruleText(rule, locale, defs, op => `${op} `);
}

function ruleText(rule: StatementRuleDef, locale: Locale, defs: ReadonlyMap<string, StatementMetricDef>, sign: (op: "<" | ">") => string, words = false): string {
  const parts = rule.all.map(c => {
    const def = defs.get(c.metric), name = c.metric === rule.metric || !def ? "" : `${def.label[zh(locale) ? 1 : 0]} `;
    if ("flipped" in c) return `${name}${zh(locale) ? (c.flipped === "toPositive" ? "由负转正（较上年同期）" : "由正转负（较上年同期）") : (c.flipped === "toPositive" ? "turned positive vs. a year ago" : "turned negative vs. a year ago")}`;
    if ("falling" in c) return `${name}${zh(locale) ? `连续 ${c.falling} 季下降` : `falling ${c.falling} quarters`}`;
    const on = c.on === "value" ? "" : zh(locale) ? (c.on === "yoy" ? "同比变动 " : "环比变动 ") : (c.on === "yoy" ? "YoY change " : "QoQ change ");
    const form: MetricForm = c.on === "value" ? def?.form ?? "multiple" : def?.form === "money" || def?.form === "per_share" ? "percent" : def?.form === "percent" ? "points" : def?.form ?? "multiple";
    return `${name}${on}${sign(c.op)}${thresholdValue(form, c.value, locale)}`;
  });
  const run = rule.persist > 1 ? (zh(locale) ? `，连续 ${rule.persist} 季` : words ? `, ${rule.persist} quarters running` : `, ${rule.persist} quarters`) : "";
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
  };
}

/* ---------- Reading the metrics ---------- */

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
