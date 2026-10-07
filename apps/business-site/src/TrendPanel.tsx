import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ChartContainer, ChartLegendContent, ChartTooltipContent, useChart, type ChartConfig } from "@/components/ui/chart";
import React, { useMemo, useState, type CSSProperties } from "react";
import type { RevenueHistory } from "@/shared/analysis-contract/revenue-history";
import type { BusinessFlowQuarter } from "@/shared/analysis-contract/business-flow";
import { compactFlowValue } from "@/lib/earning-report/web/business-flow-layout";
import { disclosedSegmentLabel } from "@/lib/earning-report/web/business-flow-model";
import type { GuidancePublication } from "@/shared/analysis-contract/guidance";
import { SLOTS, ACTION_NAMES, buildBridge, buildColumns, buildSlots, columnIndex, growth, growthSeries, guidanceLabel, guidanceOverlay, layerOrder, niceTicks, rateTicks, type Bridge, type Column, type GuideMark, type Layer, type TrendItem } from "./trend-model";

const SHADES = [100, 66, 44, 30];
const shortPeriod = (end: string) => end.slice(0, 7).replace("-", ".");
const periodLabel = (end: string) => <time dateTime={end}><span>{end.slice(0, 4)}</span><span className="trend-period-month">{end.slice(5, 7)}</span></time>;
const percent = (v: number | null) => v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}%`;
const trend = (v: number | null) => v == null || v === 0 ? undefined : v > 0 ? "up" : "down";

function layerColor(layer: Layer, hue: (slot: number) => string) {
  if (layer.tone === "total") return "var(--biz-0)";
  return `color-mix(in srgb, ${hue(layer.slot)} ${SHADES[Math.min(layer.shade, SHADES.length - 1)]}%, var(--background))`;
}

/**
 * Eight quarterly bars that morph rather than remount: every column always renders every layer, and a
 * focus change only moves heights, so "all businesses" collapses into the selected business continuously.
 */
export function TrendPanel({ history, items, selected, currentPeriod, periods, onPickPeriod, hue, guidance = null }: {
  history: RevenueHistory;
  /** Management guidance; quarterly revenue ranges are drawn on the bars, longer horizons listed below. */
  guidance?: GuidancePublication | null;
  items: TrendItem[];
  selected: TrendItem | null;
  currentPeriod: string | null;
  periods: Set<string>;
  onPickPeriod: (periodEnd: string) => void;
  hue: (slot: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  /** Which series the pointer is on; it and its axis stay lit while the other recedes. */
  const [series, setSeries] = useState<"bar" | "line" | null>(null);
  const [view, setView] = useState<"trend" | "bridge">("trend");
  const [chosenLag, setLag] = useState<1 | 4 | null>(null);
  // Retain a full prior year for comparisons, while bars, guidance and interval KPIs show only eight quarters.
  const historySlots = useMemo(() => buildSlots(history, SLOTS + 4), [history]);
  const historyColumns = useMemo(() => buildColumns(historySlots, items, selected), [historySlots, items, selected]);
  const slots = useMemo(() => historySlots.slice(-SLOTS), [historySlots]);
  const columns = useMemo(() => historyColumns.slice(-SLOTS), [historyColumns]);
  const order = useMemo(() => layerOrder(items, columns), [items, columns]);
  const overlay = useMemo(() => guidanceOverlay(slots, guidance, selected), [slots, guidance, selected]);
  const guided = [...overlay.bySlot, overlay.next].filter((m): m is GuideMark => m != null);
  const ticks = niceTicks(Math.max(0, ...columns.map(c => c.total ?? 0), ...guided.map(m => m.high)));
  const scale = ticks.at(-1)!;
  const unit = historySlots.at(-1)!.quarter!;
  const money = (v: number | null) => compactFlowValue(v, { currency: unit.currency, scale: unit.scale } as BusinessFlowQuarter);
  const guidanceMoney = (v: number | null) => compactFlowValue(v, { currency: "USD", scale: 1 } as BusinessFlowQuarter);
  const known = columns.filter(c => c.total != null);
  const last = columns.at(-1)?.total ?? null, yearAgo = columns.at(-5)?.total ?? null;
  const yoy = growth(last, yearAgo), span = known.length > 1 ? growth(known.at(-1)!.total, known[0].total) : null;
  const mode = selected?.key ?? "all";
  const legend = useMemo(() => selected ? (columns.find(c => c.layers.length > 1)?.layers ?? [])
    : [...new Map([...columns].reverse().flatMap(column => column.layers.filter(layer => layer.tone !== "total")).map(layer => [layer.key, layer])).values()], [selected, columns]);
  const index = columnIndex(columns, currentPeriod);
  const historyIndex = index + historyColumns.length - columns.length;
  // Year over year unless that quarter is missing, until the reader picks a base.
  const lag = chosenLag ?? (buildBridge(historyColumns, historyIndex, 4) ? 4 : 1);
  const bridge = useMemo(() => buildBridge(historyColumns, historyIndex, lag), [historyColumns, historyIndex, lag]);
  // The growth line has its own default: year over year needs four earlier quarters, so a short history reads quarter over quarter.
  const lineLag = chosenLag ?? (growthSeries(historyColumns, 4).slice(-SLOTS).filter(v => v != null).length >= 2 ? 4 : 1);
  const rates = useMemo(() => growthSeries(historyColumns, lineLag).slice(-SLOTS), [historyColumns, lineLag]);
  const rateCount = rates.filter(rate => rate != null).length;
  const rateAxis = useMemo(() => rateTicks(rates), [rates]);
  const rateY = (v: number) => rateAxis ? (v - rateAxis[0]) / (rateAxis[3] - rateAxis[0]) * 100 : 0;
  const rateName = lineLag === 4 ? "同比增速" : "环比增速";
  const lagSwitch = (value: 1 | 4) => <ToggleGroup type="single" variant="unstyled" rovingFocus={false} value={String(value)} onValueChange={next => { if (next) setLag(next === "4" ? 4 : 1); }} asChild>
    <span className="periods periods--small" role="radiogroup" aria-label="比较基期">
      <ToggleGroupItem value="4" role="radio" aria-checked={value === 4}>同比</ToggleGroupItem>
      <ToggleGroupItem value="1" role="radio" aria-checked={value === 1}>环比</ToggleGroupItem>
    </span>
  </ToggleGroup>;
  const subject = selected?.name ?? "全部业务";
  const lineColor = selected ? hue(selected.slot) : "var(--foreground)";

  const chartConfig = useMemo<ChartConfig>(() => ({
    ...Object.fromEntries(historyColumns.flatMap(column => column.layers).map(layer => [layer.key, { label: layer.name, color: layerColor(layer, hue) }])),
    growth: { label: rateName, color: lineColor },
  }), [historyColumns, hue, rateName, lineColor]);

  return <ChartContainer asChild config={chartConfig}><section className="trend" data-view={view} data-outlook={view === "trend" && overlay.outlook.length ? "" : undefined} aria-label={`${selected?.name ?? "全部业务"} 近 ${slots.length} 季收入`} onMouseLeave={() => { setHover(null); setSeries(null); }}>
    <header className="trend-head">
      <div className="trend-title">
        <div className="trend-heading">
          <h2 key={mode}>{subject}</h2>
          <ToggleGroup type="single" variant="unstyled" rovingFocus={false} value={view} onValueChange={next => { if (next) setView(next as "trend" | "bridge"); }} asChild>
            <span className="trend-views" role="radiogroup" aria-label="收入视图">
              <ToggleGroupItem value="trend" role="radio" aria-checked={view === "trend"}>近 {slots.length} 季收入</ToggleGroupItem>
              <ToggleGroupItem value="bridge" role="radio" aria-checked={view === "bridge"}>增长来源</ToggleGroupItem>
            </span>
          </ToggleGroup>
        </div>
        <ChartLegendContent asChild key={"legend" + mode + view}><div className="trend-legend">
          {view === "trend" && legend.length > 1 && legend.map(layer => <span key={layer.key}><i style={{ background: chartConfig[layer.key]?.color ?? layerColor(layer, hue) }} />{layer.name}</span>)}
          {view === "trend" && rateAxis && <span className="trend-legend-line" style={{ "--line": lineColor } as CSSProperties}><i />{rateName} · 右轴{rateCount < slots.length ? ` · ${rateCount}/${slots.length} 季可比` : ""}</span>}
          {view === "trend" && guided.length > 0 && <span className="trend-legend-guide"><i />管理层指引区间</span>}
          <span className="trend-basis">{view === "trend" ? `${rateAxis ? "柱：收入 · 左轴 · " : ""}按每期财报原披露口径` : bridgeNote(bridge, lag, historyColumns[historyIndex - lag])}</span>
          {view === "trend" && rateCount < slots.length && <span className="trend-basis">部分季度缺少本期或比较期的同口径收入，增速留空</span>}
        </div></ChartLegendContent>
      </div>
      {view === "trend" ? <div className="trend-kpis">
        <dl>
          <div><dt>同比</dt><dd data-trend={trend(yoy)}>{percent(yoy)}</dd></div>
          <div><dt>{known.length > 1 ? `${shortPeriod(known[0].slot.periodEnd)} 以来` : "区间"}</dt><dd data-trend={trend(span)}>{percent(span)}</dd></div>
        </dl>
        {lagSwitch(lineLag)}
      </div> : <div className="trend-kpis">
        {bridge && <dl><div><dt>{lag === 4 ? "同比" : "环比"}变化</dt><dd data-trend={trend(bridge.change)}>{signed(bridge.change, money)}<small>{percent(bridge.percent)}</small></dd></div></dl>}
        {lagSwitch(lag)}
      </div>}
    </header>
    {view === "bridge" ? <BridgePlot key={mode + lag} bridge={bridge} empty={bridgeNote(bridge, lag, historyColumns[historyIndex - lag])} subject={subject} hue={hue} money={money} /> : <>
    <div className="trend-plot" role="list" data-series={series ?? undefined} data-rates={rateAxis ? "" : undefined} style={{ "--line": lineColor, "--cols": columns.length + (overlay.next ? 1 : 0) } as CSSProperties}
      onMouseMove={e => setSeries((e.target as Element).closest("[data-series-line]") ? "line" : (e.target as Element).closest(".trend-col") ? "bar" : null)}>
      <div className="trend-grid" key={scale} aria-hidden="true">
        {ticks.map((t, k) => <div key={t} style={{ bottom: `${t / scale * 100}%` }}><span>{t ? money(t) : ""}</span>{rateAxis && <em>{axisPercent(rateAxis[k])}</em>}</div>)}
      </div>
      <i className="trend-sweep" key={"sweep" + mode} aria-hidden="true" />
      {columns.map((column, i) => <Bar key={column.slot.periodEnd} column={column} index={i} order={order} scale={scale} hue={hue} money={money}
        current={column.slot.periodEnd === currentPeriod} pickable={periods.has(column.slot.periodEnd)} hovered={hover === i}
        onHover={() => setHover(i)} onPick={() => onPickPeriod(column.slot.periodEnd)} selected={selected} rate={rates[i]} lag={lineLag} onLine={series === "line"}
        line={rateAxis ? { y: rateY(rates[i] ?? 0), next: rates[i + 1] != null ? rateY(rates[i + 1]!) : null, labelled: i === index || (hover === i && series === "line") } : null}
        guide={overlay.bySlot[i]} />)}
      {overlay.next && <GuideColumn mark={overlay.next} index={columns.length} scale={scale} money={money} hovered={hover === columns.length} onHover={() => setHover(columns.length)} />}
    </div>
    {overlay.outlook.length > 0 && <p className="trend-outlook" aria-label="管理层年度与长期指引">
      <span>管理层指引 · {overlay.outlook[0].issuedAt}</span>
      {overlay.outlook.map(item => <span key={item.id} title={item.text}><b>{guidanceLabel(item, guidanceMoney)}</b>{item.action && item.previous && <em data-action={item.action}>{ACTION_NAMES[item.action]}</em>}</span>)}
    </p>}
    </>}
  </section></ChartContainer>;
}

const signed = (v: number, money: (v: number | null) => string) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${money(Math.abs(v))}`;
const axisPercent = (v: number) => `${v < 0 ? "−" : ""}${Number(Math.abs(v).toFixed(1))}%`;
const points = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)} 个百分点`;

function bridgeNote(bridge: Bridge | null, lag: 1 | 4, base: Column | undefined) {
  const when = lag === 4 ? "去年同季" : "上一季";
  if (!bridge) return base?.state === "basis" ? `${when}未按此业务口径披露` : `缺少${when}的可核验披露`;
  if (bridge.reason === "basis") return "两期业务口径不同，只比较总额";
  if (bridge.reason === "single") return "该业务未披露下级拆分，只比较总额";
  return "两端为收入总额 · 中间为各业务的增减 · 纵轴截断";
}

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
    { key: "base", label: shortPeriod(bridge.base.slot.periodEnd), note: bridge.lag === 4 ? "去年同季" : "上一季", value: base },
    { key: "current", label: shortPeriod(bridge.current.slot.periodEnd), note: "本季", value: current },
  ];
  const end = (end: typeof ends[number], i: number) => <div key={end.key} className="bridge-col bridge-col--end" role="listitem" style={{ "--i": i } as CSSProperties}
    aria-label={`${end.note} ${end.label} ${subject}收入 ${money(end.value)}`}>
    <span className="bridge-total" data-cut={cut || undefined} style={{ height: `${y(end.value)}%` }} aria-hidden="true" />
    <span className="bridge-value" style={{ bottom: `${y(end.value)}%` }}>{money(end.value)}</span>
    <span className="bridge-name"><span className="bridge-period">{end.label}</span><b>{end.note}</b></span>
  </div>;
  return <div className="bridge-plot" role="list" aria-label={`${subject}收入从${ends[0].label}到${ends[1].label}的变化来源`} style={{ "--cols": bridge.steps.length + 2 } as CSSProperties} onMouseLeave={() => setHover(null)}>
    {end(ends[0], 0)}
    {bridge.steps.map((step, i) => {
      const top = Math.max(step.before, step.after), bottom = Math.min(step.before, step.after);
      const share = bridge.base.total ? step.delta / bridge.base.total * 100 : 0;
      const growthRate = growth(step.value, step.base);
      return <div key={step.key} className="bridge-col" role="listitem" tabIndex={0} style={{ "--i": i + 1 } as CSSProperties}
        data-align={i < 1 ? "start" : i >= bridge.steps.length - 1 ? "end" : undefined}
        onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
        aria-label={`${step.name} ${signed(step.delta, money)}，拉动 ${points(share)}`}>
        <span className="bridge-link" style={{ bottom: `${y(step.before)}%` }} aria-hidden="true" />
        <span className="bridge-step" aria-hidden="true" style={{ bottom: `${y(bottom)}%`, height: `max(2px, ${y(top) - y(bottom)}%)`, background: config[step.key]?.color ?? layerColor(step, hue) }} />
        <span className="bridge-value" data-trend={trend(step.delta)} style={{ bottom: `${y(top)}%` }}>{signed(step.delta, money)}</span>
        <span className="bridge-name" title={step.name}>{step.name}</span>
        {hover === i && <ChartTooltipContent asChild><div className="trend-tip" role="presentation">
          <div className="trend-tip-title"><i style={{ background: config[step.key]?.color ?? layerColor(step, hue) }} />{step.name}</div>
          <div className="trend-tip-row"><span>{ends[0].label}</span><b>{money(step.base)}</b></div>
          <div className="trend-tip-row"><span>{ends[1].label}</span><b>{money(step.value)}</b></div>
          <div className="trend-tip-row trend-tip-total"><span>变化</span><b>{signed(step.delta, money)}{growthRate != null && ` (${percent(growthRate)})`}</b></div>
          <p>拉动{subject}收入 {points(share)}</p>
        </div></ChartTooltipContent>}
      </div>;
    })}
    {end(ends[1], bridge.steps.length + 1)}
  </div>;
}

function Bar({ column, index, order, scale, hue, money, current, pickable, hovered, onHover, onPick, selected, rate, lag, line, onLine, guide }: {
  column: Column; index: number; order: string[]; scale: number; hue: (slot: number) => string; money: (v: number | null) => string;
  current: boolean; pickable: boolean; hovered: boolean; onHover: () => void; onPick: () => void; selected: TrendItem | null; rate: number | null; lag: 1 | 4;
  /** Growth point on the right axis (percent of plot height) and the segment to the next quarter; null without a right axis. */
  line: { y: number; next: number | null; labelled: boolean } | null;
  /** The pointer is on the growth line: the tooltip leads with the rate and drops the business split. */
  onLine: boolean;
  /** The last range management guided for this quarter. */
  guide: GuideMark | null;
}) {
  const { config } = useChart();
  const q = column.slot.quarter;
  const label = column.state === "missing" ? (column.slot.missingReason === "currency" ? "该季度披露币种不同，未作汇率换算，金额与增速留空" : "该季度未取得可核验披露") : column.state === "basis" ? (selected ? "该期财报未按此业务口径披露" : q?.revenueAdjustments?.length ? "分部含内部交易，此柱展示抵销后的合并收入；选择业务可查看分部收入" : column.layers.length > 1 ? "该期按原披露分类展示，未推定当前业务拆分" : "该期仅取得可核验的公司总收入") : "";
  const height = (column.total ?? 0) / scale * 100;
  const nearBarLabel = line != null && Math.abs(line.y - height) < 16;
  return <div className="trend-col" role="listitem" data-state={column.state} data-current={current || undefined} data-align={index < 2 ? "start" : index > 5 ? "end" : undefined} style={{ "--i": index } as CSSProperties} onMouseEnter={onHover}>
    <Button variant="unstyled" type="button" className="trend-hit" disabled={!pickable} onClick={onPick} onFocus={onHover}
      aria-label={`${shortPeriod(column.slot.periodEnd)} ${column.total != null ? money(column.total) : ""}${label ? `，${label}` : ""}${guide ? `，指引 ${money(guide.low)}–${money(guide.high)}` : ""}${pickable ? "，在流向图中查看该季度" : ""}`} />
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
    <span className="trend-period">{periodLabel(column.slot.periodEnd)}{current && <b>本季</b>}</span>
    {hovered && <ChartTooltipContent asChild><div className="trend-tip" role="presentation">
      <div className="trend-tip-title">{q ? `${q.periodStart} — ${q.periodEnd}` : shortPeriod(column.slot.periodEnd)}</div>
      {onLine && rate != null && <div className="trend-tip-row trend-tip-lead"><span>{lag === 4 ? "同比增速" : "环比增速"}</span><b data-trend={trend(rate)}>{percent(rate)}</b></div>}
      {!onLine && column.layers.length > 1 && column.layers.map(layer => <div className="trend-tip-row" key={layer.key}><span><i style={{ background: config[layer.key]?.color ?? layerColor(layer, hue) }} />{layer.name}</span><b>{money(layer.value)}</b></div>)}
      {column.total != null && <div className="trend-tip-row trend-tip-total"><span>{selected ? "业务收入" : "总收入"}</span><b>{money(column.total)}</b></div>}
      {!onLine && rate != null && <div className="trend-tip-row"><span>{lag === 4 ? "同比" : "环比"}</span><b data-trend={trend(rate)}>{percent(rate)}</b></div>}
      {!onLine && guide && <div className="trend-tip-row"><span>{guide.derived ? "指引（按增速换算）" : "指引"}</span><b>{money(guide.low)}–{money(guide.high)}</b></div>}
      {!onLine && guide && column.total != null && <p>{column.total > guide.high ? "高于指引上限" : column.total < guide.low ? "低于指引下限" : "落在指引区间内"} · 指引发布于 {guide.item.issuedAt}</p>}
      {label && <p>{label}{column.state === "basis" && q && !selected ? `：${q.segments.map(s => disclosedSegmentLabel(s.name)).join("、")}` : ""}</p>}
      {q && <p className="trend-tip-source">{q.basis === "derived" ? "第四季度 = 全年 − 前三季度累计 · " : ""}SEC {q.source.form} · {q.source.filedAt}</p>}
    </div></ChartTooltipContent>}
  </div>;
}

/** The next quarter, which has guidance but no result yet: a dashed range rather than a bar. */
function GuideColumn({ mark, index, scale, money, hovered, onHover }: { mark: GuideMark; index: number; scale: number; money: (v: number | null) => string; hovered: boolean; onHover: () => void }) {
  const { item } = mark;
  return <div className="trend-col trend-col--guide" role="listitem" tabIndex={0} data-align="end" style={{ "--i": index } as CSSProperties} onMouseEnter={onHover} onFocus={onHover}
    aria-label={`${shortPeriod(mark.periodEnd)} 管理层收入指引 ${money(mark.low)}–${money(mark.high)}${mark.derived ? "，按增速换算" : ""}`}>
    {/* An outline up to the low end reads as the expected bar; the solid band is the guided range itself. */}
    <span className="trend-guide-ghost" aria-hidden="true" style={{ height: `${mark.low / scale * 100}%` }} />
    <span className="trend-guide-band" aria-hidden="true" style={{ bottom: `${mark.low / scale * 100}%`, height: `max(3px, ${(mark.high - mark.low) / scale * 100}%)` }} />
    <span className="trend-value" style={{ bottom: `${mark.high / scale * 100}%` }}>指引</span>
    <span className="trend-period">{periodLabel(mark.periodEnd)}<b className="trend-period-guide">指引</b></span>
    {hovered && <ChartTooltipContent asChild><div className="trend-tip" role="presentation">
      <div className="trend-tip-title">{shortPeriod(mark.periodEnd)} 管理层指引</div>
      <div className="trend-tip-row trend-tip-lead"><span>收入</span><b>{money(mark.low)}–{money(mark.high)}</b></div>
      {item.derived && <p>按同比 {Number(item.low!.toFixed(2))}%–{Number(item.high!.toFixed(2))}% 与去年同季 {money(item.derived.base)} 换算</p>}
      {item.action && item.previous && <div className="trend-tip-row"><span>较上次</span><b>{ACTION_NAMES[item.action]}</b></div>}
      <p>“{item.quote}”</p>
      <p className="trend-tip-source">{mark.source ? `${mark.source.title} · ` : ""}{item.issuedAt}</p>
    </div></ChartTooltipContent>}
  </div>;
}
