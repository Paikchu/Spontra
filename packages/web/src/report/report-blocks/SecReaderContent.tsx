import type { PublishedSecReport, SecNodeResult } from "@/shared/analysis-contract/report.ts";
import type { SecReaderReport } from "@/shared/analysis-contract/sec-reader.ts";
import { formatSecMetricValue, formatSecMetricLabel } from "@/packages/web/src/model/sec-metric-format.ts";
import { RichText } from "../rich-text/RichText.tsx";
import { ReportContentRenderer } from "./ReportContentRenderer.tsx";
import { ReportMediaGroup } from "./ReportMediaGroup.tsx";
import { readableTrend, SecTrendFigure, SecTrendSource } from "../figures/index.ts";
import { getLocale, labels, messages } from "@/packages/web/src/i18n";
import { langOf } from "@/packages/web/src/i18n/SourceLanguage";

const m = messages({
  freeCashFlow: "Free cash flow", cashAndCapex: "Cash flow and capital expenditures", nonGaap: "Non-GAAP",
  standardFcf: "Operating cash flow − gross capex", adjustedFcf: "Operating cash flow − net capex (management)",
  reconciliation: "Net capex reconciliation", less: "less", addBack: "add back", unverified: "Net capex reconciliation unverified",
  depreciation: "Capex depreciation", annualizedCapex: "Annualized capex",
  annualDepreciation: (years: number) => `Annual depreciation · ${years}-year straight-line, no salvage`,
  currentDepreciation: "Current depreciation, annualized", currentOperatingIncome: "Current operating income, annualized", assumptions: "Assumptions",
  prior: "Prior", current: "Current", overTime: (label: string) => `${label} over time`, takeaway: "Takeaway",
  excerpts: "Filing excerpts", characters: (start: string, end: string) => `Characters ${start}–${end}`,
  noMarket: "No market snapshot", close: (date: string) => `Close, ${date}`,
  pe: (date: string) => `P/E · trailing 12-month diluted EPS through ${date}`, multiple: (value: string) => `${value}x`,
  sessions: (n: number) => `${n} trading ${n === 1 ? "day" : "days"} after release · `, asOf: (date: string) => `As of ${date}`,
  marketBasis: "Market data and valuation basis",
}, {
  freeCashFlow: "自由现金流", cashAndCapex: "现金流与资本开支", nonGaap: "Non-GAAP",
  standardFcf: "经营现金流 − 总资本开支", adjustedFcf: "经营现金流 − 净资本开支（管理层口径）",
  reconciliation: "净资本开支调节", less: "减", addBack: "加回", unverified: "净资本开支调节未核验",
  depreciation: "资本开支折旧", annualizedCapex: "年化资本开支",
  annualDepreciation: (years: number) => `年折旧 · ${years} 年直线法，无残值`,
  currentDepreciation: "本期折旧（年化）", currentOperatingIncome: "本期营业利润（年化）", assumptions: "假设",
  prior: "上期", current: "本期", overTime: (label: string) => `${label}走势`, takeaway: "结论",
  excerpts: "文件摘录", characters: (start: string, end: string) => `字符位置 ${start}–${end}`,
  noMarket: "无市场快照", close: (date: string) => `${date} 收盘价`,
  pe: (date: string) => `市盈率 · 截至 ${date} 的过去 12 个月稀释每股收益`, multiple: (value: string) => `${value}倍`,
  sessions: (n: number) => `发布后 ${n} 个交易日 · `, asOf: (date: string) => `截至 ${date}`,
  marketBasis: "市场数据与估值口径",
});

const amount = (v: number, currency: string) => formatSecMetricValue("amount", String(v), currency, currency, getLocale());
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
      <h3>{cash.adjustedFCF !== undefined ? m.freeCashFlow : m.cashAndCapex}</h3><p className="sec-reader-caption">{cash.period} · {m.nonGaap}</p>
      <div className="sec-reader-cash-values">
        <div><span>{m.standardFcf}</span><strong data-direction={cash.standardFCF < 0 ? "negative" : "positive"}>{amount(cash.standardFCF, cash.currency)}</strong><small>{amount(cash.operatingCashFlow, cash.currency)} − {amount(cash.grossCapex, cash.currency)}</small></div>
        {cash.adjustedFCF !== undefined && <div><span>{m.adjustedFcf}</span><strong data-direction={cash.adjustedFCF < 0 ? "negative" : "positive"}>{amount(cash.adjustedFCF, cash.currency)}</strong><small>{amount(cash.operatingCashFlow, cash.currency)} − {amount(cash.managementNetCapex!, cash.currency)}</small></div>}
      </div>
      {cash.adjustments && <details><summary>{m.reconciliation}</summary><p>{amount(cash.grossCapex, cash.currency)}{cash.adjustments.map((a) => ` ${a.value < 0 ? "−" : "+"} ${amount(Math.abs(a.value), cash.currency)}`).join("")} = {amount(cash.managementNetCapex!, cash.currency)}</p><ul>{cash.adjustments.map((a, i) => <li key={i}><span lang="en">{a.label}</span>: {a.value < 0 ? m.less : m.addBack} {amount(Math.abs(a.value), cash.currency)}</li>)}</ul></details>}
      {cash.reconciliationStatus === "unverified" && <p className="sec-reader-caption">{m.unverified}</p>}
    </div>}
    {dep && <div className="sec-reader-depreciation"><h3>{m.depreciation}</h3>
      <dl><div><dt>{m.annualizedCapex}</dt><dd>{amount(dep.annualizedCapex, dep.currency)}</dd></div><div><dt>{m.annualDepreciation(dep.usefulLifeYears)}</dt><dd>≈{amount(dep.annualExpenseIllustration, dep.currency)}</dd></div>{dep.currentAnnualizedDepreciation !== undefined && <div><dt>{m.currentDepreciation}</dt><dd>{amount(dep.currentAnnualizedDepreciation, dep.currency)}</dd></div>}{dep.currentAnnualizedOperatingIncome !== undefined && <div><dt>{m.currentOperatingIncome}</dt><dd>{amount(dep.currentAnnualizedOperatingIncome, dep.currency)}</dd></div>}</dl>
      <details><summary>{m.assumptions}</summary><ul lang="en">{dep.assumptions.map((a) => <li key={a}>{a}</li>)}</ul></details>
    </div>}
    {lens.limitations.filter((l) => !MISSING_METRIC_LIMITATION.test(l)).map((l) => <p className="sec-reader-caption" key={l} lang="en">{l}</p>)}
  </div>;
}

const changeLabel = labels({ new: "New", changed: "Changed", continuing: "Continuing", not_comparable: "No baseline" },
  { new: "新增", changed: "变化", continuing: "延续", not_comparable: "无基准" });
export function QuarterChanges({ reader }: { reader: SecReaderReport }) {
  const ui = getLocale();
  return <div className="sec-reader-changes" lang={langOf(reader.changes[0]?.implication)}>{reader.changes.map((c, i) => <article key={`${c.topic}-${i}`} data-change={c.kind}>
    <div><span className="sec-reader-change-kind" lang={ui}>{changeLabel[c.kind]}</span><h3>{c.topic}</h3></div>
    <dl><div><dt lang={ui}>{m.prior}</dt><dd>{c.prior}</dd></div><div><dt lang={ui}>{m.current}</dt><dd>{c.current}</dd></div></dl>
    <p>{c.implication}</p>
  </article>)}</div>;
}

export function ReaderSection({ section, report, nodes }: { section: SecReaderReport["sections"][number]; report: PublishedSecReport; nodes: SecNodeResult[] }) {
  const selected = nodes.filter((n) => section.nodeIds.includes(n.id));
  const evidence = selected.flatMap((n) => n.evidence).filter((e, i, all) => all.findIndex((other) => other.excerpt === e.excerpt) === i).slice(0, 8);
  const visual = section.visual;
  const trend = readableTrend(report.trends?.find((t) => t.metricKey === (visual?.chart?.metricKey ?? section.chartMetricKey)));
  const layout = visual?.layout === "chart_focus" && !trend ? "essay" : visual?.layout ?? "essay";
  const paragraph = (p: string, i: number) => <div className="sec-reader-paragraph" key={i} lang={langOf(p)}>{layout === "comparison" && visual?.paragraphLabels?.[i] && <h3>{visual.paragraphLabels[i]}</h3>}<RichText text={p} /></div>;
  const chartTitle = trend ? visual?.chart?.title || m.overTime(formatSecMetricLabel(trend.metricKey, getLocale())) : "";
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
    <p className="sec-reader-takeaway" lang={langOf(section.takeaway)}><span lang={getLocale()}>{m.takeaway}</span>{section.takeaway}</p>
    </div>
    {evidence.length > 0 && <details className="sec-report-evidence"><summary>{m.excerpts} · {evidence.length}</summary>{evidence.map((e, i) => <blockquote key={i}><p lang="en">{e.excerpt}</p><footer>{m.characters(e.start.toLocaleString("en-US"), e.end.toLocaleString("en-US"))}</footer></blockquote>)}</details>}
  </div>;
}

export function MarketContext({ report }: { report: PublishedSecReport }) {
  const market = report.marketSnapshot;
  if (market?.status !== "available" || market.price === undefined) return <aside className="sec-reader-market"><p>{m.noMarket}</p></aside>;
  const move = market.reaction;
  return <aside className="sec-reader-market"><dl>
    <div><dt>{m.close(market.priceDate ?? "")}</dt><dd>{amount(market.price, market.currency ?? "")}</dd></div>
    {market.trailingPE !== undefined && <div><dt>{m.pe(market.earningsPeriodEnd ?? "")}</dt><dd>{m.multiple(market.trailingPE.toFixed(1))}</dd></div>}
    {move && <div><dt>{move.from} → {move.to}</dt><dd>{move.changePercent > 0 ? "+" : ""}{move.changePercent.toFixed(1)}%</dd></div>}
  </dl><p className="sec-reader-caption">{move ? m.sessions(move.sessions) : ""}{m.asOf(market.asOf.slice(0, 10))} · <a href={market.sourceUrl} target="_blank" rel="noopener noreferrer">{market.source}</a></p>
    <details><summary>{m.marketBasis}</summary><ul lang={langOf(market.limitations[0])}>{market.limitations.map((l) => <li key={l}>{l}</li>)}</ul></details>
  </aside>;
}

export function WatchConditions({ reader }: { reader: SecReaderReport }) {
  return <ol className="sec-reader-watch" lang={langOf(reader.watch[0]?.condition)}>{reader.watch.map((w, i) => <li key={i}><span>{w.deadline}</span><strong>{w.condition}</strong><p>{w.consequence}</p></li>)}</ol>;
}
