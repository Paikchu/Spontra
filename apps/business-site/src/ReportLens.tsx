import { Button } from "@/packages/web/src/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/packages/web/src/ui/table";
import { useState } from "react";
import type { PublicFilingDigest } from "@/shared/analysis-contract/filings";
import { labels, messages } from "@/packages/web/src/i18n";
import { SourceLanguage, langOf } from "@/packages/web/src/i18n/SourceLanguage";
import type { FindingData } from "@/shared/analysis-runtime/findings";
import { ItemAnalysisBody, useItemAnalysis, useVerifiedAnalysis } from "./ItemAnalysis";
import { reportTitle, reportTitleLang } from "./reports-model";

const VERIFICATION = labels({ verified: "Figures verified", partial: "Partly verified", failed: "Verification failed" }, { verified: "数据已核验", partial: "部分核验", failed: "核验未通过" });
const m = messages({
  report: (title: string) => `Report: ${title}`, release: (date: string, end: string | null) => `Earnings release ${date} · Period ended ${end}`,
  filed: (form: string, date: string) => `${form} · Filed ${date}`, readFull: "Read full report", newer: "Newer", older: "Older", close: "Close report",
  keyFinancials: "Key financials", metric: "Metric", value: "Value", yoy: "YoY", qoq: "QoQ", changes: "Narrative changes", processing: "Analysis in progress", noFigures: "No verified key figures",
  showLess: "Show less", more: (n: number) => `${n} more`, noAnalysis: "No analysis", analystView: "Analyst view", further: "Further analysis",
  guidance: "Guidance", risk: "Risk", generated: (date: string) => `AI analysis · ${date}`, filing: (form: string) => `${form} filing`,
  edgar: (ticker: string) => `EDGAR filing index · ${ticker}`,
  derived: "Derived", notComparable: "Not comparable",
}, {
  report: (title: string) => `财报：${title}`, release: (date: string, end: string | null) => `业绩公告 ${date} · 截至 ${end}`,
  filed: (form: string, date: string) => `${form} · 提交于 ${date}`, readFull: "阅读完整财报", newer: "较新", older: "较早", close: "关闭财报",
  keyFinancials: "关键财务数据", metric: "指标", value: "数值", yoy: "同比", qoq: "环比", changes: "表述变化", processing: "分析中", noFigures: "无已核验的关键数据",
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
 * A report in focus, holding the whole stage the way a finding does: its analysis, written by the agent every analysis
 * is written by and verified here as a finding is, with the full report one click away. Until the report has one, the
 * filing digest stands in — the verified key figures beside the conclusions, investment view and sources.
 */
export function ReportLens({ report, ticker, data, updates, nodeColor, index, count, onStep, onClose, onOpenReport }: {
  report: PublicFilingDigest;
  ticker: string;
  data: FindingData;
  updates: number;
  nodeColor: (id: string) => string;
  index: number;
  count: number;
  onStep: (delta: 1 | -1) => void;
  onClose: () => void;
  onOpenReport: () => void;
}) {
  const [more, setMore] = useState(false);
  const analysis = useItemAnalysis(ticker, report.accessionNumber, updates);
  const verified = useVerifiedAnalysis(analysis, data, ticker);
  return <section className="lens report-lens" aria-label={m.report(reportTitle(report))} key={report.accessionNumber}>
    <header className="lens-head">
      <div className="lens-title">
        <b className="lens-kind report-kind">{report.periodLabel ?? report.form}</b>
        <h2 lang={verified ? langOf(verified.finding.title) : reportTitleLang(report)}>{verified?.finding.title ?? reportTitle(report)}</h2>
        <span className="lens-basis">{report.sources.length ? m.release(report.date, report.periodEnd) : m.filed(report.form, report.filingDate)}{!verified && report.verification && ` · ${VERIFICATION[report.verification]}`}<SourceLanguage of={verified ? [verified.finding.title, verified.finding.judgment.text] : [report.headline, report.analystView, ...report.bullets.flatMap(b => [b.label, b.detail])]} /></span>
      </div>
      <div className="lens-nav">
        {report.hasReport && <Button variant="unstyled" type="button" className="lens-pair report-open" onClick={onOpenReport}>{m.readFull}</Button>}
        <span className="lens-steps"><Button variant="unstyled" type="button" aria-label={m.newer} disabled={index <= 0} onClick={() => onStep(-1)}>‹</Button><span>{index + 1} / {count}</span><Button variant="unstyled" type="button" aria-label={m.older} disabled={index >= count - 1} onClick={() => onStep(1)}>›</Button></span>
        <Button variant="unstyled" type="button" className="lens-close" aria-label={m.close} onClick={onClose}>✕</Button>
      </div>
    </header>
    <ItemAnalysisBody analysis={analysis} verified={verified} ticker={ticker} nodeColor={nodeColor} fallback={<div className="lens-doc"><div className="lens-doc-row">
      <div className="lens-doc-cell">
        {report.keyMetrics.length > 0 ? <Table className="lens-table report-metrics" aria-label={m.keyFinancials}>
          <TableHeader><TableRow><TableHead>{m.metric}</TableHead><TableHead>{m.value}</TableHead><TableHead>{m.yoy}</TableHead><TableHead>{m.qoq}</TableHead></TableRow></TableHeader>
          <TableBody>{report.keyMetrics.map(k => <TableRow key={k.key} data-status={k.status}>
            <TableHead scope="row"><span lang={langOf(k.label)}>{k.label}</span>{k.status === "derived" ? <small>{m.derived}</small> : k.status === "not_comparable" ? <small>{m.notComparable}</small> : null}</TableHead>
            <TableCell><b>{k.value}</b></TableCell>
            <TableCell>{k.yoy ? <em data-trend={trend(k.yoy)}>{k.yoy}</em> : "—"}</TableCell>
            <TableCell>{k.qoq ? <em data-trend={trend(k.qoq)}>{k.qoq}</em> : "—"}</TableCell>
          </TableRow>)}</TableBody>
        </Table> : report.changes.length > 0 ? <ul className="report-changes" aria-label={m.changes}>
          {report.changes.map((c, i) => <li key={i}><b>{c.compare === "QoQ" ? m.qoq : m.yoy} · <span lang={langOf(c.topic)}>{c.topic}</span></b><span lang={langOf(c.statement)}>{c.statement}</span></li>)}
        </ul> : <div className="lens-empty">{report.analysisStatus === "processing" ? m.processing : m.noFigures}</div>}
        {report.keyMetrics.length > 0 && report.changes.length > 0 && <ul className="report-changes report-changes--below" aria-label={m.changes}>
          {report.changes.slice(0, more ? 8 : 3).map((c, i) => <li key={i}><b>{c.compare === "QoQ" ? m.qoq : m.yoy} · <span lang={langOf(c.topic)}>{c.topic}</span></b><span lang={langOf(c.statement)}>{c.statement}</span></li>)}
          {report.changes.length > 3 && <li><Button variant="unstyled" type="button" className="report-more" onClick={() => setMore(v => !v)}>{more ? m.showLess : m.more(report.changes.length - 3)}</Button></li>}
        </ul>}
      </div>
      <div className="lens-doc-cell">
        {report.bullets.length > 0 ? <ul className="event-bullets">{report.bullets.map((b, i) => <li key={i} data-importance={b.importance} lang={langOf(b.detail)}><b>{b.label}</b>{b.detail}</li>)}</ul>
          : report.analysisStatus === "processing" || report.analysisStatus === "not_collected" ? <p className="lens-judgment">{m.processing}</p>
          : report.headline ? <p className="lens-judgment" lang={langOf(report.headline)}>{report.headline}</p> : <p className="lens-judgment">{m.noAnalysis}</p>}
        {report.analystView && <p className="event-view"><b>{m.analystView}</b><span lang={langOf(report.analystView)}>{report.analystView}</span></p>}
        {report.report && <details className="event-footnotes"><summary>{m.further}</summary><p lang="en">{report.report}</p></details>}
        {report.guidance.length > 0 && <ul className="report-claims" data-kind="guidance">{report.guidance.map((g, i) => <li key={i}><b>{m.guidance}</b><span lang={langOf(g)}>{g}</span></li>)}</ul>}
        {report.risks.length > 0 && <ul className="report-claims" data-kind="risk">{report.risks.map((r, i) => <li key={i}><b>{m.risk}</b><span lang={langOf(r)}>{r}</span></li>)}</ul>}
        {report.warnings.length > 0 && <ul className="report-warnings" lang="en">{report.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
        {report.generatedAt && <p className="event-generated">{m.generated(report.generatedAt.slice(0, 10))}</p>}
        <ol className="sources sources--numbered">
          {report.sources.length ? report.sources.map(s => <li key={s.accessionNumber}><a href={s.indexUrl} target="_blank" rel="noopener noreferrer">{s.form} · {s.filingDate}<span aria-hidden="true"> ↗</span></a></li>)
            : <li><a href={report.documentUrl} target="_blank" rel="noopener noreferrer">{m.filing(report.form)}<span aria-hidden="true"> ↗</span></a></li>}
          <li><a href={report.edgarUrl} target="_blank" rel="noopener noreferrer">{m.edgar(ticker)}<span aria-hidden="true"> ↗</span></a></li>
        </ol>
      </div>
    </div></div>} />
  </section>;
}
