import { Button } from "@/packages/web/src/ui/button";
import { useState } from "react";
import type { PublicFilingDigest } from "@/shared/analysis-contract/filings";
import { reportTitle } from "./reports-model";

const VERIFICATION = { verified: "数字已核验", partial: "部分核验", failed: "核验未通过" } as const;
const trend = (v: string | null) => !v ? undefined : /^[+＋]|增|升|扩|improv|up/i.test(v) ? "up" as const : /^[-−–]|降|减|缩|收窄|down/i.test(v) ? "down" as const : undefined;

/**
 * A report in focus: the verified key figures with their comparisons on the left, the conclusions,
 * investment view and sources on the right, and the full report one click away. This is the
 * content the filing timeline used to show, in the lens's place.
 */
export function ReportLens({ report, ticker, index, count, onStep, onClose, onOpenReport }: {
  report: PublicFilingDigest;
  ticker: string;
  index: number;
  count: number;
  onStep: (delta: 1 | -1) => void;
  onClose: () => void;
  onOpenReport: () => void;
}) {
  const [more, setMore] = useState(false);
  return <section className="lens report-lens" aria-label={`财报：${reportTitle(report)}`} key={report.accessionNumber}>
    <header className="lens-head">
      <div className="lens-title">
        <b className="lens-kind report-kind">{report.periodLabel ?? report.form}</b>
        <h2>{reportTitle(report)}</h2>
        <span className="lens-basis">{report.sources.length ? `业绩发布 ${report.date} · 截至 ${report.periodEnd}` : `${report.form} · 申报 ${report.filingDate}`}{report.verification && ` · ${VERIFICATION[report.verification]}`}</span>
      </div>
      <div className="lens-nav">
        {report.hasReport && <Button variant="unstyled" type="button" className="lens-pair report-open" onClick={onOpenReport}>阅读完整报告</Button>}
        <span className="lens-steps"><Button variant="unstyled" type="button" aria-label="较新" disabled={index <= 0} onClick={() => onStep(-1)}>‹</Button><span>{index + 1} / {count}</span><Button variant="unstyled" type="button" aria-label="较早" disabled={index >= count - 1} onClick={() => onStep(1)}>›</Button></span>
        <Button variant="unstyled" type="button" className="lens-close" aria-label="关闭财报" onClick={onClose}>✕</Button>
      </div>
    </header>
    <div className="lens-body">
      <div className="lens-chart report-figures">
        {report.keyMetrics.length > 0 ? <dl className="report-metrics" aria-label="关键财务数据">
          {report.keyMetrics.map(m => <div key={m.key} className="report-metric" data-status={m.status}>
            <dt>{m.label}</dt>
            <dd><b>{m.value}</b>{(m.yoy || m.qoq) && <small>{m.yoy && <em data-trend={trend(m.yoy)}>同比 {m.yoy}</em>}{m.qoq && <em data-trend={trend(m.qoq)}>环比 {m.qoq}</em>}</small>}</dd>
          </div>)}
        </dl> : report.changes.length > 0 ? <ul className="report-changes" aria-label="叙述变化">
          {report.changes.map((c, i) => <li key={i}><b>{c.compare} · {c.topic}</b>{c.statement}</li>)}
        </ul> : <div className="lens-empty">{report.analysisStatus === "processing" ? "分析生成中，关键数据稍后显示" : "该报告没有已核验的关键数据"}</div>}
        {report.keyMetrics.length > 0 && report.changes.length > 0 && <ul className="report-changes report-changes--below" aria-label="叙述变化">
          {report.changes.slice(0, more ? 8 : 3).map((c, i) => <li key={i}><b>{c.compare} · {c.topic}</b>{c.statement}</li>)}
          {report.changes.length > 3 && <li><Button variant="unstyled" type="button" className="report-more" onClick={() => setMore(v => !v)}>{more ? "收起" : `还有 ${report.changes.length - 3} 项`}</Button></li>}
        </ul>}
      </div>
      <div className="lens-text">
        {report.bullets.length > 0 ? <ul className="event-bullets">{report.bullets.map((b, i) => <li key={i} data-importance={b.importance}><b>{b.label}</b>{b.detail}</li>)}</ul>
          : <p className="lens-judgment">{report.analysisStatus === "processing" || report.analysisStatus === "not_collected" ? "AI 解读正在后台生成。" : report.headline || "暂无解读。"}</p>}
        {report.analystView && <p className="event-view"><b>投资含义</b>{report.analystView}</p>}
        {report.report && <details className="event-footnotes"><summary>补充分析</summary><p>{report.report}</p></details>}
        {report.guidance.length > 0 && <ul className="report-claims" data-kind="guidance">{report.guidance.map((g, i) => <li key={i}><b>指引</b>{g}</li>)}</ul>}
        {report.risks.length > 0 && <ul className="report-claims" data-kind="risk">{report.risks.map((r, i) => <li key={i}><b>风险</b>{r}</li>)}</ul>}
        {report.warnings.length > 0 && <ul className="report-warnings">{report.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
        {report.generatedAt && <p className="event-generated">解读由模型基于申报原文生成于 {report.generatedAt.slice(0, 10)}，数字以原文为准</p>}
        <ol className="sources sources--numbered">
          {report.sources.length ? report.sources.map(s => <li key={s.accessionNumber}><a href={s.indexUrl} target="_blank" rel="noopener noreferrer">{s.form} · {s.filingDate}<span aria-hidden="true"> ↗</span></a></li>)
            : <li><a href={report.documentUrl} target="_blank" rel="noopener noreferrer">{report.form} 原文<span aria-hidden="true"> ↗</span></a></li>}
          <li><a href={report.edgarUrl} target="_blank" rel="noopener noreferrer">EDGAR 申报索引 · {ticker}<span aria-hidden="true"> ↗</span></a></li>
        </ol>
      </div>
    </div>
  </section>;
}
