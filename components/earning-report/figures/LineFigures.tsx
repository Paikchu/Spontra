import { latestChange, type SecFigure, type SecFigureSeries } from "@/shared/analysis-runtime/sec-figures.ts";
import { formatChange, formatValue, metricLabel } from "./format.ts";
import { LineChart } from "./primitives.tsx";

const describe = (list: SecFigureSeries[]) => list.map((s) => `${metricLabel(s.metricKey)}：${s.points.map((p) => `${p.date} ${formatValue(p.value, s.unit)}`).join("，")}`).join("；");

const MARGIN_ROLES: Record<string, string> = { gross_margin: "gross", operating_margin: "operating", net_margin: "net" };

/** Gross, operating and net margin on one axis: how much of revenue survives each layer. */
export function MarginLadder({ figure }: { figure: Extract<SecFigure, { kind: "margin_ladder" }> }) {
  return <LineChart unit="ratio" description={describe(figure.series)}
    series={figure.series.map((s) => ({ key: s.metricKey, label: metricLabel(s.metricKey), role: MARGIN_ROLES[s.metricKey] ?? "other", points: s.points }))} />;
}

/** Cash against long-term debt, with the latest net cash (or net debt). */
export function CashDebt({ figure }: { figure: Extract<SecFigure, { kind: "cash_debt" }> }) {
  const unit = figure.cash.unit;
  const cash = figure.cash.points.at(-1)!.value, debt = figure.debt.points.at(-1)!.value;
  const net = cash - debt;
  return <>
    <dl className="sec-figure-stats">
      <div><dt>现金及等价物</dt><dd>{formatValue(cash, unit)}</dd></div>
      <div><dt>长期债务</dt><dd>{formatValue(debt, unit)}</dd></div>
      <div><dt>{net >= 0 ? "净现金" : "净债务"}</dt><dd>{formatValue(Math.abs(net), unit)}</dd></div>
    </dl>
    <LineChart unit={unit} description={describe([figure.cash, figure.debt])}
      series={[{ key: "cash", label: "现金", role: "cash", points: figure.cash.points }, { key: "debt", label: "长期债务", role: "debt", points: figure.debt.points }]} />
  </>;
}

/** Share count trend: rising means dilution, falling means net buybacks. */
export function ShareCount({ figure }: { figure: Extract<SecFigure, { kind: "share_count" }> }) {
  const change = latestChange(figure.shares);
  return <>
    <dl className="sec-figure-stats">
      <div><dt>本期股数</dt><dd>{formatValue(change.current.value, figure.shares.unit)}</dd></div>
      {change.ratio !== undefined && <div><dt>{change.basis === "yoy" ? "同比" : "较上期"}</dt><dd>{formatChange(change.ratio)}</dd></div>}
    </dl>
    <LineChart unit={figure.shares.unit} domain="fit" description={describe([figure.shares])}
      series={[{ key: "shares", label: "股数", role: "shares", points: figure.shares.points }]} />
  </>;
}
