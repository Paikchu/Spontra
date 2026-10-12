import type { PublishedSecReport, SecNodeResult } from "@/shared/analysis-contract/report.ts";
import type { SecReaderReport } from "@/shared/analysis-contract/sec-reader.ts";
import { formatSecMetricValue, formatSecMetricLabel } from "@/packages/web/src/model/sec-metric-format.ts";
import { RichText } from "../rich-text/RichText.tsx";
import { ReportContentRenderer } from "./ReportContentRenderer.tsx";
import { ReportMediaGroup } from "./ReportMediaGroup.tsx";
import { readableTrend, SecTrendFigure, SecTrendSource } from "../figures/index.ts";

const amount = (v: number, currency: string) => formatSecMetricValue("amount", String(v), currency, currency);
/**
 * Limitations about a missing current-period metric (debt, cash, company-wide gross margin) are
 * stated elsewhere, so the cash panel hides them. Matches the Pipeline's English wording and the
 * Chinese wording of reports stored before the switch.
 */
const MISSING_METRIC_LIMITATION = /缺少本期|缺少可核验的公司|^No verifiable (current-period|company-wide)\b/i;

export function FinancialBridge({ report }: { report: PublishedSecReport }) {
  const lens = report.financialLens;
  if (!lens?.cashBridge && !lens?.depreciation) return null;
  const cash = lens.cashBridge, dep = lens.depreciation;
  return <div className="sec-reader-financial-lens">
    {cash && <div className="sec-reader-cash">
      <h3>{cash.adjustedFCF !== undefined ? "Free cash flow" : "Cash flow and capital expenditures"}</h3><p className="sec-reader-caption">{cash.period} · Non-GAAP</p>
      <div className="sec-reader-cash-values">
        <div><span>Operating cash flow − gross capex</span><strong data-direction={cash.standardFCF < 0 ? "negative" : "positive"}>{amount(cash.standardFCF, cash.currency)}</strong><small>{amount(cash.operatingCashFlow, cash.currency)} − {amount(cash.grossCapex, cash.currency)}</small></div>
        {cash.adjustedFCF !== undefined && <div><span>Operating cash flow − net capex (management)</span><strong data-direction={cash.adjustedFCF < 0 ? "negative" : "positive"}>{amount(cash.adjustedFCF, cash.currency)}</strong><small>{amount(cash.operatingCashFlow, cash.currency)} − {amount(cash.managementNetCapex!, cash.currency)}</small></div>}
      </div>
      {cash.adjustments && <details><summary>Net capex reconciliation</summary><p>{amount(cash.grossCapex, cash.currency)}{cash.adjustments.map((a) => ` ${a.value < 0 ? "−" : "+"} ${amount(Math.abs(a.value), cash.currency)}`).join("")} = {amount(cash.managementNetCapex!, cash.currency)}</p><ul>{cash.adjustments.map((a, i) => <li key={i}>{a.label}: {a.value < 0 ? "less" : "add back"} {amount(Math.abs(a.value), cash.currency)}</li>)}</ul></details>}
      {cash.reconciliationStatus === "unverified" && <p className="sec-reader-caption">Net capex reconciliation unverified</p>}
    </div>}
    {dep && <div className="sec-reader-depreciation"><h3>Capex depreciation</h3>
      <dl><div><dt>Annualized capex</dt><dd>{amount(dep.annualizedCapex, dep.currency)}</dd></div><div><dt>Annual depreciation · {dep.usefulLifeYears}-year straight-line, no salvage</dt><dd>≈{amount(dep.annualExpenseIllustration, dep.currency)}</dd></div>{dep.currentAnnualizedDepreciation !== undefined && <div><dt>Current depreciation, annualized</dt><dd>{amount(dep.currentAnnualizedDepreciation, dep.currency)}</dd></div>}{dep.currentAnnualizedOperatingIncome !== undefined && <div><dt>Current operating income, annualized</dt><dd>{amount(dep.currentAnnualizedOperatingIncome, dep.currency)}</dd></div>}</dl>
      <details><summary>Assumptions</summary><ul>{dep.assumptions.map((a) => <li key={a}>{a}</li>)}</ul></details>
    </div>}
    {lens.limitations.filter((l) => !MISSING_METRIC_LIMITATION.test(l)).map((l) => <p className="sec-reader-caption" key={l}>{l}</p>)}
  </div>;
}

const changeLabel = { new: "New", changed: "Changed", continuing: "Continuing", not_comparable: "No baseline" };
export function QuarterChanges({ reader }: { reader: SecReaderReport }) {
  return <div className="sec-reader-changes">{reader.changes.map((c, i) => <article key={`${c.topic}-${i}`} data-change={c.kind}>
    <div><span className="sec-reader-change-kind">{changeLabel[c.kind]}</span><h3>{c.topic}</h3></div>
    <dl><div><dt>Prior</dt><dd>{c.prior}</dd></div><div><dt>Current</dt><dd>{c.current}</dd></div></dl>
    <p>{c.implication}</p>
  </article>)}</div>;
}

export function ReaderSection({ section, report, nodes }: { section: SecReaderReport["sections"][number]; report: PublishedSecReport; nodes: SecNodeResult[] }) {
  const selected = nodes.filter((n) => section.nodeIds.includes(n.id));
  const evidence = selected.flatMap((n) => n.evidence).filter((e, i, all) => all.findIndex((other) => other.excerpt === e.excerpt) === i).slice(0, 8);
  const visual = section.visual;
  const trend = readableTrend(report.trends?.find((t) => t.metricKey === (visual?.chart?.metricKey ?? section.chartMetricKey)));
  const layout = visual?.layout === "chart_focus" && !trend ? "essay" : visual?.layout ?? "essay";
  const paragraph = (p: string, i: number) => <div className="sec-reader-paragraph" key={i}>{layout === "comparison" && visual?.paragraphLabels?.[i] && <h3>{visual.paragraphLabels[i]}</h3>}<RichText text={p} /></div>;
  const chartTitle = trend ? visual?.chart?.title || `${formatSecMetricLabel(trend.metricKey)} over time` : "";
  const paragraphLabels = layout === "comparison" && section.content && visual?.paragraphLabels
    ? Object.fromEntries(section.content.filter((block) => block.type === "markdown").map((block, i) => [block.blockId, visual.paragraphLabels?.[i] ?? ""])) : undefined;
  return <div className="sec-reader-article" data-role={section.role} data-layout={layout}>
    {section.role === "valuation" && <MarketContext report={report} />}
    <div className={trend || section.content?.length ? "sec-reader-content-layout" : "sec-reader-layout"}>
    {section.content?.length ? <ReportContentRenderer content={section.content} context={{ report, nodes, paragraphLabels }} />
      : trend ? <div className="report-content" data-report-surface="article" data-report-phase="final">
        <ReportMediaGroup lead={<div className="sec-reader-flow-prose">{paragraph(section.paragraphs[0], 0)}</div>}
          media={<SecTrendFigure id={`${section.id}-trend`} title={chartTitle} trend={trend} mark={visual?.chart?.mark ?? "line"} caption={visual?.chart?.caption} />}
          sources={<SecTrendSource title={chartTitle} trend={trend} />}>
          <div className="sec-reader-flow-prose">{section.paragraphs.slice(1).map((p, i) => paragraph(p, i + 1))}</div>
        </ReportMediaGroup>
      </div> : <div className="sec-report-body">{section.paragraphs.map(paragraph)}</div>}
    <p className="sec-reader-takeaway"><span>Takeaway</span>{section.takeaway}</p>
    </div>
    {evidence.length > 0 && <details className="sec-report-evidence"><summary>Filing excerpts · {evidence.length}</summary>{evidence.map((e, i) => <blockquote key={i}><p>{e.excerpt}</p><footer>Characters {e.start.toLocaleString("en-US")}–{e.end.toLocaleString("en-US")}</footer></blockquote>)}</details>}
  </div>;
}

export function MarketContext({ report }: { report: PublishedSecReport }) {
  const market = report.marketSnapshot;
  if (market?.status !== "available" || market.price === undefined) return <aside className="sec-reader-market"><p>No market snapshot</p></aside>;
  const move = market.reaction;
  return <aside className="sec-reader-market"><dl>
    <div><dt>Close, {market.priceDate}</dt><dd>{amount(market.price, market.currency ?? "")}</dd></div>
    {market.trailingPE !== undefined && <div><dt>P/E · trailing 12-month diluted EPS through {market.earningsPeriodEnd}</dt><dd>{market.trailingPE.toFixed(1)}x</dd></div>}
    {move && <div><dt>{move.from} → {move.to}</dt><dd>{move.changePercent > 0 ? "+" : ""}{move.changePercent.toFixed(1)}%</dd></div>}
  </dl><p className="sec-reader-caption">{move ? `${move.sessions} trading ${move.sessions === 1 ? "day" : "days"} after release · ` : ""}As of {market.asOf.slice(0, 10)} · <a href={market.sourceUrl} target="_blank" rel="noopener noreferrer">{market.source}</a></p>
    <details><summary>Market data and valuation basis</summary><ul>{market.limitations.map((l) => <li key={l}>{l}</li>)}</ul></details>
  </aside>;
}

export function WatchConditions({ reader }: { reader: SecReaderReport }) {
  return <ol className="sec-reader-watch">{reader.watch.map((w, i) => <li key={i}><span>{w.deadline}</span><strong>{w.condition}</strong><p>{w.consequence}</p></li>)}</ol>;
}
