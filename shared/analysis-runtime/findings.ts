import { z } from "zod";
import { FLOW_METRICS, type BusinessFlowQuarter, type FlowMetric } from "../analysis-contract/business-flow.ts";
import { FUNDAMENTAL_METRIC_CATALOG, FUNDAMENTAL_METRIC_LABEL_ZH } from "../analysis-contract/fundamental-metric-catalog.ts";
import type { FundamentalMetricKey, PublicFundamentalPoint, PublicFundamentalSeries } from "../analysis-contract/fundamentals.ts";
import { DERIVED_METRICS, EVENT_FIELDS, type AnalysisFinding, type CapitalMetric, type DerivedMetric, type EventField, type FindingEvidence, type FindingPassage, type FindingRef, type FindingSpan, type FindingWatch, type FindingsPublication } from "../analysis-contract/findings.ts";
import type { EventsPublication } from "../analysis-contract/events.ts";
import type { PeersPublication } from "../analysis-contract/peers.ts";
import { alignedPeerQuarter } from "./peers.ts";
import type { BalanceSheet, CashFlowStatement, PublicCapitalStructure, RpoDisclosure } from "../analysis-contract/capital-structure.ts";
import type { GuidanceItem, GuidancePublication } from "../analysis-contract/guidance.ts";
import type { RevenueHistory, RevenueHistoryNode } from "../analysis-contract/revenue-history.ts";
import type { LensDocument } from "../analysis-contract/lens.ts";
import { lensDocumentSchemaFor } from "./lens/schema.ts";
import { scheduleBucketAt, scheduleBucketLabel, scheduleTotalAt } from "./schedules.ts";
import type { Locale } from "./locale.ts";

/* ---------- Schema ---------- */

export const CAPITAL_METRICS = [
  "operatingCashFlow", "capex", "freeCashFlow", "financing", "debtIssued", "debtRepaid", "equityIssued", "buybacks", "dividends",
  "acquisitions", "investmentsNet", "leasePrincipal", "depreciation", "stockCompensation", "interestPaid", "taxesPaid", "unpaidCapex", "leaseAssetsObtained",
  "totalAssets", "debt", "cash", "equity", "totalLiabilities", "currentAssets", "currentLiabilities", "receivables", "inventory", "productive", "leaseAssets", "intangibles", "investments", "leases", "customerAdvances", "payables", "deferredTax",
  "rpo", "rpoNext12MonthsShare",
] as const satisfies readonly CapitalMetric[];
/** Balance-sheet instants: read at the period end, no span. */
export const CAPITAL_INSTANTS = ["totalAssets", "debt", "cash", "equity", "totalLiabilities", "currentAssets", "currentLiabilities", "receivables", "inventory", "productive", "leaseAssets", "intangibles", "investments", "leases", "customerAdvances", "payables", "deferredTax", "rpo", "rpoNext12MonthsShare"] as const satisfies readonly CapitalMetric[];
const FUNDAMENTAL_KEYS = Object.keys(FUNDAMENTAL_METRIC_CATALOG) as [FundamentalMetricKey, ...FundamentalMetricKey[]];

const text = (max: number) => z.string().trim().min(1).max(max);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const https = z.string().max(2000).refine(v => { try { const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password; } catch { return false; } });
/** English prose: a judgment runs 80 to 180 words, a title a short headline. */
const claim = z.object({ text: text(1400), sourceIds: z.array(z.string().max(40)).min(1).max(6) });
const baseRef = z.union([
  z.object({ metric: z.enum(FLOW_METRICS) }),
  z.object({ capital: z.enum(CAPITAL_METRICS) }),
  z.object({ fundamental: z.enum(FUNDAMENTAL_KEYS) }),
  z.object({ nodeId: text(200) }),
  z.object({ guidanceId: text(200) }),
  z.object({ rpoBucket: z.number().int().min(0).max(11) }),
  z.object({ peer: z.object({ ticker: z.string().regex(/^[A-Z][A-Z0-9.-]{0,11}$/), ref: z.union([z.object({ capital: z.enum(CAPITAL_METRICS) }), z.object({ fundamental: z.enum(FUNDAMENTAL_KEYS) }), z.object({ metric: z.enum(FLOW_METRICS) })]) }) }),
  z.object({ passageCell: z.object({ passageId: z.string().regex(/^[a-z0-9]{8,64}$/), row: z.number().int().min(0).max(200), col: z.number().int().min(0).max(40) }) }),
  z.object({ event: z.object({ id: z.string().regex(/^\d{10}-\d{2}-\d{6}$/), field: z.enum(EVENT_FIELDS) }) }),
  z.object({ schedule: z.object({ kind: z.enum(["debtMaturities", "leasePaymentsDue", "purchaseObligations"]), bucket: z.union([z.number().int().min(0).max(5), z.literal("total")]) }) }),
  z.object({ derived: z.enum(DERIVED_METRICS) }),
]);
const ref = z.union([baseRef, z.object({ ratio: z.object({ numerator: baseRef, denominator: baseRef }) })]);
export const findingRefSchema = ref;
const lensDocument = lensDocumentSchemaFor(ref);
/** A lens document as the agent wrote it, through the contract; null when its shape is wrong. */
export function readLensDocument(value: unknown): LensDocument | null { const parsed = lensDocument.safeParse(value); return parsed.success ? parsed.data : null; }
/** Why a lens document does not read: the first few contract violations, each with its path, for the model to fix. */
export function lensDocumentIssues(value: unknown): string[] {
  const parsed = lensDocument.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.slice(0, 8).map(i => `${i.path.join(".") || "document"}: ${i.message}`);
}
const span = z.enum(["quarter", "fiscal_year"]);
const compare = z.union([z.literal("yoy"), z.literal("qoq"), z.object({ guidanceId: text(200) })]);
const evidence = z.object({ ref, periodEnd: date, span, compare: compare.optional(), label: text(100).optional() });
const watchTest = z.object({ expect: z.enum(["above", "below", "within"]), against: z.union([z.literal("yoy"), z.literal("qoq"), z.object({ guidanceId: text(200) }), z.object({ ref })]), tolerance: z.number().min(0).max(100).optional() });
const watchSchema = z.object({ ref, condition: text(400), horizon: z.enum(["next_quarter", "fiscal_year"]), compare: compare.optional(), test: watchTest.optional() });
const lens = z.discriminatedUnion("type", [
  z.object({ type: z.literal("trend"), refs: z.array(ref).min(1).max(4), span, rate: z.enum(["yoy", "qoq"]).optional() }),
  z.object({ type: z.literal("compare_bars"), refs: z.array(ref).min(1).max(4), span }),
  z.object({ type: z.literal("share_area"), nodeIds: z.array(text(200)).min(1).max(6) }),
  z.object({ type: z.literal("ladder") }),
  z.object({ type: z.literal("document"), document: lensDocument }),
]);
const finding = z.object({
  id: text(80), kind: z.enum(["risk", "strength", "shift", "watch"]), severity: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  title: text(80), judgment: claim, evidence: z.array(evidence).min(1).max(8),
  anchors: z.object({ view: z.enum(["profit", "cash", "balance"]), nodeIds: z.array(text(200)).max(12), metrics: z.array(z.enum(FLOW_METRICS)).max(6), capital: z.array(z.enum(CAPITAL_METRICS)).max(6).optional() }),
  lens, pairWith: text(80).optional(),
  watch: watchSchema.optional(),
});
const recordEntry = z.object({ findingId: text(80), title: text(80), kind: z.enum(["risk", "strength", "shift", "watch"]), periodEnd: date, publishedAt: z.string().max(40), watch: watchSchema });
export const findingsMaterialSchema = z.object({ id: text(40), kind: z.enum(["sec", "transcript", "web"]), title: text(300), url: https, publishedAt: z.string().max(40).nullable(), passageId: z.string().regex(/^[a-z0-9]{8,64}$/).optional(), documentId: z.string().max(80).optional(), form: z.string().max(20).optional(), path: z.array(z.string().max(200)).max(12).optional(), textSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() });
const highlight = z.object({ title: text(40), ref, compare: z.enum(["yoy", "qoq"]).optional(), show: z.enum(["value", "change"]).optional() });
export const reportHighlightsSchema = z.object({ periodEnd: date, profit: z.array(highlight).max(4), cash: z.array(highlight).max(4), balance: z.array(highlight).max(4) });
export const findingsPublicationSchema = z.object({
  schemaVersion: z.literal("findings.v1"),
  ticker: z.string().regex(/^[A-Z][A-Z0-9.-]{0,11}$/),
  periodEnd: date, generatedAt: z.string().max(40), model: text(80), fingerprint: text(128).optional(),
  findings: z.array(finding).max(8),
  sources: z.array(z.object({ id: text(40), title: text(300), url: https, kind: z.enum(["sec", "web"]), publishedAt: z.string().max(40).nullable() })).min(1).max(40),
  highlights: z.array(reportHighlightsSchema).max(8).optional(),
  record: z.array(recordEntry).max(24).optional(),
  materials: z.array(findingsMaterialSchema).max(120).optional(),
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
  // Highlights alone are a publication: the findings of a run that verified none are empty, the stat tiles still show.
  return findings.length || parsed.data.highlights?.length ? { ...parsed.data, findings } : null;
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
  /** The peers projection, for `{ peer }` references; absent when not loaded. */
  peers?: PeersPublication | null;
  /** Library passages the publication quotes or reads cells from, as served now; absent when not loaded. */
  passages?: FindingPassage[] | null;
  /** The company's filed events, for `{ event }` references; absent when not loaded. */
  events?: EventsPublication | null;
};

/** `points`: a change in a rate, in percentage points, as a transformed lens series carries it. */
export type ValueUnit = "USD" | "percent" | "per_share" | "shares" | "ratio" | "points";
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
  /** Percent change for amounts; percentage-point change for rates; plain difference for ratios (×100 gives points). */
  delta: number | null;
  /** Current over compare, for "2.6x" statements. */
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

export type Point = { value: number; periodStart: string | null; periodEnd: string; currency: string | null; accessions: string[] };

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

const BALANCE: readonly CapitalMetric[] = CAPITAL_INSTANTS.filter(m => m !== "rpo" && m !== "rpoNext12MonthsShare");
const NON_CASH = { depreciation: /Depreciation|Amortization|Depletion/i, stockCompensation: /ShareBasedCompensation|StockBasedCompensation|ShareBasedPayment/i } as const;

/** The bucket covering the first twelve months after the period end, by its tagged length or its start date. */
export function rpoNextYearShare(rpo: RpoDisclosure): number | null {
  const soon = (b: { start: string | null }) => !b.start || monthIndex(b.start) - monthIndex(rpo.asOf) <= 1;
  const bucket = rpo.buckets.find(b => b.months === 12 && soon(b)) ?? rpo.buckets.find(b => b.months == null && b.start != null && soon(b));
  return bucket?.share != null ? Number(bucket.share) * 100 : null;
}
function cashMetric(c: CashFlowStatement, metric: CapitalMetric): number | null {
  const lines = (section: "investing" | "financing", group: string) => { const l = c[section].lines; return l ? sum(l.filter(line => line.group === group)) : null; };
  const operating = Number(c.operating.total), capex = lines("investing", "capex");
  // A group absent from a reconciled section is zero by the statement's own arithmetic, not unknown.
  const groupOf = (section: "investing" | "financing", group: string) => { const l = c[section].lines; return l ? sum(l.filter(line => line.group === group)) : null; };
  const nonCash = (pattern: RegExp) => { const l = c.operating.lines; if (!l) return null; const hits = l.filter(line => line.group === "nonCash" && pattern.test(line.concept)); return hits.length ? sum(hits) : null; };
  const supplemental = (group: string) => { const hits = c.supplemental.filter(line => line.group === group); return hits.length ? sum(hits) : null; };
  const outflow = (v: number | null) => v == null ? null : -v;
  switch (metric) {
    case "operatingCashFlow": return operating;
    case "capex": return outflow(capex);
    case "freeCashFlow": return capex == null ? null : operating + capex;
    case "financing": return Number(c.financing.total);
    case "debtIssued": return lines("financing", "debtIssued");
    case "debtRepaid": return outflow(lines("financing", "debtRepaid"));
    case "equityIssued": return lines("financing", "equityIssued");
    case "buybacks": return outflow(lines("financing", "buybacks"));
    case "dividends": return outflow(lines("financing", "dividends"));
    case "acquisitions": return outflow(groupOf("investing", "acquisitions"));
    case "investmentsNet": return outflow(groupOf("investing", "investments"));
    case "leasePrincipal": return outflow(groupOf("financing", "leasePrincipal"));
    case "depreciation": return nonCash(NON_CASH.depreciation);
    case "stockCompensation": return nonCash(NON_CASH.stockCompensation);
    case "interestPaid": return supplemental("interestPaid");
    case "taxesPaid": return supplemental("taxesPaid");
    case "unpaidCapex": return supplemental("unpaidCapex");
    case "leaseAssetsObtained": return supplemental("leaseAssetsObtained");
    default: return null;
  }
}
const ASSET_GROUPS: Partial<Record<CapitalMetric, string>> = { cash: "cash", receivables: "receivables", inventory: "inventory", productive: "productive", leaseAssets: "leaseAssets", intangibles: "intangibles", investments: "investments" };
const LIABILITY_GROUPS: Partial<Record<CapitalMetric, string>> = { debt: "debt", leases: "leases", customerAdvances: "customerAdvances", payables: "payables", deferredTax: "deferredTax" };
/** A balance-sheet figure: a total as stated, or the sum of the lines in one economic group (zero when the group is empty on a reconciled sheet). */
export function balanceMetric(b: BalanceSheet, metric: CapitalMetric): number | null {
  if (metric === "totalAssets") return Number(b.totals.assets);
  if (metric === "equity") return Number(b.totals.equity);
  if (metric === "totalLiabilities") return Number(b.totals.liabilities);
  if (metric === "currentAssets") return finite(b.totals.currentAssets);
  if (metric === "currentLiabilities") return finite(b.totals.currentLiabilities);
  const asset = ASSET_GROUPS[metric], liability = LIABILITY_GROUPS[metric];
  if (asset) return sum(b.assets.filter(l => l.group === asset));
  if (liability) return sum(b.liabilities.filter(l => l.group === liability));
  return null;
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
    const value = balanceMetric(b, metric);
    return value == null ? null : { value, periodStart: null, periodEnd: b.asOf, currency: b.currency, accessions: [b.source.accession] };
  }
  return cashFlowSpan(data, periodEnd, span, c => cashMetric(c, metric));
}
/** A cash-flow figure over a span: the twelve-month statement as filed for a fiscal year, otherwise the quarterly statements summed. */
export function cashFlowSpan(data: FindingData, periodEnd: string, span: FindingSpan, pick: (c: CashFlowStatement) => number | null): Point | null {
  const quarters = data.capital?.quarters ?? [];
  const point = (c: CashFlowStatement | null | undefined): Point | null => { const v = c ? pick(c) : null; return c && v != null ? { value: v, periodStart: c.periodStart, periodEnd: c.periodEnd, currency: c.currency, accessions: c.sources.map(s => s.accession) } : null; };
  if (span === "fiscal_year") {
    const ytd = quarters.find(q => near(q.periodEnd, periodEnd))?.yearToDate;
    if (ytd && monthIndex(ytd.periodEnd) - monthIndex(ytd.periodStart) >= 11) return point(ytd);
  }
  return overSpan(span, periodEnd, end => point(quarters.find(q => near(q.periodEnd, end))?.cashFlow));
}
/** The sum of one economic group of the operating section, when the section's lines reconcile. */
export const operatingGroup = (c: CashFlowStatement, group: "netIncome" | "nonCash" | "workingCapital" | "other") => c.operating.lines ? sum(c.operating.lines.filter(l => l.group === group)) : null;

/** Lines the statement places between operating income and pretax income whose name says interest expense, as a positive charge. */
function interestExpenseAt(data: FindingData, periodEnd: string): Point | null {
  const q = flowQuarter(data, periodEnd);
  const hits = (q?.otherComponents ?? []).filter(c => /\binterest\b/i.test(c.name) && !/\bincome\b/i.test(c.name.replace(/\(expense\)|expense/gi, "")));
  const values = hits.map(c => finite(c.amount.value));
  if (!q || !hits.length || values.some(v => v == null)) return null;
  return flowPoint(q, -values.reduce<number>((t, v) => t + (v ?? 0), 0));
}

/**
 * A figure no statement states, by one fixed formula over figures the statements do state. Every input must resolve;
 * nothing is assumed zero. Instants are read at the period end whatever the span; flows follow the span asked for.
 */
function derivedAt(data: FindingData, metric: DerivedMetric, periodEnd: string, span: FindingSpan): ResolvedValue | null {
  const at = (ref: FindingRef, end = periodEnd, s: FindingSpan = span) => resolveRef(data, ref, end, s);
  const yearAgo = shiftPeriod(periodEnd, -12);
  const join = (value: number, unit: ValueUnit, parts: Array<ResolvedValue | null>): ResolvedValue | null => {
    if (parts.some(p => p == null) || !Number.isFinite(value)) return null;
    const all = parts as ResolvedValue[], currencies = new Set(all.map(p => p.currency).filter(Boolean));
    if (currencies.size > 1) return null;
    return { value, unit, currency: unit === "USD" ? [...currencies][0] ?? null : null, periodStart: all.find(p => p.periodStart)?.periodStart ?? null, periodEnd: all[0]!.periodEnd, span, accessions: [...new Set(all.flatMap(p => p.accessions))] };
  };
  const v = (r: ResolvedValue | null) => r?.value ?? NaN;
  const average = (ref: FindingRef) => { const now = at(ref), then = at(ref, yearAgo); return join((v(now) + v(then)) / 2, "USD", [now, then]); };
  const group = (g: "nonCash" | "workingCapital") => { const p = cashFlowSpan(data, periodEnd, span, c => operatingGroup(c, g)); return p ? { ...p, unit: "USD" as const, span } : null; };
  switch (metric) {
    case "ebitda": { const o = at({ metric: "operating" }), d = at({ capital: "depreciation" }); return join(v(o) + v(d), "USD", [o, d]); }
    case "netDebt": { const debt = at({ capital: "debt" }), leases = at({ capital: "leases" }), cash = at({ capital: "cash" }); return join(v(debt) + v(leases) - v(cash), "USD", [debt, leases, cash]); }
    case "investedCapital": { const debt = at({ capital: "debt" }), leases = at({ capital: "leases" }), equity = at({ capital: "equity" }), cash = at({ capital: "cash" }); return join(v(debt) + v(leases) + v(equity) - v(cash), "USD", [debt, leases, equity, cash]); }
    case "nopat": {
      // The effective rate of the same span, held between zero and 35%; a pretax loss shields nothing.
      const o = at({ metric: "operating" }), tax = at({ metric: "tax" }), pretax = at({ metric: "pretax" });
      const rate = v(pretax) > 0 ? Math.min(0.35, Math.max(0, v(tax) / v(pretax))) : 0;
      return join(v(o) * (1 - rate), "USD", [o, tax, pretax]);
    }
    case "averageEquity": return average({ capital: "equity" });
    case "averageAssets": return average({ capital: "totalAssets" });
    case "averageInvestedCapital": return average({ derived: "investedCapital" });
    case "accruals": { const net = at({ metric: "net" }), ocf = at({ capital: "operatingCashFlow" }), assets = at({ derived: "averageAssets" }); return v(assets) > 0 ? join((v(net) - v(ocf)) / v(assets), "ratio", [net, ocf, assets]) : null; }
    case "nonCashCharges": return group("nonCash");
    case "workingCapitalChange": return group("workingCapital");
    case "incrementalReturn": {
      const now = at({ metric: "operating" }), then = at({ metric: "operating" }, yearAgo), ic = at({ derived: "investedCapital" }), icThen = at({ derived: "investedCapital" }, yearAgo);
      const added = v(ic) - v(icThen);
      return added > 0 ? join((v(now) - v(then)) / added, "ratio", [now, then, ic, icThen]) : null;
    }
    case "interestExpense": { const p = overSpan(span, periodEnd, end => interestExpenseAt(data, end)); return p ? { ...p, unit: "USD", span } : null; }
    case "netExternalFunding": { const issued = at({ capital: "debtIssued" }), repaid = at({ capital: "debtRepaid" }), equity = at({ capital: "equityIssued" }); return join(v(issued) - v(repaid) + v(equity), "USD", [issued, repaid, equity]); }
    case "cashRunwayMonths": {
      // Months of cash at the past year's burn; a company generating cash has no runway to count.
      const cash = at({ capital: "cash" }), fcf = at({ capital: "freeCashFlow" }, periodEnd, "fiscal_year");
      return v(fcf) < 0 && v(cash) >= 0 ? join(v(cash) / (-v(fcf) / 12), "ratio", [cash, fcf]) : null;
    }
    case "debtDueCoverage": {
      const cash = at({ capital: "cash" }), fcf = at({ capital: "freeCashFlow" }, periodEnd, "fiscal_year"), due = at({ schedule: { kind: "debtMaturities", bucket: 0 } });
      return v(due) > 0 ? join((v(cash) + v(fcf)) / v(due), "ratio", [cash, fcf, due]) : null;
    }
  }
}

/**
 * A peer's figure from the peers projection: the peer's latest quarter ending on or before the period asked for (within
 * 120 days), or the four such quarters summed for a four-quarter span of a flow. Instants and rates never sum.
 */
const PEER_FLOWS: readonly string[] = ["revenue", "grossProfit", "operatingIncome", "netIncome", "operatingCashFlow", "capex", "freeCashFlow", "debtIssued", "equityIssued", "buybacks", "dividends", "depreciation", "stockBasedCompensation"];
const PEER_FIGURE: Partial<Record<string, string>> = { revenue: "revenue", gross: "grossProfit", operating: "operatingIncome", net: "netIncome", operatingCashFlow: "operatingCashFlow", capex: "capex", freeCashFlow: "freeCashFlow", debtIssued: "debtIssued", equityIssued: "equityIssued", buybacks: "buybacks", dividends: "dividends", totalAssets: "totalAssets", debt: "debt", cash: "cash", equity: "equity", leases: "leases", customerAdvances: "customerAdvances", rpo: "rpo", depreciation: "depreciation", stockCompensation: "stockBasedCompensation", stock_based_compensation: "stockBasedCompensation", depreciation_and_amortization: "depreciation", total_revenue: "revenue", operating_cash_flow: "operatingCashFlow", capital_expenditure: "capex", free_cash_flow: "freeCashFlow", net_income: "netIncome", operating_income: "operatingIncome", gross_profit: "grossProfit", total_assets: "totalAssets", long_term_debt: "debt", cash_and_cash_equivalents: "cash", stockholders_equity: "equity", remaining_performance_obligation: "rpo" };
function peerAt(data: FindingData, ticker: string, ref: { capital: CapitalMetric } | { fundamental: string } | { metric: string }, periodEnd: string, span: FindingSpan): ResolvedValue | null {
  const company = data.peers?.companies.find(c => c.ticker === ticker);
  const key = PEER_FIGURE["capital" in ref ? ref.capital : "fundamental" in ref ? ref.fundamental : ref.metric];
  if (!company || !key) return null;
  const aligned = alignedPeerQuarter(company, periodEnd);
  if (!aligned) return null;
  if (span === "quarter" || !PEER_FLOWS.includes(key)) {
    const v = finite(aligned.figures[key as keyof typeof aligned.figures]);
    return v == null ? null : { value: v, unit: "USD", currency: "USD", periodStart: null, periodEnd: aligned.periodEnd, span, accessions: aligned.accessions };
  }
  // Four consecutive quarters ending at the aligned one, each present; a gap means no four-quarter figure.
  const sorted = [...company.quarters].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
  const start = sorted.findIndex(q => q.periodEnd === aligned.periodEnd);
  const four = sorted.slice(start, start + 4);
  if (four.length < 4 || four.some((q, i) => i > 0 && Math.abs(monthIndex(four[i - 1]!.periodEnd) - monthIndex(q.periodEnd) - 3) > 1)) return null;
  const values = four.map(q => finite(q.figures[key as keyof typeof q.figures]));
  if (values.some(v => v == null)) return null;
  return { value: values.reduce<number>((total, v) => total + (v ?? 0), 0), unit: "USD", currency: "USD", periodStart: four[3]!.periodEnd, periodEnd: aligned.periodEnd, span, accessions: [...new Set(four.flatMap(q => q.accessions))] };
}

/** "(in millions)", "(Dollars in thousands)", "(in billions, except per share data)": the scale a table's unit header states, or null. */
export function tableScale(unit: string | null): number | null {
  if (!unit) return null;
  const m = /\b(thousand|million|billion)s?\b/i.exec(unit);
  return m ? { thousand: 1e3, million: 1e6, billion: 1e9 }[m[1]!.toLowerCase()]! : null;
}
/** One table cell as a figure: only when the table states a scale and the cell is a plain amount (no percent, no per-share). */
function passageCellAt(data: FindingData, cell: { passageId: string; row: number; col: number }, periodEnd: string, span: FindingSpan): ResolvedValue | null {
  const passage = data.passages?.find(p => p.passageId === cell.passageId);
  const scale = passage?.table ? tableScale(passage.table.unit) : null;
  const c = passage?.table?.rows[cell.row]?.cells[cell.col];
  if (!passage || !scale || !c || c.value == null || /%|per share/i.test(c.text) || !Number.isFinite(c.value)) return null;
  return { value: c.value * scale, unit: "USD", currency: "USD", periodStart: null, periodEnd, span, accessions: [] };
}

/** One figure of a filed event: an insider's shares sold, proceeds, price, purchases, exercises or holdings after, dated at the event. */
function eventAt(data: FindingData, id: string, field: EventField, span: FindingSpan): ResolvedValue | null {
  const event = data.events?.events.find(e => e.id === id);
  const t = event?.insider;
  if (!event || !t) return null;
  const pick: Record<EventField, [number | null | undefined, ValueUnit]> = {
    sharesSold: [t.sold?.shares, "shares"], proceeds: [t.sold?.proceeds, "USD"], averagePrice: [t.sold?.averagePrice ?? t.bought?.averagePrice, "per_share"],
    sharesBought: [t.bought?.shares, "shares"], cost: [t.bought?.cost, "USD"], exercised: [t.exercised, "shares"], heldAfter: [t.heldAfter, "shares"],
  };
  const [value, unit] = pick[field];
  return value == null || !Number.isFinite(value) ? null : { value, unit, currency: unit === "USD" || unit === "per_share" ? "USD" : null, periodStart: null, periodEnd: event.eventDate, span, accessions: [event.id] };
}

/** The rungs of a filing's RPO schedule, nearest first, each as the months after the period end it covers and the amount expected in it. */
export function rpoBuckets(rpo: RpoDisclosure): Array<{ from: number; to: number | null; amount: number | null; share: number | null }> {
  const total = Number(rpo.total);
  return rpo.buckets.map(b => {
    // A bucket starts the month after the period end unless its start says otherwise; its end is its tagged length later.
    const from = b.start ? Math.max(0, monthIndex(b.start) - monthIndex(rpo.asOf) - 1) : 0;
    const share = b.share != null ? Number(b.share) * 100 : b.amount != null && total ? Number(b.amount) / total * 100 : null;
    const amount = b.amount != null ? Number(b.amount) : share != null ? total * share / 100 : null;
    return { from, to: b.months == null ? null : from + b.months, amount: amount != null && Number.isFinite(amount) ? amount : null, share: share != null && Number.isFinite(share) ? share : null };
  }).sort((a, b) => a.from - b.from);
}
/** "within 12 months", "13–24 months", "after 24 months" / "12 个月内", "13–24 个月", "24 个月后". */
export const rpoBucketSpan = (b: { from: number; to: number | null }, locale: Locale = "en") => locale === "zh-CN"
  ? b.from === 0 && b.to != null ? `${b.to} 个月内` : b.to == null ? `${b.from} 个月后` : `${b.from + 1}–${b.to} 个月`
  : b.from === 0 && b.to != null ? `within ${b.to} months` : b.to == null ? `after ${b.from} months` : `${b.from + 1}–${b.to} months`;
function rpoBucketAt(data: FindingData, index: number, periodEnd: string): Point | null {
  const rpo = data.capital?.quarters.find(q => near(q.periodEnd, periodEnd))?.rpo;
  const bucket = rpo ? rpoBuckets(rpo)[index] : undefined;
  return rpo && bucket && bucket.amount != null ? { value: bucket.amount, periodStart: null, periodEnd: rpo.asOf, currency: rpo.currency, accessions: [rpo.source.accession] } : null;
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
  if ("rpoBucket" in ref) return amount(rpoBucketAt(data, ref.rpoBucket, periodEnd));
  if ("derived" in ref) return derivedAt(data, ref.derived, periodEnd, span);
  if ("peer" in ref) return peerAt(data, ref.peer.ticker, ref.peer.ref, periodEnd, span);
  if ("passageCell" in ref) return passageCellAt(data, ref.passageCell, periodEnd, span);
  if ("event" in ref) return eventAt(data, ref.event.id, ref.event.field, span);
  if ("schedule" in ref) {
    const hit = ref.schedule.bucket === "total" ? scheduleTotalAt(data.capital, ref.schedule.kind, periodEnd) : scheduleBucketAt(data.capital, ref.schedule.kind, ref.schedule.bucket, periodEnd);
    return hit ? { value: hit.value, unit: "USD", currency: hit.currency, periodStart: null, periodEnd: hit.periodEnd, span, accessions: hit.accessions } : null;
  }
  const item = data.guidance?.items.find(i => i.id === ref.guidanceId);
  return item ? guidanceValue(item, span) : null;
}

const METRIC_LABEL: Record<FlowMetric, string> = { revenue: "Total revenue", cost: "Cost of revenue", gross: "Gross profit", research: "R&D expense", sales: "Sales and marketing expense", administration: "G&A expense", operatingExpenses: "Operating expenses", operating: "Operating income", other: "Non-operating income (expense)", pretax: "Pretax income", tax: "Income tax", net: "Net income" };
const GUIDANCE_LABEL: Record<GuidanceItem["metric"], string> = { revenue: "Revenue", segment_revenue: "Revenue", gross_margin: "Gross margin", operating_margin: "Operating margin", operating_income: "Operating income", eps: "EPS", free_cash_flow: "Free cash flow", operating_cash_flow: "Operating cash flow", capex: "Capex", rpo: "RPO", billings: "Billings", other: "" };
const CAPITAL_LABEL: Record<CapitalMetric, string> = {
  operatingCashFlow: "Operating cash flow", capex: "Capex", freeCashFlow: "Free cash flow", financing: "Net financing cash flow", debtIssued: "Debt issued", debtRepaid: "Debt repaid", equityIssued: "Stock issued", buybacks: "Share buybacks", dividends: "Dividends",
  acquisitions: "Acquisitions", investmentsNet: "Net purchases of investments", leasePrincipal: "Lease principal repaid", depreciation: "Depreciation and amortization", stockCompensation: "Stock-based compensation",
  interestPaid: "Cash interest paid", taxesPaid: "Cash taxes paid", unpaidCapex: "Capex incurred but unpaid", leaseAssetsObtained: "Lease assets obtained",
  totalAssets: "Total assets", debt: "Total debt", cash: "Cash and short-term investments", equity: "Shareholders' equity", totalLiabilities: "Total liabilities", currentAssets: "Current assets", currentLiabilities: "Current liabilities",
  receivables: "Receivables", inventory: "Inventory", productive: "Property and equipment", leaseAssets: "Lease right-of-use assets", intangibles: "Goodwill and intangibles", investments: "Investments", leases: "Lease liabilities", customerAdvances: "Deferred revenue and customer advances", payables: "Accounts payable and accrued liabilities", deferredTax: "Deferred tax liabilities",
  rpo: "Remaining performance obligations (RPO)", rpoNext12MonthsShare: "RPO recognized within 12 months",
};

/** The same names in Chinese, for a reader's page; the pipeline and the model read the English ones. */
const METRIC_LABEL_ZH: Record<FlowMetric, string> = { revenue: "总营收", cost: "营业成本", gross: "毛利", research: "研发费用", sales: "销售及市场费用", administration: "管理费用", operatingExpenses: "营业费用", operating: "营业利润", other: "营业外收支", pretax: "税前利润", tax: "所得税", net: "净利润" };
const GUIDANCE_LABEL_ZH: Record<GuidanceItem["metric"], string> = { revenue: "营收", segment_revenue: "营收", gross_margin: "毛利率", operating_margin: "营业利润率", operating_income: "营业利润", eps: "每股收益", free_cash_flow: "自由现金流", operating_cash_flow: "经营现金流", capex: "资本开支", rpo: "剩余履约义务", billings: "开票额", other: "" };
const CAPITAL_LABEL_ZH: Record<CapitalMetric, string> = {
  operatingCashFlow: "经营现金流", capex: "资本开支", freeCashFlow: "自由现金流", financing: "筹资活动净现金流", debtIssued: "新增借款", debtRepaid: "偿还债务", equityIssued: "股权融资", buybacks: "回购", dividends: "分红",
  acquisitions: "收购支出", investmentsNet: "投资净买入", leasePrincipal: "偿还租赁本金", depreciation: "折旧与摊销", stockCompensation: "股权激励费用",
  interestPaid: "现金支付利息", taxesPaid: "现金支付所得税", unpaidCapex: "已发生未支付的资本开支", leaseAssetsObtained: "新增租赁资产",
  totalAssets: "总资产", debt: "总债务", cash: "现金及短期投资", equity: "股东权益", totalLiabilities: "总负债", currentAssets: "流动资产", currentLiabilities: "流动负债",
  receivables: "应收账款", inventory: "存货", productive: "固定资产", leaseAssets: "租赁使用权资产", intangibles: "商誉及无形资产", investments: "投资", leases: "租赁负债", customerAdvances: "递延收入及客户预付款", payables: "应付账款及应计负债", deferredTax: "递延所得税负债",
  rpo: "剩余履约义务（RPO）", rpoNext12MonthsShare: "12 个月内确认的 RPO",
};
const DERIVED_LABEL: Record<DerivedMetric, [string, string]> = {
  ebitda: ["EBITDA", "EBITDA"], netDebt: ["Net debt", "净债务"], investedCapital: ["Invested capital", "投入资本"], nopat: ["After-tax operating income (NOPAT)", "税后经营利润（NOPAT）"],
  accruals: ["Accruals ratio", "应计项比率"], nonCashCharges: ["Non-cash charges", "非现金项目"], workingCapitalChange: ["Working-capital change", "营运资本变动"],
  averageEquity: ["Average shareholders' equity", "平均股东权益"], averageAssets: ["Average total assets", "平均总资产"], averageInvestedCapital: ["Average invested capital", "平均投入资本"],
  incrementalReturn: ["Return on added capital", "增量资本回报"], interestExpense: ["Interest expense", "利息费用"], netExternalFunding: ["Net external funding", "净外部融资"],
  cashRunwayMonths: ["Cash runway (months)", "现金跑道（月）"], debtDueCoverage: ["Coverage of debt due within 12 months", "12 个月内到期债务覆盖倍数"],
};
/** The formula behind a derived figure, in the names its inputs carry; for the page's lineage line and the ledger. */
export const DERIVED_FORMULA: Record<DerivedMetric, string> = {
  ebitda: "operating income + depreciation and amortization", netDebt: "debt + lease liabilities − cash", investedCapital: "debt + lease liabilities + equity − cash",
  nopat: "operating income × (1 − income tax ÷ pretax income), rate held between 0 and 35%", accruals: "(net income − operating cash flow) ÷ average total assets",
  nonCashCharges: "operating-section non-cash lines", workingCapitalChange: "operating-section working-capital lines",
  averageEquity: "(equity + equity a year earlier) ÷ 2", averageAssets: "(total assets + total assets a year earlier) ÷ 2", averageInvestedCapital: "(invested capital + invested capital a year earlier) ÷ 2",
  incrementalReturn: "(operating income − operating income a year earlier) ÷ (invested capital − invested capital a year earlier)", interestExpense: "non-operating lines named interest expense, as a charge",
  netExternalFunding: "debt issued − debt repaid + stock issued", cashRunwayMonths: "cash ÷ (−free cash flow of the past four quarters ÷ 12), when free cash flow is negative",
  debtDueCoverage: "(cash + free cash flow of the past four quarters) ÷ debt maturing within 12 months",
};
const MARGIN_LABEL: Partial<Record<FlowMetric, string>> = { gross: "Gross margin", operating: "Operating margin", net: "Net margin", research: "R&D % of revenue", sales: "S&M % of revenue", administration: "G&A % of revenue" };
const MARGIN_LABEL_ZH: Partial<Record<FlowMetric, string>> = { gross: "毛利率", operating: "营业利润率", net: "净利率", research: "研发费用率", sales: "销售及市场费用率", administration: "管理费用率" };

/** Human label of a reference; a business node reads by its disclosed name when the data has it. `locale` names fixed metrics in the reader's language. */
export function refLabel(data: FindingData, ref: FindingRef, locale: Locale = "en"): string {
  const zh = locale === "zh-CN";
  if ("ratio" in ref) {
    const n = refLabel(data, ref.ratio.numerator, locale), d = refLabel(data, ref.ratio.denominator, locale);
    const margin = zh ? MARGIN_LABEL_ZH : MARGIN_LABEL;
    if ("metric" in ref.ratio.denominator && ref.ratio.denominator.metric === "revenue" && "metric" in ref.ratio.numerator && margin[ref.ratio.numerator.metric]) return margin[ref.ratio.numerator.metric]!;
    return `${n} / ${d}`;
  }
  if ("metric" in ref) return (zh ? METRIC_LABEL_ZH : METRIC_LABEL)[ref.metric];
  if ("capital" in ref) return (zh ? CAPITAL_LABEL_ZH : CAPITAL_LABEL)[ref.capital];
  if ("derived" in ref) return DERIVED_LABEL[ref.derived][zh ? 1 : 0];
  if ("fundamental" in ref) {
    const zhLabel = zh ? (FUNDAMENTAL_METRIC_LABEL_ZH as Record<string, string | undefined>)[ref.fundamental] : undefined;
    return zhLabel ?? data.fundamentals?.series.find(s => s.metricKey === ref.fundamental)?.label ?? FUNDAMENTAL_METRIC_CATALOG[ref.fundamental as keyof typeof FUNDAMENTAL_METRIC_CATALOG]?.label ?? ref.fundamental;
  }
  if ("peer" in ref) return `${ref.peer.ticker} · ${refLabel(data, ref.peer.ref, locale)}`;
  if ("schedule" in ref) {
    const kindLabel: Record<string, [string, string]> = { debtMaturities: ["Debt maturities", "债务到期"], leasePaymentsDue: ["Lease payments due", "应付租赁款"], purchaseObligations: ["Purchase obligations", "采购义务"] };
    if (ref.schedule.bucket === "total") return `${kindLabel[ref.schedule.kind]![zh ? 1 : 0]}${zh ? "合计" : ", total"}`;
    return scheduleBucketLabel(ref.schedule.kind, { from: ref.schedule.bucket * 12, to: ref.schedule.bucket === 5 ? null : (ref.schedule.bucket + 1) * 12, amount: "0" }, locale);
  }
  if ("event" in ref) {
    const event = data.events?.events.find(e => e.id === ref.event.id);
    const owner = event?.insider?.ownerName ?? (zh ? "内部人" : "Insider");
    const field: Record<EventField, [string, string]> = { sharesSold: ["shares sold", "卖出股数"], proceeds: ["sale proceeds", "卖出金额"], averagePrice: ["average price", "成交均价"], sharesBought: ["shares bought", "买入股数"], cost: ["purchase cost", "买入金额"], exercised: ["shares exercised", "行权股数"], heldAfter: ["shares held after", "交易后持股"] };
    return `${owner} · ${field[ref.event.field][zh ? 1 : 0]}`;
  }
  if ("passageCell" in ref) { const p = data.passages?.find(p => p.passageId === ref.passageCell.passageId); const row = p?.table?.rows[ref.passageCell.row]; return row ? `${row.label}${p?.table?.columns[ref.passageCell.col] ? ` · ${p.table.columns[ref.passageCell.col]}` : ""}` : (zh ? "表格数字" : "Table figure"); }
  if ("rpoBucket" in ref) {
    const rpo = [...(data.capital?.quarters ?? [])].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd)).find(q => q.rpo)?.rpo;
    const bucket = rpo ? rpoBuckets(rpo)[ref.rpoBucket] : undefined;
    if (zh) return bucket ? `${rpoBucketSpan(bucket, locale)}确认的 RPO` : `RPO 第 ${ref.rpoBucket + 1} 档`;
    return bucket ? `RPO due ${rpoBucketSpan(bucket)}` : `RPO rung ${ref.rpoBucket + 1}`;
  }
  if ("guidanceId" in ref) {
    const i = data.guidance?.items.find(i => i.id === ref.guidanceId);
    if (zh) return i ? `业绩指引 · ${i.segment ? `${i.segment} ` : ""}${GUIDANCE_LABEL_ZH[i.metric] || i.label}${i.fiscalYear ? ` ${i.fiscalYear} 财年${i.fiscalQuarter ? ` Q${i.fiscalQuarter}` : ""}` : ""}` : "业绩指引";
    return i ? `Guidance · ${i.segment ? `${i.segment} ` : ""}${GUIDANCE_LABEL[i.metric] || i.label}${i.fiscalYear ? ` ${i.fiscalQuarter ? `Q${i.fiscalQuarter} ` : ""}FY${i.fiscalYear}` : ""}` : "Guidance";
  }
  for (const q of data.quarters) for (const s of q.segments) { if (s.id === ref.nodeId) return s.name; const c = s.children?.find(c => c.id === ref.nodeId); if (c) return c.name; }
  for (const h of data.history?.quarters ?? []) for (const s of h.segments) { if (s.id === ref.nodeId) return s.name; const c = s.children?.find(c => c.id === ref.nodeId); if (c) return c.name; }
  return ref.nodeId;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthYear = (date: string) => `${MONTHS[Number(date.slice(5, 7)) - 1] ?? date.slice(5, 7)} ${date.slice(0, 4)}`;
/** "2026 年 5 月" */
const monthYearZh = (date: string) => `${date.slice(0, 4)} 年 ${Number(date.slice(5, 7))} 月`;
/** Plain period label: "4 quarters ended May 2026" for a four-quarter span, "Quarter ended May 2026" for a quarter. */
export const spanLabel = (v: { span: FindingSpan; periodEnd: string }, locale: Locale = "en") => locale === "zh-CN"
  ? v.span === "fiscal_year" ? `截至 ${monthYearZh(v.periodEnd)}的 4 个季度` : `截至 ${monthYearZh(v.periodEnd)}的季度`
  : v.span === "fiscal_year" ? `4 quarters ended ${monthYear(v.periodEnd)}` : `Quarter ended ${monthYear(v.periodEnd)}`;

/** The comparison the evidence asks for; null when it was asked for and the data cannot make it. */
function compareOf(data: FindingData, e: FindingEvidence, current: ResolvedValue, locale: Locale = "en"): Pick<ResolvedEvidence, "compare" | "compareLabel" | "delta" | "ratio" | "guidance"> | null {
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
    return { compare: range, compareLabel: locale === "zh-CN" ? `业绩指引：${item.label}` : `Guidance: ${item.label}`, delta: null, ratio: null, guidance: { item, verdict, measured, unit } };
  }
  const months = e.compare === "yoy" ? -12 : -3;
  const compare = resolveRef(data, e.ref, shiftPeriod(e.periodEnd, months), e.span);
  if (!compare) return none;
  // Rates move in points: a margin, or a ratio of two figures, is compared by its difference ×100, never by its growth.
  // A growth rate needs a positive base and a positive result; a sign change or a zero base has no meaningful rate.
  const delta = current.unit === "percent" ? current.value - compare.value : current.unit === "ratio" ? current.value - compare.value : compare.value > 0 && current.value > 0 ? (current.value - compare.value) / compare.value * 100 : null;
  return { compare, compareLabel: locale === "zh-CN" ? e.compare === "yoy" ? "上年同期" : "上一季度" : e.compare === "yoy" ? "Year ago" : "Prior quarter", delta, ratio: compare.value > 0 && current.value > 0 ? current.value / compare.value : null, guidance: null };
}

/** `locale` names the figure and its comparison in the reader's language; the figures are the same in every locale. */
export function resolveEvidence(data: FindingData, e: FindingEvidence, locale: Locale = "en"): ResolvedEvidence | null {
  const current = resolveRef(data, e.ref, e.periodEnd, e.span), compared = current && compareOf(data, e, current, locale);
  return current && compared ? { evidence: e, label: e.label ?? refLabel(data, e.ref, locale), current, ...compared } : null;
}

/* ---------- Verification ---------- */

/** Amounts are written in trillions, billions or millions of dollars ("$55.7 billion"), as the ledger writes them. */
const AMOUNT_SCALES = [1e12, 1e9, 1e6];

/** Numbers a reader could have written from this evidence, in the units English prose uses. */
export function evidenceCandidates(r: ResolvedEvidence): number[] {
  const out: number[] = [];
  const scaled = (v: ResolvedValue, x: number) => v.unit === "USD" ? AMOUNT_SCALES.map(scale => x / scale) : v.unit === "ratio" ? [x, x * 100] : [x];
  const amount = (v: ResolvedValue) => {
    out.push(...scaled(v, v.value));
    if (v.range) for (const x of [v.range.low, v.range.high]) out.push(...scaled(v, x));
  };
  amount(r.current);
  if (r.compare) amount(r.compare);
  if (r.delta != null) out.push(r.delta, ...(r.current.unit === "ratio" ? [r.delta * 100] : []));
  if (r.ratio != null) out.push(r.ratio);
  if (r.guidance) out.push(r.guidance.measured);
  // "down 1%" and "a loss of $23.7 billion" write the magnitude; the sign is in the words.
  return out.filter(v => Number.isFinite(v)).flatMap(v => v < 0 ? [v, -v] : [v]);
}

const MONTH_NAME = String.raw`Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?`;
const PERIOD_UNIT = String.raw`months?|quarters?|years?|weeks?|days?|fiscal\s+(?:years?|quarters?)`;
/** The same periods and counts written in Chinese: 12 个月, 8 个季度, 3 年, 第 2 季度. */
const PERIOD_UNIT_ZH = String.raw`个?(?:月份?|季度|财季|季|财年|年|周|天|日)`;
/** Chinese counts amounts in ten-thousands: 万, 亿 (10^8) and 万亿 (10^12). */
const ZH_MAGNITUDE: Record<string, number> = { "万亿": 1e12, "亿": 1e8, "万": 1e4 };
/**
 * A number in prose, with what may mark it as a period, a count or a name rather than a figure: a fiscal-period
 * prefix (FY2026, Q3, H1, 第) or a month name (May 31); a period unit (12 months, 8 quarters, a 3-year plan, 12 个月),
 * an ordinal (4th), a quarter or half suffix (3Q, 2H) or a form name (10-K, 8-K). Digits inside an ISO date or a word
 * are never read. A Chinese magnitude after the number (285亿) is captured so the amount can be read in full.
 */
const PROSE_NUMBER = new RegExp(
  String.raw`(?<![\w.])(?<!\d{4}-)(?<!\d{4}-\d{2}-)(FY\s?|[QH](?=\d)|第\s?|(?:${MONTH_NAME})\.?\s)?` +
  String.raw`([-−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)` +
  String.raw`(\s?-?(?:${PERIOD_UNIT})\b|(?:st|nd|rd|th)\b|[QH](?![a-z])|-[KQF]\b|\s?${PERIOD_UNIT_ZH})?` +
  String.raw`(\s?(?:万亿|亿|万))?`,
  "gi");

/**
 * An amount written with a Chinese magnitude, put in the scale English prose would use for it, so 285亿 reads as
 * 28.5 (billions) and 3.5亿 as 350 (millions), the numbers the evidence candidates hold; below a million, and for a
 * share count (123万股), it stays whole.
 */
function fromChineseMagnitude(value: number, magnitude: string, shares: boolean): number {
  const absolute = value * ZH_MAGNITUDE[magnitude]!;
  // Share counts are compared whole, as the evidence holds them.
  if (shares) return absolute;
  for (const scale of [1e12, 1e9, 1e6]) if (Math.abs(absolute) >= scale) return Number((absolute / scale).toPrecision(12));
  return absolute;
}

/** Numeric statements in prose, skipping years, dates, fiscal periods, period counts, ordinals and form names. */
export function proseNumbers(prose: string): number[] {
  const out: number[] = [];
  for (const match of prose.matchAll(PROSE_NUMBER)) {
    const [, prefix, raw, suffix, magnitude] = match;
    if (prefix || suffix) continue;
    const value = Number(raw.replace("−", "-").replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    if (magnitude) { out.push(fromChineseMagnitude(value, magnitude.trim(), prose[match.index! + match[0].length] === "股")); continue; }
    // A year, alone or after "fiscal" or "calendar".
    if (Number.isInteger(value) && value >= 1900 && value <= 2100) continue;
    out.push(value);
  }
  return out;
}

const ENGLISH_SCALE: Record<string, number> = { trillion: 1e12, t: 1e12, billion: 1e9, bn: 1e9, b: 1e9, million: 1e6, mn: 1e6, m: 1e6, thousand: 1e3, k: 1e3 };
/**
 * Every figure in prose at its full value, with the rounding its written digits allow: "$1,640 million" and
 * "16.40亿美元" are both 1.64e9, "50 million shares" and "5000万股" both 5e7. Periods, years, ordinals and form names
 * are skipped as in `proseNumbers`. For comparing a translation with its source, where both write the same figures
 * in different units.
 */
export function proseFigures(prose: string): Array<{ value: number; tolerance: number; raw: string; scaled: boolean }> {
  const out: Array<{ value: number; tolerance: number; raw: string; scaled: boolean }> = [];
  for (const match of prose.matchAll(PROSE_NUMBER)) {
    const [, prefix, raw, suffix, magnitude] = match;
    if (prefix || suffix) continue;
    const number = Number(raw!.replace("−", "-").replace(/,/g, ""));
    if (!Number.isFinite(number)) continue;
    const after = prose.slice(match.index! + match[0].length);
    const scale = magnitude ? ZH_MAGNITUDE[magnitude.trim()]! : ENGLISH_SCALE[(/^\s?(trillion|billion|million|thousand|bn|mn|[tbmk])\b/i.exec(after)?.[1] ?? "").toLowerCase()] ?? 1;
    if (scale === 1 && Number.isInteger(number) && number >= 1900 && number <= 2100) continue;
    const digits = raw!.includes(".") ? raw!.length - raw!.indexOf(".") - 1 : 0;
    out.push({ value: Math.abs(number * scale), tolerance: 0.5 * 10 ** -digits * scale, raw: raw!.replace(/,/g, "").replace("−", ""), scaled: scale !== 1 });
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
export function resolveWatch(data: FindingData, watch: FindingWatch, publicationPeriodEnd: string, locale: Locale = "en"): WatchOutcome | null {
  const periodEnd = watchPeriod(publicationPeriodEnd, watch);
  const resolved = resolveEvidence(data, { ref: watch.ref, periodEnd, span: watch.horizon === "next_quarter" ? "quarter" : "fiscal_year", ...(watch.compare ? { compare: watch.compare } : {}) }, locale);
  return resolved ? { periodEnd, resolved } : null;
}
/**
 * Pass or fail of a watch's test against its published outcome: above/below the comparison, or within a guided range
 * (or within `tolerance` percent of the comparison). Null when the test cannot be read against the data.
 */
export function watchVerdict(data: FindingData, watch: FindingWatch, publicationPeriodEnd: string): { verdict: "pass" | "fail"; outcome: WatchOutcome } | null {
  const test = watch.test;
  if (!test) return null;
  const periodEnd = watchPeriod(publicationPeriodEnd, watch), span: FindingSpan = watch.horizon === "next_quarter" ? "quarter" : "fiscal_year";
  const against = test.against;
  const compare: FindingEvidence["compare"] | undefined = against === "yoy" || against === "qoq" ? against : "guidanceId" in against ? { guidanceId: against.guidanceId } : undefined;
  const resolved = resolveEvidence(data, { ref: watch.ref, periodEnd, span, ...(compare ? { compare } : {}) });
  if (!resolved) return null;
  const outcome: WatchOutcome = { periodEnd, resolved };
  const current = resolved.current.value;
  if (compare && typeof compare === "object") {
    if (!resolved.guidance) return null;
    const verdict = test.expect === "within" ? resolved.guidance.verdict === "within" : resolved.guidance.verdict === test.expect;
    return { verdict: verdict ? "pass" : "fail", outcome };
  }
  const base = compare ? resolved.compare?.value : typeof against === "object" && "ref" in against ? resolveRef(data, against.ref, periodEnd, span)?.value : null;
  if (base == null) return null;
  const pass = test.expect === "above" ? current > base : test.expect === "below" ? current < base : Math.abs(current - base) <= Math.abs(base) * ((test.tolerance ?? 5) / 100);
  return { verdict: pass ? "pass" : "fail", outcome };
}
export type WithheldFinding = { id: string; reasons: string[] };

/**
 * Keeps only findings the page's data can stand behind: every piece of evidence resolves, every
 * anchored business and metric exists in the quarter the finding is about, and every number in
 * its title and judgment is one the evidence produces. Capital anchors are checked only once the
 * capital projection has loaded; the order is severity first, then risks before the rest.
 */
export function verifyFindings(publication: FindingsPublication, data: FindingData, locale: Locale = "en"): { verified: VerifiedFinding[]; withheld: WithheldFinding[] } {
  const verified: VerifiedFinding[] = [], withheld: WithheldFinding[] = [];
  const order: Record<AnalysisFinding["kind"], number> = { risk: 0, strength: 1, shift: 2, watch: 3 };
  for (const f of publication.findings) {
    const reasons: string[] = [];
    const resolved = f.evidence.map(e => resolveEvidence(data, e, locale));
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
    else verified.push({ ...f, resolved: resolved as ResolvedEvidence[], periodEnd, watchOutcome: f.watch ? resolveWatch(data, f.watch, periodEnd, locale) : null });
  }
  verified.sort((a, b) => b.severity - a.severity || order[a.kind] - order[b.kind]);
  return { verified, withheld };
}
