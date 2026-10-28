import {publicFlowSchema} from "@/shared/analysis-runtime/financial-data/schema";
import { type BusinessFlowQuarter, type FlowAmount, type FlowMetric, type PublicBusinessFlow } from "@/shared/analysis-contract/business-flow";
import type { PublicFundamentalsResponse, FundamentalMetricKey } from "@/shared/analysis-contract/fundamentals";
import { currencyName, MINUS } from "@/shared/analysis-runtime/locale";
import { getLocale, messages } from "@/packages/web/src/i18n/core";

/** Change words and statement checks; a change's label reads in the page's locale when it is formed. */
export const flowWords = messages({
  na: "n/a", flat: "flat", new: "new", turnedLoss: "turned to loss", turnedNegative: "turned negative", turnedProfit: "turned profitable", turnedPositive: "turned positive",
  lossNarrowed: "loss narrowed", increased: "increased", lossWidened: "loss widened", decreased: "decreased", notDisclosed: "Not disclosed",
  grossCheck: "Revenue − cost of revenue = gross profit",
  operatingCheck: "Gross profit − operating expenses = operating income",
  pretaxCheck: "Operating income + other income (expense), net = income before taxes",
  netCheck: "Income before taxes − income taxes = net income",
  expenseCheck: "R&D + sales and marketing + G&A = operating expenses",
  businessCheck: "Business revenue + adjustments = revenue",
  insuranceCheck: "Revenue − disclosed expenses + investment and equity-method income = income before taxes",
  financialCheck: "Revenue − disclosed expenses = income before taxes",
  categoriesCheck: "Expense categories = disclosed expenses",
  directCheck: "Revenue − disclosed operating expenses = operating income",
  directCategoriesCheck: "Operating expense categories = disclosed operating expenses",
  otherCheck: "Signed interest and other items = other income (expense), net",
  segmentsCheck: "Segments + adjustments = revenue",
  operatingCategoriesCheck: "Expense categories = disclosed operating expenses",
}, {
  na: "不可比", flat: "持平", new: "新增", turnedLoss: "转亏", turnedNegative: "转负", turnedProfit: "扭亏为盈", turnedPositive: "转正",
  lossNarrowed: "亏损收窄", increased: "增加", lossWidened: "亏损扩大", decreased: "减少", notDisclosed: "未披露",
  grossCheck: "营收 − 营业成本 = 毛利",
  operatingCheck: "毛利 − 营业费用 = 营业利润",
  pretaxCheck: "营业利润 + 营业外收支净额 = 税前利润",
  netCheck: "税前利润 − 所得税 = 净利润",
  expenseCheck: "研发费用 + 销售及市场费用 + 管理费用 = 营业费用",
  businessCheck: "业务营收 + 调节 = 营收",
  insuranceCheck: "营收 − 已披露费用 + 投资及权益法收益 = 税前利润",
  financialCheck: "营收 − 已披露费用 = 税前利润",
  categoriesCheck: "各类费用之和 = 已披露费用",
  directCheck: "营收 − 已披露营业费用 = 营业利润",
  directCategoriesCheck: "各类营业费用之和 = 已披露营业费用",
  otherCheck: "利息及其他项目（含符号）= 营业外收支净额",
  segmentsCheck: "分部营收 + 调节 = 营收",
  operatingCategoriesCheck: "各类费用之和 = 已披露营业费用",
});

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
  return parsed.success && parsed.data.ticker===ticker && parsed.data.quarters.length ? parsed.data : adaptFundamentals(fundamentals,ticker);
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

export function compareFlowAmounts(current: BusinessFlowQuarter, previous: BusinessFlowQuarter | null, key: string, a: FlowAmount | null | undefined, b: FlowAmount | null | undefined): FlowChange {
  const av = numeric(a), bv = numeric(b);
  const none = (prior: number | null): FlowChange => ({ label: flowWords.na, comparable: false, trend: null, delta: null, previous: prior, percent: null });
  if (previous && (current.currency !== previous.currency || current.scale !== previous.scale)) return none(null);
  if (!previous || av == null || bv == null || current.currency !== previous.currency || current.scale !== previous.scale || !a?.comparabilityKey || a.comparabilityKey !== b?.comparabilityKey || a.definition !== b.definition) return none(bv);
  const delta = av - bv;
  const moved = (label: string, trend: FlowChange["trend"]): FlowChange => ({ label, comparable: true, trend, delta, previous: bv, percent: null });
  if (bv === 0) return av === 0 ? moved(flowWords.flat, null) : moved(flowWords.new, av > 0 ? "up" : "down");
  const profit = ["gross", "operating", "pretax", "net", "other"].includes(key);
  if ((av < 0 && bv >= 0) || (av >= 0 && bv < 0)) return av < 0 ? moved(profit ? flowWords.turnedLoss : flowWords.turnedNegative, "down") : moved(profit ? flowWords.turnedProfit : flowWords.turnedPositive, "up");
  if (bv < 0) return delta === 0 ? moved(flowWords.flat, null) : delta > 0 ? moved(profit ? flowWords.lossNarrowed : flowWords.increased, "up") : moved(profit ? flowWords.lossWidened : flowWords.decreased, "down");
  const percent = delta / bv * 100;
  return { label: `${percent > 0 ? "+" : ""}${percent.toFixed(1)}%`, comparable: true, trend: percent > 0 ? "up" : percent < 0 ? "down" : null, delta, previous: bv, percent };
}

export type Reconciliation = { label: string; status: "balanced" | "missing" | "mismatch"; difference: number | null };
export function reconcileQuarter(q: BusinessFlowQuarter): Reconciliation[] {
  const equations: Array<[string, Array<[FlowMetric, number]>]> = [
    [flowWords.grossCheck, [["revenue", 1], ["cost", -1], ["gross", -1]]],
    [flowWords.operatingCheck, [["gross", 1], ["operatingExpenses", -1], ["operating", -1]]],
    [flowWords.pretaxCheck, [["operating", 1], ["other", 1], ["pretax", -1]]],
    [flowWords.netCheck, [["pretax", 1], ["tax", -1], ["net", -1]]],
    [flowWords.expenseCheck, [["research", 1], ["sales", 1], ["administration", 1], ["operatingExpenses", -1]]],
  ];
  const tolerance = Math.max(1e-6, Math.abs(numeric(q.figures.revenue) ?? 0) * 1e-9);
  // Lines after income taxes (equity-method results, noncontrolling interests) close the net-income check.
  const afterTax = (q.afterTaxComponents ?? []).reduce<number | null>((sum, c) => sum == null || numeric(c.amount) == null ? null : sum + numeric(c.amount)!, 0);
  const check = (label: string, values: Array<number | null>): Reconciliation => {
    if (values.some(v => v == null || !Number.isFinite(v))) return { label, status: "missing", difference: null };
    const difference = (values as number[]).reduce((a, b) => a + b, 0);
    return { label, status: Math.abs(difference) <= tolerance ? "balanced" : "mismatch", difference };
  };
  if (q.incomeModel === "financial" || q.incomeModel === "insurance") return [
    check(flowWords.businessCheck, q.segmentsComplete ? [...q.segments.map(s => numeric(s.revenue)), ...(q.revenueAdjustments ?? []).map(a => numeric(a.amount)), numeric(q.figures.revenue) == null ? null : -numeric(q.figures.revenue)!] : [null]),
    check(q.incomeModel==="insurance"?flowWords.insuranceCheck:flowWords.financialCheck, [q.incomeModel==="insurance"?(numeric(q.figures.revenue)==null||numeric(q.figures.other)==null?null:numeric(q.figures.revenue)!+numeric(q.figures.other)!):numeric(q.figures.revenue), numeric(q.figures.operatingExpenses) == null ? null : -numeric(q.figures.operatingExpenses)!, numeric(q.figures.pretax) == null ? null : -numeric(q.figures.pretax)!]),
    check(flowWords.categoriesCheck, q.expenseComponents?.length ? [...q.expenseComponents.map(c => numeric(c.amount)), numeric(q.figures.operatingExpenses) == null ? null : -numeric(q.figures.operatingExpenses)!] : [null]),
    check(flowWords.netCheck, [numeric(q.figures.pretax), numeric(q.figures.tax) == null ? null : -numeric(q.figures.tax)!, afterTax, numeric(q.figures.net) == null ? null : -numeric(q.figures.net)!]),
  ];
  if (q.incomeModel === "direct_operating") return [
    check(flowWords.businessCheck, q.segmentsComplete ? [...q.segments.map(s => numeric(s.revenue)), ...(q.revenueAdjustments ?? []).map(a => numeric(a.amount)), numeric(q.figures.revenue) == null ? null : -numeric(q.figures.revenue)!] : [null]),
    check(flowWords.directCheck, [numeric(q.figures.revenue), numeric(q.figures.operatingExpenses) == null ? null : -numeric(q.figures.operatingExpenses)!, numeric(q.figures.operating) == null ? null : -numeric(q.figures.operating)!]),
    check(flowWords.directCategoriesCheck, q.expenseComponents?.length ? [...q.expenseComponents.map(c => numeric(c.amount)), numeric(q.figures.operatingExpenses) == null ? null : -numeric(q.figures.operatingExpenses)!] : [null]),
    ...equations.slice(2, 4).map(([label, terms]) => check(label, [...terms.map(([key, sign]) => { const value = numeric(q.figures[key]); return value == null ? null : value * sign; }), ...(label === flowWords.netCheck ? [afterTax] : [])])),
    check(flowWords.otherCheck, q.otherComponents?.length ? [...q.otherComponents.map(c => numeric(c.amount)), numeric(q.figures.other) == null ? null : -numeric(q.figures.other)!] : [null]),
  ];
  return [check(flowWords.segmentsCheck, q.segmentsComplete && q.segments.length ? [...q.segments.map(s => numeric(s.revenue)), ...(q.revenueAdjustments ?? []).map(a => numeric(a.amount)), numeric(q.figures.revenue) == null ? null : -numeric(q.figures.revenue)!] : [null]), ...equations.slice(0, 4).map(([label, terms]) => check(label, [...terms.map(([key, sign]) => { const value = numeric(q.figures[key]); return value == null ? null : value * sign; }), ...(label === flowWords.netCheck ? [afterTax] : [])])), q.expenseComponents?.length ? check(flowWords.operatingCategoriesCheck, [...q.expenseComponents.map(c=>numeric(c.amount)), numeric(q.figures.operatingExpenses) == null ? null : -numeric(q.figures.operatingExpenses)!]) : check(equations[4][0], equations[4][1].map(([key, sign])=>{const value=numeric(q.figures[key]);return value==null?null:value*sign;})), ...(q.otherComponents?.length ? [check(flowWords.otherCheck, [...q.otherComponents.map(c => numeric(c.amount)), numeric(q.figures.other) == null ? null : -numeric(q.figures.other)!])] : [])];
}

/**
 * An exact ledger amount. English writes it in millions without a unit, beside a "(USD millions)" label;
 * Chinese writes it in 亿 or 万 with the currency, at the same precision, beside a label without a unit.
 */
export function formatFlowValue(value: number | null, quarter: BusinessFlowQuarter): string {
  if (value == null) return flowWords.notDisclosed;
  if (getLocale() === "zh-CN") {
    const amount = value * quarter.scale, abs = Math.abs(amount);
    const [divisor, suffix, digits] = abs >= 1e8 ? [1e8, "亿", 3] : abs >= 1e4 ? [1e4, "万", 1] : [1, "", 0];
    const name = currencyName(quarter.currency, "zh-CN");
    return (amount < 0 ? MINUS : "") + new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(abs / divisor) + suffix + (name === quarter.currency ? ` ${name}` : name);
  }
  const display = value * quarter.scale / 1_000_000;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: Math.abs(display) < 1 ? 3 : 1 }).format(display);
}
