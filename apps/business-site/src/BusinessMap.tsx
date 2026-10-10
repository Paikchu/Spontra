import { Button } from "@/packages/web/src/ui/button";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import type { BusinessFlowQuarter, BusinessSegment, FlowMetric, FlowSource, PublicBusinessFlow } from "@/shared/analysis-contract/business-flow";
import type { CompanyBusinessContent } from "@/packages/web/src/model/company-business-content";
import { deficitFinancialGraph, financialGraph, type FinancialGraph } from "@/packages/web/src/model/business-flow-sankey";
import { compactFlowValue, type PlacedNode } from "@/packages/web/src/model/business-flow-layout";
import { availableRevenueTrees, compareRevenueNode, revenueNodeKey } from "@/packages/web/src/model/revenue-tree";
import { formatFlowValue, compareAmount, compareFlowAmounts, disclosedSegmentLabel, numeric, previousQuarter, reconcileQuarter } from "@/packages/web/src/model/business-flow-model";
import { FinancialSankey } from "@/packages/web/src/business-flow/FinancialSankey";
import { FlowChart, layoutFor, type GuideBracketMark, type GuidePillMark, type NodeCopy, type Tip } from "./FlowChart";
import { ACTION_GLYPH, actionName, guidanceMarks, markSentence } from "./guidance-marks";
import type { RevenueHistory } from "@/shared/analysis-contract/revenue-history";
import type { BusinessExplainer, ExplainerClaim, ExplainerSection } from "@/shared/analysis-contract/business-explainer";
import type { GuidancePublication } from "@/shared/analysis-contract/guidance";
import { TrendPanel } from "./TrendPanel";
import { MetricPicker, MetricTrendPanel } from "./MetricTrend";
import { REVENUE_METRIC, metricOptions, metricTrend } from "./metric-model";
import { ToggleGroup, ToggleGroupItem } from "@/packages/web/src/ui/toggle-group";
import type { CapitalQuarter, PublicCapitalStructure } from "@/shared/analysis-contract/capital-structure";
import { balanceMetrics, balancePool, balanceVerdict, cashMetrics, cashPool, fundingVerdict, type Pool } from "./capital-model";
import { PoolChart, TONE_LABEL, toneColor } from "./PoolChart";
import { Rail } from "./Sidebar";
import type { FindingsPublication } from "@/shared/analysis-contract/findings";
import type { FindingData, FindingFundamentals } from "@/shared/analysis-runtime/findings";
import { anchorNodeNames, anchorPoolKeys, findingData, verifiedFindings } from "./findings-model";
import { FindingsList } from "./FindingsList";
import { DossierTabs } from "./DossierTabs";
import { BusinessNarrativeDossier, CompanyDossier, SectionPanel } from "./NarrativeDossier";
import { resolveAnchor, rpoSeriesFromCapital } from "./narrative-model";
import { BusinessFigures, FigureCard } from "./BusinessFigures";
import type { OperatingMetricsPublication } from "@/shared/analysis-contract/operating-metrics";
import type { PlannedFigures } from "@/shared/analysis-contract/business-figures";
import type { NarrativeFigure, PanelPlan, PanelRef } from "@/shared/analysis-contract/business-narrative";
import { STAGE_LABEL, type BusinessNarrative, type CompanyNarrative } from "@/shared/analysis-contract/business-narrative";
import type { FindingRef } from "@/shared/analysis-contract/findings";
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

const ReportDialog = lazy(() => import("./ReportDialog"));

/** `flowKey` is the Sankey node the row lights; a business the statements do not split out (`synthetic`) lights the node its revenue sits inside. */
type Item = { key: string; id: string; parent: string | null; depth: number; name: string; value: number | null; slot: number; segment: BusinessSegment; flowKey: string; synthetic?: boolean };

/** Validated categorical slots (light and dark); a fifth top-level business folds into neutral rather than a generated hue. */
const HUES = 4;
const hue = (slot: number) => `var(--biz-${slot >= 1 && slot <= HUES ? slot : 0})`;
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const percent = (v: number | null) => v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(1)}%`;
const trend = (label: string) => label.startsWith("+") || /转盈|收窄|由负转正|金额增加/.test(label) ? "up" as const
  : label.startsWith("-") || label.startsWith("−") || /转亏|扩大|由正转负|金额减少/.test(label) ? "down" as const : undefined;
const shortName = (name: string) => name.length > 9 ? name.slice(0, 8) + "…" : name;
const shortPeriod = (end: string) => end.slice(0, 7).replace("-", ".");
type View = "profit" | "cash" | "balance" | "figures";

/** A loss quarter is drawn as funding (revenue plus the net loss pay every cost); any other quarter as the statement bridge. */
function statementGraph(q: BusinessFlowQuarter): FinancialGraph {
  return (numeric(q.figures.net) ?? 0) < 0 ? deficitFinancialGraph(q) ?? financialGraph(q) : financialGraph(q);
}

/** Where the net loss had to be covered, by statement stage. */
function deficitVerdict(graph: FinancialGraph, revenue: number, money: (v: number) => string) {
  const into = graph.links.filter(l => l.source === "net"), loss = into.reduce((sum, l) => sum + l.value, 0);
  const uses = graph.nodes.filter(n => !graph.links.some(l => l.source === n.name)).reduce((sum, n) => sum + n.value, 0);
  const stage = (name: string) => /^(?:other)/.test(name) ? "非营业净支出" : name === "tax" ? "所得税" : "经营成本费用";
  const parts = [...into.reduce((map, l) => map.set(stage(l.target), (map.get(stage(l.target)) ?? 0) + l.value), new Map<string, number>())];
  return { coverage: uses ? revenue / uses : null, text: `收入覆盖全部成本费用的 ${percent(revenue / uses * 100)}；净亏损 ${money(loss)} 用于补足${parts.map(([name, v]) => `${name} ${money(v)}`).join("、")}。` };
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

/** A quarter-over-quarter change as a coloured arrow and figure; nothing when the quarters are not comparable. */
function Delta({ label }: { label: string }) {
  if (label === "不可比") return null;
  const tone = trend(label);
  return <em data-trend={tone} title="环比">{tone === "up" ? "▲" : tone === "down" ? "▼" : ""}{label.replace(/^[+\-−]/, "")}</em>;
}

function businessItems(quarter: BusinessFlowQuarter | undefined, business: CompanyBusinessContent | null, slots: Map<string, number>) {
  const tree = quarter ? availableRevenueTrees(quarter)[0] : undefined;
  if (!tree) {
    const segments = quarter?.segments.length ? quarter.segments : business?.groups ?? [];
    return { quantified: false, items: segments.map((segment, i): Item => ({ key: segment.id, id: segment.id, parent: null, depth: 0, name: disclosedSegmentLabel(segment.name), value: null, slot: slots.get(segment.id) ?? i + 1, segment, flowKey: segment.id })) };
  }
  const items: Item[] = [];
  const visit = (id: string | null, depth: number, slot: number) => tree.nodes.filter(n => n.parentId === id).forEach(node => {
    const key = revenueNodeKey(tree, node.id), own = depth === 0 ? slots.get(key) ?? 0 : slot;
    items.push({ key, id: node.id, parent: node.parentId === null ? null : revenueNodeKey(tree, node.parentId), depth, name: disclosedSegmentLabel(node.name), value: numeric(node.revenue), slot: own, segment: node, flowKey: key });
    visit(node.id, depth + 1, own);
  });
  visit(null, 0, 0);
  return { quantified: true, items };
}

/**
 * Businesses the narrative tells but the statements do not split out join the list under the flow
 * node their revenue sits inside, as qualitative rows: no amount, no share, the parent's hue.
 */
function withNarrativeItems(items: Item[], narrative: CompanyNarrative | null): Item[] {
  if (!narrative) return items;
  const out = [...items];
  for (const b of narrative.businesses) {
    if (out.some(item => item.id === b.nodeId)) continue;
    const parent = b.parentNodeId ? out.find(item => item.id === b.parentNodeId) ?? null : null;
    const segment: BusinessSegment = { id: b.nodeId, name: b.name, revenue: null, description: b.verdict, products: [], customers: null, monetization: null, disclosure: "定性归属 · 比例未披露", sourceIds: [] };
    const row: Item = { key: b.nodeId, id: b.nodeId, parent: parent?.key ?? null, depth: parent ? parent.depth + 1 : 0, name: b.name, value: null, slot: parent?.slot ?? 0, segment, flowKey: parent?.flowKey ?? "revenue", synthetic: true };
    // After the parent and its existing children, so the list keeps reading top down.
    let at = parent ? out.indexOf(parent) + 1 : out.length;
    while (parent && at < out.length && out[at].parent === parent.key) at++;
    out.splice(at, 0, row);
  }
  // A single reportable segment is the company total under another name: when the narrative's businesses are all it
  // holds, the row says nothing 全部业务 does not, so they stand in its place and keep lighting its node.
  const real = out.filter(item => !item.synthetic);
  if (real.length === 1 && out.some(item => item.synthetic && item.parent === real[0].key)) {
    return out.filter(item => item !== real[0]).map(item => item.parent === real[0].key ? { ...item, parent: null, depth: 0 } : item);
  }
  return out;
}

/** The fundamentals series a narrative anchor can be charted from; null when it has no series of its own. */
function anchorMetricKey(ref: FindingRef): string | null {
  if ("capital" in ref) return ref.capital === "rpo" ? "remaining_performance_obligation" : null;
  if ("fundamental" in ref) return ref.fundamental;
  if ("metric" in ref) return ref.metric === "revenue" ? REVENUE_METRIC : null;
  return null;
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

function Sources({ sources, ids }: { sources: FlowSource[]; ids?: string[] }) {
  const list = sources.filter(s => (!ids || ids.includes(s.id)) && /^https?:\/\//.test(s.url));
  if (!list.length) return null;
  return <ul className="sources">{list.map(s => <li key={s.id}><a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}<span aria-hidden="true"> ↗</span></a></li>)}</ul>;
}

export function BusinessMap({ ticker, tools, flow, business, notice, revenueHistory, explainer = null, guidance = null, capital = null, findings = null, fundamentals = null, narrative = null, metrics = null, planned = null, events = null, filings = null }: { ticker: string; tools: ReactNode; flow: PublicBusinessFlow; business: CompanyBusinessContent | null; notice: string | null; revenueHistory: RevenueHistory | null; explainer?: BusinessExplainer | null; guidance?: GuidancePublication | null; capital?: PublicCapitalStructure | null; findings?: FindingsPublication | null; fundamentals?: FindingFundamentals | null; narrative?: CompanyNarrative | null; metrics?: OperatingMetricsPublication | null; planned?: PlannedFigures | null; events?: EventsPublication | null; filings?: PublicFilingDigestPage | null }) {
  const quarters = useMemo(() => [...flow.quarters].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd)), [flow]);
  const [period, setPeriod] = useState<string | null>(null);
  const quarter = quarters.find(q => q.id === period) ?? quarters[0];
  const previous = quarter ? previousQuarter(quarter, quarters) : null;
  const slots = useMemo(() => hueSlots(quarters), [quarters]);
  const { items, quantified } = useMemo(() => { const built = businessItems(quarter, business, slots); return { ...built, items: withNarrativeItems(built.items, narrative) }; }, [quarter, business, slots, narrative]);
  const narrativeOf = useMemo(() => new Map<string, BusinessNarrative>(narrative?.businesses.map(b => [b.nodeId, b]) ?? []), [narrative]);
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(location.search).get("business"));
  // Findings are verified against the same data the stage draws; a finding in focus reshapes the stage around its figures.
  const data = useMemo(() => findingData(flow, revenueHistory, capital, fundamentals, guidance), [flow, revenueHistory, capital, fundamentals, guidance]);
  const verified = useMemo(() => verifiedFindings(findings, data), [findings, data]);
  // Narrative figures resolve at the quarter on stage, else at the report the narrative was written from.
  const narrativePeriods = useMemo(() => [...new Set([quarter?.periodEnd, narrative?.periodEnd].filter((p): p is string => !!p))], [quarter?.periodEnd, narrative?.periodEnd]);
  const anchorOf = useCallback((item: Item) => { const b = narrativeOf.get(item.id); return b?.anchor ? { label: b.anchor.label, value: resolveAnchor(data, b.anchor, narrativePeriods) } : null; }, [narrativeOf, data, narrativePeriods]);
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
  // A business the statements do not split out charts its anchor (remaining performance obligations) while picked, until the reader picks a metric.
  const [metricPicked, setMetricPicked] = useState(() => new URLSearchParams(location.search).has("metric"));
  const anchorTrend = useMemo(() => {
    const picked = selected ? items.find(i => i.id === selected) : null;
    const told = picked?.synthetic ? narrativeOf.get(picked.id) : null;
    const key = told?.anchor ? anchorMetricKey(told.anchor.ref) : null;
    if (!key || key === REVENUE_METRIC) return null;
    const series = fundamentals?.series.find(s => s.metricKey === key) ?? (key === "remaining_performance_obligation" ? rpoSeriesFromCapital(capital) : null);
    return series ? metricTrend(series) : null;
  }, [selected, items, narrativeOf, fundamentals, capital]);
  const shownMetric = metric ?? (metricPicked ? null : anchorTrend) ?? fallbackMetric;
  // 业务图: the figures the narrative asked for, for the picked business or for the company while nothing is picked.
  // A hand-written narrative's figures come first; the planned set fills in for what it leaves out.
  const figures = useMemo((): NarrativeFigure[] => {
    const picked = selected ? items.find(i => i.id === selected) ?? null : null;
    const own = picked ? narrativeOf.get(picked.id)?.figures : narrative?.figures;
    if (own?.length) return own;
    return (picked ? planned?.businesses.find(b => b.nodeId === picked.id)?.figures : planned?.company) ?? [];
  }, [selected, items, narrativeOf, narrative, planned]);
  // What leads the stage is the model's call per business (or the narrative author's), until the reader switches; the reason shows beside it.
  const plan = useMemo((): PanelPlan | null => {
    const picked = selected ? items.find(i => i.id === selected) ?? null : null;
    const own = picked ? narrativeOf.get(picked.id)?.layout : narrative?.layout;
    return own ?? (picked ? planned?.layouts?.businesses.find(b => b.nodeId === picked.id)?.layout : planned?.layouts?.company) ?? null;
  }, [selected, items, narrativeOf, narrative, planned]);
  const panelMetric = (ref: PanelRef | null | undefined) => !ref ? null : ref.kind === "figure" ? `figure:${ref.index}` : ref.kind === "revenue_trend" ? REVENUE_METRIC : ref.kind === "metric" ? ref.key : null;
  // The lower panel is the reader's: revenue by business, any SEC series, or one of the figures; `?metric=figure:<n>` keeps it.
  const figureKey = (i: number) => `figure:${i}`;
  const effectiveMetricKey = metricPicked ? metricKey : panelMetric(plan?.panels[1]) ?? metricKey;
  const shownFigure = useMemo(() => { const m = /^figure:(\d+)$/.exec(effectiveMetricKey); return m ? figures[Number(m[1])] ?? null : null; }, [effectiveMetricKey, figures]);
  /** A fundamentals series, or the capital-built RPO series, by key. */
  function metricFor(key: string) {
    const series = fundamentals?.series.find(s => s.metricKey === key) ?? (key === "remaining_performance_obligation" ? rpoSeriesFromCapital(capital) : null);
    return series ? metricTrend(series) : null;
  }
  const pickerGroups = useMemo(() => {
    const base = shownMetric && shownMetric.key !== REVENUE_METRIC && !metricGroups.some(g => g.options.some(o => o.key === shownMetric.key))
      ? [...metricGroups, { group: "业务锚点", options: [{ key: shownMetric.key, label: shownMetric.label }] }] : metricGroups;
    return figures.length ? [...base, { group: "业务图", options: figures.map((f, i) => ({ key: figureKey(i), label: f.title })) }] : base;
  }, [shownMetric, metricGroups, figures]);
  const chooseMetric = (key: string) => { setMetricPicked(true); setMetricKey(key); };
  const pair = focused ? verified.find(f => f.id === focused.pairWith) ?? null : null;
  const focusIndex = focused ? verified.indexOf(focused) : -1;
  const [preview, setPreview] = useState<string | null>(null);
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const current = items.find(item => item.id === selected) ?? null;
  const revenue = quarter ? numeric(quarter.figures.revenue) : null;
  const segmentRevenue = quarter?.revenueAdjustments?.length ? quarter.segments.reduce((sum,s)=>sum+(numeric(s.revenue)??0),0) : revenue;
  const shareBasis = quarter?.revenueAdjustments?.length ? '抵销前分部收入' : '总收入';
  const money = useCallback((v: number | null) => quarter ? compactFlowValue(v, quarter) : "—", [quarter]);

  useEffect(() => {
    const url = new URL(location.href);
    if (current) url.searchParams.set("business", current.id); else url.searchParams.delete("business");
    if (focused) url.searchParams.set("finding", focused.id); else url.searchParams.delete("finding");
    if (focusedEvent) url.searchParams.set("event", focusedEvent.id); else url.searchParams.delete("event");
    if (focusedReport) url.searchParams.set("report", focusedReport.accessionNumber); else url.searchParams.delete("report");
    if (metric) url.searchParams.set("metric", metric.key); else if (shownFigure && metricPicked) url.searchParams.set("metric", effectiveMetricKey); else url.searchParams.delete("metric");
    if (url.href !== location.href) history.replaceState(history.state, "", url);
  }, [current, focused, focusedEvent, focusedReport, metric, shownFigure, metricPicked, effectiveMetricKey]);
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
  // Walking the findings: arrow keys step through them in order while 逐条看 is on.
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
  const [chosenView, setChosenView] = useState<View>("profit");
  const [viewPicked, setViewPicked] = useState(false);
  const setView = (next: View) => { setChosenView(next); setViewPicked(true); };
  // The lead panel: the composition's first entry, or the first figure when the reader chose 业务图 themselves.
  const lead: PanelRef | null = viewPicked ? (chosenView === "figures" ? { kind: "figure", index: 0 } : null) : plan?.panels[0] ?? null;
  const plannedView: View = !lead || lead.kind === "flow" ? "profit" : lead.kind === "cash" ? "cash" : lead.kind === "balance" ? "balance" : "figures";
  const wantedView = viewPicked ? chosenView : plannedView;
  const cash = funding?.cashFlow ?? funding?.yearToDate ?? null;
  const leadDrawable = lead ? lead.kind === "figure" ? !!figures[lead.index] : lead.kind === "metric" ? !!metricFor(lead.key) : lead.kind === "revenue_trend" ? hasRevenueTrend : lead.kind === "timeline" || lead.kind === "parties" || lead.kind === "comparison" || lead.kind === "checks" || lead.kind === "chain" ? !!narrative : true : false;
  const view: View = wantedView === "cash" && cash ? "cash" : wantedView === "balance" && funding?.balanceSheet ? "balance" : wantedView === "figures" && lead && leadDrawable ? "figures" : "profit";
  // A finding in focus brings the stage to its report and statement view, and clears any business pick so the whole statement reads.
  useEffect(() => {
    if (!focused) return;
    setSelected(null);
    setPeriod(quarters.find(q => q.periodEnd === focused.periodEnd)?.id ?? null);
    setView(focused.anchors.view);
  }, [focused?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const amountOf = useCallback((n: PlacedNode) => n.amount ? numeric(n.amount) : n.metric && quarter ? numeric(quarter.figures[n.metric]) : n.value, [quarter]);
  /** Same comparison as the list and tooltip: only an equal-definition prior quarter yields a change. */
  const comparisonOf = useCallback((n: PlacedNode) => !quarter ? null
    : n.amount ? compareFlowAmounts(quarter, previous, n.name, n.amount, previousGraph?.nodes.find(p => p.name === n.name)?.amount)
    : n.metric ? compareAmount(quarter, previous, n.metric)
    : n.segmentId ? compareRevenueNode(quarter, previous, n.segmentId) : null, [quarter, previous, previousGraph]);
  const changeOf = useCallback((n: PlacedNode) => comparisonOf(n)?.label ?? "不可比", [comparisonOf]);
  /** The prior amount behind a percentage change: only a same-sign, same-definition prior quarter is drawn as a ghost outline. */
  const priorOf = useCallback((n: PlacedNode) => { const c = comparisonOf(n); return c && c.percent != null && c.previous != null ? Math.abs(c.previous) : null; }, [comparisonOf]);
  const copy = useCallback((n: PlacedNode): NodeCopy => {
    const label = changeOf(n);
    return { name: shortName(n.label), value: money(amountOf(n)), ...(label !== "不可比" ? { change: { label, trend: trend(label) } } : {}) };
  }, [money, amountOf, changeOf]);
  const layout = useMemo(() => graph ? layoutFor(graph, copy) : null, [graph, copy]);
  // 对比上季 needs the prior quarter drawn in this quarter's currency and scale; its labels carry no change of their own.
  const priorMoney = useCallback((v: number | null) => previous ? compactFlowValue(v, previous) : "—", [previous]);
  const priorCopy = useCallback((n: PlacedNode): NodeCopy => ({ name: shortName(n.label), value: priorMoney(n.amount ? numeric(n.amount) : n.metric && previous ? numeric(previous.figures[n.metric]) : n.value) }), [priorMoney, previous]);
  const priorQuarter = useMemo(() => previous && previousGraph?.links.length && quarter && previous.currency === quarter.currency && previous.scale === quarter.scale
    && previous.incomeModel !== "financial" && previous.incomeModel !== "insurance" ? { graph: previousGraph, copy: priorCopy, label: previous.label } : null, [previous, previousGraph, quarter, priorCopy]);
  const proportional = Boolean(quarter && layout && quarter.incomeModel !== "financial" && quarter.incomeModel !== "insurance");
  const deficit = graph?.deficit && revenue ? deficitVerdict(graph, revenue, v => money(v)) : null;

  const itemByNode = useMemo(() => new Map(items.filter(item => !item.synthetic).map(item => ["segment:" + item.key, item])), [items]);
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
    const rows: Array<[string, string]> = [["本季", money(amountOf(n))]];
    if (revenue && n.name !== "revenue") rows.push([(n.tone === "profit" || n.tone === "loss") && !n.segmentId ? "利润率" : "占收入", percent((amountOf(n) ?? n.value) / revenue * 100)]);
    if (n.offset && graph) {
      rows.push(["已抵减", money(graph.links.filter(l => l.target === n.name).reduce((sum, l) => sum + l.value, 0))]);
      rows.push(["抵减后余额", money(graph.links.filter(l => l.source === n.name).reduce((sum, l) => sum + l.value, 0))]);
    }
    if(n.segmentId&&quarter.revenueAdjustments?.length)rows.splice(1,1,["占抵销前分部收入",percent((amountOf(n)??0)/segmentRevenue!*100)]);
    rows.push(["环比", changeOf(n)], [`原披露金额（${quarter.currency} 百万）`, formatFlowValue(amountOf(n),quarter)]);
    return { title: n.label, color: colorOf(n.name), rows };
  }, [quarter, revenue, money, amountOf, colorOf, changeOf, graph, segmentRevenue]);

  // Guidance on the bars: this quarter's guided range as a bracket with its verdict, next quarter's as a pill, both at the chart's units.
  const guideMarks = useMemo((): { brackets: GuideBracketMark[]; pills: GuidePillMark[] } => {
    if (!quarter || !graph || !guidance) return { brackets: [], pills: [] };
    const dollars = (v: number | null) => v == null ? "—" : compactFlowValue(v / quarter.scale, quarter);
    const amountOfNode = (name: string) => { const n = graph.nodes.find(n => n.name === name); return n ? (n.amount ? numeric(n.amount) : n.metric ? numeric(quarter.figures[n.metric]) : n.value) : null; };
    const marks = guidanceMarks(quarter, graph.nodes.map(n => n.name), guidance, { amountOf: amountOfNode, businessIdOf: name => itemByNode.get(name)?.id ?? null, money: v => dollars(v) });
    const VERDICT = { above: "高于指引上限", within: "落在指引区间内", below: "低于指引下限" } as const;
    return {
      brackets: marks.brackets.map(b => ({ node: b.node, low: b.low / quarter.scale, high: b.high / quarter.scale, derived: b.derived, verdict: b.verdict, url: b.source?.url ?? null,
        tip: { title: `本季指引 · ${markSentence(b.item, dollars)}`, color: colorOf(b.node), note: b.item.quote,
          rows: [[b.derived ? "指引（按增速换算）" : "指引区间", `${dollars(b.low)}–${dollars(b.high)}`], ["本季", money(amountOfNode(b.node))], ["结果", VERDICT[b.verdict]], ["发布于", b.item.issuedAt.slice(0, 10)]],
          link: b.source ? `来源：${b.source.title}` : undefined } })),
      pills: marks.pills.map(p => ({ node: p.node, text: p.text, action: p.action ?? null, glyph: p.action ? ACTION_GLYPH[p.action] : "", url: p.source?.url ?? null,
        tip: { title: `下季指引 · ${markSentence(p.item, dollars)}`, color: colorOf(p.node), note: p.item.quote,
          rows: [...(p.action && p.action !== "initiated" ? [["较上次", actionName(p.action) + (p.item.previous && p.item.previous.low != null ? `（此前 ${p.item.measure === "growth" || p.item.unit === "percent" ? `${p.item.previous.low}%–${p.item.previous.high}%` : `${dollars(p.item.previous.low)}–${dollars(p.item.previous.high)}`}）` : "")] as [string, string]] : []), ["发布于", p.item.issuedAt.slice(0, 10)]],
          link: p.source ? `来源：${p.source.title}` : undefined } })),
    };
  }, [quarter, graph, guidance, itemByNode, colorOf, money]);
  const spotlight = useMemo(() => focused && view === "profit" ? anchorNodeNames(focused, quarter, items) : null, [focused, view, quarter, items]);
  const poolSpotlight = useMemo(() => focused && view !== "profit" ? anchorPoolKeys(focused) : null, [focused, view]);
  const nodeColor = useCallback((id: string) => { const item = items.find(i => i.id === id); return item ? hue(item.slot) : "var(--biz-0)"; }, [items]);
  const focusFinding = (id: string | null) => { setFocusId(id); if (id) { setEventId(null); setReportId(null); } else { setStory(false); setSplit(false); } };
  const focusEvent = (id: string | null) => { setEventId(id); if (id) { setSelected(null); setFocusId(null); setReportId(null); setStory(false); setSplit(false); } };
  // The rail holds one pick at a time: a business, a finding, or a report/event.
  const pickBusiness = (id: string | null) => { setSelected(id); setMetricPicked(false); setViewPicked(false); if (id) { setFocusId(null); setEventId(null); setReportId(null); setStory(false); setSplit(false); } };
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
  // The business list is a drawer: closed, only 全部业务 and the business picked (with its parent) show.
  const [businessOpen, setBusinessOpen] = useState(false);
  const businessDigest = new Set([current?.key, current?.parent].filter(Boolean));
  // One section can open over the whole rail; the rest of the rail returns when it closes.
  const [section, setSection] = useState<RailSectionKey | null>(null);
  const showFindings = !current && !!findings && verified.length > 0;
  const openSection = section === "findings" && !showFindings || section === "events" && !rail ? null : section;
  const sectionFocus = (key: RailSectionKey) => ({ expanded: openSection === key, onExpand: expandSection(key) });
  const expandSection = (key: RailSectionKey) => (open: boolean) => railTransition(() => {
    setSection(open ? key : null);
    document.getElementById("rail-body")?.scrollTo({ top: 0 });
  });
  const previewItem = items.find(item => item.key === preview);
  // A business the statements do not split out lights nothing: its figures are the whole statement's, and the chart stays readable while its dossier opens.
  const active = previewItem ? (previewItem.synthetic ? null : "segment:" + previewItem.flowKey) : hoverNode ?? (current && !current.synthetic ? "segment:" + current.flowKey : null);
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

  const reconciliation = quarter ? reconcileQuarter(quarter) : [];
  const balanced = reconciliation.length > 0 && reconciliation.every(r => r.status === "balanced");
  const figure = (key: FlowMetric) => quarter ? numeric(quarter.figures[key]) : null;
  const margin = (key: FlowMetric) => { const v = figure(key); return v != null && revenue ? `利润率 ${percent(v / revenue * 100)}` : "利润率 —"; };
  const change = (key: FlowMetric) => quarter ? compareAmount(quarter, previous, key).label : "不可比";
  const itemChange = current && quarter && !current.synthetic ? compareRevenueNode(quarter, previous, current.key).label : "不可比";
  const parent = current?.parent ? items.find(item => item.key === current.parent) : null;

  /** One panel of the composition, wherever it sits; the flow, cash and balance only ever lead, so they draw nothing here. */
  const renderPanel = (panel: PanelRef, picker?: ReactNode): ReactNode => {
    const told = current ? narrativeOf.get(current.id) ?? null : null;
    if (panel.kind === "figure") return figures[panel.index] ? <FigureCard figure={figures[panel.index]} metrics={metrics} /> : null;
    if (panel.kind === "metric") { const t = metricFor(panel.key); return t ? <MetricTrendPanel trend={t} currentPeriod={quarter?.periodEnd ?? null} periods={new Set(quarters.map(q => q.periodEnd))} onPickPeriod={end => setPeriod(quarters.find(q => q.periodEnd === end)?.id ?? null)} picker={picker ?? null} /> : null; }
    if (panel.kind === "revenue_trend") return hasRevenueTrend ? <TrendPanel history={revenueHistory!} items={items.filter(i => !i.synthetic)} selected={current?.synthetic ? null : current} currentPeriod={quarter?.periodEnd ?? null}
      periods={new Set(quarters.map(q => q.periodEnd))} onPickPeriod={end => setPeriod(quarters.find(q => q.periodEnd === end)?.id ?? null)} hue={hue} guidance={guidance} picker={picker ?? null} /> : null;
    if (panel.kind === "timeline" || panel.kind === "parties" || panel.kind === "comparison" || panel.kind === "checks" || panel.kind === "chain") return narrative ? <SectionPanel kind={panel.kind} business={told} narrative={narrative} data={data} periods={narrativePeriods} /> : null;
    return null;
  };
  const dossierAside = current
    ? <Dossier item={current} parent={parent ?? null} sources={quarter?.sources.length ? quarter.sources : business?.sources ?? []} explainer={explainer} narrative={narrative} data={data} periods={narrativePeriods} />
    : narrative ? <CompanyDossier narrative={narrative} data={data} periods={narrativePeriods} onPick={id => pickBusiness(id)} /> : null;
  // Below the main slot: the reader's pick when they made one, else every panel of the composition the main slot is not already showing
  // (so a lead the reader switched away from moves down, and nothing appears twice).
  const mainRef: PanelRef | null = view === "profit" ? { kind: "flow" } : view === "cash" ? { kind: "cash" } : view === "balance" ? { kind: "balance" } : lead;
  const lowerPanels: PanelRef[] = metricPicked || !plan ? [] : plan.panels.filter(p => p.kind !== "flow" && p.kind !== "cash" && p.kind !== "balance" && !(view === "figures" && viewPicked && p.kind === "figure") && JSON.stringify(p) !== JSON.stringify(mainRef));
  const findingPlan = focused ? planned?.layouts?.findings?.find(f => f.findingId === focused.id)?.layout ?? null : null;
  const lowerPicker = <MetricPicker value={effectiveMetricKey} groups={pickerGroups} revenue={hasRevenueTrend} onChange={chooseMetric} />;

  return <div className="map">
    <Rail ticker={ticker} actions={tools} label="公司业务" expanded={openSection != null}>
      <RailSection name="business" title="业务" expandable={items.some(i => !businessDigest.has(i.key))} focused={current != null} drawer expanded={businessOpen} onExpand={open => railTransition(() => setBusinessOpen(open))}>
        <div className="rail-list section-body" id="rail-business" role="listbox" aria-label="选择业务以在图中高亮" ref={listRef} onKeyDown={onListKey} onMouseLeave={() => setPreview(null)}>
          <Button variant="unstyled" type="button" role="option" aria-selected={!current} tabIndex={!current ? 0 : -1} className="row row--all" onClick={() => pickBusiness(null)} onMouseEnter={() => setPreview(null)}
            title={[quantified ? `总收入 · ${items.filter(i => !i.parent).length} 项一级业务` : "总收入", narrative && STAGE_LABEL[narrative.stage]].filter(Boolean).join(" · ")}>
            <i className="row-chip row-chip--all" aria-hidden="true" />
            <span className="row-name">全部业务</span>
            <span className="row-value">{revenue != null ? money(revenue) : ""}</span>
            {quarter && <span className="row-meta"><Delta label={change("revenue")} /></span>}
          </Button>
          {items.map(item => {
            const share = item.value != null && segmentRevenue ? item.value / segmentRevenue * 100 : null;
            const delta = quarter && quantified && !item.synthetic ? compareRevenueNode(quarter, previous, item.key).label : "不可比";
            const nb = narrativeOf.get(item.id), anchor = item.synthetic ? anchorOf(item) : null;
            return <Button variant="unstyled" type="button" role="option" key={item.key} data-id={item.id} aria-selected={current?.key === item.key} tabIndex={current?.key === item.key ? 0 : -1}
              className="row" data-depth={item.depth} data-hover={hovered === item.key || undefined} data-synthetic={item.synthetic || undefined} data-extra={businessDigest.has(item.key) ? undefined : ""} style={{ "--c": hue(item.slot) } as CSSProperties}
              onClick={() => pickBusiness(current?.key === item.key ? null : item.id)} onMouseEnter={() => setPreview(item.key)}
              title={[share != null ? `占${shareBasis} ${percent(share)}${quarter.revenueAdjustments?.length ? "（抵销前）" : ""}` : anchor?.value ? `${anchor.label} · 收入未单独披露` : "定性归属 · 比例未披露", nb && STAGE_LABEL[nb.stage]].filter(Boolean).join(" · ")}>
              <i className="row-chip" aria-hidden="true" />
              <span className="row-name">{item.name}</span>
              <span className="row-value">{item.value != null ? money(item.value) : anchor?.value ? compactFlowValue(anchor.value.value, { currency: anchor.value.currency ?? "USD", scale: 1 } as BusinessFlowQuarter) : ""}</span>
              {share != null && <span className="row-bar" aria-hidden="true"><b style={{ width: `${Math.max(0.6, share)}%` }} /></span>}
              <span className="row-meta">{share != null ? <>{percent(share)}<Delta label={delta} /></> : anchor?.value ? `${anchor.label} · 收入未单独披露` : "定性归属 · 比例未披露"}</span>
            </Button>;
          })}
        </div>
      </RailSection>
      {showFindings && <FindingsList findings={verified} focus={focused?.id ?? null} story={story} periodEnd={findings.periodEnd} {...sectionFocus("findings")} onFocus={focusFinding} onStory={() => { if (story) { setStory(false); setFocusId(null); } else { setStory(true); setEventId(null); setFocusId(focused?.id ?? verified[0].id); } }} />}
      {rail && <EventsList rail={rail} focus={focusedReport?.accessionNumber ?? focusedEvent?.id ?? null} pendingInsider={events?.pendingInsider ?? 0} {...sectionFocus("events")} onFocus={focusItem} />}
      {!!quarter?.revenueAdjustments?.length&&<p className="revenue-reconciliation">收入对账 · {quarter.currency} 百万<br/>分部收入（抵销前） {formatFlowValue(segmentRevenue,quarter)}<br/>{quarter.revenueAdjustments.map(a=><span key={a.id}>{a.name} {formatFlowValue(numeric(a.amount),quarter)}<br/></span>)}合并收入 {formatFlowValue(revenue,quarter)}</p>}
    </Rail>

    <section className="stage" data-view={view} data-trend={hasRevenueTrend || metricGroups.length ? "" : undefined} data-finding={focused?.kind} data-timeline={points.length ? "" : undefined} aria-label={`${ticker} 收入到利润流向`}>
      <header className="stage-head stage-head--summary">
        {quarter && view !== "profit" && view !== "figures" && funding ? <CapitalStats view={view} funding={funding} /> : quarter && <div className="stats" aria-live="polite">
          {current?.synthetic ? <>
            {(() => { const a = anchorOf(current); const nb = narrativeOf.get(current.id); return a?.value ? <Stat label={a.label} value={a.value.value} format={v => v == null ? "—" : compactFlowValue(v, { currency: a.value!.currency ?? "USD", scale: 1 } as BusinessFlowQuarter)} note={`${nb ? STAGE_LABEL[nb.stage] : ""} · 收入未单独披露`} /> : <Stat label={current.name} value={null} format={() => nb ? STAGE_LABEL[nb.stage] : "—"} note="收入未单独披露" />; })()}
            <Stat label="公司总收入" value={revenue} format={money} note={`环比 ${change("revenue")}`} tone={trend(change("revenue"))} />
          </> : current && current.value != null ? <>
            <Stat label="本季收入" value={current.value} format={money} note={`环比 ${itemChange}`} tone={trend(itemChange)} />
            <Stat label={`占${shareBasis}`} value={segmentRevenue ? current.value / segmentRevenue * 100 : null} format={percent} note={parent?.value ? `占${parent.name} ${percent(current.value / parent.value * 100)}` : "一级业务"} />
            <Stat label="公司总收入" value={revenue} format={money} note="成本与利润不按业务分摊" />
          </> : <>
            <Stat label="总收入" value={revenue} format={money} note={`环比 ${change("revenue")}`} tone={trend(change("revenue"))} />
            {quarter.incomeModel !== "direct_operating" && figure("gross") != null && <Stat label="毛利" value={figure("gross")} format={money} note={margin("gross")} />}
            {figure("operating") != null || figure("pretax") == null
              ? <Stat label="营业利润" value={figure("operating")} format={money} note={margin("operating")} />
              : <Stat label="税前利润" value={figure("pretax")} format={money} note={margin("pretax")} />}
            <Stat label={deficit ? "净亏损" : "净利润"} value={figure("net")} format={money} note={deficit?.coverage != null ? `${margin("net")} · 收入覆盖 ${percent(deficit.coverage * 100)}` : margin("net")} />
          </>}
        </div>}
        <div className="stage-controls">
        {((funding && (cash || funding.balanceSheet)) || figures.length > 0) && <ToggleGroup type="single" variant="unstyled" rovingFocus={false} value={view} onValueChange={next => { if (next) setView(next as View); }} asChild>
          <span className="trend-views stage-views" role="radiogroup" aria-label="财务视图">
            <ToggleGroupItem value="profit" role="radio" aria-checked={view === "profit"}>利润</ToggleGroupItem>
            {cash && <ToggleGroupItem value="cash" role="radio" aria-checked={view === "cash"}>现金流</ToggleGroupItem>}
            {funding?.balanceSheet && <ToggleGroupItem value="balance" role="radio" aria-checked={view === "balance"}>资产负债</ToggleGroupItem>}
            {figures.length > 0 && <ToggleGroupItem value="figures" role="radio" aria-checked={view === "figures"}>业务图</ToggleGroupItem>}
          </span>
        </ToggleGroup>}
        {/* The quarter is picked on the time axis under the chart; the header only names the one on stage. */}
        {quarter && <span className="report-current" aria-live="polite"><span>财报季度</span><b>{shortPeriod(quarter.periodEnd)}</b></span>}
        </div>
        {quarter && view !== "figures" && <Verdict view={view} funding={funding} deficit={deficit?.text ?? null} />}
        {plan && !viewPicked && <p className="stage-verdict stage-verdict--plan"><b>为什么先看这张</b>{plan.reason}</p>}
      </header>

      <div className="chart">
        {view === "figures" && lead ? (lead.kind === "figure" && viewPicked
            ? <BusinessFigures figures={figures} metrics={metrics} aside={dossierAside} />
            : <div className="figures" data-aside={dossierAside ? "" : undefined}>
              {dossierAside && <aside className="fc-business-details figures-aside" aria-label="业务档案"><div className="fc-business-scroll" tabIndex={0}>{dossierAside}</div></aside>}
              <div className="figures-canvas">{renderPanel(lead)}</div>
            </div>)
          : view !== "profit" && funding ? <CapitalChart view={view} funding={funding} ticker={ticker} spotlight={poolSpotlight} />
          : !quarter ? <div className="empty"><h2>季度财务未披露</h2><p>需要同币种、同口径的三个月数据才能绘制流向；不会用示例数据替代。</p></div>
          : proportional && layout ? <FlowChart graph={graph!} copy={copy} money={v => money(v)} colorOf={colorOf} active={active} revealKey={quarter.id} productBusiness={current && !current.synthetic ? "segment:" + current.flowKey : null} businessDetails={<Dossier item={current} parent={parent ?? null} sources={quarter?.sources.length ? quarter.sources : business?.sources ?? []} explainer={explainer} narrative={narrative} data={data} periods={narrativePeriods} />}
              detailsKey={current?.synthetic ? current.key : "company"}
              companyDetails={current?.synthetic ? <Dossier item={current} parent={parent ?? null} sources={quarter?.sources.length ? quarter.sources : business?.sources ?? []} explainer={explainer} narrative={narrative} data={data} periods={narrativePeriods} />
                : !current && narrative && !focused && !focusedEvent && !focusedReport ? <CompanyDossier narrative={narrative} data={data} periods={narrativePeriods} onPick={id => pickBusiness(id)} /> : null}
              focusSlot={n => segmentRevenue ? `占${shareBasis} ${percent(n.value / segmentRevenue * 100)}` : null}
              onHover={name => setHoverNode(name)} tipFor={tipFor} spotlight={spotlight} priorOf={priorOf} previous={priorQuarter} brackets={guideMarks.brackets} pills={guideMarks.pills}
              onPick={n => { const item = itemByNode.get(n.name); pickBusiness(item && current?.key !== item.key ? item.id : null); }}
              label={`${ticker} ${quarter.label} 收入到净利润桑基图，金额单位 ${quarter.currency}`} />
          : <div className="business-flow chart-fallback">{current && <Dossier item={current} parent={parent ?? null} sources={quarter.sources.length ? quarter.sources : business?.sources ?? []} explainer={explainer} narrative={narrative} data={data} periods={narrativePeriods} />}<FinancialSankey quarter={quarter} previous={previous} onSegment={key => pickBusiness(items.find(item => item.key === key)?.id ?? null)} /></div>}
      </div>


      {focusedReport ? <div className="lens-stage"><ReportLens report={focusedReport} ticker={ticker} index={railIndex} count={railList.length}
        onStep={delta => { const next = railList[railIndex + delta]; if (next) focusItem(next); }} onClose={() => focusReport(null)} onOpenReport={() => setReader(true)} />
        {reader && <Suspense fallback={null}><ReportDialog ticker={ticker} accession={focusedReport.snapshot?.accession ?? focusedReport.accessionNumber}
          snapshot={focusedReport.snapshot ? { reportDate: focusedReport.snapshot.reportDate, reportVersion: focusedReport.snapshot.reportVersion } : null} onClose={() => setReader(false)} /></Suspense>}</div>
      : focusedEvent && events ? <div className="lens-stage"><EventLens event={focusedEvent} publication={events} index={railIndex} count={railList.length}
        onStep={delta => { const next = railList[railIndex + delta]; if (next) focusItem(next); }} onClose={() => focusEvent(null)} /></div>
      : focused && findings ? <div className="lens-stage" data-split={split && pair ? "" : undefined}>
        <LensPanel finding={focused} data={data} sources={findings.sources} nodeColor={nodeColor} pair={pair} split={split && !!pair}
          story={story} index={focusIndex} count={verified.length} onPair={() => setSplit(v => !v)}
          onStep={delta => { const next = verified[focusIndex + delta]; if (next) focusFinding(next.id); }} onClose={() => focusFinding(null)} />
        {split && pair && <LensPanel finding={pair} data={data} sources={findings.sources} nodeColor={nodeColor} pair={null} compact
          story={false} index={-1} count={verified.length} onPair={() => {}} onStep={() => {}} onClose={() => setSplit(false)} onFocusThis={() => setFocusId(pair.id)} />}
      </div>
      : lowerPanels.length ? <div className="stage-panels" aria-label="按叙事排布的面板">
        <div className="stage-panels-head"><span>{current?.name ?? narrative?.companyName ?? ticker} · 按叙事排布</span>{lowerPicker}</div>
        {lowerPanels.map((panel, i) => <div key={i} className="stage-panel">{renderPanel(panel)}</div>)}
      </div>
      : shownFigure ? <section className="trend trend--figure" aria-label={shownFigure.title}>
        <div className="trend-heading"><h2>{current?.name ?? narrative?.companyName ?? ticker}</h2>{lowerPicker}</div>
        <BusinessFigures figures={[shownFigure]} metrics={metrics} aside={null} />
      </section>
      : shownMetric ? <MetricTrendPanel trend={shownMetric} currentPeriod={quarter?.periodEnd ?? null} periods={new Set(quarters.map(q => q.periodEnd))}
        onPickPeriod={end => setPeriod(quarters.find(q => q.periodEnd === end)?.id ?? null)}
        picker={<MetricPicker value={shownMetric.key} groups={pickerGroups} revenue={hasRevenueTrend} onChange={chooseMetric} />} />
      : hasRevenueTrend && <TrendPanel history={revenueHistory!} items={items.filter(i => !i.synthetic)} selected={current?.synthetic ? null : current} currentPeriod={quarter?.periodEnd ?? null}
        periods={new Set(quarters.map(q => q.periodEnd))} onPickPeriod={end => setPeriod(quarters.find(q => q.periodEnd === end)?.id ?? null)} hue={hue} guidance={guidance}
        picker={<MetricPicker value={REVENUE_METRIC} groups={pickerGroups} revenue onChange={chooseMetric} />} />}
      {focused && findingPlan && <div className="stage-panels" aria-label="要点的核验面板">
        <div className="stage-panels-head"><span>{focused.title} · 核验</span><em>{findingPlan.reason}</em></div>
        {findingPlan.panels.filter(p => p.kind !== "flow" && p.kind !== "cash" && p.kind !== "balance").map((panel, i) => <div key={i} className="stage-panel">{renderPanel(panel)}</div>)}
      </div>}

      {points.length > 0 && <Timeline points={points} now={now.getTime()} currentPeriod={quarter?.periodEnd ?? null} focus={focusedReport?.accessionNumber ?? focusedEvent?.id ?? null}
        onReport={(id, end) => { if (filings?.filings.some(f => f.accessionNumber === id)) { focusFinding(null); focusReport(id); } else { setPeriod(quarters.find(q => q.periodEnd === end)?.id ?? null); focusFinding(null); setEventId(null); setReportId(null); } }} onEvent={id => focusEvent(id)} />}

      <footer className="stage-foot">
        {view === "figures" ? <span className="legend-note">业务图由叙事层的拆解与运营指标生成；阶梯图数值均引自公司原文</span>
          : view !== "profit" && funding ? <CapitalLegend view={view} funding={funding} /> : proportional ? <div className="legend" aria-label="图例">
          <span><i className="legend-biz" />业务收入</span>
          <span><i style={{ background: "var(--flow-profit)" }} />利润</span>
          {(graph?.signed || graph?.deficit) && <span><i style={{ background: "var(--loss)" }} />{graph?.deficit ? "净亏损（资金缺口）" : "亏损"}</span>}
          <span><i style={{ background: "var(--flow-expense)" }} />成本与费用</span>
          <span className="legend-note">线宽 = 本季金额{graph?.signed ? "绝对值" : ""}{previous ? " · 百分比 = 较上季变化 · 虚线框 = 上季金额" : ""}{guideMarks.brackets.length ? " · 括号 = 本季指引区间" : ""}{guideMarks.pills.length ? " · 胶囊 = 下季指引" : ""}</span>
        </div> : <span className="legend-note">框图表示会计关系，宽度不代表金额</span>}
        <p className="provenance">
          {notice && <span>{notice}</span>}
          {view === "figures" ? metrics && <span>运营指标 {metrics.model === "authored" ? "人工整理" : metrics.model} · {metrics.generatedAt.slice(0, 10)}</span> : view !== "profit" && funding ? <CapitalProvenance view={view} funding={funding} /> : <>
          {graph?.notice && proportional && <span>{graph.notice}</span>}
          {quarter && <span>{balanced ? `${reconciliation.length} 项会计等式已核对` : "部分披露缺失，只绘制已对平路径"}</span>}
          </>}
          {flow.fetchedAt && <span>数据 {flow.fetchedAt.slice(0, 10)}</span>}
        </p>
      </footer>
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
const cashPeriod = (funding: CapitalQuarter) => funding.cashFlow ? "本季" : `年初至今 ${months(funding.yearToDate!.periodStart, funding.yearToDate!.periodEnd)} 个月`;
const pct = (v: number | null) => v == null || !Number.isFinite(v) ? "—" : `${Math.round(v * 100)}%`;

function CapitalStats({ view, funding }: { view: View; funding: CapitalQuarter }) {
  const money = capitalMoney(funding);
  if (view === "balance") {
    const b = funding.balanceSheet!, m = balanceMetrics(b);
    return <div className="stats" aria-live="polite">
      <Stat label="总资产" value={m.assets} format={money} note={`截至 ${b.asOf}`} />
      <Stat label="有息债务" value={m.debt} format={money} note={`债务与租赁占资产 ${pct(m.leverage)}`} />
      {m.customer > 0 ? <Stat label="客户预付" value={m.customer} format={money} note={`占资产 ${pct(m.customer / m.assets)}`} />
        : <Stat label="现金与短期投资" value={b.assets.filter(l => l.group === "cash").reduce((s, l) => s + Number(l.value), 0)} format={money} note="含受限现金" />}
      <Stat label="股东权益" value={m.equity} format={money} note={m.deficit > 0 ? `投入 ${money(m.paidIn)} · 累计亏损 ${money(m.deficit)}` : `占资产 ${pct(m.equity / m.assets)}`} tone={m.equity < 0 ? "down" : undefined} />
    </div>;
  }
  const c = cashOf(funding), m = cashMetrics(c), period = cashPeriod(funding);
  const outside = [m.debtNet != null ? `净借款 ${money(m.debtNet)}` : null, m.equityIssued ? `发股 ${money(m.equityIssued)}` : null].filter(Boolean).join(" · ");
  return <div className="stats" aria-live="polite">
    <Stat label={`经营现金流 · ${period}`} value={m.operating} format={money} note={m.selfFunding == null ? "经营活动产生的现金" : m.selfFunding >= 2 ? `为资本开支的 ${m.selfFunding.toFixed(1)} 倍` : `覆盖资本开支 ${pct(m.selfFunding)}`} tone={m.operating < 0 ? "down" : undefined} />
    {m.capex != null && <Stat label="资本开支" value={m.capex} format={money} note={m.free != null ? `自由现金流 ${money(m.free)}` : undefined} />}
    <Stat label="融资活动净额" value={m.financing} format={money} note={outside || "借款、发股与回报股东合计"} />
    <Stat label="现金变动" value={Number(c.netChange)} format={money} note={funding.balanceSheet ? `期末现金与短期投资 ${money(funding.balanceSheet.assets.filter(l => l.group === "cash").reduce((s, l) => s + Number(l.value), 0))}` : undefined} />
  </div>;
}

function Verdict({ view, funding, deficit }: { view: View; funding: CapitalQuarter | null; deficit: string | null }) {
  if (view === "balance" && funding?.balanceSheet) return <p className="stage-verdict"><b>资金结构</b>{balanceVerdict(funding.balanceSheet)}</p>;
  if (view === "cash" && funding && (funding.cashFlow || funding.yearToDate)) {
    const money = capitalMoney(funding), verdict = fundingVerdict(cashOf(funding), funding.balanceSheet, v => money(v));
    return <p className="stage-verdict" data-kind={verdict.kind}><b>{verdict.label}</b>{verdict.text}</p>;
  }
  return deficit ? <p className="stage-verdict" data-kind="survival"><b>亏损从哪来</b>{deficit}</p> : null;
}

function poolOf(view: View, funding: CapitalQuarter): Pool {
  return view === "balance" ? balancePool(funding.balanceSheet!) : cashPool(cashOf(funding));
}

function CapitalChart({ view, funding, ticker, spotlight = null }: { view: View; funding: CapitalQuarter; ticker: string; spotlight?: Set<string> | null }) {
  const pool = useMemo(() => poolOf(view, funding), [view, funding]);
  const money = useMemo(() => { const format = capitalMoney(funding); return (v: number) => format(v); }, [funding]);
  return <PoolChart key={view + funding.periodEnd} pool={pool} money={money} spotlight={spotlight}
    label={view === "balance" ? `${ticker} 截至 ${funding.periodEnd} 的资金来源到资产` : `${ticker} ${cashPeriod(funding)}现金来源到去向`} />;
}

function CapitalLegend({ view, funding }: { view: View; funding: CapitalQuarter }) {
  const pool = poolOf(view, funding);
  // Tones whose items are too small to see are left out of the legend.
  const tones = [...new Set([...pool.sources, ...pool.uses].filter(item => item.value >= pool.total * 0.01).map(item => item.tone))];
  return <div className="legend" aria-label="图例">
    {tones.map(tone => <span key={tone}><i style={{ background: toneColor(tone) }} />{TONE_LABEL[tone]}</span>)}
    <span className="legend-note">左侧来源与右侧去向合计相等 · 线宽 = 金额</span>
  </div>;
}

function CapitalProvenance({ view, funding }: { view: View; funding: CapitalQuarter }) {
  if (view === "balance") return <>
    <span>资产、负债与权益各行已与报表合计核对</span>
    <a href={funding.balanceSheet!.source.url} target="_blank" rel="noopener noreferrer">{funding.balanceSheet!.source.form} {funding.balanceSheet!.source.accession}</a>
  </>;
  const c = cashOf(funding);
  return <>
    <span title={c.formula}>{c.basis === "derived" ? `本季 = 年初至今 ${months(funding.yearToDate!.periodStart, c.periodEnd)} 个月 − 前 ${months(funding.yearToDate!.periodStart, c.periodStart)} 个月（两期财报相减）` : funding.cashFlow ? "现金流量表本季原披露" : "本季无法从累计数拆分，显示年初至今"}</span>
    <span>三类现金流已与现金变动核对</span>
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

function Dossier({ item, parent, sources, explainer, narrative, data, periods }: { item: Item | null; parent: Item | null; sources: FlowSource[]; explainer: BusinessExplainer | null; narrative: CompanyNarrative | null; data: FindingData; periods: string[] }) {
  if (!item) return null;
  const explained = explainer?.businesses.find(b => b.nodeId === item.id);
  const told = narrative?.businesses.find(b => b.nodeId === item.id);
  // The narrative carries the fixed reading order; the explainer's own angles follow it as further tabs.
  if (narrative && told) return <BusinessNarrativeDossier key={item.key} business={told} narrative={narrative} data={data} periods={periods} parentName={parent?.name ?? null}
    extraSections={explainer && explained ? explainedSections(explainer, explained) : []} />;
  if (explainer && explained) return <ExplainedDossier key={item.key} item={item} parent={parent} explainer={explainer} explained={explained} />;
  const segment = item.segment;
  const [description, basis] = (segment.description || "业务说明未披露").split("\n");
  return <section className="dossier" key={item.key} aria-label={`${item.name} 业务档案`}>
    <h3>{parent ? `${parent.name} / ` : ""}{item.name}</h3>
    <p>{description}</p>

    <DossierTabs label={item.name} sections={[["客户", segment.customers ?? "未披露"], ["收费方式", segment.monetization ?? "未披露"]]} />
    {basis && <p className="fine">{basis}</p>}
    <Sources sources={sources} ids={segment.sourceIds} />
  </section>;
}

/** A model-written explanation: every statement carries numbered links to the pages it was written from. */
function ExplainedDossier({ item, parent, explainer, explained }: { item: Item; parent: Item | null; explainer: BusinessExplainer; explained: BusinessExplainer["businesses"][number] }) {
  const claims = [explained.summary, ...(explained.offerings ?? []).flatMap(p => [p.description, p.charging]), ...explained.sections.flatMap(s => s.items.map(i => i.claim))];
  const cited = [...new Set(claims.flatMap(c => c?.sourceIds ?? []))].map(id => explainer.sources.find(s => s.id === id)).filter(s => s != null);
  const cite = (claim: ExplainerClaim) => <span className="cites">{claim.sourceIds.map(id => {
    const index = cited.findIndex(s => s.id === id);
    return index < 0 ? null : <a key={id} href={cited[index].url} target="_blank" rel="noopener noreferrer" title={cited[index].title}>{index + 1}</a>;
  })}</span>;
  return <section className="dossier" aria-label={`${item.name} 业务档案`}>
    <h3>{parent ? `${parent.name} / ` : ""}{item.name}</h3>
    {/* Without a verified summary, the filing's own one-line description still says what the business is. */}
    {explained.summary ? <p className="dossier-lede">{explained.summary.text}{cite(explained.summary)}</p>
      : item.segment.description && <p>{item.segment.description.split("\n")[0]}</p>}

    {/* Products come first when verified; the other tabs are the angles the model chose for this business. */}
    <DossierTabs label={item.name} sections={[
      ...(explained.offerings?.length ? [["产品介绍", <ul key="offerings" className="dossier-products">{explained.offerings.map(p => <li key={p.id}><b>{p.name}</b>{p.description.text}{cite(p.description)}</li>)}</ul>] as [string, ReactNode]] : []),
      ...explained.sections.map((section): [string, ReactNode] => [section.title, <DossierSection key={section.id} section={section} cite={cite} />]),
    ]} />

    <ol className="sources sources--numbered">{cited.map(s => <li key={s.id}><a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}<span aria-hidden="true"> ↗</span></a></li>)}</ol>
  </section>;
}

/** The explainer's tabs for one business: verified products first, then the angles the model chose. Each claim links to its pages. */
function explainedSections(explainer: BusinessExplainer, explained: BusinessExplainer["businesses"][number]): Array<[string, ReactNode]> {
  const claims = [explained.summary, ...(explained.offerings ?? []).flatMap(p => [p.description, p.charging]), ...explained.sections.flatMap(s => s.items.map(i => i.claim))];
  const cited = [...new Set(claims.flatMap(c => c?.sourceIds ?? []))].map(id => explainer.sources.find(s => s.id === id)).filter(s => s != null);
  const cite = (claim: ExplainerClaim) => <span className="cites">{claim.sourceIds.map(id => {
    const index = cited.findIndex(s => s.id === id);
    return index < 0 ? null : <a key={id} href={cited[index].url} target="_blank" rel="noopener noreferrer" title={cited[index].title}>{index + 1}</a>;
  })}</span>;
  return [
    ...(explained.offerings?.length ? [["产品介绍", <ul key="offerings" className="dossier-products">{explained.offerings.map(p => <li key={p.id}><b>{p.name}</b>{p.description.text}{cite(p.description)}</li>)}</ul>] as [string, ReactNode]] : []),
    ...explained.sections.map((section): [string, ReactNode] => [section.title, <DossierSection key={section.id} section={section} cite={cite} />]),
  ];
}

/** Steps read as a numbered chain, a list as named entries, prose as plain statements. */
function DossierSection({ section, cite }: { section: ExplainerSection; cite: (claim: ExplainerClaim) => ReactNode }) {
  if (section.layout === "steps") return <ol className="dossier-steps">{section.items.map((i, n) => <li key={n}>{i.label && <b>{i.label}</b>}{i.claim.text}{cite(i.claim)}</li>)}</ol>;
  if (section.layout === "list") return <ul className="dossier-products">{section.items.map((i, n) => <li key={n}><b>{i.label}</b>{i.claim.text}{cite(i.claim)}</li>)}</ul>;
  return <>{section.items.map((i, n) => <p key={n} className="dossier-prose">{i.label && <b>{i.label}：</b>}{i.claim.text}{cite(i.claim)}</p>)}</>;
}
