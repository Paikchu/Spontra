import type { PublishedSecReport, SecNodeResult } from "@/shared/analysis-contract/report.ts";
import type { SecReaderReport } from "@/shared/analysis-contract/sec-reader.ts";
import { formatSecMetricValue, formatSecMetricLabel } from "@/lib/earning-report/web/sec-metric-format.ts";
import { RichText } from "../rich-text/RichText.tsx";
import { ReportContentRenderer } from "./ReportContentRenderer.tsx";
import { ReportMediaGroup } from "./ReportMediaGroup.tsx";
import { readableTrend, SecTrendFigure, SecTrendSource } from "./SecTrendFigure.tsx";

const amount = (v: number, currency: string) => formatSecMetricValue("amount", String(v), currency, currency);

export function ReportBoundary({ report }: { report?: PublishedSecReport | null }) {
  if (!report) return null;
  const critical = report.financialLens?.limitations.filter((l) => /缺少本期|缺少可核验的公司/.test(l)) ?? [];
  critical.push(...(report.reader?.limitations ?? []).slice(0, 3).map((l) => `${l.issue}：${l.impact}`));
  const unread = report.sourceMaterials?.filter((m) => m.status !== "read").length ?? 0;
  if (unread) critical.push(`有 ${unread} 份附件尚未解析，相关业务和财务信息可能缺失。`);
  // Historical reports only carry machine warnings; translate those without claiming no balance sheet was read.
  if (!report.financialLens) {
    const missing = report.dataQuality.warnings.find((w) => w.startsWith("XBRL has no current-period value for:")) ?? "";
    if (/\bdebt\b/.test(missing)) critical.push("本报告缺少本期可核验的债务总额，杠杆全貌不可见。");
    if (/\bgross_margin\b/.test(missing)) critical.push("缺少可核验的整体毛利率，分部利润率不能替代。");
  }
  const partial = report.dataQuality.analysisStatus !== "complete" || report.dataQuality.verificationStatus !== "verified"
    || Boolean(report.dataQuality.failedNodeIds?.length || report.dataQuality.unresolvedQuestions?.length)
    || report.dataQuality.warnings.some((w) => /编排.*未|审校未完成/.test(w));
  if (!partial && !critical.length) return null;
  return <aside className="sec-reader-boundary" aria-label="阅读前需要知道">
    <strong>{partial ? "这份报告仍有判断边界" : "影响判断的数据缺口"}</strong>
    {critical.map((text) => <p key={text}>{text}</p>)}
    {partial && <p>部分证据或分析尚不完整；已核验数字不代表整份投资判断已获证实。<a href="#sec-report-quality">查看范围与缺口</a></p>}
  </aside>;
}

export function FinancialBridge({ report }: { report: PublishedSecReport }) {
  const lens = report.financialLens;
  if (!lens?.cashBridge && !lens?.depreciation) return null;
  const cash = lens.cashBridge, dep = lens.depreciation;
  return <div className="sec-reader-financial-lens">
    {cash && <div className="sec-reader-cash">
      <h3>{cash.adjustedFCF !== undefined ? "现金流：两种计算口径" : "现金流与资本开支"}</h3><p className="sec-reader-caption">{cash.period} · 自由现金流为非 GAAP 流动性指标</p>
      <div className="sec-reader-cash-values">
        <div><span>经营现金流 − 总资本开支</span><strong data-direction={cash.standardFCF < 0 ? "negative" : "positive"}>{amount(cash.standardFCF, cash.currency)}</strong><small>{amount(cash.operatingCashFlow, cash.currency)} − {amount(cash.grossCapex, cash.currency)}</small></div>
        {cash.adjustedFCF !== undefined && <div><span>按管理层净资本开支测算</span><strong data-direction={cash.adjustedFCF < 0 ? "negative" : "positive"}>{amount(cash.adjustedFCF, cash.currency)}</strong><small>{amount(cash.operatingCashFlow, cash.currency)} − {amount(cash.managementNetCapex!, cash.currency)}</small></div>}
      </div>
      {cash.adjustments && <details><summary>核对净资本开支调节表</summary><p>{amount(cash.grossCapex, cash.currency)}{cash.adjustments.map((a) => ` ${a.value < 0 ? "−" : "+"} ${amount(Math.abs(a.value), cash.currency)}`).join("")} = {amount(cash.managementNetCapex!, cash.currency)}</p><ul>{cash.adjustments.map((a, i) => <li key={i}>{a.label}：{a.value < 0 ? "扣减" : "加回"} {amount(Math.abs(a.value), cash.currency)}</li>)}</ul><p>按原表数值正负号核对；算术一致不代表调整项与经营现金流互不重叠。</p></details>}
      {cash.reconciliationStatus === "unverified" && <p className="sec-reader-caption">管理层口径为算术测算，调整项与经营现金流是否重叠尚待核对；不能直接视为可自由支配现金。</p>}
      {cash.adjustment !== undefined && <p>差额 {amount(cash.adjustment, cash.currency)} 来自资本开支的调整。调整口径为正，也不能单独证明无需融资。</p>}
    </div>}
    {dep && <div className="sec-reader-depreciation"><h3>投入怎样传到未来利润</h3>
      <p>假设当前投入速度持续一年，年化资本开支 {amount(dep.annualizedCapex, dep.currency)}；全部按 {dep.usefulLifeYears} 年、零残值、直线法计提，年费用量级为 <strong>{amount(dep.annualExpenseIllustration, dep.currency)}</strong>。</p>
      <dl>{dep.currentAnnualizedDepreciation !== undefined && <div><dt>本期折旧年化</dt><dd>{amount(dep.currentAnnualizedDepreciation, dep.currency)}</dd></div>}{dep.currentAnnualizedOperatingIncome !== undefined && <div><dt>本期营业利润年化</dt><dd>{amount(dep.currentAnnualizedOperatingIncome, dep.currency)}</dd></div>}</dl>
      <p className="sec-reader-caption">这是量级压力测试，不能视为明年新增折旧，也不能与现有折旧直接相加。</p>
      <details><summary>查看推演假设</summary><ul>{dep.assumptions.map((a) => <li key={a}>{a}</li>)}</ul></details>
    </div>}
    {lens.limitations.filter((l) => !/缺少本期|缺少可核验的公司/.test(l)).map((l) => <p className="sec-reader-caption" key={l}>{l}</p>)}
  </div>;
}

const changeLabel = { new: "本期新增", changed: "发生变化", continuing: "趋势延续", not_comparable: "基线待补" };
export function QuarterChanges({ reader }: { reader: SecReaderReport }) {
  return <div className="sec-reader-changes">{reader.changes.map((c, i) => <article key={`${c.topic}-${i}`} data-change={c.kind}>
    <div><span className="sec-reader-change-kind">{changeLabel[c.kind]}</span><h3>{c.topic}</h3></div>
    <dl><div><dt>前期</dt><dd>{c.prior}</dd></div><div><dt>本期</dt><dd>{c.current}</dd></div></dl>
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
  const chartTitle = trend ? visual?.chart?.title || `${formatSecMetricLabel(trend.metricKey)}的变化` : "";
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
    <p className="sec-reader-takeaway"><span>分析结论</span>{section.takeaway}</p>
    </div>
    {evidence.length > 0 && <details className="sec-report-evidence"><summary>核对原文 · {evidence.length} 段</summary>{evidence.map((e, i) => <blockquote key={i}><p>{e.excerpt}</p><footer>字符位置 {e.start}–{e.end}</footer></blockquote>)}</details>}
  </div>;
}

export function MarketContext({ report }: { report: PublishedSecReport }) {
  const market = report.marketSnapshot;
  if (market?.status !== "available" || market.price === undefined) return <aside className="sec-reader-market"><p>缺少可核验的行情快照，以下只能讨论业务条件，无法判断当前价格是否有吸引力。</p></aside>;
  const move = market.reaction;
  return <aside className="sec-reader-market"><dl>
    <div><dt>{market.priceDate} 收盘</dt><dd>{amount(market.price, market.currency ?? "")}</dd></div>
    {market.trailingPE !== undefined && <div><dt>P/E · 截至 {market.earningsPeriodEnd} 的过去一年摊薄 EPS</dt><dd>{market.trailingPE.toFixed(1)} 倍</dd></div>}
    {move && <div><dt>{move.from} → {move.to}</dt><dd>{move.changePercent > 0 ? "+" : ""}{move.changePercent.toFixed(1)}%</dd></div>}
  </dl><p className="sec-reader-caption">{move ? `截至发布后第 ${move.sessions} 个完整交易日。` : ""}快照生成于 {market.asOf.slice(0, 10)} · <a href={market.sourceUrl} target="_blank" rel="noopener noreferrer">{market.source}</a></p>
    <details><summary>行情与估值口径</summary><ul>{market.limitations.map((l) => <li key={l}>{l}</li>)}</ul></details>
  </aside>;
}

export function WatchConditions({ reader }: { reader: SecReaderReport }) {
  return <ol className="sec-reader-watch">{reader.watch.map((w, i) => <li key={i}><span>{w.deadline}</span><strong>{w.condition}</strong><p>{w.consequence}</p></li>)}</ol>;
}
