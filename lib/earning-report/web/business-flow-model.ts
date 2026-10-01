import { z } from "zod";
import { FLOW_METRICS, type BusinessFlowQuarter, type FlowAmount, type FlowMetric, type PublicBusinessFlow } from "@/shared/analysis-contract/business-flow";
import type { PublicFundamentalsResponse, FundamentalMetricKey } from "@/shared/analysis-contract/fundamentals";

const amountSchema = z.object({ value:z.string().nullable().refine(v=>v===null || (v.trim()!=="" && Number.isFinite(Number(v)))), basis:z.enum(["reported","derived"]), definition:z.string(), comparabilityKey:z.string().nullable(), sourceIds:z.array(z.string()).max(100), formula:z.string().optional(),lineage:z.array(z.object({accession:z.string(),url:z.string(),concept:z.string(),contextId:z.string(),periodStart:z.string(),periodEnd:z.string(),dimensions:z.record(z.string(),z.string()),parserVersion:z.string()})).max(50).optional() });
const sourceSchema=z.object({id:z.string(),title:z.string(),url:z.string(),publishedAt:z.string().nullable().optional()});
const quarterSchema=z.object({id:z.string().min(1),incomeModel:z.enum(["standard","direct_operating","financial","insurance","unknown"]).optional(),label:z.string(),periodStart:z.string().nullable(),periodEnd:z.string().refine(v=>Number.isFinite(Date.parse(v))),periodType:z.literal("3M"),currency:z.string().min(1),scale:z.number().finite().positive(),basisLabel:z.string(),reportedAt:z.string().nullable(),figures:z.partialRecord(z.enum(FLOW_METRICS),amountSchema),segments:z.array(z.object({id:z.string().min(1),name:z.string(),revenue:amountSchema.nullable(),description:z.string(),products:z.array(z.string()).max(100),customers:z.string().nullable(),monetization:z.string().nullable(),disclosure:z.string(),sourceIds:z.array(z.string()),children:z.array(z.object({id:z.string(),name:z.string(),revenue:amountSchema})).max(40).optional()})).max(40),segmentsComplete:z.boolean(),expenseComponents:z.array(z.object({id:z.string(),name:z.string(),group:z.enum(["direct","research","sales","administration","other"]),amount:amountSchema})).max(40).optional(),otherComponents:z.array(z.object({id:z.string(),name:z.string(),amount:amountSchema})).max(20).optional(),sources:z.array(sourceSchema).max(100)});
const publicFlowSchema=z.object({schemaVersion:z.literal("business-flow.v1"),ticker:z.string(),fetchedAt:z.string().nullable(),quarters:z.array(quarterSchema).max(40)}).refine(f=>new Set(f.quarters.map(q=>q.id)).size===f.quarters.length && f.quarters.every(q=>new Set(q.segments.map(s=>s.id)).size===q.segments.length));

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
      if (point.sourceAccession && !sources.some(s => s.id === point.sourceAccession)) sources.push({ id: point.sourceAccession, title: `SEC 文件 ${point.sourceAccession}`, url: `https://www.sec.gov/edgar/search/#/q=${encodeURIComponent(point.sourceAccession)}`, publishedAt: point.sourceFiledAt });
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
    return { id: period.periodEnd, label: `截至 ${period.periodEnd} 的三个月`, periodStart: null, periodEnd: period.periodEnd, periodType: "3M" as const, currency: period.currency, scale: 1, basisLabel: `${data.source === "sec_xbrl" ? "SEC XBRL" : "Yahoo Finance"} · 三个月季度数据 · 重列可比性未验证`, reportedAt: null, figures, segments: [], segmentsComplete: false, sources };
  });
  return { schemaVersion: "business-flow.v1", ticker, fetchedAt: data.fetchedAt, quarters };
}

export function selectFlow(published: PublicBusinessFlow | undefined, fundamentals: PublicFundamentalsResponse | null, ticker: string): PublicBusinessFlow {
  const parsed=publicFlowSchema.safeParse(published);
  return parsed.success && parsed.data.ticker===ticker && parsed.data.quarters.length ? parsed.data : adaptFundamentals(fundamentals,ticker);
}

export function previousQuarter(current: BusinessFlowQuarter, quarters: BusinessFlowQuarter[]): BusinessFlowQuarter | null {
  const candidates = quarters.filter(q => q.periodEnd < current.periodEnd).sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
  const previous = candidates[0];
  if (!previous) return null;
  const days = (Date.parse(current.periodEnd) - Date.parse(previous.periodEnd)) / 86400000;
  return days >= 70 && days <= 110 ? previous : null;
}

export function compareAmount(current: BusinessFlowQuarter, previous: BusinessFlowQuarter | null, key: FlowMetric, segmentId?: string) {
  const lookup = (q: BusinessFlowQuarter | null, id: string) => q?.segments.find(s => s.id === id)?.revenue ?? q?.segments.flatMap(s => s.children ?? []).find(s => s.id === id)?.revenue;
  const a = segmentId ? lookup(current, segmentId) : current.figures[key];
  const b = segmentId ? lookup(previous, segmentId) : previous?.figures[key];
  return compareFlowAmounts(current, previous, key, a, b);
}

export function compareFlowAmounts(current: BusinessFlowQuarter, previous: BusinessFlowQuarter | null, key: string, a: FlowAmount | null | undefined, b: FlowAmount | null | undefined) {
  const av = numeric(a), bv = numeric(b);
  if (previous && (current.currency !== previous.currency || current.scale !== previous.scale)) return { label: "不可比", delta: null, previous: null, percent: null };
  if (!previous || av == null || bv == null || current.currency !== previous.currency || current.scale !== previous.scale || !a?.comparabilityKey || a.comparabilityKey !== b?.comparabilityKey || a.definition !== b.definition) return { label: "不可比", delta: null, previous: bv, percent: null };
  const delta = av - bv;
  if (bv === 0) return { label: av === 0 ? "持平" : "上季为零", delta, previous: bv, percent: null };
  const profit = ["gross", "operating", "pretax", "net", "other"].includes(key);
  if ((av < 0 && bv >= 0) || (av >= 0 && bv < 0)) return { label: profit ? av < 0 ? "转亏" : "转盈" : av < 0 ? "由正转负" : "由负转正", delta, previous: bv, percent: null };
  if (bv < 0) return { label: delta === 0 ? "持平" : profit ? delta > 0 ? "亏损收窄" : "亏损扩大" : delta > 0 ? "金额增加" : "金额减少", delta, previous: bv, percent: null };
  const percent = delta / bv * 100;
  return { label: `${percent > 0 ? "+" : ""}${percent.toFixed(1)}%`, delta, previous: bv, percent };
}

export type Reconciliation = { label: string; status: "balanced" | "missing" | "mismatch"; difference: number | null };
export function reconcileQuarter(q: BusinessFlowQuarter): Reconciliation[] {
  const equations: Array<[string, Array<[FlowMetric, number]>]> = [
    ["收入 − 营业成本 = 毛利", [["revenue", 1], ["cost", -1], ["gross", -1]]],
    ["毛利 − 运营费用 = 营业利润", [["gross", 1], ["operatingExpenses", -1], ["operating", -1]]],
    ["营业利润 + 其他损益 = 税前利润", [["operating", 1], ["other", 1], ["pretax", -1]]],
    ["税前利润 − 所得税 = 净利润", [["pretax", 1], ["tax", -1], ["net", -1]]],
    ["研发 + 销售营销 + 行政 = 运营费用", [["research", 1], ["sales", 1], ["administration", 1], ["operatingExpenses", -1]]],
  ];
  const tolerance = Math.max(1e-6, Math.abs(numeric(q.figures.revenue) ?? 0) * 1e-9);
  const check = (label: string, values: Array<number | null>): Reconciliation => {
    if (values.some(v => v == null || !Number.isFinite(v))) return { label, status: "missing", difference: null };
    const difference = (values as number[]).reduce((a, b) => a + b, 0);
    return { label, status: Math.abs(difference) <= tolerance ? "balanced" : "mismatch", difference };
  };
  if (q.incomeModel === "direct_operating") return [
    check("业务收入合计 = 收入", q.segmentsComplete ? [...q.segments.map(s => numeric(s.revenue)), numeric(q.figures.revenue) == null ? null : -numeric(q.figures.revenue)!] : [null]),
    check("收入 − 已披露营业费用 = 营业利润", [numeric(q.figures.revenue), numeric(q.figures.operatingExpenses) == null ? null : -numeric(q.figures.operatingExpenses)!, numeric(q.figures.operating) == null ? null : -numeric(q.figures.operating)!]),
    check("营业费用分类合计 = 已披露营业费用", q.expenseComponents?.length ? [...q.expenseComponents.map(c => numeric(c.amount)), numeric(q.figures.operatingExpenses) == null ? null : -numeric(q.figures.operatingExpenses)!] : [null]),
    ...equations.slice(2, 4).map(([label, terms]) => check(label, terms.map(([key, sign]) => { const value = numeric(q.figures[key]); return value == null ? null : value * sign; }))),
    check("有符号利息及其他损益合计 = 其他损益净额", q.otherComponents?.length ? [...q.otherComponents.map(c => numeric(c.amount)), numeric(q.figures.other) == null ? null : -numeric(q.figures.other)!] : [null]),
  ];
  return [check("分部合计 = 收入", q.segmentsComplete && q.segments.length ? [...q.segments.map(s => numeric(s.revenue)), numeric(q.figures.revenue) == null ? null : -numeric(q.figures.revenue)!] : [null]), ...equations.map(([label, terms]) => check(label, terms.map(([key, sign]) => { const value = numeric(q.figures[key]); return value == null ? null : value * sign; })))];
}

export function formatFlowValue(value: number | null, quarter: BusinessFlowQuarter): string {
  if (value == null) return "未披露";
  const display = value * quarter.scale / 1_000_000;
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: Math.abs(display) < 1 ? 3 : 1 }).format(display);
}

export function marginChange(current: BusinessFlowQuarter, previous: BusinessFlowQuarter | null, metric: "gross" | "operating" | "net"): string {
  const revenue = numeric(current.figures.revenue), value = numeric(current.figures[metric]);
  if (revenue == null || revenue <= 0 || value == null) return "利润率未披露";
  const margin = value / revenue * 100;
  const oldRevenue = numeric(previous?.figures.revenue), oldValue = numeric(previous?.figures[metric]);
  if (compareAmount(current, previous, metric).delta == null || compareAmount(current, previous, "revenue").delta == null || oldRevenue == null || oldRevenue <= 0 || oldValue == null) return `利润率 ${margin.toFixed(1)}% · 变化不可比`;
  const delta = margin - oldValue / oldRevenue * 100;
  return `利润率 ${margin.toFixed(1)}% · ${delta > 0 ? "+" : ""}${delta.toFixed(1)} 个百分点`;
}

export function hasFinancialValues(quarter: BusinessFlowQuarter) { return FLOW_METRICS.some(key => numeric(quarter.figures[key]) != null); }
