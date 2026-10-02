import type { ReactNode } from "react";
import { SEC_FIGURE_CATALOG, readableSecFigure, type SecFigure, type SecFigureKind } from "@/shared/analysis-runtime/sec-figures.ts";
import { CashBridge } from "./CashBridge.tsx";
import { GrowthChart } from "./GrowthChart.tsx";
import { KpiStrip } from "./KpiStrip.tsx";
import { CashDebt, MarginLadder, ShareCount } from "./LineFigures.tsx";
import { PerHundred } from "./PerHundred.tsx";
import { ProfitFlow } from "./ProfitFlow.tsx";
import { metricLabel } from "./format.ts";

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
    <figcaption><strong>{title}</strong><small>{SEC_FIGURE_CATALOG[figure.kind].label} · {figure.periodScope === "annual" ? "年度" : "季度"} · 截至 {figure.periodEnd} · SEC XBRL</small></figcaption>
    <Body figure={figure} />
    {caption && <p className="report-content-caption">{caption}</p>}
  </figure>;
}

type Row = { period: string; label: string; value: number; unit: string; accession: string };

/** Every number a figure draws, with its unit and SEC accession. */
export function secFigureRows(figure: SecFigure): Row[] {
  const series = (list: Array<{ metricKey: string; unit: string; points: Array<{ date: string; value: number; accession: string }> }>) =>
    list.flatMap((s) => s.points.map((p) => ({ period: p.date, label: metricLabel(s.metricKey), value: p.value, unit: s.unit, accession: p.accession })));
  const income = (snapshot: Extract<SecFigure, { kind: "profit_flow" }>["current"]) => ([
    ["营收", snapshot.revenue], ["毛利润", snapshot.grossProfit], ["营业利润", snapshot.operatingIncome], ["净利润", snapshot.netIncome],
  ] as const).map(([label, value]) => ({ period: snapshot.date, label, value, unit: snapshot.currency, accession: snapshot.accessions.join("、") }));
  switch (figure.kind) {
    case "kpi_strip": case "margin_ladder": return series(figure.series);
    case "growth": return series([figure.revenue]);
    case "cash_debt": return series([figure.cash, figure.debt]);
    case "share_count": return series([figure.shares]);
    case "profit_flow": return income(figure.current);
    case "per_hundred": return [...income(figure.current), ...income(figure.prior)];
    case "cash_bridge": return ([
      ...(figure.netIncome !== undefined ? [["净利润", figure.netIncome] as const] : []),
      ["经营现金流", figure.operatingCashFlow], ["资本开支", figure.capex], ["自由现金流", figure.freeCashFlow],
    ] as const).map(([label, value]) => ({ period: figure.periodEnd, label, value, unit: figure.currency, accession: figure.accessions.join("、") }));
  }
}

/** Kept outside floating media so opening the data table never squeezes the article. */
export function SecFigureSource({ figure, title }: { figure: SecFigure; title: string }) {
  const rows = secFigureRows(figure);
  return <details className="report-content-source"><summary>{title} · 查看数据与来源</summary>
    <div className="report-content-table-scroll" tabIndex={0} role="region" aria-label={`${title}原始数据`}>
      <table><thead><tr><th scope="col">期间</th><th scope="col">项目</th><th scope="col">数值</th><th scope="col">单位</th><th scope="col">SEC accession</th></tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}><th scope="row">{r.period}</th><td>{r.label}</td><td data-chart-value={r.value}>{r.value.toLocaleString("zh-CN", { maximumFractionDigits: 10 })}</td><td>{r.unit === "ratio" ? "比率" : r.unit}</td><td>{r.accession}</td></tr>)}</tbody>
      </table>
    </div>
    {figure.kind === "margin_ladder" && figure.series.some((s) => s.basis === "derived") && <p className="report-content-caption">利润率由同期利润与营收的已核验数值计算。</p>}
  </details>;
}
