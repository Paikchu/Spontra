import { cashBridgeSteps, type SecFigure } from "@/shared/analysis-runtime/sec-figures.ts";
import { currencyName, formatValue } from "./format.ts";
import { niceTicks, scale } from "./primitives.tsx";

/** Waterfall from net income to free cash flow; totals start at zero, changes float between them. */
export function CashBridge({ figure }: { figure: Extract<SecFigure, { kind: "cash_bridge" }> }) {
  const steps = cashBridgeSteps(figure);
  const unit = figure.currency;
  const width = 620, height = 260, left = 56, right = 12, top = 26, bottom = 196;
  const ticks = niceTicks(Math.min(0, ...steps.flatMap((s) => [s.start, s.end])), Math.max(0, ...steps.flatMap((s) => [s.start, s.end])) * 1.08);
  const y = scale([ticks[0], ticks.at(-1)!], [bottom, top]);
  const slot = (width - left - right) / steps.length;
  const description = steps.map((s) => `${s.label} ${formatValue(s.value, unit, { signed: s.kind === "change" })}`).join("；");
  return <svg className="sec-figure-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={description}>
    {ticks.map((t) => <g key={t} className="sec-figure-grid"><line x1={left} x2={width - right} y1={y(t)} y2={y(t)} data-zero={t === 0 || undefined} />
      <text x={left - 8} y={y(t) + 4} textAnchor="end">{formatValue(t, unit, { withUnit: false })}</text></g>)}
    {steps.map((s, i) => {
      const x = left + i * slot + slot * 0.18, w = slot * 0.64;
      const y0 = y(Math.max(s.start, s.end)), y1 = y(Math.min(s.start, s.end));
      const role = s.kind === "total" ? (s.key === "free_cash_flow" ? "result" : "total") : s.value >= 0 ? "increase" : "decrease";
      const below = s.kind === "total" ? s.end < 0 : s.value < 0;
      return <g key={s.key} className="sec-figure-step" data-role={role}>
        {i < steps.length - 1 && <line className="sec-figure-connector" x1={x + w} x2={left + (i + 1) * slot + slot * 0.18} y1={y(s.end)} y2={y(s.end)} />}
        <rect x={x} y={y0} width={w} height={Math.max(1, y1 - y0)} rx="3" />
        <text className="sec-figure-value" x={x + w / 2} y={below ? y1 + 15 : y0 - 7} textAnchor="middle">{formatValue(s.value, unit, { signed: s.kind === "change", withUnit: false })}</text>
        <text className="sec-figure-axis" x={x + w / 2} y={height - 34} textAnchor="middle">{s.label}</text>
      </g>;
    })}
    <text className="sec-figure-axis" x={left} y={height - 8}>单位：{currencyName(unit)} · {figure.periodEnd}</text>
  </svg>;
}
