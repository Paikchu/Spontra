import { latestChange, type SecFigure } from "@/shared/analysis-runtime/sec-figures.ts";
import { direction, formatChange, formatPoints, formatValue, metricLabel } from "./format.ts";
import { Sparkline } from "./primitives.tsx";

/** 2–4 headline numbers, each with its change and recent trend. */
export function KpiStrip({ figure }: { figure: Extract<SecFigure, { kind: "kpi_strip" }> }) {
  return <ul className="sec-figure-kpis">
    {figure.series.map((series) => {
      const change = latestChange(series);
      const ratio = series.unit === "ratio";
      const text = ratio ? formatPoints(change.delta) : change.ratio !== undefined ? formatChange(change.ratio) : formatValue(change.delta, series.unit, { signed: true });
      return <li key={series.metricKey}>
        <span className="sec-figure-kpi-label">{metricLabel(series.metricKey)}</span>
        <strong className="sec-figure-kpi-value">{formatValue(change.current.value, series.unit)}</strong>
        <span className="sec-figure-change" data-direction={direction(change.delta)}>{text}<small>{change.basis === "yoy" ? "同比" : "较上期"}</small></span>
        <Sparkline points={series.points} mark={ratio ? "line" : "bar"} />
      </li>;
    })}
  </ul>;
}
