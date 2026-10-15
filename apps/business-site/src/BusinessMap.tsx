import { Button } from "@/packages/web/src/ui/button";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import type { BusinessFlowQuarter, BusinessSegment, FlowMetric, FlowSource, PublicBusinessFlow } from "@/shared/analysis-contract/business-flow";
import { deficitFinancialGraph, financialGraph, type FinancialGraph } from "@/packages/web/src/model/business-flow-sankey";
import { compactFlowValue, truncateToWidth, type PlacedNode } from "@/packages/web/src/model/business-flow-layout";
import { availableRevenueTrees, compareRevenueNode, revenueNodeKey } from "@/packages/web/src/model/revenue-tree";
import { formatFlowValue, compareAmount, compareFlowAmounts, flowWords, numeric, previousQuarter, yearAgoQuarter, type FlowChange } from "@/packages/web/src/model/business-flow-model";
import { FinancialSankey } from "@/packages/web/src/business-flow/FinancialSankey";
import { FlowChart, layoutFor, type CompareBasis, type GuideBracketMark, type GuidePillMark, type NodeCopy, type Tip } from "./FlowChart";
import { ACTION_GLYPH, actionName, guidanceMarks, markSentence } from "./guidance-marks";
import type { RevenueHistory } from "@/shared/analysis-contract/revenue-history";
import type { BusinessExplainer, ExplainerClaim, ExplainerSection } from "@/shared/analysis-contract/business-explainer";
import type { BusinessTree } from "@/shared/analysis-contract/business-tree";
import { treeNodeFor } from "@/shared/analysis-runtime/business-tree";
import { MindLens, type MindMapInput } from "./MindMap";
import type { MindItem } from "./mindmap-layout";
import type { GuidancePublication } from "@/shared/analysis-contract/guidance";
import { TrendPanel } from "./TrendPanel";
import { MetricPicker, MetricTrendPanel } from "./MetricTrend";
import { REVENUE_METRIC, metricOptions, metricTrend } from "./metric-model";
import { ToggleGroup, ToggleGroupItem } from "@/packages/web/src/ui/toggle-group";
import type { CapitalQuarter, PublicCapitalStructure } from "@/shared/analysis-contract/capital-structure";
import { balanceMetrics, balancePool, cashMetrics, cashPool, type Pool } from "./capital-model";
import { PoolChart, TONE_LABEL, toneColor } from "./PoolChart";
import { Rail } from "./Sidebar";
import type { FindingPassage, FindingsPublication } from "@/shared/analysis-contract/findings";
import type { PeersPublication } from "@/shared/analysis-contract/peers";
import { watchVerdict, type FindingFundamentals, type ResolvedEvidence, type ResolvedValue } from "@/shared/analysis-runtime/findings";
import { formatChange, higherIsBetter, highlightChange, highlightsFor, ratioForm, type VerifiedHighlight } from "@/shared/analysis-runtime/highlights";
import { anchorNodeNames, anchorPoolKeys, findingData, VIEW_LABEL, verifiedFindings } from "./findings-model";
import { FindingsList } from "./FindingsList";
import { LensPanel } from "./LensPanel";
import type { EventsPublication } from "@/shared/analysis-contract/events";
import type { PublicFilingDigestPage } from "@/shared/analysis-contract/filings";
import { timelinePoints } from "./events-model";
import { railItems, timelineFromFilings, type RailItem } from "./reports-model";
import { EventsList } from "./EventsList";
import { RailSection, railTransition, type RailSectionKey } from "./RailSection";
import { EventLens } from "./EventLens";
import { ReportLens } from "./ReportLens";
import { Timeline } from "./Timeline";
import { lazy, Suspense } from "react";
import { getLocale, messages } from "@/packages/web/src/i18n";
import { SourceLanguage, langOf } from "@/packages/web/src/i18n/SourceLanguage";
import { compactShares, multiple, perShare, qoqLabel, yoyLabel } from "@/shared/analysis-runtime/locale";

const m = messages({
  lastYear: "last year", lastQuarter: "last quarter", yearAgo: "Year ago", lastQuarterPeriod: "Last quarter",
  companyBusinesses: "Company businesses", businesses: "Businesses", allBusinesses: "All businesses", totalRevenue: "Total revenue",
  topLevelCount: (n: number) => `Total revenue · ${n} top-level ${n === 1 ? "business" : "businesses"}`,
  shareBeforeEliminations: "Share of segment revenue before eliminations", share: "Share of revenue",
  reconciliation: (currency: string) => `Revenue reconciliation · ${currency} millions`, segmentTotal: "Segment revenue (before eliminations)", consolidated: "Consolidated revenue",
  findingStage: (ticker: string, title: string) => `${ticker} finding: ${title}`, flowStage: (ticker: string) => `${ticker} revenue to profit flow`,
  revenueThisQuarter: "Revenue this quarter", ofParent: (share: string, parent: string) => `${share} of ${parent}`, topLevel: "Top-level business",
  companyRevenue: "Total company revenue", gross: "Gross profit", operating: "Operating income", pretax: "Income before taxes", netLoss: "Net loss", net: "Net income",
  margin: (value: string) => `Margin ${value}`, coverage: (value: string) => `Cost coverage ${value}`,
  comparisonBase: "Comparison base", financialView: "Financial view", noFinancials: "No quarterly financials disclosed",
  chart: (ticker: string, period: string, currency: string) => `${ticker} ${period} revenue to net income, ${currency}`,
  legend: "Legend", businessRevenue: "Business revenue", profit: "Profit", loss: "Loss", costs: "Costs and expenses", data: (date: string) => `Data ${date}`,
  thisQuarter: "This quarter", marginLabel: "Margin", offset: "Offset", remaining: "Remaining after offset", asReported: (currency: string) => `As reported (${currency} millions)`,
  above: "Above range", within: "Within range", below: "Below range", thisGuidance: (text: string) => `This quarter’s guidance · ${text}`,
  derivedGuidance: "Guidance (from growth rate)", guidanceRange: "Guidance range", result: "Result", issued: "Issued", source: (title: string) => `Source: ${title}`,
  nextGuidance: (text: string) => `Next quarter’s guidance · ${text}`, vsPrevious: "vs. previous", previously: (range: string) => ` (previously ${range})`,
  totalAssets: "Total assets", asOf: (date: string) => `As of ${date}`, debt: "Debt", leverage: (value: string) => `Debt and leases ${value} of assets`,
  customer: "Customer prepayments", ofAssets: (value: string) => `${value} of assets`, cash: "Cash and short-term investments", equity: "Stockholders’ equity",
  paidIn: (paid: string, deficit: string) => `Paid-in ${paid} · Accumulated deficit ${deficit}`,
  operatingCash: (period: string) => `Operating cash flow · ${period}`, capexCoverage: (value: string) => `Capex coverage ${value}`, capex: "Capital expenditures",
  free: (value: string) => `Free cash flow ${value}`, financing: "Net cash from financing", netBorrowing: (value: string) => `Net borrowing ${value}`,
  sharesIssued: (value: string) => `Shares issued ${value}`, cashChange: "Change in cash", endingCash: (value: string) => `Ending cash and short-term investments ${value}`,
  yearToDate: (months: number) => `Year to date (${months} months)`,
  balanceChart: (ticker: string, date: string) => `${ticker} funding sources to assets as of ${date}`, cashChart: (ticker: string, period: string) => `${ticker} cash sources and uses, ${period.toLowerCase()}`,
  derived: (to: number, from: number) => `Derived · ${to}M − ${from}M year to date`,
  profile: (name: string) => `${name} business profile`, noDescription: "No description", customers: "Customers", revenueModel: "Revenue model", notDisclosed: "Not disclosed",
  details: (label: string) => `${label} business details`, products: "Products",
}, {
  lastYear: "上年同期", lastQuarter: "上季度", yearAgo: "上年同期", lastQuarterPeriod: "上季度",
  companyBusinesses: "公司业务", businesses: "业务", allBusinesses: "全部业务", totalRevenue: "总营收",
  topLevelCount: (n: number) => `总营收 · ${n} 个一级业务`,
  shareBeforeEliminations: "占抵销前分部营收", share: "占营收",
  reconciliation: () => "营收调节", segmentTotal: "分部营收（抵销前）", consolidated: "合并营收",
  findingStage: (ticker: string, title: string) => `${ticker} 要点：${title}`, flowStage: (ticker: string) => `${ticker} 营收至利润流向`,
  revenueThisQuarter: "本季营收", ofParent: (share: string, parent: string) => `占 ${parent} ${share}`, topLevel: "一级业务",
  companyRevenue: "公司总营收", gross: "毛利", operating: "营业利润", pretax: "税前利润", netLoss: "净亏损", net: "净利润",
  margin: (value: string) => `利润率 ${value}`, coverage: (value: string) => `成本覆盖率 ${value}`,
  comparisonBase: "比较基准", financialView: "报表视图", noFinancials: "未披露季度财务数据",
  chart: (ticker: string, period: string, currency: string) => `${ticker} ${period} 营收至净利润，${currency}`,
  legend: "图例", businessRevenue: "业务营收", profit: "利润", loss: "亏损", costs: "成本与费用", data: (date: string) => `数据 ${date}`,
  thisQuarter: "本季度", marginLabel: "利润率", offset: "抵减", remaining: "抵减后余额", asReported: () => "披露值",
  above: "高于指引区间", within: "处于指引区间", below: "低于指引区间", thisGuidance: (text: string) => `本季度指引 · ${text}`,
  derivedGuidance: "业绩指引（按增长率推算）", guidanceRange: "指引区间", result: "结果", issued: "发布日期", source: (title: string) => `来源：${title}`,
  nextGuidance: (text: string) => `下季度指引 · ${text}`, vsPrevious: "较前次", previously: (range: string) => `（前次 ${range}）`,
  totalAssets: "总资产", asOf: (date: string) => `截至 ${date}`, debt: "债务", leverage: (value: string) => `债务及租赁占资产 ${value}`,
  customer: "客户预付款", ofAssets: (value: string) => `占资产 ${value}`, cash: "现金及短期投资", equity: "股东权益",
  paidIn: (paid: string, deficit: string) => `实收资本 ${paid} · 累计亏损 ${deficit}`,
  operatingCash: (period: string) => `经营现金流 · ${period}`, capexCoverage: (value: string) => `资本开支覆盖 ${value}`, capex: "资本开支",
  free: (value: string) => `自由现金流 ${value}`, financing: "筹资活动净现金流", netBorrowing: (value: string) => `净借款 ${value}`,
  sharesIssued: (value: string) => `股权融资 ${value}`, cashChange: "现金变动", endingCash: (value: string) => `期末现金及短期投资 ${value}`,
  yearToDate: (months: number) => `年初至今（${months} 个月）`,
  balanceChart: (ticker: string, date: string) => `${ticker} 截至 ${date} 的资金来源与资产`, cashChart: (ticker: string, period: string) => `${ticker} 现金来源与去向，${period}`,
  derived: (to: number, from: number) => `推算 · 年初至今 ${to} 个月 − ${from} 个月`,
  profile: (name: string) => `${name} 业务概况`, noDescription: "无描述", customers: "客户", revenueModel: "收入模式", notDisclosed: "未披露",
  details: (label: string) => `${label} 业务详情`, products: "产品",
});

const ReportDialog = lazy(() => import("./ReportDialog"));

type Item = { key: string; id: string; parent: string | null; depth: number; name: string; value: number | null; slot: number; segment: BusinessSegment };

/** Validated categorical slots (light and dark); a fifth top-level business folds into neutral rather than a generated hue. */
const HUES = 4;
const hue = (slot: number) => `var(--biz-${slot >= 1 && slot <= HUES ? slot : 0})`;
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const percent = (v: number | null) => v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(1)}%`;
const none = (): FlowChange => ({ label: flowWords.na, comparable: false, trend: null, delta: null, previous: null, percent: null });
/** Chart labels keep about thirteen ems of name; the tooltip carries the full one. */
const shortName = (name: string) => truncateToWidth(name, 13);
const shortPeriod = (end: string) => end.slice(0, 7).replace("-", ".");
type View = "profit" | "cash" | "balance";
/** Every change on the stage is against one base: the same quarter a year earlier (YoY) or the quarter before (QoQ). */
type Basis = "yoy" | "qoq";
const basisWords = (basis: Basis): CompareBasis & { period: string } => basis === "yoy"
  ? { change: yoyLabel(getLocale()), prior: m.lastYear, period: m.yearAgo } : { change: qoqLabel(getLocale()), prior: m.lastQuarter, period: m.lastQuarterPeriod };
/** The quarter as a label names it: the flow's own label in English, the quarter's end elsewhere. */
const periodName = (q: BusinessFlowQuarter) => getLocale() === "en" ? q.label : shortPeriod(q.periodEnd);

/** A loss quarter is drawn as funding (revenue plus the net loss pay every cost); any other quarter as the statement bridge. */
function statementGraph(q: BusinessFlowQuarter): FinancialGraph {
  return (numeric(q.figures.net) ?? 0) < 0 ? deficitFinancialGraph(q) ?? financialGraph(q) : financialGraph(q);
}

/** The share of all costs and expenses that revenue paid for in a loss quarter; the net loss paid the rest. */
function revenueCoverage(graph: FinancialGraph, revenue: number) {
  const uses = graph.nodes.filter(n => !graph.links.some(l => l.source === n.name)).reduce((sum, n) => sum + n.value, 0);
  return uses ? revenue / uses : null;
}

/** Hue follows the business, not its rank: slots are assigned once, newest quarter first, and kept when the period changes. */
function hueSlots(quarters: BusinessFlowQuarter[]) {
  const slots = new Map<string, number>();
  for (const quarter of quarters) {
    const tree = availableRevenueTrees(quarter)[0];
    const roots = tree ? tree.nodes.filter(n => n.parentId === null).map(n => revenueNodeKey(tree, n.id)) : quarter.segments.map(s => s.id);
    for (const key of roots) if (!slots.has(key)) slots.set(key, slots.size + 1);
  }
  return slots;
}

/** A change against the comparison quarter as a coloured arrow and figure; nothing when the quarters are not comparable. */
function Delta({ change, word }: { change: FlowChange; word: string }) {
  if (!change.comparable) return null;
  const tone = change.trend ?? undefined;
  return <em data-trend={tone} title={word}>{tone === "up" ? "▲" : tone === "down" ? "▼" : ""}{change.label.replace(/^[+\-−]/, "")}</em>;
}

function businessItems(quarter: BusinessFlowQuarter | undefined, slots: Map<string, number>) {
  const tree = quarter ? availableRevenueTrees(quarter)[0] : undefined;
  if (!tree) {
    const segments = quarter?.segments ?? [];
    return { quantified: false, items: segments.map((segment, i): Item => ({ key: segment.id, id: segment.id, parent: null, depth: 0, name: segment.name, value: null, slot: slots.get(segment.id) ?? i + 1, segment })) };
  }
  const items: Item[] = [];
  const visit = (id: string | null, depth: number, slot: number) => tree.nodes.filter(n => n.parentId === id).forEach(node => {
    const key = revenueNodeKey(tree, node.id), own = depth === 0 ? slots.get(key) ?? 0 : slot;
    items.push({ key, id: node.id, parent: node.parentId === null ? null : revenueNodeKey(tree, node.parentId), depth, name: node.name, value: numeric(node.revenue), slot: own, segment: node });
    visit(node.id, depth + 1, own);
  });
  visit(null, 0, 0);
  return { quantified: true, items };
}

function useTween(target: number | null, ms = 650) {
  const [value, setValue] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    if (target == null || from.current == null || reducedMotion()) { from.current = target; setValue(target); return; }
    const start = performance.now(), origin = from.current;
    let frame = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / ms), eased = 1 - Math.pow(1 - p, 4);
      from.current = origin + (target - origin) * eased;
      setValue(from.current);
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);
  return value;
}

function Stat({ label, value, format, note, tone }: { label: string; value: number | null; format: (v: number | null) => string; note?: string; tone?: "up" | "down" }) {
  const shown = useTween(value);
  return <div className="stat">
    <span className="stat-label">{label}</span>
    <strong className="stat-value">{format(shown)}</strong>
    {note && <span className="stat-note" data-trend={tone}>{note}</span>}
  </div>;
}

/** A highlight's figure in its own unit: an amount, a rate, a margin or a multiple, per share. */
function highlightValue(v: number | null, r: ResolvedValue, ref: ResolvedEvidence["evidence"]["ref"]): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (r.unit === "USD") return compactFlowValue(v, { currency: r.currency ?? "USD", scale: 1 } as BusinessFlowQuarter);
  if (r.unit === "percent") return percent(v);
  const locale = getLocale();
  if (r.unit === "per_share") return locale === "en" && (r.currency ?? "USD") === "USD" ? `$${v.toFixed(2)}` : perShare(v, r.currency ?? "USD", locale);
  if (r.unit === "shares") return locale === "en" ? `${(v / 1e6).toFixed(0)}M` : compactShares(v, locale);
  return ratioForm(ref) === "percent" ? percent(v * 100) : multiple(v.toFixed(2), locale);
}

/**
 * The headline figures a model picked for this report and view, each resolved from the data. The large number is the
 * figure, or its change when the rate is the news; the note carries the other, and the label is left out of the note
 * when the title already names it.
 */
function HighlightStats({ tiles }: { tiles: VerifiedHighlight[] }) {
  return <div className="stats" aria-live="polite">{tiles.map(tile => {
    const r = tile.resolved, change = highlightChange(r, getLocale()), basis = r.evidence.compare === "qoq" ? qoqLabel(getLocale()) : yoyLabel(getLocale());
    const level = (v: ResolvedValue | null) => v ? highlightValue(v.value, v, tile.ref) : "";
    const tone = change && r.delta && higherIsBetter(tile.ref) ? r.delta > 0 ? "up" : "down" : undefined;
    if (tile.show === "change" && r.delta != null) {
      const note = `${level(r.current)}${r.compare ? ` · ${r.compareLabel} ${level(r.compare)}` : ""}`;
      return <Stat key={JSON.stringify(tile.ref)} label={`${tile.title} · ${basis}`} value={r.delta} format={v => v == null ? "—" : formatChange(v, r, getLocale())} note={note} tone={tone} />;
    }
    const named = tile.title.toLowerCase() === r.label.toLowerCase() ? "" : `${r.label} · `;
    const note = change ? `${named}${basis} ${change}` : r.compare ? `${named}${r.compareLabel} ${level(r.compare)}` : named.slice(0, -3) || undefined;
    return <Stat key={JSON.stringify(tile.ref)} label={tile.title} value={r.current.value} format={v => highlightValue(v, r.current, tile.ref)} note={note} tone={tone} />;
  })}</div>;
}

function Sources({ sources, ids }: { sources: FlowSource[]; ids?: string[] }) {
  const list = sources.filter(s => (!ids || ids.includes(s.id)) && /^https?:\/\//.test(s.url));
  if (!list.length) return null;
  return <ul className="sources">{list.map(s => <li key={s.id}><a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}<span aria-hidden="true"> ↗</span></a></li>)}</ul>;
}

export function BusinessMap({ ticker, tools, flow, notice, revenueHistory, explainer = null, tree = null, guidance = null, capital = null, findings = null, peers = null, passages = null, fundamentals = null, events = null, filings = null }: { ticker: string; tools: ReactNode; flow: PublicBusinessFlow; notice: string | null; revenueHistory: RevenueHistory | null; explainer?: BusinessExplainer | null; tree?: BusinessTree | null; guidance?: GuidancePublication | null; capital?: PublicCapitalStructure | null; findings?: FindingsPublication | null; peers?: PeersPublication | null; passages?: FindingPassage[] | null; fundamentals?: FindingFundamentals | null; events?: EventsPublication | null; filings?: PublicFilingDigestPage | null }) {
  const quarters = useMemo(() => [...flow.quarters].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd)), [flow]);
  const [period, setPeriod] = useState<string | null>(null);
  const quarter = quarters.find(q => q.id === period) ?? quarters[0];
  // YoY by default; QoQ when the year-ago quarter was not collected but the one before was.
  const [chosenBasis, setBasis] = useState<Basis | null>(null);
  const yearAgo = quarter ? yearAgoQuarter(quarter, quarters) : null, lastQuarter = quarter ? previousQuarter(quarter, quarters) : null;
  const basis: Basis = chosenBasis ?? (yearAgo || !lastQuarter ? "yoy" : "qoq");
  const previous = basis === "yoy" ? yearAgo : lastQuarter;
  const word = useMemo(() => basisWords(basis), [basis]);
  const slots = useMemo(() => hueSlots(quarters), [quarters]);
  const { items, quantified } = useMemo(() => businessItems(quarter, slots), [quarter, slots]);
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(location.search).get("business"));
  // Findings are verified against the same data the stage draws; a finding in focus reshapes the stage around its figures.
  const data = useMemo(() => findingData(flow, revenueHistory, capital, fundamentals, guidance, peers, passages, events), [flow, revenueHistory, capital, fundamentals, guidance, peers, passages, events]);
  const verified = useMemo(() => verifiedFindings(findings, data), [findings, data]);
  // Scored watches: pass or fail once the watched period reported, from the same data the stage draws.
  const verdicts = useMemo(() => Object.fromEntries(verified.flatMap(f => { const v = f.watch?.test ? watchVerdict(data, f.watch, f.periodEnd) : null; return v ? [[f.id, v.verdict]] : []; })) as Record<string, "pass" | "fail">, [verified, data]);
  const [focusId, setFocusId] = useState<string | null>(() => new URLSearchParams(location.search).get("finding"));
  const [story, setStory] = useState(false);
  const [split, setSplit] = useState(false);
  const focused = verified.find(f => f.id === focusId) ?? null;
  // Reports and filed events share the rail with the findings; one row is in focus at a time, and the time axis lists them all.
  const [eventId, setEventId] = useState<string | null>(() => new URLSearchParams(location.search).get("event"));
  const [reportId, setReportId] = useState<string | null>(() => new URLSearchParams(location.search).get("report"));
  const [reader, setReader] = useState(false);
  const [now] = useState(() => new Date());
  const rail = useMemo(() => railItems(filings, events, now), [filings, events, now]);
  const railList = useMemo(() => rail ? [...rail.recent, ...rail.earlier] : [], [rail]);
  const focusedEvent = focusId || reportId ? null : events?.events.find(e => e.id === eventId) ?? null;
  const focusedReport = focusId ? null : filings?.filings.find(f => f.accessionNumber === reportId) ?? null;
  const railIndex = railList.findIndex(i => i.id === (focusedReport?.accessionNumber ?? focusedEvent?.id));
  // Reports come from the filings when they have loaded; until then the flow quarters stand in for them on the axis.
  const points = useMemo(() => filings ? timelineFromFilings(filings, events, 24, now, quarters) : timelinePoints(quarters, events, 24, now), [filings, quarters, events, now]);
  // The trend below the flow shows revenue by business, or one company-level SEC series picked from the fundamentals.
  const metricGroups = useMemo(() => metricOptions(fundamentals), [fundamentals]);
  const hasRevenueTrend = !!revenueHistory && revenueHistory.quarters.length >= 2;
  const [metricKey, setMetricKey] = useState<string>(() => new URLSearchParams(location.search).get("metric") ?? REVENUE_METRIC);
  const metricSeries = metricKey === REVENUE_METRIC ? null : fundamentals?.series.find(s => s.metricKey === metricKey && metricGroups.some(g => g.options.some(o => o.key === s.metricKey)));
  const metric = useMemo(() => metricSeries ? metricTrend(metricSeries) : null, [metricSeries]);
  const firstMetric = metricGroups[0]?.options[0]?.key;
  const fallbackMetric = !metric && !hasRevenueTrend && firstMetric ? metricTrend(fundamentals!.series.find(s => s.metricKey === firstMetric)!) : null;
  const shownMetric = metric ?? fallbackMetric;
  const pair = focused ? verified.find(f => f.id === focused.pairWith) ?? null : null;
  const focusIndex = focused ? verified.indexOf(focused) : -1;
  const [preview, setPreview] = useState<string | null>(null);
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const current = items.find(item => item.id === selected) ?? null;
  const revenue = quarter ? numeric(quarter.figures.revenue) : null;
  const segmentRevenue = quarter?.revenueAdjustments?.length ? quarter.segments.reduce((sum,s)=>sum+(numeric(s.revenue)??0),0) : revenue;
  const shareLabel = quarter?.revenueAdjustments?.length ? m.shareBeforeEliminations : m.share;
  // The comparison quarter's share needs its total on the same basis and comparable with this quarter's.
  const priorShareBase = quarter && previous && compareAmount(quarter, previous, "revenue").percent != null
    ? quarter.revenueAdjustments?.length ? previous.segments.reduce((sum, s) => sum + (numeric(s.revenue) ?? 0), 0) || null : numeric(previous.figures.revenue) : null;
  const money = useCallback((v: number | null) => quarter ? compactFlowValue(v, quarter) : "—", [quarter]);

  useEffect(() => {
    const url = new URL(location.href);
    if (current) url.searchParams.set("business", current.id); else url.searchParams.delete("business");
    if (focused) url.searchParams.set("finding", focused.id); else url.searchParams.delete("finding");
    if (focusedEvent) url.searchParams.set("event", focusedEvent.id); else url.searchParams.delete("event");
    if (focusedReport) url.searchParams.set("report", focusedReport.accessionNumber); else url.searchParams.delete("report");
    if (metric) url.searchParams.set("metric", metric.key); else url.searchParams.delete("metric");
    if (url.href !== location.href) history.replaceState(history.state, "", url);
  }, [current, focused, focusedEvent, focusedReport, metric]);
  // A business picked in the chart is brought into view in the list, scrolling only the list (a column or, on narrow screens, a chip row).
  useEffect(() => {
    const option = listRef.current?.querySelector<HTMLElement>('[role=option][aria-selected="true"]');
    if (option) revealInList(option, behavior());
  }, [current?.key]);
  useEffect(() => {
    const escape = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape" && !(e.target as HTMLElement).closest("input,select,dialog")) { setSelected(null); setFocusId(null); setEventId(null); setReportId(null); setStory(false); } };
    addEventListener("keydown", escape);
    return () => removeEventListener("keydown", escape);
  }, []);
  // Walking the findings: arrow keys step through them in order while the walk-through is on.
  useEffect(() => {
    if (!story) return;
    const step = (e: globalThis.KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input,select,textarea") || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      e.preventDefault();
      setFocusId(id => { const i = Math.max(0, verified.findIndex(f => f.id === id)); return verified[Math.max(0, Math.min(verified.length - 1, i + (e.key === "ArrowRight" ? 1 : -1)))]?.id ?? id; });
    };
    addEventListener("keydown", step);
    return () => removeEventListener("keydown", step);
  }, [story, verified]);

  const graph = useMemo(() => quarter ? statementGraph(quarter) : null, [quarter]);
  const previousGraph = useMemo(() => previous ? statementGraph(previous) : null, [previous]);
  const funding = capital?.quarters.find(q => q.periodEnd === quarter?.periodEnd) ?? null;
  const [chosenView, setView] = useState<View>("profit");
  const cash = funding?.cashFlow ?? funding?.yearToDate ?? null;
  const view: View = chosenView === "cash" && cash ? "cash" : chosenView === "balance" && funding?.balanceSheet ? "balance" : "profit";
  // The company's headline figures for the report and view, as the findings run picked them; too few verified keeps the fixed tiles.
  const highlights = useMemo(() => quarter ? highlightsFor(findings, data, quarter.periodEnd, view, getLocale()) : null, [findings, data, quarter, view]);
  // A finding in focus brings the stage to its report and statement view, and clears any business pick so the whole statement reads.
  useEffect(() => {
    if (!focused) return;
    setSelected(null);
    setPeriod(quarters.find(q => q.periodEnd === focused.periodEnd)?.id ?? null);
    setView(focused.anchors.view);
  }, [focused?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const amountOf = useCallback((n: PlacedNode) => n.amount ? numeric(n.amount) : n.metric && quarter ? numeric(quarter.figures[n.metric]) : n.value, [quarter]);
  /** Same comparison as the list and tooltip: only an equal-definition comparison quarter yields a change. */
  const comparisonOf = useCallback((n: PlacedNode) => !quarter ? null
    : n.amount ? compareFlowAmounts(quarter, previous, n.name, n.amount, previousGraph?.nodes.find(p => p.name === n.name)?.amount)
    : n.metric ? compareAmount(quarter, previous, n.metric)
    : n.segmentId ? compareRevenueNode(quarter, previous, n.segmentId) : null, [quarter, previous, previousGraph]);
  const changeOf = useCallback((n: PlacedNode) => comparisonOf(n) ?? none(), [comparisonOf]);
  /** The comparison amount behind a percentage change: only a same-sign, same-definition comparison quarter is drawn as a tick. */
  const priorOf = useCallback((n: PlacedNode) => { const c = comparisonOf(n); return c && c.percent != null && c.previous != null ? Math.abs(c.previous) : null; }, [comparisonOf]);
  const copy = useCallback((n: PlacedNode): NodeCopy => {
    const change = changeOf(n);
    return { name: shortName(n.label), value: money(amountOf(n)), ...(change.comparable ? { change: { label: change.label, trend: change.trend ?? undefined } } : {}) };
  }, [money, amountOf, changeOf]);
  const layout = useMemo(() => graph ? layoutFor(graph, copy) : null, [graph, copy]);
  const proportional = Boolean(quarter && layout && quarter.incomeModel !== "financial" && quarter.incomeModel !== "insurance");
  const coverage = graph?.deficit && revenue ? revenueCoverage(graph, revenue) : null;

  const itemByNode = useMemo(() => new Map(items.map(item => ["segment:" + item.key, item])), [items]);
  const toneOf = useMemo(() => new Map(layout?.nodes.map(n => [n.name, n.tone]) ?? []), [layout]);
  const colorOf = useCallback((name: string) => {
    const item = itemByNode.get(name);
    if (item) return hue(item.slot);
    if (name === "revenue") return "var(--flow-revenue)";
    if (toneOf.get(name) === "loss") return "var(--loss)";
    return toneOf.get(name) === "expense" ? "var(--flow-expense)" : "var(--flow-profit)";
  }, [itemByNode, toneOf]);

  const tipFor = useCallback((n: PlacedNode): Tip => {
    if (!quarter) return { title: n.label, color: colorOf(n.name), rows: [] };
    const rows: Array<[string, string]> = [[m.thisQuarter, money(amountOf(n))]];
    if (revenue && n.name !== "revenue") rows.push([(n.tone === "profit" || n.tone === "loss") && !n.segmentId ? m.marginLabel : m.share, percent((amountOf(n) ?? n.value) / revenue * 100)]);
    if (n.offset && graph) {
      rows.push([m.offset, money(graph.links.filter(l => l.target === n.name).reduce((sum, l) => sum + l.value, 0))]);
      rows.push([m.remaining, money(graph.links.filter(l => l.source === n.name).reduce((sum, l) => sum + l.value, 0))]);
    }
    if(n.segmentId&&quarter.revenueAdjustments?.length)rows.splice(1,1,[m.shareBeforeEliminations,percent((amountOf(n)??0)/segmentRevenue!*100)]);
    const prior = priorOf(n);
    if (prior != null && previous) rows.push([`${word.period} ${shortPeriod(previous.periodEnd)}`, money(prior)]);
    rows.push([word.change, changeOf(n).label], [m.asReported(quarter.currency), formatFlowValue(amountOf(n),quarter)]);
    return { title: n.label, color: colorOf(n.name), rows };
  }, [quarter, previous, word, revenue, money, amountOf, colorOf, changeOf, priorOf, graph, segmentRevenue]);

  // Guidance on the bars: this quarter's guided range as a bracket with its verdict, next quarter's as a pill, both at the chart's units.
  const guideMarks = useMemo((): { brackets: GuideBracketMark[]; pills: GuidePillMark[] } => {
    if (!quarter || !graph || !guidance) return { brackets: [], pills: [] };
    const dollars = (v: number | null) => v == null ? "—" : compactFlowValue(v / quarter.scale, quarter);
    const amountOfNode = (name: string) => { const n = graph.nodes.find(n => n.name === name); return n ? (n.amount ? numeric(n.amount) : n.metric ? numeric(quarter.figures[n.metric]) : n.value) : null; };
    const marks = guidanceMarks(quarter, graph.nodes.map(n => n.name), guidance, { amountOf: amountOfNode, businessIdOf: name => itemByNode.get(name)?.id ?? null, money: v => dollars(v) });
    const VERDICT = { above: m.above, within: m.within, below: m.below };
    return {
      brackets: marks.brackets.map(b => ({ node: b.node, low: b.low / quarter.scale, high: b.high / quarter.scale, derived: b.derived, verdict: b.verdict, url: b.source?.url ?? null,
        tip: { title: m.thisGuidance(markSentence(b.item, dollars)), color: colorOf(b.node), note: b.item.quote,
          rows: [[b.derived ? m.derivedGuidance : m.guidanceRange, `${dollars(b.low)}–${dollars(b.high)}`], [m.thisQuarter, money(amountOfNode(b.node))], [m.result, VERDICT[b.verdict]], [m.issued, b.item.issuedAt.slice(0, 10)]],
          link: b.source ? m.source(b.source.title) : undefined } })),
      pills: marks.pills.map(p => ({ node: p.node, text: p.text, action: p.action ?? null, glyph: p.action ? ACTION_GLYPH[p.action] : "", url: p.source?.url ?? null,
        tip: { title: m.nextGuidance(markSentence(p.item, dollars)), color: colorOf(p.node), note: p.item.quote,
          rows: [...(p.action && p.action !== "initiated" ? [[m.vsPrevious, actionName(p.action) + (p.item.previous && p.item.previous.low != null ? m.previously(p.item.measure === "growth" || p.item.unit === "percent" ? `${p.item.previous.low}%–${p.item.previous.high}%` : `${dollars(p.item.previous.low)}–${dollars(p.item.previous.high)}`) : "")] as [string, string]] : []), [m.issued, p.item.issuedAt.slice(0, 10)]],
          link: p.source ? m.source(p.source.title) : undefined } })),
    };
  }, [quarter, graph, guidance, itemByNode, colorOf, money]);
  const spotlight = useMemo(() => focused && view === "profit" ? anchorNodeNames(focused, quarter, items) : null, [focused, view, quarter, items]);
  const poolSpotlight = useMemo(() => focused && view !== "profit" ? anchorPoolKeys(focused) : null, [focused, view]);
  const nodeColor = useCallback((id: string) => { const item = items.find(i => i.id === id); return item ? hue(item.slot) : "var(--biz-0)"; }, [items]);
  const focusFinding = (id: string | null) => { setFocusId(id); if (id) { setEventId(null); setReportId(null); } else { setStory(false); setSplit(false); } };
  const focusEvent = (id: string | null) => { setEventId(id); if (id) { setSelected(null); setFocusId(null); setReportId(null); setStory(false); setSplit(false); } };
  // The rail holds one pick at a time: a business, a finding, or a report/event.
  const pickBusiness = (id: string | null) => { setSelected(id); if (id) { setFocusId(null); setEventId(null); setReportId(null); setStory(false); setSplit(false); } };
  // A report in focus also brings the stage to its quarter when the flow has it.
  const focusReport = (id: string | null) => {
    setReportId(id); setReader(false);
    if (!id) return;
    setSelected(null); setFocusId(null); setEventId(null); setStory(false); setSplit(false);
    const end = filings?.filings.find(f => f.accessionNumber === id)?.periodEnd;
    const match = end ? quarters.find(q => q.periodEnd === end) : null;
    if (match) setPeriod(match.id);
  };
  const focusItem = (item: RailItem | null) => { if (!item) { setEventId(null); setReportId(null); } else if (item.kind === "report") focusReport(item.id); else focusEvent(item.id); };
  // The business list is a drawer: closed, only All businesses and the business picked (with its parent) show.
  const [businessOpen, setBusinessOpen] = useState(false);
  const businessDigest = new Set([current?.key, current?.parent].filter(Boolean));
  const businessExpandable = items.some(i => !businessDigest.has(i.key));
  const toggleBusiness = (open: boolean) => railTransition(() => setBusinessOpen(open));
  // A business picked on the chart unfolds the whole list, so it reads in place among its siblings.
  const pickOnChart = (id: string | null) => { pickBusiness(id); if (id) setBusinessOpen(true); };
  // One section can open over the whole rail; the rest of the rail returns when it closes.
  const [section, setSection] = useState<RailSectionKey | null>(null);
  // The findings stay in the rail whatever business is picked; focusing one brings the stage back to the whole company.
  const showFindings = !!findings && verified.length > 0;
  const openSection = section === "findings" && !showFindings || section === "events" && !rail ? null : section;
  const sectionFocus = (key: RailSectionKey) => ({ expanded: openSection === key, onExpand: expandSection(key) });
  const expandSection = (key: RailSectionKey) => (open: boolean) => railTransition(() => {
    setSection(open ? key : null);
    document.getElementById("rail-body")?.scrollTo({ top: 0 });
  });
  const previewItem = items.find(item => item.key === preview);
  const active = previewItem ? "segment:" + previewItem.key : hoverNode ?? (current ? "segment:" + current.key : null);
  const hovered = hoverNode ? itemByNode.get(hoverNode)?.key : undefined;

  // Arrow keys move through the rows on screen (the digest while the section is closed) and pick each in turn.
  function onListKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const options = [...(listRef.current?.querySelectorAll<HTMLElement>("[role=option]") ?? [])].filter(o => o.getClientRects().length > 0);
    const index = Math.max(0, options.indexOf(e.target as HTMLElement));
    const next = options[e.key === "Home" ? 0 : e.key === "End" ? options.length - 1 : Math.max(0, Math.min(options.length - 1, index + (e.key === "ArrowDown" ? 1 : -1)))];
    if (!next || next === e.target) return;
    pickBusiness(next.dataset.id ?? null);
    next.focus();
  }

  // A picked business is broken down from the businesses the chart draws at its left edge: itself, or the disclosed businesses it is made of.
  const mindMap = useMemo((): MindMapInput | null => {
    if (!tree || !current) return null;
    const leaves = (item: Item): Item[] => { const children = items.filter(i => i.parent === item.key); return children.length ? children.flatMap(leaves) : [item]; };
    const branches = leaves(current).flatMap(item => {
      const node = treeNodeFor(tree, item.id);
      return node && (node.children.length || node.revenue.length) ? [{ node: "segment:" + item.key, label: item.name, summary: node.summary, revenue: node.revenue, nodes: node.children }] : [];
    });
    return branches.length ? { branches, sources: tree.sources } : null;
  }, [tree, current, items]);
  // A node picked in the breakdown opens below the chart; it belongs to the business picked, and closes with it.
  const [mindPicked, setMindPicked] = useState<{ business: string; item: MindItem } | null>(null);
  const mindItem = mindMap && mindPicked && mindPicked.business === current?.key ? mindPicked.item : null;
  const setMindItem = (item: MindItem | null) => setMindPicked(item && current ? { business: current.key, item } : null);

  const figure = (key: FlowMetric) => quarter ? numeric(quarter.figures[key]) : null;
  const margin = (key: FlowMetric) => { const v = figure(key); return m.margin(v != null && revenue ? percent(v / revenue * 100) : "—"); };
  const change = (key: FlowMetric) => quarter ? compareAmount(quarter, previous, key) : none();
  const itemChange = current && quarter ? compareRevenueNode(quarter, previous, current.key) : none();
  const parent = current?.parent ? items.find(item => item.key === current.parent) : null;
  const topLevel = items.filter(i => !i.parent).length;

  return <div className="map">
    <Rail ticker={ticker} actions={tools} label={m.companyBusinesses} expanded={openSection != null}>
      <RailSection name="business" title={m.businesses} expandable={businessExpandable} focused={current != null} drawer expanded={businessOpen} onExpand={toggleBusiness}>
        <div className="rail-list section-body" id="rail-business" role="listbox" aria-label={m.businesses} ref={listRef} onKeyDown={onListKey} onMouseLeave={() => setPreview(null)}>
          {/* All businesses heads the drawer: it shows the whole company, and with nothing else picked a click unfolds or folds the list. */}
          <Button variant="unstyled" type="button" role="option" aria-selected={!current} tabIndex={!current ? 0 : -1} className="row row--all" onMouseEnter={() => setPreview(null)}
            onClick={() => { if (current) pickBusiness(null); else if (businessExpandable) toggleBusiness(!businessOpen); }}
            title={quantified ? m.topLevelCount(topLevel) : m.totalRevenue}>
            <i className="row-chip row-chip--all" aria-hidden="true" />
            <span className="row-name">{m.allBusinesses}</span>
            <span className="row-value">{revenue != null ? money(revenue) : ""}</span>
            {quarter && <span className="row-meta"><Delta change={change("revenue")} word={word.change} /></span>}
          </Button>
          {items.map(item => {
            const share = item.value != null && segmentRevenue ? item.value / segmentRevenue * 100 : null;
            const delta = quarter && quantified ? compareRevenueNode(quarter, previous, item.key) : none();
            return <Button variant="unstyled" type="button" role="option" key={item.key} data-id={item.id} aria-selected={current?.key === item.key} tabIndex={current?.key === item.key ? 0 : -1}
              className="row" data-depth={item.depth} data-hover={hovered === item.key || undefined} data-extra={businessDigest.has(item.key) ? undefined : ""} style={{ "--c": hue(item.slot) } as CSSProperties}
              onClick={() => pickBusiness(current?.key === item.key ? null : item.id)} onMouseEnter={() => setPreview(item.key)}
              title={share != null ? `${shareLabel} ${percent(share)}` : undefined}>
              <i className="row-chip" aria-hidden="true" />
              <span className="row-name">{item.name}</span>
              <span className="row-value">{item.value != null ? money(item.value) : ""}</span>
              {share != null && <span className="row-bar" aria-hidden="true"><b style={{ width: `${Math.max(0.6, share)}%` }} /></span>}
              <span className="row-meta">{share != null ? <>{percent(share)}<Delta change={delta} word={word.change} /></> : "—"}</span>
            </Button>;
          })}
        </div>
      </RailSection>
      {showFindings && <FindingsList findings={verified} verdicts={verdicts} focus={focused?.id ?? null} story={story} periodEnd={findings.periodEnd} {...sectionFocus("findings")} onFocus={focusFinding} onStory={() => { if (story) { setStory(false); setFocusId(null); } else { setStory(true); setEventId(null); setFocusId(focused?.id ?? verified[0].id); } }} />}
      {rail && <EventsList rail={rail} focus={focusedReport?.accessionNumber ?? focusedEvent?.id ?? null} pendingInsider={events?.pendingInsider ?? 0} {...sectionFocus("events")} onFocus={focusItem} />}
      {!!quarter?.revenueAdjustments?.length&&<p className="revenue-reconciliation">{m.reconciliation(quarter.currency)}<br/>{m.segmentTotal} {formatFlowValue(segmentRevenue,quarter)}<br/>{quarter.revenueAdjustments.map(a=><span key={a.id}>{a.name} {formatFlowValue(numeric(a.amount),quarter)}<br/></span>)}{m.consolidated} {formatFlowValue(revenue,quarter)}</p>}
    </Rail>

    <section className="stage" data-focus={focused && findings ? "finding" : undefined} data-trend={hasRevenueTrend || metricGroups.length ? "" : undefined} data-finding={focused?.kind} data-timeline={points.length ? "" : undefined} aria-label={focused ? m.findingStage(ticker, focused.title) : m.flowStage(ticker)}>
      {focused && findings ? <div className="lens-stage" data-split={split && pair ? "" : undefined}>
        <LensPanel finding={focused} data={data} sources={findings.sources} materials={findings.materials} record={findings.record} ticker={ticker} nodeColor={nodeColor} pair={pair} split={split && !!pair}
          story={story} index={focusIndex} count={verified.length} onPair={() => setSplit(v => !v)}
          onStep={delta => { const next = verified[focusIndex + delta]; if (next) focusFinding(next.id); }} onClose={() => focusFinding(null)} />
        {split && pair && <LensPanel finding={pair} data={data} sources={findings.sources} materials={findings.materials} record={findings.record} ticker={ticker} nodeColor={nodeColor} pair={null} compact
          story={false} index={-1} count={verified.length} onPair={() => {}} onStep={() => {}} onClose={() => setSplit(false)} onFocusThis={() => setFocusId(pair.id)} />}
      </div> : <>
      <header className="stage-head stage-head--summary">
        {quarter && view !== "profit" && funding ? <CapitalStats view={view} funding={funding} tiles={highlights} />
          : quarter && !current && highlights ? <HighlightStats tiles={highlights} />
          : quarter && <div className="stats" aria-live="polite">
          {current && current.value != null ? <>
            <Stat label={m.revenueThisQuarter} value={current.value} format={money} note={`${word.change} ${itemChange.label}`} tone={itemChange.trend ?? undefined} />
            <Stat label={shareLabel} value={segmentRevenue ? current.value / segmentRevenue * 100 : null} format={percent} note={parent?.value ? m.ofParent(percent(current.value / parent.value * 100), parent.name) : m.topLevel} />
            <Stat label={m.companyRevenue} value={revenue} format={money} />
          </> : <>
            <Stat label={m.totalRevenue} value={revenue} format={money} note={`${word.change} ${change("revenue").label}`} tone={change("revenue").trend ?? undefined} />
            {quarter.incomeModel !== "direct_operating" && figure("gross") != null && <Stat label={m.gross} value={figure("gross")} format={money} note={margin("gross")} />}
            {figure("operating") != null || figure("pretax") == null
              ? <Stat label={m.operating} value={figure("operating")} format={money} note={margin("operating")} />
              : <Stat label={m.pretax} value={figure("pretax")} format={money} note={margin("pretax")} />}
            <Stat label={graph?.deficit ? m.netLoss : m.net} value={figure("net")} format={money} note={coverage != null ? `${margin("net")} · ${m.coverage(percent(coverage * 100))}` : margin("net")} />
          </>}
        </div>}
        <div className="stage-controls">
        {view === "profit" && yearAgo && lastQuarter && <ToggleGroup type="single" variant="unstyled" rovingFocus={false} value={basis} onValueChange={next => { if (next) setBasis(next as Basis); }} asChild>
          <span className="trend-views stage-views" role="radiogroup" aria-label={m.comparisonBase}>
            <ToggleGroupItem value="yoy" role="radio" aria-checked={basis === "yoy"}>{yoyLabel(getLocale())}</ToggleGroupItem>
            <ToggleGroupItem value="qoq" role="radio" aria-checked={basis === "qoq"}>{qoqLabel(getLocale())}</ToggleGroupItem>
          </span>
        </ToggleGroup>}
        {funding && (cash || funding.balanceSheet) && <ToggleGroup type="single" variant="unstyled" rovingFocus={false} value={view} onValueChange={next => { if (next) setView(next as View); }} asChild>
          <span className="trend-views stage-views" role="radiogroup" aria-label={m.financialView}>
            <ToggleGroupItem value="profit" role="radio" aria-checked={view === "profit"}>{VIEW_LABEL.profit}</ToggleGroupItem>
            {cash && <ToggleGroupItem value="cash" role="radio" aria-checked={view === "cash"}>{VIEW_LABEL.cash}</ToggleGroupItem>}
            {funding.balanceSheet && <ToggleGroupItem value="balance" role="radio" aria-checked={view === "balance"}>{VIEW_LABEL.balance}</ToggleGroupItem>}
          </span>
        </ToggleGroup>}
        </div>
      </header>

      <div className="chart">
        {view !== "profit" && funding ? <CapitalChart view={view} funding={funding} ticker={ticker} spotlight={poolSpotlight} />
          : !quarter ? <div className="empty"><h2>{m.noFinancials}</h2></div>
          : proportional && layout ? <FlowChart graph={graph!} copy={copy} money={v => money(v)} colorOf={colorOf} active={active} revealKey={quarter.id} productBusiness={current ? "segment:" + current.key : null} mindMap={mindMap} mindPick={mindItem?.id ?? null} onMindPick={setMindItem} businessDetails={<Dossier item={current} parent={parent ?? null} sources={quarter.sources} explainer={explainer} />}
              focusSlot={n => { const prior = priorOf(n); return segmentRevenue ? `${shareLabel} ${percent(n.value / segmentRevenue * 100)}${prior != null && priorShareBase ? ` · ${word.period} ${percent(prior / priorShareBase * 100)}` : ""}` : null; }}
              onHover={name => setHoverNode(name)} tipFor={tipFor} spotlight={spotlight} priorOf={priorOf} basis={word} brackets={guideMarks.brackets} pills={guideMarks.pills}
              onPick={n => { const item = itemByNode.get(n.name); pickOnChart(item && current?.key !== item.key ? item.id : null); }}
              label={m.chart(ticker, periodName(quarter), quarter.currency)} />
          : <div className="business-flow chart-fallback">{current && <Dossier item={current} parent={parent ?? null} sources={quarter.sources} explainer={explainer} />}<FinancialSankey quarter={quarter} previous={previous} word={word.change} onSegment={key => pickOnChart(items.find(item => item.key === key)?.id ?? null)} /></div>}
      </div>

      {points.length > 0 && <Timeline points={points} now={now.getTime()} currentPeriod={quarter?.periodEnd ?? null} focus={focusedReport?.accessionNumber ?? focusedEvent?.id ?? null}
        onReport={(id, end) => { if (filings?.filings.some(f => f.accessionNumber === id)) { focusFinding(null); focusReport(id); } else { setPeriod(quarters.find(q => q.periodEnd === end)?.id ?? null); focusFinding(null); setEventId(null); setReportId(null); } }} onEvent={id => focusEvent(id)} />}

      {focusedReport ? <div className="lens-stage"><ReportLens report={focusedReport} ticker={ticker} index={railIndex} count={railList.length}
        onStep={delta => { const next = railList[railIndex + delta]; if (next) focusItem(next); }} onClose={() => focusReport(null)} onOpenReport={() => setReader(true)} />
        {reader && <Suspense fallback={null}><ReportDialog ticker={ticker} accession={focusedReport.snapshot?.accession ?? focusedReport.accessionNumber}
          snapshot={focusedReport.snapshot ? { reportDate: focusedReport.snapshot.reportDate, reportVersion: focusedReport.snapshot.reportVersion } : null} onClose={() => setReader(false)} /></Suspense>}</div>
      : focusedEvent && events ? <div className="lens-stage"><EventLens event={focusedEvent} publication={events} index={railIndex} count={railList.length}
        onStep={delta => { const next = railList[railIndex + delta]; if (next) focusItem(next); }} onClose={() => focusEvent(null)} /></div>
      : mindItem && mindMap ? <div className="lens-stage"><MindLens item={mindItem} branch={mindMap.branches.find(b => b.node === mindItem.anchor)} sources={mindMap.sources} onClose={() => setMindItem(null)} /></div>
      : shownMetric ? <MetricTrendPanel trend={shownMetric} currentPeriod={quarter?.periodEnd ?? null} periods={new Set(quarters.map(q => q.periodEnd))}
        onPickPeriod={end => setPeriod(quarters.find(q => q.periodEnd === end)?.id ?? null)}
        picker={<MetricPicker value={shownMetric.key} groups={metricGroups} revenue={hasRevenueTrend} onChange={setMetricKey} />} />
      : hasRevenueTrend && <TrendPanel history={revenueHistory!} items={items} selected={current} currentPeriod={quarter?.periodEnd ?? null}
        periods={new Set(quarters.map(q => q.periodEnd))} onPickPeriod={end => setPeriod(quarters.find(q => q.periodEnd === end)?.id ?? null)} hue={hue} guidance={guidance}
        picker={<MetricPicker value={REVENUE_METRIC} groups={metricGroups} revenue onChange={setMetricKey} />} />}

      <footer className="stage-foot">
        {view !== "profit" && funding ? <CapitalLegend view={view} funding={funding} /> : proportional ? <div className="legend" aria-label={m.legend}>
          <span><i className="legend-biz" />{m.businessRevenue}</span>
          <span><i style={{ background: "var(--flow-profit)" }} />{m.profit}</span>
          {(graph?.signed || graph?.deficit) && <span><i style={{ background: "var(--loss)" }} />{graph?.deficit ? m.netLoss : m.loss}</span>}
          <span><i style={{ background: "var(--flow-expense)" }} />{m.costs}</span>
        </div> : null}
        <p className="provenance">
          {notice && <span>{notice}</span>}
          {view !== "profit" && funding && <CapitalProvenance view={view} funding={funding} />}
          {flow.fetchedAt && <span>{m.data(flow.fetchedAt.slice(0, 10))}</span>}
        </p>
      </footer>
      </>}
    </section>
  </div>;
}

const behavior = (): ScrollBehavior => reducedMotion() ? "auto" : "smooth";

const capitalMoney = (funding: CapitalQuarter) => {
  const currency = funding.balanceSheet?.currency ?? funding.cashFlow?.currency ?? funding.yearToDate?.currency ?? "USD";
  return (v: number | null) => compactFlowValue(v, { currency, scale: 1 } as BusinessFlowQuarter);
};
const cashOf = (funding: CapitalQuarter) => funding.cashFlow ?? funding.yearToDate!;
const months = (start: string, end: string) => Math.round((Date.parse(end) - Date.parse(start)) / 86400000 / 30.4);
const cashPeriod = (funding: CapitalQuarter) => funding.cashFlow ? m.thisQuarter : m.yearToDate(months(funding.yearToDate!.periodStart, funding.yearToDate!.periodEnd));
const pct = (v: number | null) => v == null || !Number.isFinite(v) ? "—" : `${Math.round(v * 100)}%`;

function CapitalStats({ view, funding, tiles }: { view: View; funding: CapitalQuarter; tiles: VerifiedHighlight[] | null }) {
  if (tiles) return <HighlightStats tiles={tiles} />;
  const money = capitalMoney(funding);
  if (view === "balance") {
    const b = funding.balanceSheet!, b2 = balanceMetrics(b);
    return <div className="stats" aria-live="polite">
      <Stat label={m.totalAssets} value={b2.assets} format={money} note={m.asOf(b.asOf)} />
      <Stat label={m.debt} value={b2.debt} format={money} note={m.leverage(pct(b2.leverage))} />
      {b2.customer > 0 ? <Stat label={m.customer} value={b2.customer} format={money} note={m.ofAssets(pct(b2.customer / b2.assets))} />
        : <Stat label={m.cash} value={b.assets.filter(l => l.group === "cash").reduce((s, l) => s + Number(l.value), 0)} format={money} />}
      <Stat label={m.equity} value={b2.equity} format={money} note={b2.deficit > 0 ? m.paidIn(money(b2.paidIn), money(b2.deficit)) : m.ofAssets(pct(b2.equity / b2.assets))} tone={b2.equity < 0 ? "down" : undefined} />
    </div>;
  }
  const c = cashOf(funding), k = cashMetrics(c), period = cashPeriod(funding);
  const outside = [k.debtNet != null ? m.netBorrowing(money(k.debtNet)) : null, k.equityIssued ? m.sharesIssued(money(k.equityIssued)) : null].filter(Boolean).join(" · ");
  return <div className="stats" aria-live="polite">
    <Stat label={m.operatingCash(period)} value={k.operating} format={money} note={k.selfFunding == null ? undefined : m.capexCoverage(k.selfFunding >= 2 ? multiple(k.selfFunding.toFixed(1), getLocale()) : pct(k.selfFunding))} tone={k.operating < 0 ? "down" : undefined} />
    {k.capex != null && <Stat label={m.capex} value={k.capex} format={money} note={k.free != null ? m.free(money(k.free)) : undefined} />}
    <Stat label={m.financing} value={k.financing} format={money} note={outside || undefined} />
    <Stat label={m.cashChange} value={Number(c.netChange)} format={money} note={funding.balanceSheet ? m.endingCash(money(funding.balanceSheet.assets.filter(l => l.group === "cash").reduce((s, l) => s + Number(l.value), 0))) : undefined} />
  </div>;
}

function poolOf(view: View, funding: CapitalQuarter): Pool {
  return view === "balance" ? balancePool(funding.balanceSheet!) : cashPool(cashOf(funding));
}

function CapitalChart({ view, funding, ticker, spotlight = null }: { view: View; funding: CapitalQuarter; ticker: string; spotlight?: Set<string> | null }) {
  const pool = useMemo(() => poolOf(view, funding), [view, funding]);
  const money = useMemo(() => { const format = capitalMoney(funding); return (v: number) => format(v); }, [funding]);
  return <PoolChart key={view + funding.periodEnd} pool={pool} money={money} spotlight={spotlight}
    label={view === "balance" ? m.balanceChart(ticker, funding.periodEnd) : m.cashChart(ticker, cashPeriod(funding))} />;
}

function CapitalLegend({ view, funding }: { view: View; funding: CapitalQuarter }) {
  const pool = poolOf(view, funding);
  // Tones whose items are too small to see are left out of the legend.
  const tones = [...new Set([...pool.sources, ...pool.uses].filter(item => item.value >= pool.total * 0.01).map(item => item.tone))];
  return <div className="legend" aria-label={m.legend}>
    {tones.map(tone => <span key={tone}><i style={{ background: toneColor(tone) }} />{TONE_LABEL[tone]}</span>)}
  </div>;
}

function CapitalProvenance({ view, funding }: { view: View; funding: CapitalQuarter }) {
  if (view === "balance") return <a href={funding.balanceSheet!.source.url} target="_blank" rel="noopener noreferrer">{funding.balanceSheet!.source.form} {funding.balanceSheet!.source.accession}</a>;
  const c = cashOf(funding);
  return <>
    {c.basis === "derived" && <span title={c.formula}>{m.derived(months(funding.yearToDate!.periodStart, c.periodEnd), months(funding.yearToDate!.periodStart, c.periodStart))}</span>}
    {c.sources.map(s => <a key={s.accession} href={s.url} target="_blank" rel="noopener noreferrer">{s.form} {s.accession}</a>)}
  </>;
}

/** Scrolls each scrollable ancestor just enough to show the element; unlike scrollIntoView it never moves the page. */
function revealInList(element: HTMLElement, mode: ScrollBehavior) {
  for (let box = element.parentElement; box && box !== document.body; box = box.parentElement) {
    const style = getComputedStyle(box), outer = box.getBoundingClientRect(), inner = element.getBoundingClientRect(), pad = 8;
    const top = /auto|scroll/.test(style.overflowY) && box.scrollHeight > box.clientHeight
      ? inner.top < outer.top + pad ? inner.top - outer.top - pad : inner.bottom > outer.bottom - pad ? inner.bottom - outer.bottom + pad : 0 : 0;
    const left = /auto|scroll/.test(style.overflowX) && box.scrollWidth > box.clientWidth
      ? inner.left < outer.left + pad ? inner.left - outer.left - pad : inner.right > outer.right - pad ? inner.right - outer.right + pad : 0 : 0;
    if (top || left) box.scrollBy({ top, left, behavior: mode });
  }
}

function Dossier({ item, parent, sources, explainer }: { item: Item | null; parent: Item | null; sources: FlowSource[]; explainer: BusinessExplainer | null }) {
  if (!item) return null;
  const explained = explainer?.businesses.find(b => b.nodeId === item.id);
  if (explainer && explained) return <ExplainedDossier key={item.key} item={item} parent={parent} explainer={explainer} explained={explained} />;
  const segment = item.segment;
  const [description, basis] = (segment.description ?? "").split("\n");
  const english = (text: string | null | undefined) => text ? <span lang="en">{text}</span> : m.notDisclosed;
  return <section className="dossier" key={item.key} aria-label={m.profile(item.name)}>
    <h3>{parent ? `${parent.name} / ` : ""}{item.name}<SourceLanguage of={[segment.description, segment.customers, segment.monetization]} /></h3>
    {description ? <p lang="en">{description}</p> : <p>{m.noDescription}</p>}

    <DossierTabs label={item.name} sections={[[m.customers, english(segment.customers)], [m.revenueModel, english(segment.monetization)]]} />
    {basis && <p className="fine" lang="en">{basis}</p>}
    <Sources sources={sources} ids={segment.sourceIds} />
  </section>;
}

/** One section of a business at a time; which sections exist depends on the business. Arrow keys move between tabs. */
/** A section's third entry is the language of its own name and content when that is not the page's (model-written sections). */
function DossierTabs({ label, sections }: { label: string; sections: Array<[string, ReactNode] | [string, ReactNode, string]> }) {
  const [chosen, setChosen] = useState(0);
  const tabs = useRef<HTMLDivElement>(null);
  const id = useId();
  if (!sections.length) return null;
  const active = Math.min(chosen, sections.length - 1);
  const choose = (index: number, focus = false) => {
    setChosen(index);
    const list = tabs.current, scroller = list?.closest<HTMLElement>(".fc-business-scroll");
    // Switching from further down the card starts the new section at its top, under the sticky tabs.
    if (list && scroller) {
      const top = list.parentElement!.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - parseFloat(getComputedStyle(scroller).paddingTop);
      if (scroller.scrollTop > top) scroller.scrollTop = top;
    }
    if (focus) list?.querySelectorAll<HTMLButtonElement>("[role=tab]")[index]?.focus();
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const index = event.key === "Home" ? 0 : event.key === "End" ? sections.length - 1 : step ? (active + step + sections.length) % sections.length : -1;
    if (index < 0) return;
    event.preventDefault();
    choose(index, true);
  };
  return <div className="dossier-tabs">
    <div ref={tabs} className="dossier-tablist" role="tablist" aria-label={m.details(label)} onKeyDown={onKey}>
      {sections.map(([name, , lang], i) => <button key={i} type="button" role="tab" lang={lang} id={`${id}-tab-${i}`} aria-selected={i === active} aria-controls={`${id}-panel`} tabIndex={i === active ? 0 : -1} onClick={() => choose(i)}>{name}</button>)}
    </div>
    <div className="dossier-panel" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${active}`} key={active} lang={sections[active][2]}>{sections[active][1]}</div>
  </div>;
}

/** A model-written explanation: every statement carries numbered links to the pages it was written from. */
function ExplainedDossier({ item, parent, explainer, explained }: { item: Item; parent: Item | null; explainer: BusinessExplainer; explained: BusinessExplainer["businesses"][number] }) {
  const claims = [explained.summary, ...(explained.offerings ?? []).flatMap(p => [p.description, p.charging]), ...explained.sections.flatMap(s => s.items.map(i => i.claim))];
  const cited = [...new Set(claims.flatMap(c => c?.sourceIds ?? []))].map(id => explainer.sources.find(s => s.id === id)).filter(s => s != null);
  const cite = (claim: ExplainerClaim) => <span className="cites">{claim.sourceIds.map(id => {
    const index = cited.findIndex(s => s.id === id);
    return index < 0 ? null : <a key={id} href={cited[index].url} target="_blank" rel="noopener noreferrer" title={cited[index].title}>{index + 1}</a>;
  })}</span>;
  return <section className="dossier" aria-label={m.profile(item.name)}>
    <h3>{parent ? `${parent.name} / ` : ""}{item.name}<SourceLanguage of={[explained.summary?.text, ...(explained.offerings ?? []).map(p => p.description.text), ...explained.sections.flatMap(s => [s.title, ...s.items.flatMap(i => [i.label, i.claim.text])])]} /></h3>
    {/* Without a verified summary, the filing's own one-line description still says what the business is. */}
    {explained.summary ? <p className="dossier-lede" lang={langOf(explained.summary.text)}>{explained.summary.text}{cite(explained.summary)}</p>
      : item.segment.description && <p lang="en">{item.segment.description.split("\n")[0]}</p>}

    {/* Products come first when verified; the other tabs are the angles the model chose for this business. */}
    <DossierTabs label={item.name} sections={[
      ...(explained.offerings?.length ? [[m.products, <ul className="dossier-products">{explained.offerings.map(p => <li key={p.id} lang={langOf(p.description.text)}><b>{p.name}</b>{p.description.text}{cite(p.description)}</li>)}</ul>] as [string, ReactNode]] : []),
      ...explained.sections.map((section): [string, ReactNode, string] => [section.title, <DossierSection section={section} cite={cite} />, langOf(section.title)]),
    ]} />

    <ol className="sources sources--numbered">{cited.map(s => <li key={s.id}><a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}<span aria-hidden="true"> ↗</span></a></li>)}</ol>
  </section>;
}

/** Steps read as a numbered chain, a list as named entries, prose as plain statements. */
function DossierSection({ section, cite }: { section: ExplainerSection; cite: (claim: ExplainerClaim) => ReactNode }) {
  if (section.layout === "steps") return <ol className="dossier-steps">{section.items.map((i, n) => <li key={n}>{i.label && <b>{i.label}</b>}{i.claim.text}{cite(i.claim)}</li>)}</ol>;
  if (section.layout === "list") return <ul className="dossier-products">{section.items.map((i, n) => <li key={n}><b>{i.label}</b>{i.claim.text}{cite(i.claim)}</li>)}</ul>;
  return <>{section.items.map((i, n) => <p key={n} className="dossier-prose">{i.label && <b>{i.label}: </b>}{i.claim.text}{cite(i.claim)}</p>)}</>;
}
