import { useMemo, useState, type CSSProperties } from "react";
import type { RevenueHistory } from "@/shared/analysis-contract/revenue-history";
import type { BusinessFlowQuarter } from "@/shared/analysis-contract/business-flow";
import { compactFlowValue } from "@/lib/earning-report/web/business-flow-layout";
import { disclosedSegmentLabel } from "@/lib/earning-report/web/business-flow-model";
import { buildColumns, buildSlots, growth, layerOrder, niceTicks, type Column, type Layer, type TrendItem } from "./trend-model";

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

  return <section className="trend" aria-label={`${selected?.name ?? "全部业务"} 近 ${slots.length} 季收入`} onMouseLeave={() => setHover(null)}>
    <header className="trend-head">
      <div className="trend-title">
        <h2 key={mode}>{selected ? selected.name : "全部业务"}<span> · 近 {slots.length} 季收入</span></h2>
        <div className="trend-legend" key={"legend" + mode}>
          {legend.length > 1 && legend.map(layer => <span key={layer.key}><i style={{ background: layerColor(layer, hue) }} />{layer.name}</span>)}
          <span className="trend-basis">按每期财报原披露口径</span>
        </div>
      </div>
      <dl className="trend-kpis">
        <div><dt>同比</dt><dd data-trend={trend(yoy)}>{percent(yoy)}</dd></div>
        <div><dt>{known.length > 1 ? `${shortPeriod(known[0].slot.periodEnd)} 以来` : "区间"}</dt><dd data-trend={trend(span)}>{percent(span)}</dd></div>
      </dl>
    </header>
    <div className="trend-plot" role="list">
      <div className="trend-grid" key={scale} aria-hidden="true">
        {ticks.map(t => <div key={t} style={{ bottom: `${t / scale * 100}%` }}><span>{t ? money(t) : ""}</span></div>)}
      </div>
      <i className="trend-sweep" key={"sweep" + mode} aria-hidden="true" />
      {columns.map((column, i) => <Bar key={column.slot.periodEnd} column={column} index={i} order={order} scale={scale} hue={hue} money={money}
        current={column.slot.periodEnd === currentPeriod} pickable={periods.has(column.slot.periodEnd)} hovered={hover === i}
        onHover={() => setHover(i)} onPick={() => onPickPeriod(column.slot.periodEnd)} selected={selected} />)}
    </div>
  </section>;
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
