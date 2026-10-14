import { Button } from "@/packages/web/src/ui/button";
import { useState } from "react";
import type { PublicFilingDigest } from "@/shared/analysis-contract/filings";
import { labels, messages } from "@/packages/web/src/i18n";
import { SourceLanguage } from "@/packages/web/src/i18n/SourceLanguage";
import { reportTitle } from "./reports-model";

const VERIFICATION = labels({ verified: "Figures verified", partial: "Partly verified", failed: "Verification failed" }, { verified: "数据已核验", partial: "部分核验", failed: "核验未通过" });
const m = messages({
  report: (title: string) => `Report: ${title}`, release: (date: string, end: string | null) => `Earnings release ${date} · Period ended ${end}`,
  filed: (form: string, date: string) => `${form} · Filed ${date}`, readFull: "Read full report", newer: "Newer", older: "Older", close: "Close report",
  keyFinancials: "Key financials", yoy: "YoY", qoq: "QoQ", changes: "Narrative changes", processing: "Analysis in progress", noFigures: "No verified key figures",
  showLess: "Show less", more: (n: number) => `${n} more`, noAnalysis: "No analysis", analystView: "Analyst view", further: "Further analysis",
  guidance: "Guidance", risk: "Risk", generated: (date: string) => `AI analysis · ${date}`, filing: (form: string) => `${form} filing`,
  edgar: (ticker: string) => `EDGAR filing index · ${ticker}`,
  derived: "Derived", notComparable: "Not comparable",
}, {
  report: (title: string) => `财报：${title}`, release: (date: string, end: string | null) => `业绩公告 ${date} · 截至 ${end}`,
  filed: (form: string, date: string) => `${form} · 提交于 ${date}`, readFull: "阅读完整财报", newer: "较新", older: "较早", close: "关闭财报",
  keyFinancials: "关键财务数据", yoy: "同比", qoq: "环比", changes: "表述变化", processing: "分析中", noFigures: "无已核验的关键数据",
  showLess: "收起", more: (n: number) => `另有 ${n} 条`, noAnalysis: "暂无分析", analystView: "分析观点", further: "延伸分析",
  guidance: "业绩指引", risk: "风险", generated: (date: string) => `AI 分析 · ${date}`, filing: (form: string) => `${form} 文件`,
  edgar: (ticker: string) => `EDGAR 文件索引 · ${ticker}`,
  derived: "推算", notComparable: "不可比",
});
/** Direction of a change as written: a leading sign first ("+12%", "−1.5 pp"), then words in English (or CJK for older text). */
const trend = (v: string | null) => !v ? undefined
  : /^\s*[+＋]/.test(v) ? "up" as const
  : /^\s*[-−–]/.test(v) ? "down" as const
  : /\b(?:up|increase[ds]?|higher|grew|growth|rose|improv\w*|expand\w*|widen\w*)\b|增|升|扩/i.test(v) ? "up" as const
  : /\b(?:down|decrease[ds]?|lower|declin\w*|fell|contract\w*|narrow\w*)\b|降|减|缩|收窄/i.test(v) ? "down" as const : undefined;

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
  return <section className="lens report-lens" aria-label={m.report(reportTitle(report))} key={report.accessionNumber}>
    <header className="lens-head">
      <div className="lens-title">
        <b className="lens-kind report-kind">{report.periodLabel ?? report.form}</b>
        <h2>{reportTitle(report)}</h2>
        <span className="lens-basis">{report.sources.length ? m.release(report.date, report.periodEnd) : m.filed(report.form, report.filingDate)}{report.verification && ` · ${VERIFICATION[report.verification]}`}<SourceLanguage /></span>
      </div>
      <div className="lens-nav">
        {report.hasReport && <Button variant="unstyled" type="button" className="lens-pair report-open" onClick={onOpenReport}>{m.readFull}</Button>}
        <span className="lens-steps"><Button variant="unstyled" type="button" aria-label={m.newer} disabled={index <= 0} onClick={() => onStep(-1)}>‹</Button><span>{index + 1} / {count}</span><Button variant="unstyled" type="button" aria-label={m.older} disabled={index >= count - 1} onClick={() => onStep(1)}>›</Button></span>
        <Button variant="unstyled" type="button" className="lens-close" aria-label={m.close} onClick={onClose}>✕</Button>
      </div>
    </header>
    <div className="lens-body">
      <div className="lens-chart report-figures">
        {report.keyMetrics.length > 0 ? <dl className="report-metrics" aria-label={m.keyFinancials}>
          {report.keyMetrics.map(k => <div key={k.key} className="report-metric" data-status={k.status}>
            <dt><span lang="en">{k.label}</span>{k.status === "derived" ? <i> · {m.derived}</i> : k.status === "not_comparable" ? <i> · {m.notComparable}</i> : null}</dt>
            <dd><b>{k.value}</b>{(k.yoy || k.qoq) && <small>{k.yoy && <em data-trend={trend(k.yoy)}>{m.yoy} {k.yoy}</em>}{k.qoq && <em data-trend={trend(k.qoq)}>{m.qoq} {k.qoq}</em>}</small>}</dd>
          </div>)}
        </dl> : report.changes.length > 0 ? <ul className="report-changes" aria-label={m.changes}>
          {report.changes.map((c, i) => <li key={i}><b>{c.compare === "QoQ" ? m.qoq : m.yoy} · <span lang="en">{c.topic}</span></b><span lang="en">{c.statement}</span></li>)}
        </ul> : <div className="lens-empty">{report.analysisStatus === "processing" ? m.processing : m.noFigures}</div>}
        {report.keyMetrics.length > 0 && report.changes.length > 0 && <ul className="report-changes report-changes--below" aria-label={m.changes}>
          {report.changes.slice(0, more ? 8 : 3).map((c, i) => <li key={i}><b>{c.compare === "QoQ" ? m.qoq : m.yoy} · <span lang="en">{c.topic}</span></b><span lang="en">{c.statement}</span></li>)}
          {report.changes.length > 3 && <li><Button variant="unstyled" type="button" className="report-more" onClick={() => setMore(v => !v)}>{more ? m.showLess : m.more(report.changes.length - 3)}</Button></li>}
        </ul>}
      </div>
      <div className="lens-text">
        {report.bullets.length > 0 ? <ul className="event-bullets" lang="en">{report.bullets.map((b, i) => <li key={i} data-importance={b.importance}><b>{b.label}</b>{b.detail}</li>)}</ul>
          : report.analysisStatus === "processing" || report.analysisStatus === "not_collected" ? <p className="lens-judgment">{m.processing}</p>
          : report.headline ? <p className="lens-judgment" lang="en">{report.headline}</p> : <p className="lens-judgment">{m.noAnalysis}</p>}
        {report.analystView && <p className="event-view"><b>{m.analystView}</b><span lang="en">{report.analystView}</span></p>}
        {report.report && <details className="event-footnotes"><summary>{m.further}</summary><p lang="en">{report.report}</p></details>}
        {report.guidance.length > 0 && <ul className="report-claims" data-kind="guidance">{report.guidance.map((g, i) => <li key={i}><b>{m.guidance}</b><span lang="en">{g}</span></li>)}</ul>}
        {report.risks.length > 0 && <ul className="report-claims" data-kind="risk">{report.risks.map((r, i) => <li key={i}><b>{m.risk}</b><span lang="en">{r}</span></li>)}</ul>}
        {report.warnings.length > 0 && <ul className="report-warnings" lang="en">{report.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
        {report.generatedAt && <p className="event-generated">{m.generated(report.generatedAt.slice(0, 10))}</p>}
        <ol className="sources sources--numbered">
          {report.sources.length ? report.sources.map(s => <li key={s.accessionNumber}><a href={s.indexUrl} target="_blank" rel="noopener noreferrer">{s.form} · {s.filingDate}<span aria-hidden="true"> ↗</span></a></li>)
            : <li><a href={report.documentUrl} target="_blank" rel="noopener noreferrer">{m.filing(report.form)}<span aria-hidden="true"> ↗</span></a></li>}
          <li><a href={report.edgarUrl} target="_blank" rel="noopener noreferrer">{m.edgar(ticker)}<span aria-hidden="true"> ↗</span></a></li>
        </ol>
      </div>
    </div>
  </section>;
}
