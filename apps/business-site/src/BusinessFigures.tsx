import { useMemo, type ReactNode } from "react";
import type { NarrativeFigure } from "@/shared/analysis-contract/business-narrative";
import type { OperatingMetric, OperatingMetricsPublication } from "@/shared/analysis-contract/operating-metrics";
import { formatOperating } from "@/shared/analysis-runtime/operating-metrics";

/**
 * Figures the narrative asked for, drawn from data the page holds: a stack from the business's own
 * capabilities (or the company's businesses), a ladder from operating metrics by key. The model
 * chose the decomposition and the binding; nothing here is a number it wrote.
 */
export function BusinessFigures({ figures, metrics, aside }: { figures: NarrativeFigure[]; metrics: OperatingMetricsPublication | null; aside: ReactNode }) {
  return <div className="figures" data-aside={aside ? "" : undefined}>
    {aside && <aside className="fc-business-details figures-aside" aria-label="业务档案"><div className="fc-business-scroll" tabIndex={0}>{aside}</div></aside>}
    <div className="figures-canvas">
      {figures.map((f, i) => <FigureCard key={i} figure={f} metrics={metrics} />)}
    </div>
  </div>;
}

/** One figure as a card, wherever the stage puts it. */
export function FigureCard({ figure, metrics }: { figure: NarrativeFigure; metrics: OperatingMetricsPublication | null }) {
  return figure.type === "stack" ? <StackFigure figure={figure} /> : <LadderFigure figure={figure} metrics={metrics} />;
}

/** Layers read bottom-up: the physical or lowest layer sits at the bottom, the customer-facing one on top. */
function StackFigure({ figure }: { figure: Extract<NarrativeFigure, { type: "stack" }> }) {
  const layers = [...figure.layers].reverse();
  return <figure className="figure figure--stack">
    <figcaption><b>{figure.title}</b><span>{figure.meaning}</span></figcaption>
    <ol className="stack" aria-label={figure.title}>
      {layers.map((layer, i) => <li key={i} className="stack-layer" style={{ "--i": layers.length - 1 - i } as React.CSSProperties}>
        <span className="stack-name">{layer.name}</span>
        <span className="stack-items">{layer.items.map(item => <span key={item} className="stack-item">{item}</span>)}</span>
      </li>)}
    </ol>
  </figure>;
}

const shortDate = (d: string) => d.slice(0, 7).replace("-", ".");
const ROLE_LABEL = { actual: "在用", contracted: "签约", target: "目标" } as const;

/**
 * Operating metrics over time. The actual track is a filled bar; a contracted or target track is a
 * dashed outline behind it at the same date, so the gap between them reads as what is still to be
 * delivered. Dates come from the union of the tracks; a track without a value at a date draws nothing.
 */
function LadderFigure({ figure, metrics }: { figure: Extract<NarrativeFigure, { type: "ladder" }>; metrics: OperatingMetricsPublication | null }) {
  const tracks = useMemo(() => figure.tracks.flatMap(t => { const m = metrics?.metrics.find(x => x.key === t.metricKey); return m ? [{ role: t.role, metric: m }] : []; }), [figure, metrics]);
  const dates = useMemo(() => [...new Set(tracks.flatMap(t => t.metric.observations.map(o => o.asOf)))].sort(), [tracks]);
  if (!tracks.length || dates.length < 2) return <figure className="figure figure--ladder"><figcaption><b>{figure.title}</b><span>{figure.meaning}</span></figcaption><p className="narrative-empty">运营指标尚未抽取到足够的期数。</p></figure>;
  const unit = tracks[0].metric.unit;
  const max = Math.max(...tracks.flatMap(t => t.metric.observations.map(o => o.value)));
  const W = 640, H = 220, PAD = { l: 8, r: 8, t: 26, b: 26 };
  const innerW = W - PAD.l - PAD.r, innerH = H - PAD.t - PAD.b;
  const slot = innerW / dates.length, bar = Math.min(56, slot * 0.46);
  const y = (v: number) => PAD.t + innerH - (v / max) * innerH;
  const actual = tracks.find(t => t.role === "actual"), others = tracks.filter(t => t.role !== "actual");
  const valueAt = (m: OperatingMetric, d: string) => m.observations.find(o => o.asOf === d)?.value ?? null;
  return <figure className="figure figure--ladder">
    <figcaption><b>{figure.title}</b><span>{figure.meaning}</span></figcaption>
    <svg className="ladder" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${figure.title}：${tracks.map(t => `${t.metric.label}${t.metric.observations.map(o => ` ${shortDate(o.asOf)} ${formatOperating(o.value, unit)}`).join("")}`).join("；")}`}>
      <line x1={PAD.l} x2={W - PAD.r} y1={PAD.t + innerH} y2={PAD.t + innerH} className="ladder-axis" />
      {dates.map((d, i) => {
        const cx = PAD.l + slot * (i + 0.5);
        const a = actual ? valueAt(actual.metric, d) : null;
        return <g key={d}>
          {others.map((t, n) => { const v = valueAt(t.metric, d); return v == null ? null : <g key={n}>
            <rect x={cx - bar / 2 - 5} y={y(v)} width={bar + 10} height={innerH + PAD.t - y(v)} className="ladder-outline" data-role={t.role} />
            <text x={cx} y={y(v) - 6} className="ladder-value ladder-value--outline">{formatOperating(v, unit)}</text>
          </g>; })}
          {a != null && <>
            <rect x={cx - bar / 2} y={y(a)} width={bar} height={innerH + PAD.t - y(a)} className="ladder-bar" />
            <text x={cx} y={y(a) - 6} className="ladder-value">{formatOperating(a, unit)}</text>
          </>}
          <text x={cx} y={H - 8} className="ladder-date">{shortDate(d)}</text>
        </g>;
      })}
    </svg>
    <div className="ladder-legend">
      {tracks.map((t, i) => <span key={i} data-role={t.role}><i />{t.metric.label} · {ROLE_LABEL[t.role]}</span>)}
      <span className="ladder-note">数值均引自公司原文，悬停柱体可见出处</span>
    </div>
    <ul className="ladder-quotes">
      {tracks.flatMap(t => t.metric.observations.map(o => <li key={`${t.metric.key}-${o.asOf}`}><b>{shortDate(o.asOf)} · {t.metric.label} {formatOperating(o.value, unit)}</b><q lang="en">{o.quote}</q><a href={metrics?.sources.find(s => s.id === o.sourceId)?.url} target="_blank" rel="noopener noreferrer">{metrics?.sources.find(s => s.id === o.sourceId)?.title ?? o.sourceId} ↗</a></li>))}
    </ul>
  </figure>;
}
