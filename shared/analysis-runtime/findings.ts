import { z } from "zod";
import { FLOW_METRICS, type BusinessFlowQuarter, type FlowMetric } from "../analysis-contract/business-flow.ts";
import { FUNDAMENTAL_METRIC_CATALOG } from "../analysis-contract/fundamental-metric-catalog.ts";
import type { FundamentalMetricKey, PublicFundamentalPoint, PublicFundamentalSeries } from "../analysis-contract/fundamentals.ts";
import type { AnalysisFinding, CapitalMetric, FindingBaseRef, FindingEvidence, FindingRef, FindingSpan, FindingWatch, FindingsPublication } from "../analysis-contract/findings.ts";
import type { CashFlowStatement, PublicCapitalStructure, RpoDisclosure } from "../analysis-contract/capital-structure.ts";
import type { GuidanceItem, GuidancePublication } from "../analysis-contract/guidance.ts";
import type { RevenueHistory, RevenueHistoryNode } from "../analysis-contract/revenue-history.ts";

/* ---------- Schema ---------- */

export const CAPITAL_METRICS = ["operatingCashFlow", "capex", "freeCashFlow", "financing", "debtIssued", "debtRepaid", "equityIssued", "buybacks", "dividends", "totalAssets", "debt", "cash", "equity", "rpo", "rpoNext12MonthsShare"] as const satisfies readonly CapitalMetric[];
const FUNDAMENTAL_KEYS = Object.keys(FUNDAMENTAL_METRIC_CATALOG) as [FundamentalMetricKey, ...FundamentalMetricKey[]];

const text = (max: number) => z.string().trim().min(1).max(max);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const https = z.string().max(2000).refine(v => { try { const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password; } catch { return false; } });
const claim = z.object({ text: text(600), sourceIds: z.array(z.string().max(40)).min(1).max(6) });
const baseRef = z.union([
  z.object({ metric: z.enum(FLOW_METRICS) }),
  z.object({ capital: z.enum(CAPITAL_METRICS) }),
  z.object({ fundamental: z.enum(FUNDAMENTAL_KEYS) }),
  z.object({ nodeId: text(200) }),
  z.object({ guidanceId: text(200) }),
]);
const ref = z.union([baseRef, z.object({ ratio: z.object({ numerator: baseRef, denominator: baseRef }) })]);
const span = z.enum(["quarter", "fiscal_year"]);
const compare = z.union([z.literal("yoy"), z.literal("qoq"), z.object({ guidanceId: text(200) })]);
const evidence = z.object({ ref, periodEnd: date, span, compare: compare.optional(), label: text(60).optional() });
const lens = z.discriminatedUnion("type", [
  z.object({ type: z.literal("trend"), refs: z.array(ref).min(1).max(4), span, rate: z.enum(["yoy", "qoq"]).optional() }),
  z.object({ type: z.literal("compare_bars"), refs: z.array(ref).min(1).max(4), span }),
  z.object({ type: z.literal("share_area"), nodeIds: z.array(text(200)).min(1).max(6) }),
  z.object({ type: z.literal("ladder") }),
]);
const finding = z.object({
  id: text(80), kind: z.enum(["risk", "strength", "shift", "watch"]), severity: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  title: text(24), judgment: claim, evidence: z.array(evidence).min(1).max(8),
  anchors: z.object({ view: z.enum(["profit", "cash", "balance"]), nodeIds: z.array(text(200)).max(12), metrics: z.array(z.enum(FLOW_METRICS)).max(6), capital: z.array(z.enum(CAPITAL_METRICS)).max(6).optional() }),
  lens, pairWith: text(80).optional(),
  watch: z.object({ ref, condition: text(200), horizon: z.enum(["next_quarter", "fiscal_year"]), compare: compare.optional() }).optional(),
});
export const findingsPublicationSchema = z.object({
  schemaVersion: z.literal("findings.v1"),
  ticker: z.string().regex(/^[A-Z][A-Z0-9.-]{0,11}$/),
  periodEnd: date, generatedAt: z.string().max(40), model: text(80), fingerprint: text(128).optional(),
  findings: z.array(finding).min(1).max(8),
  sources: z.array(z.object({ id: text(40), title: text(300), url: https, kind: z.enum(["sec", "web"]), publishedAt: z.string().max(40).nullable() })).min(1).max(40),
});

/**
 * Parses a findings publication for one ticker, stripping unknown fields. A finding whose judgment
 * cites a source the document does not list is dropped; a pair pointing at a dropped or unknown
 * finding loses the pairing. Nothing left means no publication rather than an empty one.
 */
const fundamentalsSchema = z.object({ series: z.array(z.object({
  metricKey: z.enum(FUNDAMENTAL_KEYS), label: text(80), category: z.enum(["income_statement", "cash_flow", "balance_sheet", "per_share", "valuation", "ratio"]),
  unitFamily: z.enum(["currency", "percent", "per_share", "shares", "multiple"]), currency: z.string().max(8), available: z.boolean(),
  points: z.array(z.object({ periodEnd: date, valueDecimal: z.string().max(40).nullable(), sourceAccession: z.string().max(40).optional() })).max(64),
})).max(64) });

/** The public subset of a fundamentals response: SEC-sourced series and points, nothing about refresh state. */
export function readFindingFundamentals(value: unknown, ticker: string): FindingFundamentals | null {
  const body = value as { ticker?: unknown; source?: unknown; status?: unknown } | null;
  if (!body || body.ticker !== ticker || body.source !== "sec_xbrl" || body.status !== "ready") return null;
  const parsed = fundamentalsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function readFindingsPublication(value: unknown, ticker: string): FindingsPublication | null {
  const parsed = findingsPublicationSchema.safeParse(value);
  if (!parsed.success || parsed.data.ticker !== ticker) return null;
  const sources = new Set(parsed.data.sources.map(s => s.id));
  const seen = new Set<string>();
  const kept = parsed.data.findings.filter(f => { if (seen.has(f.id) || !f.judgment.sourceIds.every(id => sources.has(id))) return false; seen.add(f.id); return true; });
  const ids = new Set(kept.map(f => f.id));
  const findings: AnalysisFinding[] = kept.map(f => { if (f.pairWith && (f.pairWith === f.id || !ids.has(f.pairWith))) { const { pairWith, ...rest } = f; void pairWith; return rest; } return f; });
  return findings.length ? { ...parsed.data, findings } : null;
}

/* ---------- Resolution ---------- */

/** Everything a finding may point at, as the page already holds it. Absent data resolves to nothing, never to zero. */
export type FindingFundamentalSeries = Pick<PublicFundamentalSeries, "metricKey" | "label" | "category" | "unitFamily" | "currency" | "available"> & { points: Array<Pick<PublicFundamentalPoint, "periodEnd" | "valueDecimal" | "sourceAccession">> };
/** The part of a fundamentals response findings read; a public copy stripped to these fields is enough. */
export type FindingFundamentals = { series: FindingFundamentalSeries[] };
export type FindingData = {
  quarters: BusinessFlowQuarter[];
  history: RevenueHistory | null;
  capital: PublicCapitalStructure | null;
  fundamentals: FindingFundamentals | null;
  guidance: GuidancePublication | null;
};

export type ValueUnit = "USD" | "percent" | "per_share" | "shares" | "ratio";
export type ResolvedValue = {
  value: number;
  unit: ValueUnit;
  currency: string | null;
  periodStart: string | null;
  periodEnd: string;
  span: FindingSpan;
  /** A guided range stands for its own value: `value` is its low end. */
  range?: { low: number; high: number };
  /** Filing accessions the value was read from, when known. */
  accessions: string[];
};
export type GuidanceVerdict = "above" | "within" | "below";
export type ResolvedEvidence = {
  evidence: FindingEvidence;
  label: string;
  current: ResolvedValue;
  compare: ResolvedValue | null;
  compareLabel: string | null;
  /** Percent change for amounts; percentage-point change for rates. */
  delta: number | null;
  /** Current over compare, for "x 倍" statements. */
  ratio: number | null;
  guidance: { item: GuidanceItem; verdict: GuidanceVerdict; measured: number; unit: ValueUnit } | null;
};

const DAY = 86_400_000;
const near = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= 20 * DAY;
const monthIndex = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
const monthEnd = (index: number) => new Date(Date.UTC(Math.floor(index / 12), index % 12 + 1, 0)).toISOString().slice(0, 10);
/** The calendar month end `months` earlier; fiscal quarters are matched to it within twenty days. */
export const shiftPeriod = (periodEnd: string, months: number) => monthEnd(monthIndex(periodEnd) + months);
const finite = (v: unknown): number | null => { const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN; return Number.isFinite(n) ? n : null; };
const sum = (lines: Array<{ value: string | number }>) => lines.reduce((total, line) => total + Number(line.value), 0);

type Point = { value: number; periodStart: string | null; periodEnd: string; currency: string | null; accessions: string[] };

/** The four quarterly points ending at `periodEnd`, summed; any gap leaves the span unresolved. */
function overSpan(span: FindingSpan, periodEnd: string, at: (end: string) => Point | null): Point | null {
  if (span === "quarter") return at(periodEnd);
  const points = [0, -3, -6, -9].map(m => at(shiftPeriod(periodEnd, m)));
  if (points.some(p => p == null)) return null;
  const all = points as Point[];
  if (new Set(all.map(p => p.currency)).size > 1) return null;
  return { value: all.reduce((s, p) => s + p.value, 0), periodStart: all[3].periodStart, periodEnd: all[0].periodEnd, currency: all[0].currency, accessions: [...new Set(all.flatMap(p => p.accessions))] };
}

function flowQuarter(data: FindingData, periodEnd: string) {
  return data.quarters.find(q => q.periodType === "3M" && near(q.periodEnd, periodEnd)) ?? null;
}
const flowPoint = (q: BusinessFlowQuarter, value: number): Point => ({ value: value * q.scale, periodStart: q.periodStart, periodEnd: q.periodEnd, currency: q.currency, accessions: q.sources.map(s => s.id) });

/** Income-statement lines the SEC fundamentals series also carry, for quarters the flow does not hold. */
const FUNDAMENTAL_OF: Partial<Record<FlowMetric, string>> = { revenue: "total_revenue", gross: "gross_profit", operating: "operating_income", net: "net_income", research: "research_and_development" };
function metricAt(data: FindingData, metric: FlowMetric, periodEnd: string): Point | null {
  const q = flowQuarter(data, periodEnd), v = q ? finite(q.figures[metric]?.value) : null;
  if (q && v != null) return flowPoint(q, v);
  const key = FUNDAMENTAL_OF[metric], series = key ? data.fundamentals?.series.find(s => s.metricKey === key && s.available) : null;
  const p = series?.points.find(p => near(p.periodEnd, periodEnd)), pv = p ? finite(p.valueDecimal) : null;
  if (p && pv != null) return { value: pv, periodStart: null, periodEnd: p.periodEnd, currency: series!.currency, accessions: p.sourceAccession ? [p.sourceAccession] : [] };
  const h = metric === "revenue" ? data.history?.quarters.find(q => near(q.periodEnd, periodEnd)) : null, hv = h ? finite(h.revenue) : null;
  return h && hv != null ? { value: hv * h.scale, periodStart: h.periodStart, periodEnd: h.periodEnd, currency: h.currency, accessions: [h.source.accession] } : null;
}

function findHistoryNode(nodes: RevenueHistoryNode[], id: string): { value: string } | null {
  for (const node of nodes) { if (node.id === id) return node; const child = node.children?.find(c => c.id === id); if (child) return child; }
  return null;
}
/** Every disclosed business of a quarter, flat: segments and their children, then breakdown nodes. */
export function flowNodeIds(q: BusinessFlowQuarter): Set<string> {
  return new Set([...q.segments.flatMap(s => [s.id, ...(s.children ?? []).map(c => c.id)]), ...(q.revenueBreakdowns ?? []).flatMap(b => b.nodes.map(n => n.id))]);
}
function flowNodeValue(q: BusinessFlowQuarter, id: string): number | null {
  for (const s of q.segments) { if (s.id === id) return finite(s.revenue?.value); const c = s.children?.find(c => c.id === id); if (c) return finite(c.revenue.value); }
  for (const b of q.revenueBreakdowns ?? []) { const n = b.nodes.find(n => n.id === id); if (n) return finite(n.revenue?.value); }
  return null;
}
function nodeAt(data: FindingData, id: string, periodEnd: string): Point | null {
  const h = data.history?.quarters.find(q => near(q.periodEnd, periodEnd));
  const node = h ? findHistoryNode(h.segments, id) : null, hv = node ? finite(node.value) : null;
  if (h && hv != null) return { value: hv * h.scale, periodStart: h.periodStart, periodEnd: h.periodEnd, currency: h.currency, accessions: [h.source.accession] };
  const q = flowQuarter(data, periodEnd), v = q ? flowNodeValue(q, id) : null;
  return q && v != null ? flowPoint(q, v) : null;
}

const BALANCE: CapitalMetric[] = ["totalAssets", "debt", "cash", "equity"];

/** The bucket covering the first twelve months after the period end, by its tagged length or its start date. */
export function rpoNextYearShare(rpo: RpoDisclosure): number | null {
  const soon = (b: { start: string | null }) => !b.start || monthIndex(b.start) - monthIndex(rpo.asOf) <= 1;
  const bucket = rpo.buckets.find(b => b.months === 12 && soon(b)) ?? rpo.buckets.find(b => b.months == null && b.start != null && soon(b));
  return bucket?.share != null ? Number(bucket.share) * 100 : null;
}
function cashMetric(c: CashFlowStatement, metric: CapitalMetric): number | null {
  const lines = (section: "investing" | "financing", group: string) => { const l = c[section].lines; return l ? sum(l.filter(line => line.group === group)) : null; };
  const operating = Number(c.operating.total), capex = lines("investing", "capex");
  switch (metric) {
    case "operatingCashFlow": return operating;
    case "capex": return capex == null ? null : -capex;
    case "freeCashFlow": return capex == null ? null : operating + capex;
    case "financing": return Number(c.financing.total);
    case "debtIssued": return lines("financing", "debtIssued");
    case "debtRepaid": { const v = lines("financing", "debtRepaid"); return v == null ? null : -v; }
    case "equityIssued": return lines("financing", "equityIssued");
    case "buybacks": { const v = lines("financing", "buybacks"); return v == null ? null : -v; }
    case "dividends": { const v = lines("financing", "dividends"); return v == null ? null : -v; }
    default: return null;
  }
}
function capitalAt(data: FindingData, metric: CapitalMetric, periodEnd: string, span: FindingSpan): Point | null {
  const quarters = data.capital?.quarters ?? [];
  if (metric === "rpo" || metric === "rpoNext12MonthsShare") {
    const rpo = quarters.find(q => near(q.periodEnd, periodEnd))?.rpo;
    if (!rpo) return null;
    const value = metric === "rpo" ? Number(rpo.total) : rpoNextYearShare(rpo);
    return value == null ? null : { value, periodStart: null, periodEnd: rpo.asOf, currency: metric === "rpo" ? rpo.currency : null, accessions: [rpo.source.accession] };
  }
  if (BALANCE.includes(metric)) {
    const b = quarters.find(q => near(q.periodEnd, periodEnd))?.balanceSheet;
    if (!b) return null;
    const value = metric === "totalAssets" ? Number(b.totals.assets) : metric === "equity" ? Number(b.totals.equity) : metric === "debt" ? sum(b.liabilities.filter(l => l.group === "debt")) : sum(b.assets.filter(l => l.group === "cash"));
    return { value, periodStart: null, periodEnd: b.asOf, currency: b.currency, accessions: [b.source.accession] };
  }
  const point = (c: CashFlowStatement | null | undefined): Point | null => { const v = c ? cashMetric(c, metric) : null; return c && v != null ? { value: v, periodStart: c.periodStart, periodEnd: c.periodEnd, currency: c.currency, accessions: c.sources.map(s => s.accession) } : null; };
  if (span === "fiscal_year") {
    // A twelve-month statement as filed is the fiscal year itself; otherwise four quarterly statements.
    const ytd = quarters.find(q => near(q.periodEnd, periodEnd))?.yearToDate;
    if (ytd && monthIndex(ytd.periodEnd) - monthIndex(ytd.periodStart) >= 11) return point(ytd);
  }
  return overSpan(span, periodEnd, end => point(quarters.find(q => near(q.periodEnd, end))?.cashFlow));
}

function fundamentalAt(data: FindingData, key: string, periodEnd: string, span: FindingSpan): { point: Point; unit: ValueUnit } | null {
  const series = data.fundamentals?.series.find(s => s.metricKey === key && s.available);
  if (!series) return null;
  const unit: ValueUnit = series.unitFamily === "percent" ? "percent" : series.unitFamily === "per_share" ? "per_share" : series.unitFamily === "shares" ? "shares" : series.unitFamily === "multiple" ? "ratio" : "USD";
  const at = (end: string): Point | null => {
    const p = series.points.find(p => near(p.periodEnd, end)), v = p ? finite(p.valueDecimal) : null;
    return p && v != null ? { value: v, periodStart: null, periodEnd: p.periodEnd, currency: unit === "USD" ? series.currency : null, accessions: p.sourceAccession ? [p.sourceAccession] : [] } : null;
  };
  // Rates and per-share figures do not add up across quarters.
  if (span === "fiscal_year" && series.category !== "income_statement" && series.category !== "cash_flow") return null;
  const point = overSpan(span, periodEnd, at);
  return point ? { point, unit } : null;
}

function guidanceValue(item: GuidanceItem, span: FindingSpan): ResolvedValue | null {
  const low = item.unit === "USD" ? item.low : item.derived?.low ?? item.low, high = item.unit === "USD" ? item.high : item.derived?.high ?? item.high;
  if (low == null && high == null) return null;
  const unit: ValueUnit = item.unit === "USD" || item.derived ? "USD" : item.unit === "USD_per_share" ? "per_share" : "percent";
  return { value: low ?? high!, unit, currency: unit === "USD" ? "USD" : null, periodStart: null, periodEnd: item.periodEnd ?? item.issuedAt, span, range: { low: low ?? high!, high: high ?? low! }, accessions: [] };
}

/** The figure a reference names at a period, or null when the page's data cannot answer it. */
export function resolveRef(data: FindingData, ref: FindingRef, periodEnd: string, span: FindingSpan): ResolvedValue | null {
  if ("ratio" in ref) {
    // Both sides at the same period and span; a guided range has no single value to divide.
    const n = resolveRef(data, ref.ratio.numerator, periodEnd, span), d = resolveRef(data, ref.ratio.denominator, periodEnd, span);
    if (!n || !d || n.range || d.range || d.value === 0) return null;
    return { value: n.value / d.value, unit: "ratio", currency: null, periodStart: n.periodStart ?? d.periodStart, periodEnd: n.periodEnd, span, accessions: [...new Set([...n.accessions, ...d.accessions])] };
  }
  const amount = (p: Point | null, unit: ValueUnit = "USD"): ResolvedValue | null => p && { ...p, unit, span };
  if ("metric" in ref) return amount(overSpan(span, periodEnd, end => metricAt(data, ref.metric, end)));
  if ("nodeId" in ref) return amount(overSpan(span, periodEnd, end => nodeAt(data, ref.nodeId, end)));
  if ("capital" in ref) return amount(capitalAt(data, ref.capital, periodEnd, span), ref.capital === "rpoNext12MonthsShare" ? "percent" : "USD");
  if ("fundamental" in ref) { const r = fundamentalAt(data, ref.fundamental, periodEnd, span); return r && amount(r.point, r.unit); }
  const item = data.guidance?.items.find(i => i.id === ref.guidanceId);
  return item ? guidanceValue(item, span) : null;
}

const METRIC_LABEL: Record<FlowMetric, string> = { revenue: "总收入", cost: "营业成本", gross: "毛利", research: "研发费用", sales: "销售费用", administration: "管理费用", operatingExpenses: "营业费用", operating: "营业利润", other: "非营业损益", pretax: "税前利润", tax: "所得税", net: "净利润" };
const GUIDANCE_LABEL: Record<GuidanceItem["metric"], string> = { revenue: "收入", segment_revenue: "收入", gross_margin: "毛利率", operating_margin: "营业利润率", operating_income: "营业利润", eps: "EPS", free_cash_flow: "自由现金流", operating_cash_flow: "经营现金流", capex: "资本开支", rpo: "RPO", billings: "Billings", other: "" };
const CAPITAL_LABEL: Record<CapitalMetric, string> = { operatingCashFlow: "经营现金流", capex: "资本开支", freeCashFlow: "自由现金流", financing: "融资活动净额", debtIssued: "新增借款", debtRepaid: "偿还借款", equityIssued: "发行股票", buybacks: "股票回购", dividends: "分红", totalAssets: "总资产", debt: "有息债务", cash: "现金与短期投资", equity: "股东权益", rpo: "剩余履约义务 (RPO)", rpoNext12MonthsShare: "RPO 未来 12 个月确认比例" };

/** Human label of a reference; a business node reads by its disclosed name when the data has it. */
export function refLabel(data: FindingData, ref: FindingRef): string {
  if ("ratio" in ref) return `${refLabel(data, ref.ratio.numerator)} / ${refLabel(data, ref.ratio.denominator)}`;
  if ("metric" in ref) return METRIC_LABEL[ref.metric];
  if ("capital" in ref) return CAPITAL_LABEL[ref.capital];
  if ("fundamental" in ref) return data.fundamentals?.series.find(s => s.metricKey === ref.fundamental)?.label ?? FUNDAMENTAL_METRIC_CATALOG[ref.fundamental as keyof typeof FUNDAMENTAL_METRIC_CATALOG]?.label ?? ref.fundamental;
  if ("guidanceId" in ref) { const i = data.guidance?.items.find(i => i.id === ref.guidanceId); return i ? `指引 · ${i.segment ? `${i.segment} ` : ""}${GUIDANCE_LABEL[i.metric] || i.label}${i.fiscalYear ? ` FY${i.fiscalYear}${i.fiscalQuarter ? ` Q${i.fiscalQuarter}` : ""}` : ""}` : "指引"; }
  for (const q of data.quarters) for (const s of q.segments) { if (s.id === ref.nodeId) return s.name; const c = s.children?.find(c => c.id === ref.nodeId); if (c) return c.name; }
  for (const h of data.history?.quarters ?? []) for (const s of h.segments) { if (s.id === ref.nodeId) return s.name; const c = s.children?.find(c => c.id === ref.nodeId); if (c) return c.name; }
  return ref.nodeId;
}

/** Plain period label: "FY 截至 2026-05" for a four-quarter span, "2026.05 季" for a quarter. */
export const spanLabel = (v: { span: FindingSpan; periodEnd: string }) => v.span === "fiscal_year" ? `截至 ${v.periodEnd.slice(0, 7)} 的四个季度` : `${v.periodEnd.slice(0, 7).replace("-", ".")} 季`;

/** The comparison the evidence asks for; null when it was asked for and the data cannot make it. */
function compareOf(data: FindingData, e: FindingEvidence, current: ResolvedValue): Pick<ResolvedEvidence, "compare" | "compareLabel" | "delta" | "ratio" | "guidance"> | null {
  const none = null;
  if (!e.compare) return { compare: null, compareLabel: null, delta: null, ratio: null, guidance: null };
  if (typeof e.compare === "object") {
    const target = e.compare.guidanceId;
    const item = data.guidance?.items.find(i => i.id === target), range = item ? guidanceValue(item, e.span) : null;
    if (!item || !range?.range) return none;
    // Growth guidance without a derived amount is compared on the measured year-over-year rate.
    let measured = current.value, unit = current.unit;
    if (item.measure === "growth" && !item.derived) {
      const base = resolveRef(data, e.ref, shiftPeriod(e.periodEnd, -12), e.span);
      if (!base || base.value <= 0) return none;
      measured = (current.value / base.value - 1) * 100; unit = "percent";
    } else if (range.unit !== current.unit) return none;
    const verdict: GuidanceVerdict = measured > range.range.high ? "above" : measured < range.range.low ? "below" : "within";
    return { compare: range, compareLabel: `指引 ${item.label}`, delta: null, ratio: null, guidance: { item, verdict, measured, unit } };
  }
  const months = e.compare === "yoy" ? -12 : -3;
  const compare = resolveRef(data, e.ref, shiftPeriod(e.periodEnd, months), e.span);
  if (!compare) return none;
  const delta = current.unit === "percent" ? current.value - compare.value : compare.value !== 0 ? (current.value - compare.value) / Math.abs(compare.value) * 100 : null;
  return { compare, compareLabel: e.compare === "yoy" ? "去年同期" : "上一季", delta, ratio: compare.value > 0 && current.value > 0 ? current.value / compare.value : null, guidance: null };
}

export function resolveEvidence(data: FindingData, e: FindingEvidence): ResolvedEvidence | null {
  const current = resolveRef(data, e.ref, e.periodEnd, e.span), compared = current && compareOf(data, e, current);
  return current && compared ? { evidence: e, label: e.label ?? refLabel(data, e.ref), current, ...compared } : null;
}

/* ---------- Verification ---------- */

/** Numbers a reader could have written from this evidence, in the units Chinese prose uses. */
export function evidenceCandidates(r: ResolvedEvidence): number[] {
  const out: number[] = [];
  const amount = (v: ResolvedValue) => {
    if (v.unit === "USD") out.push(v.value / 1e8, v.value / 1e12, v.value / 1e9, v.value / 1e6);
    else if (v.unit === "ratio") out.push(v.value, v.value * 100);
    else out.push(v.value);
    if (v.range) for (const x of [v.range.low, v.range.high]) out.push(v.unit === "USD" ? x / 1e8 : x);
  };
  amount(r.current);
  if (r.compare) amount(r.compare);
  if (r.delta != null) out.push(r.delta);
  if (r.ratio != null) out.push(r.ratio);
  if (r.guidance) out.push(r.guidance.measured);
  // "下降 1%" and "亏损 237 亿" write the magnitude; the sign is in the words.
  return out.filter(v => Number.isFinite(v)).flatMap(v => v < 0 ? [v, -v] : [v]);
}

/** Numeric statements in prose, skipping dates, fiscal periods and citation markers. */
export function proseNumbers(prose: string): number[] {
  const out: number[] = [];
  for (const match of prose.matchAll(/(?<![\w.])(FY|Q|第)?\s?([-−]?\d+(?:\.\d+)?)\s?(财年|年|月|日|季|个季度|个月|Q)?/g)) {
    const [, prefix, raw, suffix] = match;
    if (prefix || suffix) continue;
    const value = Number(raw.replace("−", "-"));
    if (!Number.isFinite(value)) continue;
    if (Number.isInteger(value) && value >= 1900 && value <= 2100) continue;
    out.push(value);
  }
  return out;
}

const decimals = (v: number) => { const s = String(v); const i = s.indexOf("."); return i < 0 ? 0 : s.length - i - 1; };
/** A written number matches a candidate within rounding of the digits written, or two percent. */
export function numberSupported(written: number, candidates: number[]): boolean {
  const rounding = 0.5 * 10 ** -decimals(written);
  return candidates.some(c => Math.abs(written - c) <= Math.max(rounding + 1e-9, Math.abs(c) * 0.02));
}

/** The watched figure once the period it points at has been published. */
export type WatchOutcome = { periodEnd: string; resolved: ResolvedEvidence };
export type VerifiedFinding = AnalysisFinding & { resolved: ResolvedEvidence[]; periodEnd: string; watchOutcome: WatchOutcome | null };

/** The period a watch points at, counted from the report the findings were written from. */
export const watchPeriod = (publicationPeriodEnd: string, watch: FindingWatch) => shiftPeriod(publicationPeriodEnd, watch.horizon === "next_quarter" ? 3 : 12);

/** Resolves the watch at its own period; null until that period's data exists. */
export function resolveWatch(data: FindingData, watch: FindingWatch, publicationPeriodEnd: string): WatchOutcome | null {
  const periodEnd = watchPeriod(publicationPeriodEnd, watch);
  const resolved = resolveEvidence(data, { ref: watch.ref, periodEnd, span: watch.horizon === "next_quarter" ? "quarter" : "fiscal_year", ...(watch.compare ? { compare: watch.compare } : {}) });
  return resolved ? { periodEnd, resolved } : null;
}
export type WithheldFinding = { id: string; reasons: string[] };

/**
 * Keeps only findings the page's data can stand behind: every piece of evidence resolves, every
 * anchored business and metric exists in the quarter the finding is about, and every number in
 * its title and judgment is one the evidence produces. Capital anchors are checked only once the
 * capital projection has loaded; the order is severity first, then risks before the rest.
 */
export function verifyFindings(publication: FindingsPublication, data: FindingData): { verified: VerifiedFinding[]; withheld: WithheldFinding[] } {
  const verified: VerifiedFinding[] = [], withheld: WithheldFinding[] = [];
  const order: Record<AnalysisFinding["kind"], number> = { risk: 0, strength: 1, shift: 2, watch: 3 };
  for (const f of publication.findings) {
    const reasons: string[] = [];
    const resolved = f.evidence.map(e => resolveEvidence(data, e));
    resolved.forEach((r, i) => { if (!r) reasons.push(`evidence ${i} unresolved`); });
    // Anchors are checked on the report the findings were written from, whatever periods the evidence spans.
    const periodEnd = publication.periodEnd;
    const quarter = flowQuarter(data, periodEnd);
    if (f.anchors.nodeIds.length) {
      const ids = quarter ? flowNodeIds(quarter) : new Set((data.history?.quarters.find(q => near(q.periodEnd, periodEnd))?.segments ?? []).flatMap(s => [s.id, ...(s.children ?? []).map(c => c.id)]));
      for (const id of f.anchors.nodeIds) if (!ids.has(id)) reasons.push(`anchor node ${id} absent`);
    }
    for (const m of f.anchors.metrics) if (!quarter || finite(quarter.figures[m]?.value) == null) reasons.push(`anchor metric ${m} absent`);
    if (data.capital) for (const c of f.anchors.capital ?? []) if (!capitalAt(data, c, periodEnd, "quarter") && !capitalAt(data, c, periodEnd, "fiscal_year")) reasons.push(`anchor capital ${c} absent`);
    if (f.lens.type === "ladder" && !data.capital?.quarters.some(q => q.rpo)) reasons.push("ladder lens without RPO");
    const candidates = resolved.flatMap(r => r ? evidenceCandidates(r) : []);
    for (const n of proseNumbers(`${f.title} ${f.judgment.text}`)) if (!numberSupported(n, candidates)) reasons.push(`number ${n} unsupported`);
    if (reasons.length) withheld.push({ id: f.id, reasons });
    else verified.push({ ...f, resolved: resolved as ResolvedEvidence[], periodEnd, watchOutcome: f.watch ? resolveWatch(data, f.watch, periodEnd) : null });
  }
  verified.sort((a, b) => b.severity - a.severity || order[a.kind] - order[b.kind]);
  return { verified, withheld };
}
