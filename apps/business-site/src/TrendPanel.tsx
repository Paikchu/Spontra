import { useMemo, useState, type CSSProperties } from "react";
import type { RevenueHistory } from "@/shared/analysis-contract/revenue-history";
import type { BusinessFlowQuarter } from "@/shared/analysis-contract/business-flow";
import { compactFlowValue } from "@/lib/earning-report/web/business-flow-layout";
import { disclosedSegmentLabel } from "@/lib/earning-report/web/business-flow-model";
import { buildBridge, buildColumns, buildSlots, columnIndex, growth, layerOrder, niceTicks, type Bridge, type Column, type Layer, type TrendItem } from "./trend-model";

const SHADES = [100, 66, 44, 30];
const shortPeriod = (end: string) => end.slice(0, 7).replace("-", ".");
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
export function TrendPanel({ history, items, selected, currentPeriod, periods, onPickPeriod, hue }: {
  history: RevenueHistory;
  items: TrendItem[];
  selected: TrendItem | null;
  currentPeriod: string | null;
  periods: Set<string>;
  onPickPeriod: (periodEnd: string) => void;
  hue: (slot: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [view, setView] = useState<"trend" | "bridge">("trend");
  const [chosenLag, setLag] = useState<1 | 4 | null>(null);
  const slots = useMemo(() => buildSlots(history), [history]);
  const columns = useMemo(() => buildColumns(slots, items, selected), [slots, items, selected]);
  const order = useMemo(() => layerOrder(items), [items]);
  const ticks = niceTicks(Math.max(0, ...columns.map(c => c.total ?? 0)));
  const scale = ticks.at(-1)!;
  const unit = history.quarters.at(-1)!;
  const money = (v: number | null) => compactFlowValue(v, { currency: unit.currency, scale: unit.scale } as BusinessFlowQuarter);
  const known = columns.filter(c => c.total != null);
  const last = columns.at(-1)?.total ?? null, yearAgo = columns.at(-5)?.total ?? null;
  const yoy = growth(last, yearAgo), span = known.length > 1 ? growth(known.at(-1)!.total, known[0].total) : null;
  const mode = selected?.key ?? "all";
  const legend = selected ? (columns.find(c => c.layers.length > 1)?.layers ?? []) : columns.findLast(c => c.state === "ok")?.layers ?? [];
  const index = columnIndex(columns, currentPeriod);
  // Year over year unless that quarter is missing, until the reader picks a base.
  const lag = chosenLag ?? (buildBridge(columns, index, 4) ? 4 : 1);
  const bridge = useMemo(() => buildBridge(columns, index, lag), [columns, index, lag]);
  const subject = selected?.name ?? "全部业务";

  return <section className="trend" aria-label={`${selected?.name ?? "全部业务"} 近 ${slots.length} 季收入`} onMouseLeave={() => setHover(null)}>
    <header className="trend-head">
      <div className="trend-title">
        <div className="trend-heading">
          <h2 key={mode}>{subject}</h2>
          <span className="trend-views" role="radiogroup" aria-label="收入视图">
            <button type="button" role="radio" aria-checked={view === "trend"} onClick={() => setView("trend")}>近 {slots.length} 季收入</button>
            <button type="button" role="radio" aria-checked={view === "bridge"} onClick={() => setView("bridge")}>增长来源</button>
          </span>
        </div>
        <div className="trend-legend" key={"legend" + mode + view}>
          {view === "trend" && legend.length > 1 && legend.map(layer => <span key={layer.key}><i style={{ background: layerColor(layer, hue) }} />{layer.name}</span>)}
          <span className="trend-basis">{view === "trend" ? "按每期财报原披露口径" : bridgeNote(bridge, lag, columns[index - lag])}</span>
        </div>
      </div>
      {view === "trend" ? <dl className="trend-kpis">
        <div><dt>同比</dt><dd data-trend={trend(yoy)}>{percent(yoy)}</dd></div>
        <div><dt>{known.length > 1 ? `${shortPeriod(known[0].slot.periodEnd)} 以来` : "区间"}</dt><dd data-trend={trend(span)}>{percent(span)}</dd></div>
      </dl> : <div className="trend-kpis">
        {bridge && <dl><div><dt>{lag === 4 ? "同比" : "环比"}变化</dt><dd data-trend={trend(bridge.change)}>{signed(bridge.change, money)}<small>{percent(bridge.percent)}</small></dd></div></dl>}
        <span className="periods periods--small" role="radiogroup" aria-label="比较基期">
          <button type="button" role="radio" aria-checked={lag === 4} onClick={() => setLag(4)}>同比</button>
          <button type="button" role="radio" aria-checked={lag === 1} onClick={() => setLag(1)}>环比</button>
        </span>
      </div>}
    </header>
    {view === "bridge" ? <BridgePlot key={mode + lag} bridge={bridge} empty={bridgeNote(bridge, lag, columns[index - lag])} subject={subject} hue={hue} money={money} /> : <div className="trend-plot" role="list">
      <div className="trend-grid" key={scale} aria-hidden="true">
        {ticks.map(t => <div key={t} style={{ bottom: `${t / scale * 100}%` }}><span>{t ? money(t) : ""}</span></div>)}
      </div>
      <i className="trend-sweep" key={"sweep" + mode} aria-hidden="true" />
      {columns.map((column, i) => <Bar key={column.slot.periodEnd} column={column} index={i} order={order} scale={scale} hue={hue} money={money}
        current={column.slot.periodEnd === currentPeriod} pickable={periods.has(column.slot.periodEnd)} hovered={hover === i}
        onHover={() => setHover(i)} onPick={() => onPickPeriod(column.slot.periodEnd)} selected={selected} />)}
    </div>}
  </section>;
}

const signed = (v: number, money: (v: number | null) => string) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${money(Math.abs(v))}`;
const points = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)} 个百分点`;

function bridgeNote(bridge: Bridge | null, lag: 1 | 4, base: Column | undefined) {
  const when = lag === 4 ? "去年同季" : "上一季";
  if (!bridge) return base?.state === "basis" ? `${when}未按此业务口径披露` : `缺少${when}的可核验披露`;
  if (bridge.reason === "basis") return "两期业务口径不同，只比较总额";
  if (bridge.reason === "single") return "该业务未披露下级拆分，只比较总额";
  return "柱长 = 各业务收入变化 · 纵轴不从零开始";
}

/**
 * Revenue bridge: the base quarter's level, one floating step per business sorted by its change, then the current level.
 * The ends are level marks rather than bars, because the axis is cut to the range of the change and a bar would misstate the level.
 */
function BridgePlot({ bridge, empty, subject, hue, money }: { bridge: Bridge | null; empty: string; subject: string; hue: (slot: number) => string; money: (v: number | null) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!bridge) return <div className="bridge-plot bridge-plot--empty"><p>{empty}</p></div>;
  const base = bridge.base.total!, current = bridge.current.total!;
  const levels = [base, current, ...bridge.steps.flatMap(s => [s.before, s.after])];
  const lo = Math.min(...levels), hi = Math.max(...levels), pad = Math.max((hi - lo) * 0.28, Math.abs(hi) * 0.01);
  const y = (v: number) => (v - (lo - pad)) / (hi - lo + 2 * pad) * 100;
  const ends = [
    { key: "base", label: shortPeriod(bridge.base.slot.periodEnd), note: bridge.lag === 4 ? "去年同季" : "上一季", value: base },
    { key: "current", label: shortPeriod(bridge.current.slot.periodEnd), note: "本季", value: current },
  ];
  const end = (end: typeof ends[number], i: number) => <div key={end.key} className="bridge-col bridge-col--end" role="listitem" style={{ "--i": i } as CSSProperties}
    aria-label={`${end.note} ${end.label} ${subject}收入 ${money(end.value)}`}>
    <span className="bridge-level" style={{ bottom: `${y(end.value)}%` }} aria-hidden="true" />
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
        <span className="bridge-step" aria-hidden="true" style={{ bottom: `${y(bottom)}%`, height: `max(2px, ${y(top) - y(bottom)}%)`, background: layerColor(step, hue) }} />
        <span className="bridge-value" data-trend={trend(step.delta)} style={{ bottom: `${y(top)}%` }}>{signed(step.delta, money)}</span>
        <span className="bridge-name" title={step.name}>{step.name}</span>
        {hover === i && <div className="trend-tip" role="presentation">
          <div className="trend-tip-title"><i style={{ background: layerColor(step, hue) }} />{step.name}</div>
          <div className="trend-tip-row"><span>{ends[0].label}</span><b>{money(step.base)}</b></div>
          <div className="trend-tip-row"><span>{ends[1].label}</span><b>{money(step.value)}</b></div>
          <div className="trend-tip-row trend-tip-total"><span>变化</span><b>{signed(step.delta, money)}{growthRate != null && ` (${percent(growthRate)})`}</b></div>
          <p>拉动{subject}收入 {points(share)}</p>
        </div>}
      </div>;
    })}
    {end(ends[1], bridge.steps.length + 1)}
  </div>;
}

function Bar({ column, index, order, scale, hue, money, current, pickable, hovered, onHover, onPick, selected }: {
  column: Column; index: number; order: string[]; scale: number; hue: (slot: number) => string; money: (v: number | null) => string;
  current: boolean; pickable: boolean; hovered: boolean; onHover: () => void; onPick: () => void; selected: TrendItem | null;
}) {
  const q = column.slot.quarter;
  const label = column.state === "missing" ? "该季度未取得可核验披露" : column.state === "basis" ? (selected ? "该期财报未按此业务口径披露" : "该期财报采用不同业务口径，显示公司总收入") : "";
  const height = (column.total ?? 0) / scale * 100;
  return <div className="trend-col" role="listitem" data-state={column.state} data-current={current || undefined} data-align={index < 2 ? "start" : index > 5 ? "end" : undefined} style={{ "--i": index } as CSSProperties} onMouseEnter={onHover}>
    <button type="button" className="trend-hit" disabled={!pickable} onClick={onPick} onFocus={onHover}
      aria-label={`${shortPeriod(column.slot.periodEnd)} ${column.total != null ? money(column.total) : label}${pickable ? "，在流向图中查看该季度" : ""}`} />
    <span className="trend-value" style={{ bottom: `${height}%` }}>{column.total != null ? money(column.total) : "—"}</span>
    <span className="trend-stack" aria-hidden="true">
      {order.map(key => {
        const layer = column.layers.find(l => l.key === key);
        return <i key={key} data-on={layer ? "" : undefined} data-tone={layer?.tone} style={{ height: `${(layer?.value ?? 0) / scale * 100}%`, ...(layer ? { background: layerColor(layer, hue) } : {}) }} />;
      })}
      {!column.layers.length && <i className="trend-ghost" />}
    </span>
    <span className="trend-period">{shortPeriod(column.slot.periodEnd)}{current && <b>本季</b>}</span>
    {hovered && <div className="trend-tip" role="presentation">
      <div className="trend-tip-title">{q ? `${q.periodStart} — ${q.periodEnd}` : shortPeriod(column.slot.periodEnd)}</div>
      {column.layers.length > 1 && column.layers.map(layer => <div className="trend-tip-row" key={layer.key}><span><i style={{ background: layerColor(layer, hue) }} />{layer.name}</span><b>{money(layer.value)}</b></div>)}
      {column.total != null && <div className="trend-tip-row trend-tip-total"><span>{selected ? "业务收入" : "总收入"}</span><b>{money(column.total)}</b></div>}
      {label && <p>{label}{column.state === "basis" && q && !selected ? `：${q.segments.map(s => disclosedSegmentLabel(s.name)).join("、")}` : ""}</p>}
      {q && <p className="trend-tip-source">{q.basis === "derived" ? "第四季度 = 全年 − 前三季度累计 · " : ""}SEC {q.source.form} · {q.source.filedAt}</p>}
    </div>}
  </div>;
}
