import { latestChange, type SecFigure, type SecFigureSeries } from "@/shared/analysis-runtime/sec-figures.ts";
import { formatChange, formatValue, metricLabel } from "./format.ts";
import { LineChart } from "./primitives.tsx";
import { labels, messages } from "@/packages/web/src/i18n";

const m = messages({
  cashAndEquivalents: "Cash and equivalents", longTermDebt: "Long-term debt", netCash: "Net cash", netDebt: "Net debt", cash: "Cash",
  sharesLatest: "Shares, latest", yoy: "YoY", prior: "vs. prior period", shares: "Shares",
}, {
  cashAndEquivalents: "现金及等价物", longTermDebt: "长期债务", netCash: "净现金", netDebt: "净债务", cash: "现金",
  sharesLatest: "最新股数", yoy: "同比", prior: "较上期", shares: "股数",
});

const describe = (list: SecFigureSeries[]) => list.map((s) => `${metricLabel(s.metricKey)}: ${s.points.map((p) => `${p.date} ${formatValue(p.value, s.unit)}`).join(", ")}`).join("; ");

const MARGIN_ROLES: Record<string, string> = { gross_margin: "gross", operating_margin: "operating", net_margin: "net" };
/** Line-end labels fit a 140-unit margin; the accessible description keeps the full names. */
const MARGIN_LABELS = labels({ gross_margin: "Gross", operating_margin: "Operating", net_margin: "Net" }, { gross_margin: "毛利率", operating_margin: "营业利润率", net_margin: "净利率" });

/** Gross, operating and net margin on one axis: how much of revenue survives each layer. */
export function MarginLadder({ figure }: { figure: Extract<SecFigure, { kind: "margin_ladder" }> }) {
  return <LineChart unit="ratio" description={describe(figure.series)}
    series={figure.series.map((s) => ({ key: s.metricKey, label: MARGIN_LABELS[s.metricKey as keyof typeof MARGIN_LABELS] ?? metricLabel(s.metricKey), role: MARGIN_ROLES[s.metricKey] ?? "other", points: s.points }))} />;
}

/** Cash against long-term debt, with the latest net cash (or net debt). */
export function CashDebt({ figure }: { figure: Extract<SecFigure, { kind: "cash_debt" }> }) {
  const unit = figure.cash.unit;
  const cash = figure.cash.points.at(-1)!.value, debt = figure.debt.points.at(-1)!.value;
  const net = cash - debt;
  return <>
    <dl className="sec-figure-stats">
      <div><dt>{m.cashAndEquivalents}</dt><dd>{formatValue(cash, unit)}</dd></div>
      <div><dt>{m.longTermDebt}</dt><dd>{formatValue(debt, unit)}</dd></div>
      <div><dt>{net >= 0 ? m.netCash : m.netDebt}</dt><dd>{formatValue(Math.abs(net), unit)}</dd></div>
    </dl>
    <LineChart unit={unit} description={describe([figure.cash, figure.debt])}
      series={[{ key: "cash", label: m.cash, role: "cash", points: figure.cash.points }, { key: "debt", label: m.longTermDebt, role: "debt", points: figure.debt.points }]} />
  </>;
}

/** Share count trend: rising means dilution, falling means net buybacks. */
export function ShareCount({ figure }: { figure: Extract<SecFigure, { kind: "share_count" }> }) {
  const change = latestChange(figure.shares);
  return <>
    <dl className="sec-figure-stats">
      <div><dt>{m.sharesLatest}</dt><dd>{formatValue(change.current.value, figure.shares.unit)}</dd></div>
      {change.ratio !== undefined && <div><dt>{change.basis === "yoy" ? m.yoy : m.prior}</dt><dd>{formatChange(change.ratio)}</dd></div>}
    </dl>
    <LineChart unit={figure.shares.unit} domain="fit" description={describe([figure.shares])}
      series={[{ key: "shares", label: m.shares, role: "shares", points: figure.shares.points }]} />
  </>;
}
