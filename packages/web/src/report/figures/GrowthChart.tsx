import { yoyGrowth, type SecFigure } from "@/shared/analysis-runtime/sec-figures.ts";
import { formatChange, formatValue, shortPeriod } from "./format.ts";
import { niceTicks, scale } from "./primitives.tsx";

/** Revenue bars (left axis) with year-over-year growth (right axis) where a year-ago period exists. */
export function GrowthChart({ figure }: { figure: Extract<SecFigure, { kind: "growth" }> }) {
  const { points, unit } = figure.revenue;
  const growth = yoyGrowth(figure.revenue);
  const width = 620, height = 240, left = 56, right = 56, top = 26, bottom = 202;
  const slot = (width - left - right) / points.length;
  const cx = (date: string) => left + slot * (points.findIndex((p) => p.date === date) + 0.5);
  const valueTicks = niceTicks(Math.min(0, ...points.map((p) => p.value)), Math.max(...points.map((p) => p.value)) * 1.05);
  const vy = scale([valueTicks[0], valueTicks.at(-1)!], [bottom, top]);
  const rates = growth.map((g) => g.growth);
  const growthTicks = rates.length ? niceTicks(Math.min(0, ...rates), Math.max(0, ...rates) * 1.15, 3) : [];
  const gy = growthTicks.length ? scale([growthTicks[0], growthTicks.at(-1)!], [bottom, top]) : () => bottom;
  const latest = points.at(-1)!;
  const description = `收入：${points.map((p) => `${p.date} ${formatValue(p.value, unit)}`).join("；")}。同比增速：${growth.map((g) => `${g.date} ${formatChange(g.growth)}`).join("；") || "无可比去年同期"}`;
  return <>
    <div className="sec-figure-legend"><span data-role="total">收入（左轴）</span>{growth.length > 0 && <span data-role="rate">同比增速（右轴）</span>}</div>
    <svg className="sec-figure-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={description}>
      {valueTicks.map((t) => <g key={t} className="sec-figure-grid"><line x1={left} x2={width - right} y1={vy(t)} y2={vy(t)} data-zero={t === 0 || undefined} />
        <text x={left - 8} y={vy(t) + 4} textAnchor="end">{formatValue(t, unit, { withUnit: false })}</text></g>)}
      {growthTicks.map((t) => <text key={t} className="sec-figure-grid" x={width - right + 8} y={gy(t) + 4}>{formatChange(t, 0)}</text>)}
      {points.map((p, i) => <rect key={p.date} className="sec-figure-bar" data-current={i === points.length - 1}
        x={cx(p.date) - slot * 0.3} y={Math.min(vy(0), vy(p.value))} width={slot * 0.6} height={Math.abs(vy(p.value) - vy(0))} rx="3" />)}
      <text className="sec-figure-value" x={cx(latest.date)} y={vy(latest.value) - 8} textAnchor="middle">{formatValue(latest.value, unit, { withUnit: false })}</text>
      {growth.length > 1 && <polyline className="sec-figure-rate" points={growth.map((g) => `${cx(g.date)},${gy(g.growth)}`).join(" ")} />}
      {growth.map((g, i) => <circle key={g.date} className="sec-figure-rate-point" data-current={i === growth.length - 1} cx={cx(g.date)} cy={gy(g.growth)} r={i === growth.length - 1 ? 4.5 : 3} />)}
      {growth.length > 0 && <text className="sec-figure-rate-label" x={cx(growth.at(-1)!.date)} y={gy(growth.at(-1)!.growth) + 18} textAnchor="middle">{formatChange(growth.at(-1)!.growth)}</text>}
      {points.map((p, i) => (points.length <= 6 || i % 2 === (points.length - 1) % 2) && <text key={p.date} className="sec-figure-axis" x={cx(p.date)} y={height - 14} textAnchor="middle">{shortPeriod(p.date)}</text>)}
    </svg>
  </>;
}
