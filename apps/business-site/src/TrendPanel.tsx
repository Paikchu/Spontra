import { Button } from "@/packages/web/src/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/packages/web/src/ui/toggle-group";
import { ChartContainer, ChartLegendContent, ChartTooltipContent, useChart, type ChartConfig } from "@/packages/web/src/ui/custom-chart";
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { RevenueHistory } from "@/shared/analysis-contract/revenue-history";
import type { BusinessFlowQuarter } from "@/shared/analysis-contract/business-flow";
import { compactFlowValue } from "@/packages/web/src/model/business-flow-layout";
import type { GuidancePublication } from "@/shared/analysis-contract/guidance";
import { getLocale, messages } from "@/packages/web/src/i18n";
import { axisNumber, axisUnit, compactMoney, qoqLabel, range, yoyLabel, shortPeriod } from "@/shared/analysis-runtime/locale";
import { QuarterBadge, fiscalPhrase } from "./PeriodMark";
import { MomentumTag } from "./MomentumTag";
import { momentumOf } from "./momentum";
import { SLOTS, ACTION_NAMES, buildBridge, buildColumns, buildSlots, columnIndex, visibleSlotCount, growth, growthSeries, guidanceLabel, guidanceOverlay, layerOrder, niceTicks, onSameBasis, rateTicks, type Bridge, type Column, type GuideMark, type Layer, type TrendItem } from "./trend-model";

const m = messages({
  yoyGrowth: "YoY growth", qoqGrowth: "QoQ growth", comparisonBase: "Comparison base", allBusinesses: "All businesses",
  revenueOf: (name: string) => `${name} revenue`, totalRevenueLower: "total revenue", trendLabel: (subject: string, n: number) => `${subject}: revenue, last ${n} quarters`,
  revenueView: "Revenue view", revenue: "Revenue", growthDrivers: "Growth drivers", guidanceRange: "Guidance range", totalsOnly: "Totals only",
  since: (period: string) => `Since ${period}`, period: "Period", change: (basis: string) => `${basis} change`,
  noYearAgo: "No comparable year-ago quarter", noPrior: "No comparable prior quarter", outlook: "Management outlook", guidanceIssued: (date: string) => `Guidance · ${date}`,
  pp: " pp", yearAgo: "Year ago", priorQuarter: "Prior quarter", thisQuarter: "This quarter",
  bridgeLabel: (subject: string, from: string, to: string) => `${subject} change, ${from} to ${to}`, changeHead: "Change", contribution: "Contribution",
  otherCurrency: "Other reporting currency", notDisclosed: "Not disclosed", notReported: "Not reported", afterEliminations: "Consolidated revenue after adjustments",
  segmentsAsReported: "Segments as reported", totalOnly: "Total revenue only", guidanceAria: (low: string, high: string) => `, guidance ${low}–${high}`,
  businessRevenue: "Business revenue", totalRevenue: "Total revenue", guidanceDerived: "Guidance (from growth rate)", guidance: "Guidance",
  aboveRange: "Above range", belowRange: "Below range", withinRange: "Within range", issued: (date: string) => `Issued ${date}`, derivedQ4: "Derived Q4 · ",
  guideAria: (period: string, low: string, high: string, derived: boolean) => `${period} management revenue guidance ${low}–${high}${derived ? ", from growth rate" : ""}`,
  managementGuidance: (period: string) => `${period} management guidance`, guidedYoy: "Guided YoY", yearAgoBase: "Year-ago base", vsPrevious: "vs. previous",
  secFiling: (form: string, filed: string) => `SEC ${form} · ${filed}`,
  comma: ", ",
  basisChanged: "Segments re-based", basisWhy: (since: string) => `Segments reported on a new basis from ${since}. Growth by business is only computed within one basis; a year-ago quarter restated in the latest filing is on the new basis.`,
  earlierBasis: "Earlier segment basis", currentBasis: "Current segment basis",
}, {
  yoyGrowth: "同比增长", qoqGrowth: "环比增长", comparisonBase: "比较基准", allBusinesses: "全部业务",
  revenueOf: (name: string) => `${name} 营收`, totalRevenueLower: "总营收", trendLabel: (subject: string, n: number) => `${subject}：营收，最近 ${n} 个季度`,
  revenueView: "营收视图", revenue: "营收", growthDrivers: "增长来源", guidanceRange: "指引区间", totalsOnly: "仅总额",
  since: (period: string) => `${period} 以来`, period: "区间", change: (basis: string) => `${basis}变化`,
  noYearAgo: "无可比的上年同期季度", noPrior: "无可比的上一季度", outlook: "管理层展望", guidanceIssued: (date: string) => `业绩指引 · ${date}`,
  pp: "个百分点", yearAgo: "上年同期", priorQuarter: "上一季度", thisQuarter: "本季度",
  bridgeLabel: (subject: string, from: string, to: string) => `${subject}变化，${from} 至 ${to}`, changeHead: "变化", contribution: "贡献",
  otherCurrency: "其他报告货币", notDisclosed: "未披露", notReported: "未报告", afterEliminations: "调节后的合并营收",
  segmentsAsReported: "按披露的分部", totalOnly: "仅披露总营收", guidanceAria: (low: string, high: string) => `，业绩指引 ${low}–${high}`,
  businessRevenue: "业务营收", totalRevenue: "总营收", guidanceDerived: "业绩指引（按增长率推算）", guidance: "业绩指引",
  aboveRange: "高于指引区间", belowRange: "低于指引区间", withinRange: "处于指引区间", issued: (date: string) => `发布于 ${date}`, derivedQ4: "推算 Q4 · ",
  guideAria: (period: string, low: string, high: string, derived: boolean) => `${period} 管理层营收指引 ${low}–${high}${derived ? "，按增长率推算" : ""}`,
  managementGuidance: (period: string) => `${period} 管理层指引`, guidedYoy: "指引同比", yearAgoBase: "上年同期基数", vsPrevious: "较前次",
  secFiling: (form: string, filed: string) => `SEC ${form} · ${filed}`,
  comma: "，",
  basisChanged: "分部口径已调整", basisWhy: (since: string) => `自 ${since} 起按新分部口径披露。分业务的增速只在同一口径内计算；最新财报按新口径重算的上年同期数属于新口径。`,
  earlierBasis: "原分部口径", currentBasis: "现分部口径",
});

/** An amount in the reader's number form; English keeps the flow chart's own formatter. */
function flowMoney(v: number | null, currency: string, scale: number): string {
  const locale = getLocale();
  if (locale === "en") return compactFlowValue(v, { currency, scale } as BusinessFlowQuarter);
  return v == null || !Number.isFinite(v) ? m.notDisclosed : compactMoney(v * scale, currency, locale);
}

const SHADES = [100, 66, 44, 30];
const periodLabel = (end: string) => <time dateTime={end}><span>{end.slice(0, 4)}</span><span className="trend-period-month">{end.slice(5, 7)}</span></time>;
const percent = (v: number | null) => v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}%`;
const trend = (v: number | null) => v == null || v === 0 ? undefined : v > 0 ? "up" : "down";

function layerColor(layer: Layer, hue: (slot: number) => string) {
  if (layer.tone === "total") return "var(--biz-0)";
  return `color-mix(in srgb, ${hue(layer.slot)} ${SHADES[Math.min(layer.shade, SHADES.length - 1)]}%, var(--background))`;
}

/**
 * Up to five quarterly bars (fewer for a short disclosure history) that morph rather than remount: every column always renders every layer, and a
 * focus change only moves heights, so "all businesses" collapses into the selected business continuously.
 */
export function TrendPanel({ history, items, selected, currentPeriod, periods, onPickPeriod, hue, guidance = null, picker = null, ticker }: {
  history: RevenueHistory;
  /** Metric picker beside the heading; switching away from revenue replaces this panel with a company-level metric. */
  picker?: ReactNode;
  /** Management guidance; quarterly revenue ranges are drawn on the bars, longer horizons listed below. */
  guidance?: GuidancePublication | null;
  items: TrendItem[];
  selected: TrendItem | null;
  currentPeriod: string | null;
  periods: Set<string>;
  onPickPeriod: (periodEnd: string) => void;
  hue: (slot: number) => string;
  ticker: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  /** Which series the pointer is on; it and its axis stay lit while the other recedes. */
  const [series, setSeries] = useState<"bar" | "line" | null>(null);
  const [view, setView] = useState<"trend" | "bridge">("trend");
  const [chosenLag, setLag] = useState<1 | 4 | null>(null);
  // Retain a full prior year for comparisons, while bars, guidance and interval KPIs show only the visible quarters.
  const historySlots = useMemo(() => buildSlots(history, SLOTS + 4), [history]);
  const historyColumns = useMemo(() => buildColumns(historySlots, items, selected), [historySlots, items, selected]);
  const visible = visibleSlotCount(historySlots);
  const slots = useMemo(() => historySlots.slice(historySlots.length - visible), [historySlots, visible]);
  const columns = useMemo(() => historyColumns.slice(historyColumns.length - visible), [historyColumns, visible]);
  const order = useMemo(() => layerOrder(items, columns), [items, columns]);
  const overlay = useMemo(() => guidanceOverlay(slots, guidance, selected), [slots, guidance, selected]);
  const guided = [...overlay.bySlot, overlay.next].filter((m): m is GuideMark => m != null);
  const ticks = niceTicks(Math.max(0, ...columns.map(c => c.total ?? 0), ...guided.map(m => m.high)));
  const scale = ticks.at(-1)!;
  const unit = historySlots.at(-1)!.quarter!;
  const money = (v: number | null) => flowMoney(v, unit.currency, unit.scale);
  const guidanceMoney = (v: number | null) => flowMoney(v, "USD", 1);
  const known = columns.filter(c => c.total != null);
  const last = historyColumns.at(-1)?.total ?? null, yearAgo = historyColumns.at(-5)?.total ?? null;
  // A business's change is read within one segment basis only; the company's total is the same on any basis.
  const comparable = (a: Column | undefined, b: Column | undefined) => !selected || (!!a && !!b && onSameBasis(a, b));
  const yoy = comparable(historyColumns.at(-1), historyColumns.at(-5)) ? growth(last, yearAgo) : null;
  const span = known.length > 1 && comparable(known.at(-1), known[0]) ? growth(known.at(-1)!.total, known[0].total) : null;
  const mode = selected?.key ?? "all";
  const legend = useMemo(() => selected ? (columns.find(c => c.layers.length > 1)?.layers ?? [])
    : [...new Map([...columns].reverse().flatMap(column => column.layers.filter(layer => layer.tone !== "total")).map(layer => [layer.key, layer])).values()], [selected, columns]);
  const index = columnIndex(columns, currentPeriod);
  const historyIndex = index + historyColumns.length - columns.length;
  // Year over year unless that quarter is missing, until the reader picks a base.
  const lag = chosenLag ?? (buildBridge(historyColumns, historyIndex, 4) ? 4 : 1);
  const bridge = useMemo(() => buildBridge(historyColumns, historyIndex, lag), [historyColumns, historyIndex, lag]);
  // The growth line has its own default: year over year needs four earlier quarters, so a short history reads quarter over quarter.
  const lineLag = chosenLag ?? (growthSeries(historyColumns, 4, !!selected).slice(-visible).filter(v => v != null).length >= 2 ? 4 : 1);
  const rates = useMemo(() => growthSeries(historyColumns, lineLag, !!selected).slice(-visible), [historyColumns, lineLag, visible, selected]);
  // A re-segmentation inside the bars drawn: the first quarter on the current basis after one on an earlier basis.
  const rebased = columns.some(c => c.segmentBasis === "earlier") && columns.some(c => c.segmentBasis === "current");
  const basisSince = rebased ? columns.find((c, i) => c.segmentBasis === "current" && columns.slice(0, i).some(p => p.segmentBasis === "earlier"))?.slot.periodEnd ?? null : null;
  const rateAxis = useMemo(() => rateTicks(rates), [rates]);
  const rateY = (v: number) => rateAxis ? (v - rateAxis[0]) / (rateAxis[3] - rateAxis[0]) * 100 : 0;
  const rateName = lineLag === 4 ? m.yoyGrowth : m.qoqGrowth;
  const lagSwitch = (value: 1 | 4) => <ToggleGroup type="single" variant="unstyled" rovingFocus={false} value={String(value)} onValueChange={next => { if (next) setLag(next === "4" ? 4 : 1); }} asChild>
    <span className="periods periods--small" role="radiogroup" aria-label={m.comparisonBase}>
      <ToggleGroupItem value="4" role="radio" aria-checked={value === 4}>{yoyLabel(getLocale())}</ToggleGroupItem>
      <ToggleGroupItem value="1" role="radio" aria-checked={value === 1}>{qoqLabel(getLocale())}</ToggleGroupItem>
    </span>
  </ToggleGroup>;
  const subject = selected?.name ?? m.allBusinesses;
  // How year-over-year growth of the revenue drawn is moving, at the quarter on the stage.
  const momentum = useMemo(() => momentumOf(historyColumns.map(c => ({ periodEnd: c.slot.periodEnd, value: c.total })), currentPeriod), [historyColumns, currentPeriod]);
  const revenueName = selected ? m.revenueOf(selected.name) : m.totalRevenueLower;
  const lineColor = selected ? hue(selected.slot) : "var(--foreground)";

  const chartConfig = useMemo<ChartConfig>(() => ({
    ...Object.fromEntries(historyColumns.flatMap(column => column.layers).map(layer => [layer.key, { label: layer.name, color: layerColor(layer, hue) }])),
    growth: { label: rateName, color: lineColor },
  }), [historyColumns, hue, rateName, lineColor]);

  return <ChartContainer asChild config={chartConfig}><section className="trend" data-view={view} data-outlook={view === "trend" && overlay.outlook.length ? "" : undefined} aria-label={m.trendLabel(subject, slots.length)} onMouseLeave={() => { setHover(null); setSeries(null); }}>
    <header className="trend-head">
      <div className="trend-title">
        <div className="trend-heading">
          <h2 key={mode}>{subject}</h2>
          <MomentumTag momentum={momentum} subject={selected ? m.revenueOf(selected.name) : m.totalRevenueLower} />
          {basisSince && <span className="basis-tag" tabIndex={0} title={m.basisWhy(shortPeriod(basisSince))} aria-label={`${m.basisChanged} · ${m.basisWhy(shortPeriod(basisSince))}`}>{m.basisChanged}</span>}
          {picker}
          <ToggleGroup type="single" variant="unstyled" rovingFocus={false} value={view} onValueChange={next => { if (next) setView(next as "trend" | "bridge"); }} asChild>
            <span className="trend-views" role="radiogroup" aria-label={m.revenueView}>
              <ToggleGroupItem value="trend" role="radio" aria-checked={view === "trend"}>{m.revenue}</ToggleGroupItem>
              <ToggleGroupItem value="bridge" role="radio" aria-checked={view === "bridge"}>{m.growthDrivers}</ToggleGroupItem>
            </span>
          </ToggleGroup>
        </div>
        <ChartLegendContent asChild key={"legend" + mode + view}><div className="trend-legend">
          {view === "trend" && legend.length > 1 && legend.map(layer => <span key={layer.key}><i style={{ background: chartConfig[layer.key]?.color ?? layerColor(layer, hue) }} />{layer.name}</span>)}
          {view === "trend" && rateAxis && <span className="trend-legend-line" style={{ "--line": lineColor } as CSSProperties}><i />{rateName}</span>}
          {view === "trend" && guided.length > 0 && <span className="trend-legend-guide"><i />{m.guidanceRange}</span>}
          {view === "trend" && <span className="trend-sub">{axisUnit(unit.currency, getLocale())}</span>}
          {view === "bridge" && bridge && bridge.reason !== "split" && <span className="trend-basis">{m.totalsOnly}</span>}
        </div></ChartLegendContent>
      </div>
      {view === "trend" ? <div className="trend-kpis">
        <dl>
          <div><dt>{yoyLabel(getLocale())}</dt><dd data-trend={trend(yoy)}>{percent(yoy)}</dd></div>
          <div><dt>{known.length > 1 ? m.since(shortPeriod(known[0].slot.periodEnd)) : m.period}</dt><dd data-trend={trend(span)}>{percent(span)}</dd></div>
        </dl>
        {lagSwitch(lineLag)}
      </div> : <div className="trend-kpis">
        {bridge && <dl><div><dt>{m.change(lag === 4 ? yoyLabel(getLocale()) : qoqLabel(getLocale()))}</dt><dd data-trend={trend(bridge.change)}>{signed(bridge.change, money)}<small>{percent(bridge.percent)}</small></dd></div></dl>}
        {lagSwitch(lag)}
      </div>}
    </header>
    {view === "bridge" ? <BridgePlot key={mode + lag} bridge={bridge} empty={lag === 4 ? m.noYearAgo : m.noPrior} subject={revenueName} hue={hue} money={money} /> : <>
    <div className="trend-plot" role="list" data-series={series ?? undefined} data-rates={rateAxis ? "" : undefined} style={{ "--line": lineColor, "--cols": columns.length + (overlay.next ? 1 : 0) } as CSSProperties}
      onMouseMove={e => setSeries((e.target as Element).closest("[data-series-line]") ? "line" : (e.target as Element).closest(".trend-col") ? "bar" : null)}>
      <div className="trend-grid" key={scale} aria-hidden="true">
        {/* Ticks carry the magnitude only; the currency is stated once in the legend, so a tick never outgrows the axis. */}
        {ticks.map((t, k) => <div key={t} style={{ bottom: `${t / scale * 100}%` }}><span>{axisNumber(t * unit.scale, getLocale())}</span>{rateAxis && <em>{axisPercent(rateAxis[k])}</em>}</div>)}
      </div>
      <i className="trend-sweep" key={"sweep" + mode} aria-hidden="true" />
      {columns.map((column, i) => <Bar key={column.slot.periodEnd} column={column} index={i} basisBreak={rebased && !!column.segmentBasis && (() => { const before = columns.slice(0, i).reverse().find(c => c.segmentBasis); return !!before && before.segmentBasis !== column.segmentBasis; })()} order={order} scale={scale} hue={hue} money={money} ticker={ticker}
        current={column.slot.periodEnd === currentPeriod} pickable={periods.has(column.slot.periodEnd)} hovered={hover === i}
        onHover={() => setHover(i)} onPick={() => onPickPeriod(column.slot.periodEnd)} selected={selected} rate={rates[i]} lag={lineLag} onLine={series === "line"}
        line={rateAxis ? { y: rateY(rates[i] ?? 0), next: rates[i + 1] != null ? rateY(rates[i + 1]!) : null, labelled: i === index || series === "line" } : null}
        guide={overlay.bySlot[i]} />)}
      {overlay.next && <GuideColumn mark={overlay.next} index={columns.length} scale={scale} money={money} hovered={hover === columns.length} onHover={() => setHover(columns.length)} />}
    </div>
    {overlay.outlook.length > 0 && <p className="trend-outlook" aria-label={m.outlook}>
      <span>{m.guidanceIssued(overlay.outlook[0].issuedAt)}</span>
      {overlay.outlook.map(item => <span key={item.id} title={item.text}><b>{guidanceLabel(item, guidanceMoney)}</b>{item.action && item.previous && <em data-action={item.action}>{ACTION_NAMES[item.action]}</em>}</span>)}
    </p>}
    </>}
  </section></ChartContainer>;
}

const signed = (v: number, money: (v: number | null) => string) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${money(Math.abs(v))}`;
const axisPercent = (v: number) => `${v < 0 ? "−" : ""}${Number(Math.abs(v).toFixed(1))}%`;
const points = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}${m.pp}`;

/**
 * Revenue bridge: the base quarter's total as a bar, one floating step per business sorted by its change, then the current total.
 * The axis starts above zero so small changes stay visible; the end bars carry a break mark there, and the floor sits well
 * below the lower total so the two ends still read as two large, comparable amounts rather than a short and a tall one.
 */
function BridgePlot({ bridge, empty, subject, hue, money }: { bridge: Bridge | null; empty: string; subject: string; hue: (slot: number) => string; money: (v: number | null) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const { config } = useChart();
  if (!bridge) return <div className="bridge-plot bridge-plot--empty"><p>{empty}</p></div>;
  const base = bridge.base.total!, current = bridge.current.total!;
  const levels = [base, current, ...bridge.steps.flatMap(s => [s.before, s.after])];
  const lo = Math.min(...levels), hi = Math.max(...levels), span = Math.max(hi - lo, Math.abs(hi) * 0.02);
  const floor = lo > 0 ? Math.max(0, lo - span * 1.4) : lo - span * 0.25, ceil = hi + span * 0.18;
  const cut = floor > 0;
  const y = (v: number) => (v - floor) / (ceil - floor) * 100;
  const ends = [
    { key: "base", label: shortPeriod(bridge.base.slot.periodEnd), note: bridge.lag === 4 ? m.yearAgo : m.priorQuarter, value: base },
    { key: "current", label: shortPeriod(bridge.current.slot.periodEnd), note: m.thisQuarter, value: current },
  ];
  const end = (end: typeof ends[number], i: number) => <div key={end.key} className="bridge-col bridge-col--end" role="listitem" style={{ "--i": i } as CSSProperties}
    aria-label={`${end.note} ${end.label} ${subject} ${money(end.value)}`}>
    <span className="bridge-total" data-cut={cut || undefined} style={{ height: `${y(end.value)}%` }} aria-hidden="true" />
    <span className="bridge-value" style={{ bottom: `${y(end.value)}%` }}>{money(end.value)}</span>
    <span className="bridge-name"><span className="bridge-period">{end.label}</span><b>{end.note}</b></span>
  </div>;
  return <div className="bridge-plot" role="list" aria-label={m.bridgeLabel(subject, ends[0].label, ends[1].label)} style={{ "--cols": bridge.steps.length + 2 } as CSSProperties} onMouseLeave={() => setHover(null)}>
    {end(ends[0], 0)}
    {bridge.steps.map((step, i) => {
      const top = Math.max(step.before, step.after), bottom = Math.min(step.before, step.after);
      const share = bridge.base.total ? step.delta / bridge.base.total * 100 : 0;
      const growthRate = growth(step.value, step.base);
      return <div key={step.key} className="bridge-col" role="listitem" tabIndex={0} style={{ "--i": i + 1 } as CSSProperties}
        data-align={i < 1 ? "start" : i >= bridge.steps.length - 1 ? "end" : undefined}
        onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
        aria-label={`${step.name} ${signed(step.delta, money)}, ${points(share)}`}>
        <span className="bridge-link" style={{ bottom: `${y(step.before)}%` }} aria-hidden="true" />
        <span className="bridge-step" aria-hidden="true" style={{ bottom: `${y(bottom)}%`, height: `max(2px, ${y(top) - y(bottom)}%)`, background: config[step.key]?.color ?? layerColor(step, hue) }} />
        <span className="bridge-value" data-trend={trend(step.delta)} style={{ bottom: `${y(top)}%` }}>{signed(step.delta, money)}</span>
        <span className="bridge-name" title={step.name}>{step.name}</span>
        {hover === i && <ChartTooltipContent asChild><div className="trend-tip" role="presentation">
          <div className="trend-tip-title"><i style={{ background: config[step.key]?.color ?? layerColor(step, hue) }} />{step.name}</div>
          <div className="trend-tip-row"><span>{ends[0].label}</span><b>{money(step.base)}</b></div>
          <div className="trend-tip-row"><span>{ends[1].label}</span><b>{money(step.value)}</b></div>
          <div className="trend-tip-row trend-tip-total"><span>{m.changeHead}</span><b>{signed(step.delta, money)}{growthRate != null && ` (${percent(growthRate)})`}</b></div>
          <div className="trend-tip-row"><span>{m.contribution}</span><b>{points(share)}</b></div>
        </div></ChartTooltipContent>}
      </div>;
    })}
    {end(ends[1], bridge.steps.length + 1)}
  </div>;
}

function Bar({ column, index, basisBreak = false, order, scale, hue, money, current, pickable, hovered, onHover, onPick, selected, rate, lag, line, onLine, guide, ticker }: {
  column: Column; index: number; /** The segment basis changes between the split quarter before this one and this one. */ basisBreak?: boolean; order: string[]; scale: number; hue: (slot: number) => string; money: (v: number | null) => string;
  current: boolean; pickable: boolean; hovered: boolean; onHover: () => void; onPick: () => void; selected: TrendItem | null; rate: number | null; lag: 1 | 4; ticker: string;
  /** Growth point on the right axis (percent of plot height) and the segment to the next quarter; null without a right axis. */
  line: { y: number; next: number | null; labelled: boolean } | null;
  /** The pointer is on the growth line: the tooltip leads with the rate and drops the business split. */
  onLine: boolean;
  /** The last range management guided for this quarter. */
  guide: GuideMark | null;
}) {
  const { config } = useChart();
  const q = column.slot.quarter;
  const label = column.state === "missing" ? (column.slot.missingReason === "currency" ? m.otherCurrency : m.notDisclosed) : column.state === "basis" ? (selected ? m.notReported : q?.revenueAdjustments?.length ? m.afterEliminations : column.layers.length > 1 ? m.segmentsAsReported : m.totalOnly) : "";
  const height = (column.total ?? 0) / scale * 100;
  const nearBarLabel = line != null && Math.abs(line.y - height) < 16;
    const fiscal = fiscalPhrase(ticker, column.slot.periodEnd, column.slot.quarter?.periodStart);
    const mark = fiscal.primary ?? fiscal.unknown;
    return <div className="trend-col" role="listitem" data-state={column.state} data-current={current || undefined} data-segment-basis={column.segmentBasis ?? undefined} data-basis-break={basisBreak || undefined} data-align={index < 2 ? "start" : index > 5 ? "end" : undefined} style={{ "--i": index } as CSSProperties} onMouseEnter={onHover}>
    <Button variant="unstyled" type="button" className="trend-hit" disabled={!pickable} onClick={onPick} onFocus={onHover}
      aria-label={`${mark} ${shortPeriod(column.slot.periodEnd)} ${column.total != null ? money(column.total) : ""}${label ? m.comma + label : ""}${guide ? m.guidanceAria(money(guide.low), money(guide.high)) : ""}`} />
    {/* With the growth line drawn, the axes carry the scale and only the current or hovered bar keeps its value label. */}
    <span className="trend-value" data-quiet={line && !current && !(hovered && !onLine) ? "" : undefined} style={{ bottom: `${height}%` }}>{column.total != null ? money(column.total) : "—"}</span>
    <span className="trend-stack" aria-hidden="true">
      {order.map(key => {
        const layer = column.layers.find(l => l.key === key);
        return <i key={key} data-on={layer ? "" : undefined} data-tone={layer?.tone} style={{ height: `${(layer?.value ?? 0) / scale * 100}%`, ...(layer ? { background: config[layer.key]?.color ?? layerColor(layer, hue) } : {}) }} />;
      })}
      {!column.layers.length && <i className="trend-ghost" />}
    </span>
    {guide && <span className="trend-guide" data-derived={guide.derived || undefined} aria-hidden="true"
      style={{ bottom: `${guide.low / scale * 100}%`, height: `${(guide.high - guide.low) / scale * 100}%` }} />}
    {line && rate != null && line.next != null && <svg className="trend-line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" y1={100 - line.y} x2="100" y2={100 - line.next} vectorEffect="non-scaling-stroke" />
      <line className="trend-line-hit" data-series-line="" x1="0" y1={100 - line.y} x2="100" y2={100 - line.next} vectorEffect="non-scaling-stroke" />
    </svg>}
    {line && rate != null && <i className="trend-dot" data-series-line="" data-hover={hovered || undefined} aria-hidden="true" style={{ bottom: `${line.y}%` }} onClick={pickable ? onPick : undefined} />}
    {line?.labelled && rate != null && <span className="trend-rate" data-trend={trend(rate)} data-below={rate < 0 || nearBarLabel || undefined} aria-hidden="true" style={{ bottom: `${nearBarLabel ? Math.min(line.y, height) : line.y}%` }}>{percent(rate)}</span>}
    <QuarterBadge ticker={ticker} periodEnd={column.slot.periodEnd} periodStart={column.slot.quarter?.periodStart} current={current} prefix={m.thisQuarter} />
    {hovered && <ChartTooltipContent asChild><div className="trend-tip" role="presentation">
      <div className="trend-tip-title">{mark}{q ? ` · ${q.periodStart} — ${q.periodEnd}` : ` · ${shortPeriod(column.slot.periodEnd)}`}</div>
      {onLine && rate != null && <div className="trend-tip-row trend-tip-lead"><span>{lag === 4 ? m.yoyGrowth : m.qoqGrowth}</span><b data-trend={trend(rate)}>{percent(rate)}</b></div>}
      {!onLine && column.layers.length > 1 && column.layers.map(layer => <div className="trend-tip-row" key={layer.key}><span><i style={{ background: config[layer.key]?.color ?? layerColor(layer, hue) }} />{layer.name}</span><b>{money(layer.value)}</b></div>)}
      {column.total != null && <div className="trend-tip-row trend-tip-total"><span>{selected ? m.businessRevenue : m.totalRevenue}</span><b>{money(column.total)}</b></div>}
      {!onLine && rate != null && <div className="trend-tip-row"><span>{lag === 4 ? yoyLabel(getLocale()) : qoqLabel(getLocale())}</span><b data-trend={trend(rate)}>{percent(rate)}</b></div>}
      {!onLine && guide && <div className="trend-tip-row"><span>{guide.derived ? m.guidanceDerived : m.guidance}</span><b>{range(money(guide.low), money(guide.high), getLocale())}</b></div>}
      {!onLine && guide && column.total != null && <p>{column.total > guide.high ? m.aboveRange : column.total < guide.low ? m.belowRange : m.withinRange} · {m.issued(guide.item.issuedAt)}</p>}
      {label && <p>{label}{column.state === "basis" && q && !selected ? `: ${q.segments.map(s => s.name).join(", ")}` : ""}</p>}
      {column.segmentBasis === "earlier" && <p className="trend-tip-basis">{m.earlierBasis}</p>}
      {q && <p className="trend-tip-source">{q.basis === "derived" ? m.derivedQ4 : ""}{m.secFiling(q.source.form, q.source.filedAt)}</p>}
    </div></ChartTooltipContent>}
  </div>;
}

/** The next quarter, which has guidance but no result yet: a dashed range rather than a bar. */
function GuideColumn({ mark, index, scale, money, hovered, onHover }: { mark: GuideMark; index: number; scale: number; money: (v: number | null) => string; hovered: boolean; onHover: () => void }) {
  const { item } = mark;
  return <div className="trend-col trend-col--guide" role="listitem" tabIndex={0} data-align="end" style={{ "--i": index } as CSSProperties} onMouseEnter={onHover} onFocus={onHover}
    aria-label={m.guideAria(shortPeriod(mark.periodEnd), money(mark.low), money(mark.high), mark.derived)}>
    {/* An outline up to the low end reads as the expected bar; the solid band is the guided range itself. */}
    <span className="trend-guide-ghost" aria-hidden="true" style={{ height: `${mark.low / scale * 100}%` }} />
    <span className="trend-guide-band" aria-hidden="true" style={{ bottom: `${mark.low / scale * 100}%`, height: `max(3px, ${(mark.high - mark.low) / scale * 100}%)` }} />
    <span className="trend-value" style={{ bottom: `${mark.high / scale * 100}%` }}>{m.guidance}</span>
    <span className="trend-period">{periodLabel(mark.periodEnd)}<b className="trend-period-guide">{m.guidance}</b></span>
    {hovered && <ChartTooltipContent asChild><div className="trend-tip" role="presentation">
      <div className="trend-tip-title">{m.managementGuidance(shortPeriod(mark.periodEnd))}</div>
      <div className="trend-tip-row trend-tip-lead"><span>{m.revenue}</span><b>{range(money(mark.low), money(mark.high), getLocale())}</b></div>
      {item.derived && <div className="trend-tip-row"><span>{m.guidedYoy}</span><b>{Number(item.low!.toFixed(2))}%–{Number(item.high!.toFixed(2))}%</b></div>}
      {item.derived && <div className="trend-tip-row"><span>{m.yearAgoBase}</span><b>{money(item.derived.base)}</b></div>}
      {item.action && item.previous && <div className="trend-tip-row"><span>{m.vsPrevious}</span><b>{ACTION_NAMES[item.action]}</b></div>}
      <p lang="en">“{item.quote}”</p>
      <p className="trend-tip-source">{mark.source ? `${mark.source.title} · ` : ""}{item.issuedAt}</p>
    </div></ChartTooltipContent>}
  </div>;
}
