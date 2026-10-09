import type { SecFigurePoint } from "@/shared/analysis-runtime/sec-figures.ts";
import { formatValue, shortPeriod } from "./format.ts";

/** Round tick values whose range fully covers [min, max], so no mark is drawn past the axis. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  const span = max - min || Math.abs(max) || 1;
  const raw = span / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  const end = Math.ceil(max / step - 1e-9) * step;
  for (let v = Math.floor(min / step + 1e-9) * step; v <= end + step * 1e-9; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

/** Linear map from a numeric domain onto a pixel range. */
export function scale([d0, d1]: [number, number], [r0, r1]: [number, number]) {
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  return (v: number) => r0 + (v - d0) * k;
}

/** Vertical positions for end-of-line labels, nudged apart so they never overlap. */
export function separateLabels(ys: number[], gap = 15): number[] {
  const order = ys.map((y, i) => [y, i] as const).sort((a, b) => a[0] - b[0]);
  const placed: number[] = [];
  for (const [y] of order) placed.push(Math.max(y, (placed.at(-1) ?? -Infinity) + gap));
  const result = new Array<number>(ys.length);
  order.forEach(([, i], rank) => { result[i] = placed[rank]; });
  return result;
}

/** A tiny bar or line trend for metric tiles; the newest period is emphasised. */
export function Sparkline({ points, mark }: { points: readonly SecFigurePoint[]; mark: "bar" | "line" }) {
  const values = points.map((p) => p.value);
  const width = 160, height = 44;
  if (mark === "bar") {
    const max = Math.max(...values.map(Math.abs), 1e-12);
    const slot = width / points.length;
    return <svg className="sec-figure-spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      {points.map((p, i) => {
        const h = Math.max(1.5, Math.abs(p.value) / max * (height - 4));
        return <rect key={p.date} data-current={i === points.length - 1} data-negative={p.value < 0 || undefined}
          x={i * slot + slot * 0.18} y={height - h} width={slot * 0.64} height={h} rx="1.5" />;
      })}
    </svg>;
  }
  const min = Math.min(...values), max = Math.max(...values);
  const y = scale([min, max === min ? min + 1 : max], [height - 6, 6]);
  const x = (i: number) => 6 + i * (width - 12) / Math.max(1, points.length - 1);
  return <svg className="sec-figure-spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
    <polyline points={points.map((p, i) => `${x(i)},${y(p.value)}`).join(" ")} vectorEffect="non-scaling-stroke" />
    <circle cx={x(points.length - 1)} cy={y(values.at(-1)!)} r="3" data-current="true" />
  </svg>;
}

export type LineSeries = { key: string; label: string; role: string; points: readonly SecFigurePoint[] };

/** Several series on one value axis and a shared period axis; labels sit at each line's end. */
export function LineChart({ series, unit, description, domain = "zero" }: { series: LineSeries[]; unit: string; description: string; domain?: "zero" | "fit" }) {
  const dates = [...new Set(series.flatMap((s) => s.points.map((p) => p.date)))].sort();
  const values = series.flatMap((s) => s.points.map((p) => p.value));
  const [low, high] = [Math.min(...values), Math.max(...values)];
  // Lines may start above zero (share counts); bars elsewhere in the library never do.
  const pad = (high - low || Math.abs(high) || 1) * 0.15;
  const ticks = domain === "fit" ? niceTicks(low - pad, high + pad, 3) : niceTicks(Math.min(0, low), Math.max(0, high) * 1.05);
  const width = 620, height = 230, left = 56, right = 150, top = 14, bottom = 196;
  const y = scale([ticks[0], ticks.at(-1)!], [bottom, top]);
  const x = (date: string) => left + dates.indexOf(date) * (width - left - right) / Math.max(1, dates.length - 1);
  const ends = series.map((s) => y(s.points.at(-1)!.value));
  const labels = separateLabels(ends);
  const axisDates = dates.length > 4 ? [dates[0], dates[Math.floor((dates.length - 1) / 2)], dates.at(-1)!] : dates;
  return <svg className="sec-figure-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={description}>
    {ticks.map((t) => <g key={t} className="sec-figure-grid"><line x1={left} x2={width - right} y1={y(t)} y2={y(t)} data-zero={t === 0 || undefined} />
      <text x={left - 8} y={y(t) + 4} textAnchor="end">{formatValue(t, unit, { withUnit: false })}</text></g>)}
    {series.map((s, i) => <g key={s.key} className="sec-figure-line" data-role={s.role}>
      <polyline points={s.points.map((p) => `${x(p.date)},${y(p.value)}`).join(" ")} />
      <circle cx={x(s.points.at(-1)!.date)} cy={ends[i]} r="4" />
      <text x={width - right + 10} y={labels[i] + 4}><tspan className="sec-figure-line-label">{s.label}</tspan> {formatValue(s.points.at(-1)!.value, unit, { withUnit: false })}</text>
    </g>)}
    {axisDates.map((d) => <text key={d} className="sec-figure-axis" x={x(d)} y={height - 8} textAnchor="middle">{shortPeriod(d)}</text>)}
  </svg>;
}
