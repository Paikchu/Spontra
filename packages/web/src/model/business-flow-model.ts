import { enrichDisclosedRevenue } from "./company-revenue-disclosures";
import {publicFlowSchema} from "@/shared/analysis-runtime/financial-data/schema";
import { type BusinessFlowQuarter, type FlowAmount, type FlowMetric, type PublicBusinessFlow } from "@/shared/analysis-contract/business-flow";
import type { PublicFundamentalsResponse, FundamentalMetricKey } from "@/shared/analysis-contract/fundamentals";


export function numeric(amount: FlowAmount | null | undefined): number | null {
  if (typeof amount?.value !== "string" || amount.value.trim() === "") return null;
  const value = Number(amount.value);
  return Number.isFinite(value) ? value : null;
}

const metricMap: Partial<Record<FlowMetric, FundamentalMetricKey>> = { revenue: "total_revenue", gross: "gross_profit", operating: "operating_income", net: "net_income", research: "research_and_development" };

export function adaptFundamentals(data: PublicFundamentalsResponse | null, ticker: string): PublicBusinessFlow {
  if (!data || data.ticker !== ticker || !Array.isArray(data.periods) || !Array.isArray(data.series)) return { schemaVersion: "business-flow.v1", ticker, fetchedAt: null, quarters: [] };
  const quarters = data.periods.filter(p => p && p.periodType === "3M" && typeof p.periodEnd === "string" && Number.isFinite(Date.parse(p.periodEnd))).map(period => {
    const figures: BusinessFlowQuarter["figures"] = {};
    const sources: BusinessFlowQuarter["sources"] = [];
    for (const [target, key] of Object.entries(metricMap)) {
      const series = data.series.find(s => s && Array.isArray(s.points) && s.metricKey === key && s.unitFamily === "currency" && s.currency === period.currency && s.unit === period.currency);
      const point = series?.points.find(p => p && p.periodEnd === period.periodEnd);
      if (!series || !point) continue;
      if (point.sourceAccession && !sources.some(s => s.id === point.sourceAccession)) sources.push({ id: point.sourceAccession, title: `SEC filing ${point.sourceAccession}`, url: `https://www.sec.gov/edgar/search/#/q=${encodeURIComponent(point.sourceAccession)}`, publishedAt: point.sourceFiledAt });
      figures[target as FlowMetric] = { value: point.valueDecimal, basis: series.basis, definition: `${data.catalogVersion}:${key}`, comparabilityKey: point.revision != null ? `${data.source}:${key}:revision-${point.revision}` : null, sourceIds: point.sourceAccession ? [point.sourceAccession] : [], formula: point.derivationFormula };
    }
    // Differences are only formed from figures in the same filing/revision. No YTD subtraction.
    for (const [target, left, right] of [["cost", "revenue", "gross"], ["operatingExpenses", "gross", "operating"]] as const) {
      const a = figures[left], b = figures[right];
      const av = numeric(a), bv = numeric(b);
      const sharedFiling = a?.sourceIds.length && a.sourceIds.join() === b?.sourceIds.join();
      const leftPoint = data.series.find(s => s && Array.isArray(s.points) && s.metricKey === metricMap[left])?.points.find(p => p && p.periodEnd === period.periodEnd);
      const rightPoint = data.series.find(s => s && Array.isArray(s.points) && s.metricKey === metricMap[right])?.points.find(p => p && p.periodEnd === period.periodEnd);
      const sharedRevision = leftPoint?.revision != null && leftPoint.revision === rightPoint?.revision;
      if (av != null && bv != null && (sharedFiling || sharedRevision)) figures[target] = { value: String(av - bv), basis: "derived", definition: `${left}-${right}`, comparabilityKey: a?.comparabilityKey && b?.comparabilityKey ? `${a.comparabilityKey}|${b.comparabilityKey}` : null, sourceIds: a?.sourceIds ?? [], formula: `${left} − ${right}` };
    }
    return { id: period.periodEnd, label: `Three months ended ${period.periodEnd}`, periodStart: null, periodEnd: period.periodEnd, periodType: "3M" as const, currency: period.currency, scale: 1, basisLabel: `${data.source === "sec_xbrl" ? "SEC XBRL" : "Yahoo Finance"} · Three-month quarterly data · Recast comparability not verified`, reportedAt: null, figures, segments: [], segmentsComplete: false, sources };
  });
  return { schemaVersion: "business-flow.v1", ticker, fetchedAt: data.fetchedAt, quarters };
}

export function selectFlow(published: PublicBusinessFlow | undefined, fundamentals: PublicFundamentalsResponse | null, ticker: string): PublicBusinessFlow {
  const parsed=publicFlowSchema.safeParse(published);
  const flow = parsed.success && parsed.data.ticker===ticker && parsed.data.quarters.length ? parsed.data : adaptFundamentals(fundamentals,ticker);
  return { ...flow, quarters: flow.quarters.map(q => enrichDisclosedRevenue(ticker, q)) };
}

/** The quarter `days` before this one, give or take three weeks; a fiscal calendar's 52/53-week years drift a few days. */
function quarterBefore(current: BusinessFlowQuarter, quarters: BusinessFlowQuarter[], days: number): BusinessFlowQuarter | null {
  const end = Date.parse(current.periodEnd);
  const gap = (q: BusinessFlowQuarter) => Math.abs((end - Date.parse(q.periodEnd)) / 86400000 - days);
  return quarters.filter(q => q.periodEnd < current.periodEnd && gap(q) <= 21).sort((a, b) => gap(a) - gap(b))[0] ?? null;
}

export function previousQuarter(current: BusinessFlowQuarter, quarters: BusinessFlowQuarter[]): BusinessFlowQuarter | null {
  return quarterBefore(current, quarters, 91);
}

/** The same fiscal quarter a year earlier: the base of a year-over-year change. */
export function yearAgoQuarter(current: BusinessFlowQuarter, quarters: BusinessFlowQuarter[]): BusinessFlowQuarter | null {
  return quarterBefore(current, quarters, 365);
}

export function compareAmount(current: BusinessFlowQuarter, previous: BusinessFlowQuarter | null, key: FlowMetric, segmentId?: string) {
  const lookup = (q: BusinessFlowQuarter | null, id: string) => q?.segments.find(s => s.id === id)?.revenue ?? q?.segments.flatMap(s => s.children ?? []).find(s => s.id === id)?.revenue;
  const a = segmentId ? lookup(current, segmentId) : current.figures[key];
  const b = segmentId ? lookup(previous, segmentId) : previous?.figures[key];
  return compareFlowAmounts(current, previous, key, a, b);
}

/** A change between two quarters. `comparable` is false when the quarters cannot be compared; `trend` says which way the figure moved. */
export type FlowChange = { label: string; comparable: boolean; trend: "up" | "down" | null; delta: number | null; previous: number | null; percent: number | null };
export const NOT_COMPARABLE = "n/a";

export function compareFlowAmounts(current: BusinessFlowQuarter, previous: BusinessFlowQuarter | null, key: string, a: FlowAmount | null | undefined, b: FlowAmount | null | undefined): FlowChange {
  const av = numeric(a), bv = numeric(b);
  const none = (prior: number | null): FlowChange => ({ label: NOT_COMPARABLE, comparable: false, trend: null, delta: null, previous: prior, percent: null });
  if (previous && (current.currency !== previous.currency || current.scale !== previous.scale)) return none(null);
  if (!previous || av == null || bv == null || current.currency !== previous.currency || current.scale !== previous.scale || !a?.comparabilityKey || a.comparabilityKey !== b?.comparabilityKey || a.definition !== b.definition) return none(bv);
  const delta = av - bv;
  const moved = (label: string, trend: FlowChange["trend"]): FlowChange => ({ label, comparable: true, trend, delta, previous: bv, percent: null });
  if (bv === 0) return av === 0 ? moved("flat", null) : moved("new", av > 0 ? "up" : "down");
  const profit = ["gross", "operating", "pretax", "net", "other"].includes(key);
  if ((av < 0 && bv >= 0) || (av >= 0 && bv < 0)) return av < 0 ? moved(profit ? "turned to loss" : "turned negative", "down") : moved(profit ? "turned profitable" : "turned positive", "up");
  if (bv < 0) return delta === 0 ? moved("flat", null) : delta > 0 ? moved(profit ? "loss narrowed" : "increased", "up") : moved(profit ? "loss widened" : "decreased", "down");
  const percent = delta / bv * 100;
  return { label: `${percent > 0 ? "+" : ""}${percent.toFixed(1)}%`, comparable: true, trend: percent > 0 ? "up" : percent < 0 ? "down" : null, delta, previous: bv, percent };
}

export type Reconciliation = { label: string; status: "balanced" | "missing" | "mismatch"; difference: number | null };
export function reconcileQuarter(q: BusinessFlowQuarter): Reconciliation[] {
  const equations: Array<[string, Array<[FlowMetric, number]>]> = [
    ["Revenue − cost of revenue = gross profit", [["revenue", 1], ["cost", -1], ["gross", -1]]],
    ["Gross profit − operating expenses = operating income", [["gross", 1], ["operatingExpenses", -1], ["operating", -1]]],
    ["Operating income + other income (expense), net = income before taxes", [["operating", 1], ["other", 1], ["pretax", -1]]],
    ["Income before taxes − income taxes = net income", [["pretax", 1], ["tax", -1], ["net", -1]]],
    ["R&D + sales and marketing + G&A = operating expenses", [["research", 1], ["sales", 1], ["administration", 1], ["operatingExpenses", -1]]],
  ];
  const tolerance = Math.max(1e-6, Math.abs(numeric(q.figures.revenue) ?? 0) * 1e-9);
  const check = (label: string, values: Array<number | null>): Reconciliation => {
    if (values.some(v => v == null || !Number.isFinite(v))) return { label, status: "missing", difference: null };
    const difference = (values as number[]).reduce((a, b) => a + b, 0);
    return { label, status: Math.abs(difference) <= tolerance ? "balanced" : "mismatch", difference };
  };
  if (q.incomeModel === "financial" || q.incomeModel === "insurance") return [
    check("Business revenue + eliminations = revenue", q.segmentsComplete ? [...q.segments.map(s => numeric(s.revenue)), ...(q.revenueAdjustments ?? []).map(a => numeric(a.amount)), numeric(q.figures.revenue) == null ? null : -numeric(q.figures.revenue)!] : [null]),
    check(q.incomeModel==="insurance"?"Revenue − disclosed expenses + investment and equity-method income = income before taxes":"Revenue − disclosed expenses = income before taxes", [q.incomeModel==="insurance"?(numeric(q.figures.revenue)==null||numeric(q.figures.other)==null?null:numeric(q.figures.revenue)!+numeric(q.figures.other)!):numeric(q.figures.revenue), numeric(q.figures.operatingExpenses) == null ? null : -numeric(q.figures.operatingExpenses)!, numeric(q.figures.pretax) == null ? null : -numeric(q.figures.pretax)!]),
    check("Expense categories = disclosed expenses", q.expenseComponents?.length ? [...q.expenseComponents.map(c => numeric(c.amount)), numeric(q.figures.operatingExpenses) == null ? null : -numeric(q.figures.operatingExpenses)!] : [null]),
    check("Income before taxes − income taxes = net income", [numeric(q.figures.pretax), numeric(q.figures.tax) == null ? null : -numeric(q.figures.tax)!, numeric(q.figures.net) == null ? null : -numeric(q.figures.net)!]),
  ];
  if (q.incomeModel === "direct_operating") return [
    check("Business revenue + eliminations = revenue", q.segmentsComplete ? [...q.segments.map(s => numeric(s.revenue)), ...(q.revenueAdjustments ?? []).map(a => numeric(a.amount)), numeric(q.figures.revenue) == null ? null : -numeric(q.figures.revenue)!] : [null]),
    check("Revenue − disclosed operating expenses = operating income", [numeric(q.figures.revenue), numeric(q.figures.operatingExpenses) == null ? null : -numeric(q.figures.operatingExpenses)!, numeric(q.figures.operating) == null ? null : -numeric(q.figures.operating)!]),
    check("Operating expense categories = disclosed operating expenses", q.expenseComponents?.length ? [...q.expenseComponents.map(c => numeric(c.amount)), numeric(q.figures.operatingExpenses) == null ? null : -numeric(q.figures.operatingExpenses)!] : [null]),
    ...equations.slice(2, 4).map(([label, terms]) => check(label, terms.map(([key, sign]) => { const value = numeric(q.figures[key]); return value == null ? null : value * sign; }))),
    check("Signed interest and other items = other income (expense), net", q.otherComponents?.length ? [...q.otherComponents.map(c => numeric(c.amount)), numeric(q.figures.other) == null ? null : -numeric(q.figures.other)!] : [null]),
  ];
  return [check("Segments + eliminations = revenue", q.segmentsComplete && q.segments.length ? [...q.segments.map(s => numeric(s.revenue)), ...(q.revenueAdjustments ?? []).map(a => numeric(a.amount)), numeric(q.figures.revenue) == null ? null : -numeric(q.figures.revenue)!] : [null]), ...equations.slice(0, 4).map(([label, terms]) => check(label, terms.map(([key, sign]) => { const value = numeric(q.figures[key]); return value == null ? null : value * sign; }))), q.expenseComponents?.length ? check("Expense categories = disclosed operating expenses", [...q.expenseComponents.map(c=>numeric(c.amount)), numeric(q.figures.operatingExpenses) == null ? null : -numeric(q.figures.operatingExpenses)!]) : check(equations[4][0], equations[4][1].map(([key, sign])=>{const value=numeric(q.figures[key]);return value==null?null:value*sign;}))];
}

export function formatFlowValue(value: number | null, quarter: BusinessFlowQuarter): string {
  if (value == null) return "Not disclosed";
  const display = value * quarter.scale / 1_000_000;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: Math.abs(display) < 1 ? 3 : 1 }).format(display);
}
