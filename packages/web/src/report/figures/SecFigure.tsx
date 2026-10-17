import type { ReactNode } from "react";
import { readableSecFigure, secFigureLabel, type SecFigure, type SecFigureKind } from "@/shared/analysis-runtime/sec-figures.ts";
import { getLocale, messages } from "@/packages/web/src/i18n";
import { langOf } from "@/packages/web/src/i18n/SourceLanguage";
import { CashBridge } from "./CashBridge.tsx";
import { GrowthChart } from "./GrowthChart.tsx";
import { KpiStrip } from "./KpiStrip.tsx";
import { CashDebt, MarginLadder, ShareCount } from "./LineFigures.tsx";
import { PerHundred } from "./PerHundred.tsx";
import { ProfitFlow } from "./ProfitFlow.tsx";
import { metricLabel, unitName } from "./format.ts";

const m = messages({
  annual: "Annual", quarterly: "Quarterly", asOf: (date: string) => `As of ${date}`, source: "SEC XBRL",
  revenue: "Revenue", gross: "Gross profit", operating: "Operating income", net: "Net income",
  operatingCashFlow: "Operating cash flow", capex: "Capital expenditures", freeCashFlow: "Free cash flow",
  sources: "Data and sources", sourceData: (title: string) => `${title} source data`,
  period: "Period", item: "Item", value: "Value", unit: "Unit", accession: "SEC accession", ratio: "Ratio",
}, {
  annual: "年度", quarterly: "季度", asOf: (date: string) => `截至 ${date}`, source: "SEC XBRL",
  revenue: "营收", gross: "毛利", operating: "营业利润", net: "净利润",
  operatingCashFlow: "经营现金流", capex: "资本开支", freeCashFlow: "自由现金流",
  sources: "数据与来源", sourceData: (title: string) => `${title} 源数据`,
  period: "期间", item: "项目", value: "数值", unit: "单位", accession: "SEC 文件编号", ratio: "比率",
});

type FigureBody<K extends SecFigureKind> = (props: { figure: Extract<SecFigure, { kind: K }> }) => ReactNode;

/** The closed registry: one drawing component per figure kind the Pipeline can build. */
const FIGURE_COMPONENTS: { [K in SecFigureKind]: FigureBody<K> } = {
  kpi_strip: KpiStrip,
  growth: GrowthChart,
  margin_ladder: MarginLadder,
  profit_flow: ProfitFlow,
  per_hundred: PerHundred,
  cash_bridge: CashBridge,
  cash_debt: CashDebt,
  share_count: ShareCount,
};

/** Find and re-validate a stored figure; damaged or missing ones are never drawn. */
export function findSecFigure(figures: readonly unknown[] | undefined, figureKey: string): SecFigure | null {
  const candidate = figures?.find((f) => f && typeof f === "object" && (f as { figureKey?: unknown }).figureKey === figureKey);
  return candidate ? readableSecFigure(candidate) : null;
}

export function SecFigureView({ id, figure, title, caption }: { id: string; figure: SecFigure; title: string; caption?: string }) {
  const Body = FIGURE_COMPONENTS[figure.kind] as FigureBody<SecFigureKind>;
  return <figure id={id} className="report-content-figure sec-figure" data-figure-kind={figure.kind}>
    <figcaption><strong>{title}</strong><small>{secFigureLabel(figure.kind, getLocale())} · {figure.periodScope === "annual" ? m.annual : m.quarterly} · {m.asOf(figure.periodEnd)} · {m.source}</small></figcaption>
    <Body figure={figure} />
    {caption && <p className="report-content-caption" lang={langOf(caption)}>{caption}</p>}
  </figure>;
}

type Row = { period: string; label: string; value: number; unit: string; accession: string };

/** Every number a figure draws, with its unit and SEC accession. */
export function secFigureRows(figure: SecFigure): Row[] {
  const series = (list: Array<{ metricKey: string; unit: string; points: Array<{ date: string; value: number; accession: string }> }>) =>
    list.flatMap((s) => s.points.map((p) => ({ period: p.date, label: metricLabel(s.metricKey), value: p.value, unit: s.unit, accession: p.accession })));
  const income = (snapshot: Extract<SecFigure, { kind: "profit_flow" }>["current"]) => ([
    [m.revenue, snapshot.revenue], [m.gross, snapshot.grossProfit], [m.operating, snapshot.operatingIncome], [m.net, snapshot.netIncome],
  ] as const).map(([label, value]) => ({ period: snapshot.date, label, value, unit: snapshot.currency, accession: snapshot.accessions.join(", ") }));
  switch (figure.kind) {
    case "kpi_strip": case "margin_ladder": return series(figure.series);
    case "growth": return series([figure.revenue]);
    case "cash_debt": return series([figure.cash, figure.debt]);
    case "share_count": return series([figure.shares]);
    case "profit_flow": return income(figure.current);
    case "per_hundred": return [...income(figure.current), ...income(figure.prior)];
    case "cash_bridge": return ([
      ...(figure.netIncome !== undefined ? [[m.net, figure.netIncome] as const] : []),
      [m.operatingCashFlow, figure.operatingCashFlow], [m.capex, figure.capex], [m.freeCashFlow, figure.freeCashFlow],
    ] as const).map(([label, value]) => ({ period: figure.periodEnd, label, value, unit: figure.currency, accession: figure.accessions.join(", ") }));
  }
}

/** Kept outside floating media so opening the data table never squeezes the article. */
export function SecFigureSource({ figure, title }: { figure: SecFigure; title: string }) {
  const rows = secFigureRows(figure);
  return <details className="report-content-source"><summary>{title} · {m.sources}</summary>
    <div className="report-content-table-scroll" tabIndex={0} role="region" aria-label={m.sourceData(title)}>
      <table><thead><tr><th scope="col">{m.period}</th><th scope="col">{m.item}</th><th scope="col">{m.value}</th><th scope="col">{m.unit}</th><th scope="col">{m.accession}</th></tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}><th scope="row">{r.period}</th><td>{r.label}</td><td data-chart-value={r.value}>{r.value.toLocaleString("en-US", { maximumFractionDigits: 10 })}</td><td>{r.unit === "ratio" ? m.ratio : unitName(r.unit)}</td><td>{r.accession}</td></tr>)}</tbody>
      </table>
    </div>
  </details>;
}
