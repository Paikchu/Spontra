import { Button } from "@/packages/web/src/ui/button";
import { useState } from "react";
import type { PublicFilingDigest } from "@/shared/analysis-contract/filings";
import { reportTitle } from "./reports-model";

const VERIFICATION = { verified: "Figures verified", partial: "Partly verified", failed: "Verification failed" } as const;
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
  return <section className="lens report-lens" aria-label={`Report: ${reportTitle(report)}`} key={report.accessionNumber}>
    <header className="lens-head">
      <div className="lens-title">
        <b className="lens-kind report-kind">{report.periodLabel ?? report.form}</b>
        <h2>{reportTitle(report)}</h2>
        <span className="lens-basis">{report.sources.length ? `Earnings release ${report.date} · Period ended ${report.periodEnd}` : `${report.form} · Filed ${report.filingDate}`}{report.verification && ` · ${VERIFICATION[report.verification]}`}</span>
      </div>
      <div className="lens-nav">
        {report.hasReport && <Button variant="unstyled" type="button" className="lens-pair report-open" onClick={onOpenReport}>Read full report</Button>}
        <span className="lens-steps"><Button variant="unstyled" type="button" aria-label="Newer" disabled={index <= 0} onClick={() => onStep(-1)}>‹</Button><span>{index + 1} / {count}</span><Button variant="unstyled" type="button" aria-label="Older" disabled={index >= count - 1} onClick={() => onStep(1)}>›</Button></span>
        <Button variant="unstyled" type="button" className="lens-close" aria-label="Close report" onClick={onClose}>✕</Button>
      </div>
    </header>
    <div className="lens-body">
      <div className="lens-chart report-figures">
        {report.keyMetrics.length > 0 ? <dl className="report-metrics" aria-label="Key financials">
          {report.keyMetrics.map(m => <div key={m.key} className="report-metric" data-status={m.status}>
            <dt>{m.label}</dt>
            <dd><b>{m.value}</b>{(m.yoy || m.qoq) && <small>{m.yoy && <em data-trend={trend(m.yoy)}>YoY {m.yoy}</em>}{m.qoq && <em data-trend={trend(m.qoq)}>QoQ {m.qoq}</em>}</small>}</dd>
          </div>)}
        </dl> : report.changes.length > 0 ? <ul className="report-changes" aria-label="Narrative changes">
          {report.changes.map((c, i) => <li key={i}><b>{c.compare} · {c.topic}</b>{c.statement}</li>)}
        </ul> : <div className="lens-empty">{report.analysisStatus === "processing" ? "Analysis in progress" : "No verified key figures"}</div>}
        {report.keyMetrics.length > 0 && report.changes.length > 0 && <ul className="report-changes report-changes--below" aria-label="Narrative changes">
          {report.changes.slice(0, more ? 8 : 3).map((c, i) => <li key={i}><b>{c.compare} · {c.topic}</b>{c.statement}</li>)}
          {report.changes.length > 3 && <li><Button variant="unstyled" type="button" className="report-more" onClick={() => setMore(v => !v)}>{more ? "Show less" : `${report.changes.length - 3} more`}</Button></li>}
        </ul>}
      </div>
      <div className="lens-text">
        {report.bullets.length > 0 ? <ul className="event-bullets">{report.bullets.map((b, i) => <li key={i} data-importance={b.importance}><b>{b.label}</b>{b.detail}</li>)}</ul>
          : <p className="lens-judgment">{report.analysisStatus === "processing" || report.analysisStatus === "not_collected" ? "Analysis in progress" : report.headline || "No analysis"}</p>}
        {report.analystView && <p className="event-view"><b>Analyst view</b>{report.analystView}</p>}
        {report.report && <details className="event-footnotes"><summary>Further analysis</summary><p>{report.report}</p></details>}
        {report.guidance.length > 0 && <ul className="report-claims" data-kind="guidance">{report.guidance.map((g, i) => <li key={i}><b>Guidance</b>{g}</li>)}</ul>}
        {report.risks.length > 0 && <ul className="report-claims" data-kind="risk">{report.risks.map((r, i) => <li key={i}><b>Risk</b>{r}</li>)}</ul>}
        {report.warnings.length > 0 && <ul className="report-warnings">{report.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
        {report.generatedAt && <p className="event-generated">AI analysis · {report.generatedAt.slice(0, 10)}</p>}
        <ol className="sources sources--numbered">
          {report.sources.length ? report.sources.map(s => <li key={s.accessionNumber}><a href={s.indexUrl} target="_blank" rel="noopener noreferrer">{s.form} · {s.filingDate}<span aria-hidden="true"> ↗</span></a></li>)
            : <li><a href={report.documentUrl} target="_blank" rel="noopener noreferrer">{report.form} filing<span aria-hidden="true"> ↗</span></a></li>}
          <li><a href={report.edgarUrl} target="_blank" rel="noopener noreferrer">EDGAR filing index · {ticker}<span aria-hidden="true"> ↗</span></a></li>
        </ol>
      </div>
    </div>
  </section>;
}
