import { SecComposedSection } from "@/packages/web/src/report/report-blocks/SecComposedSection.tsx";
import type { PublishedSecReport } from "@/shared/analysis-contract/report.ts";
import type { SecFilingWithSummary } from "@/shared/analysis-contract/report.ts";
import type { ReactNode } from "react";
import { ReportBackLink } from "./ReportBackLink";
import { RichText } from "@/packages/web/src/report/rich-text/RichText.tsx";
import { SecReportNavigator, type ReportSectionLink } from "@/packages/web/src/sec-report/SecReportNavigator.tsx";
import { FinancialBridge, QuarterChanges, ReaderSection, WatchConditions } from "@/packages/web/src/report/report-blocks/SecReaderContent.tsx";
import { formatSecMetricLabel, formatSecMetricValue } from "@/packages/web/src/model/sec-metric-format.ts";
import { localizeReaderWarning, parseSecReaderReport } from "@/shared/analysis-runtime/sec-reader-schema.ts";
import { getLocale, messages } from "@/packages/web/src/i18n";
import { SourceLanguage } from "@/packages/web/src/i18n/SourceLanguage";

const m = messages({
  sourcesAndBasis: "Sources and analysis basis", keyTakeaways: "Key takeaways", investmentView: "Investment view", keyMetrics: "Key metrics",
  overview: "Report overview", dataQuality: "Data quality", changes: "Changes this period", watchList: "Watch list",
  workpapers: "Research basis and filing text", earningsReport: "Earnings period report", filingAnalysis: (form: string) => `${form} · SEC filing analysis`,
  inProgress: "Analysis in progress", ticker: "Ticker", periodEnd: "Period end", earningsDate: "Earnings date", filed: "Filed", generated: "Generated",
  someUnavailable: "Some content unavailable", noReport: "No report", reportInProgress: "Report in progress",
  sourceMaterials: "Source materials", textRead: "Text read", notParsed: "Not parsed", secFiling: "SEC filing",
  viewOnEdgar: "View filing on EDGAR ↗", notAdvice: "Not investment advice", noAnalysis: "No analysis", excerpts: "Filing excerpts",
  characters: (start: string, end: string) => `Characters ${start}–${end}`, noTakeaways: "No takeaways", noMetrics: "No verified metrics",
  qoq: (value: string) => `QoQ ${value}`, yoy: (value: string) => `YoY ${value}`, none: "n/a", definition: "Definition",
  noVerification: "No verification results", openQuestion: (question: string) => `Open question: ${question}`, incompleteNode: (id: string) => `Incomplete node: ${id}`,
  coverageLog: "Data coverage and processing log", textScanned: "Collected text scanned", disclosureCandidates: "Disclosure candidates",
  metricCoverage: "Metric coverage", structuredCheck: "Structured data check", completeness: "Analysis completeness",
  questionCoverage: "Research question coverage", reportVersion: "Report version", noIssues: "No issues",
  verified: "Verified", derived: "Derived", notDisclosed: "Not disclosed", notComparable: "Not comparable", partial: "Partial", failed: "Failed",
  allAnswered: "All questions answered", maxRounds: "Repair rounds exhausted", noProgress: "No repair progress", insufficient: "Insufficient filing support",
  partialBecause: (reason: string) => `Partial · ${reason}`,
}, {
  sourcesAndBasis: "来源与分析依据", keyTakeaways: "核心结论", investmentView: "投资观点", keyMetrics: "关键指标",
  overview: "报告概览", dataQuality: "数据质量", changes: "本期变化", watchList: "跟踪清单",
  workpapers: "研究依据与文件原文", earningsReport: "业绩期报告", filingAnalysis: (form: string) => `${form} · SEC 文件分析`,
  inProgress: "分析中", ticker: "股票代码", periodEnd: "期末日", earningsDate: "业绩发布日", filed: "提交日", generated: "生成日",
  someUnavailable: "部分内容不可用", noReport: "无报告", reportInProgress: "报告生成中",
  sourceMaterials: "来源材料", textRead: "已读取文本", notParsed: "未解析", secFiling: "SEC 文件",
  viewOnEdgar: "在 EDGAR 查看文件 ↗", notAdvice: "不构成投资建议", noAnalysis: "暂无分析", excerpts: "文件摘录",
  characters: (start: string, end: string) => `字符位置 ${start}–${end}`, noTakeaways: "无结论", noMetrics: "无已核验指标",
  qoq: (value: string) => `环比 ${value}`, yoy: (value: string) => `同比 ${value}`, none: "无", definition: "定义",
  noVerification: "无核验结果", openQuestion: (question: string) => `待解问题：${question}`, incompleteNode: (id: string) => `未完成节点：${id}`,
  coverageLog: "数据覆盖与处理日志", textScanned: "已扫描文本", disclosureCandidates: "候选披露",
  metricCoverage: "指标覆盖率", structuredCheck: "结构化数据核验", completeness: "分析完整度",
  questionCoverage: "研究问题覆盖率", reportVersion: "报告版本", noIssues: "无问题",
  verified: "已核验", derived: "推算", notDisclosed: "未披露", notComparable: "不可比", partial: "部分", failed: "失败",
  allAnswered: "问题均已回答", maxRounds: "修复轮次已用尽", noProgress: "修复无进展", insufficient: "文件依据不足",
  partialBecause: (reason: string) => `部分 · ${reason}`,
});

type ReportSectionDefinition = ReportSectionLink & {
  className?: string;
  content: ReactNode;
  /** Generated sections are English throughout; a generated title alone marks only the heading. */
  lang?: "en";
  titleLang?: "en";
};

export function SecReportDocument({ companyName, filing, embedded = false }: { companyName: string; filing: SecFilingWithSummary; embedded?: boolean }) {
  const summary = filing.summary;
  const group = filing.earningsGroup;
  // The page can receive snapshots from an older backend as well as current D1 reads.
  const parsed = filing.analysis?.reader ? parseSecReaderReport(filing.analysis.reader) : undefined;
  const renderWarnings = [...new Set([...(parsed?.reader?.presentationWarnings ?? []), ...(parsed?.warnings ?? [])])];
  const report = filing.analysis ? { ...filing.analysis, reader: parsed?.reader,
    dataQuality: { ...filing.analysis.dataQuality, warnings: [...new Set([...filing.analysis.dataQuality.warnings, ...renderWarnings])] } } : undefined;
  const reader = report?.reader;
  const reportReady = Boolean(summary?.report || (embedded && (report?.reader || report?.presentation)));
  const composed = report?.presentation?.version === "sec-presentation.v1" && report.presentation.sections.length > 0;
  const nodeSectionIndex = composed ? String(report!.presentation!.sections.length + 1).padStart(2, "0") : "04";
  const nodeSectionTitle = m.sourcesAndBasis;
  const nodeLinks: ReportSectionLink[] = (summary?.nodes ?? []).map((node, index) => ({
    id: `sec-report-node-${index + 1}`,
    index: `${nodeSectionIndex}.${String(index + 1).padStart(2, "0")}`,
    title: node.title,
    description: node.narrative || node.findings[0]?.detail,
    depth: 1,
    parentTitle: nodeSectionTitle,
  }));
  const reportSections: ReportSectionDefinition[] = reportReady ? [
    {
      id: "sec-report-conclusions",
      title: m.keyTakeaways,
      className: "sec-report-conclusions",
      content: (
        <>
          <ConclusionList bullets={summary?.bullets ?? []} />
          {summary?.analystView && <InvestmentView text={summary.analystView} />}
        </>
      ),
    },
    {
      id: "sec-report-metrics",
      title: m.keyMetrics,
      content: <VerifiedMetrics report={report} />,
    },
    {
      id: "sec-report-body",
      title: m.overview,
      content: (
        <div className="sec-report-body" lang="en">
          <RichText text={summary?.report ?? ""} />
        </div>
      ),
    },
    {
      id: "sec-report-nodes",
      title: nodeSectionTitle,
      content: (
        <div className="sec-report-node-list" lang="en">
          {(summary?.nodes ?? []).map((node, index) => (
            <details
              id={nodeLinks[index].id}
              open={!reader && !composed}
              tabIndex={-1}
              data-report-nav-item={!reader || undefined}
              data-report-index={nodeLinks[index].index}
              data-report-title={nodeLinks[index].title}
              data-report-description={nodeLinks[index].description}
              data-report-depth="1"
              data-report-parent-title={nodeSectionTitle}
              className="sec-report-node scroll-mt-24"
              key={node.id}
            >
              <summary><span>{node.title}</span></summary>
              <div>
                <NodeContent node={node} />
              </div>
            </details>
          ))}
        </div>
      ),
    },
    {
      id: "sec-report-quality",
      title: m.dataQuality,
      content: <DataQuality report={report} />,
    },
  ] : [];
  if (reportReady && !composed && !reader) {
    const nodeSectionPosition = reportSections.findIndex((section) => section.id === "sec-report-nodes");
    reportSections.splice(nodeSectionPosition, 1, ...(summary?.nodes ?? []).map((node, index) => ({
      id: nodeLinks[index].id,
      title: node.title,
      description: nodeLinks[index].description,
      content: <NodeContent node={node} />,
      lang: "en" as const,
    })));
  }
  if (reportReady && report?.presentation?.version === "sec-presentation.v1" && report.presentation.sections.length) {
    const evidenceSection = reportSections.find((section) => section.id === "sec-report-nodes")!;
    const qualitySection = reportSections.find((section) => section.id === "sec-report-quality")!;
    reportSections.splice(0, reportSections.length,
      ...report.presentation.sections.map((section) => ({ id: section.id, title: section.title, titleLang: "en" as const, content: <SecComposedSection section={section} report={report} /> })),
      { ...evidenceSection, title: m.sourcesAndBasis },
      qualitySection,
    );
  }
  if (reportReady && reader && report) {
    const qualitySection = reportSections.find((s) => s.id === "sec-report-quality")!;
    const evidenceSection = reportSections.find((s) => s.id === "sec-report-nodes")!;
    reportSections.splice(0, reportSections.length,
      { id: "sec-report-conclusions", title: m.keyTakeaways, content: <><ConclusionList bullets={summary?.bullets ?? []} />{summary?.analystView && <InvestmentView text={summary.analystView} />}<FinancialBridge report={report} /></> },
      { id: "sec-report-changes", title: m.changes, content: <QuarterChanges reader={reader} /> },
      { id: "sec-report-metrics", title: m.keyMetrics, content: <VerifiedMetrics report={report} /> },
      ...reader.sections.map((section) => ({ id: section.id, title: section.title, titleLang: "en" as const, description: section.takeaway, className: `sec-reader-section sec-reader-role-${section.role}`, content: <ReaderSection section={section} report={report} nodes={summary?.nodes ?? []} /> })),
      { id: "sec-report-watch", title: m.watchList, content: <WatchConditions reader={reader} /> },
      { ...evidenceSection, content: <details className="sec-reader-workpapers"><summary>{m.workpapers}</summary>{evidenceSection.content}</details> },
      qualitySection,
    );
  }
  const navigationSections: ReportSectionLink[] = reportSections.flatMap((section, index) => {
    const sectionLink = { id: section.id, index: String(index + 1).padStart(2, "0"), title: section.title, description: section.description, depth: 0 as const };
    return section.id === "sec-report-nodes" && !reader ? [sectionLink, ...nodeLinks] : [sectionLink];
  });

  const Container = embedded ? "article" : "main";
  const headline = summary?.headline || report?.headline || filing.description;
  return (
    <Container className="sec-report-shell">
      {!embedded && <ReportBackLink ticker={filing.ticker} />}
      {!embedded && <header className="sec-report-header">
        <div>
          <span className="sec-report-kicker">{group ? m.earningsReport : m.filingAnalysis(filing.form)} <SourceLanguage /></span>
          <h1>{companyName}</h1>
          {headline ? <p lang="en">{headline}</p> : <p>{m.inProgress}</p>}
        </div>
        <dl className="sec-report-meta">
          <div><dt>{m.ticker}</dt><dd>{filing.ticker}</dd></div>
          <div><dt>{m.periodEnd}</dt><dd>{formatDate(group?.periodEnd ?? filing.reportDate)}</dd></div>
          <div><dt>{group ? m.earningsDate : m.filed}</dt><dd>{formatDate(group?.earningsDate ?? filing.filingDate)}</dd></div>
          <div><dt>{m.generated}</dt><dd>{summary?.generatedAt.slice(0, 10) ?? "—"}</dd></div>
        </dl>
      </header>}
      {renderWarnings.length > 0 && <p role="status" className="sec-report-empty">{m.someUnavailable}</p>}
      {!reportReady ? (
        <section className="sec-report-pending" aria-labelledby="sec-report-pending-title">
          <h2 id="sec-report-pending-title">{embedded ? summary ? m.keyTakeaways : m.noReport : m.reportInProgress}{embedded && summary && <> <SourceLanguage /></>}</h2>
          {embedded && summary?.headline && <p lang="en">{summary.headline}</p>}
          {summary?.bullets.length ? <ConclusionList bullets={summary.bullets} /> : null}
          {embedded && summary?.analystView && <p lang="en">{summary.analystView}</p>}
        </section>
      ) : (
        <>
          {!embedded && <SecReportNavigator initialSections={navigationSections} />}
          <div data-report-sections>
            {reportSections.map((section, index) => (
              <section
                key={section.id}
                id={section.id}
                tabIndex={-1}
                data-report-section
                data-report-nav-item
                data-report-index={String(index + 1).padStart(2, "0")}
                data-report-title={section.title}
                data-report-description={section.description}
                data-report-depth="0"
                className={`sec-report-section scroll-mt-24 ${section.className ?? ""}`}
                lang={section.lang}
                aria-labelledby={`${section.id}-title`}
              >
                <SectionHeading index={String(index + 1).padStart(2, "0")} title={section.title} id={`${section.id}-title`} sourceLanguage={embedded && index === 0} lang={section.titleLang} />
                {section.content}
              </section>
            ))}
          </div>
        </>
      )}

      {report?.sourceMaterials?.length ? <section className="sec-report-section sec-materials" aria-label={m.sourceMaterials}>
        <h2>{m.sourceMaterials}</h2>
        <ul>{report.sourceMaterials.map((material, index) => <li key={`${material.filename}-${index}`}>
          <a href={material.url} target="_blank" rel="noopener noreferrer">{material.type} · {material.filename}</a>
          <span>{material.status === "read" ? m.textRead : m.notParsed}</span>
        </li>)}</ul>
      </section> : null}
      <footer className="sec-report-source">
        <div><span>{m.secFiling}</span><strong>{filing.form} · {filing.accessionNumber}</strong></div>
        <a href={filing.indexUrl} rel="noopener noreferrer" target="_blank">{m.viewOnEdgar}</a>
        <p>{m.notAdvice}</p>
      </footer>
    </Container>
  );
}

function SectionHeading({ id, index, title, sourceLanguage = false, lang }: { id: string; index: string; title: string; sourceLanguage?: boolean; lang?: string }) {
  return <div className="sec-report-section-heading"><span>{index}</span><h2 id={id} lang={lang}>{title}{sourceLanguage && <> <SourceLanguage /></>}</h2></div>;
}

/** The analyst's view is generated English; its label is in the reader's language. */
function InvestmentView({ text }: { text: string }) {
  return <p className="sec-report-investment-view" lang="en"><span lang={getLocale()}>{m.investmentView}</span>{text}</p>;
}

function NodeContent({ node }: { node: NonNullable<NonNullable<SecFilingWithSummary["summary"]>["nodes"]>[number] }) {
  return <>
    {node.findings.length > 0 && <ConclusionList bullets={node.findings} />}
    {node.narrative && <RichText text={node.narrative} />}
    {node.error && <p className="sec-report-error" lang={getLocale()}>{m.noAnalysis}</p>}
    {node.evidence.length > 0 && (
      <details className="sec-report-evidence">
        <summary lang={getLocale()}>{m.excerpts} · {node.evidence.length}</summary>
        {node.evidence.map((evidence, index) => (
          <blockquote key={`${evidence.start}-${index}`}>
            <p>{evidence.excerpt}</p>
            <footer lang={getLocale()}>{m.characters(evidence.start.toLocaleString("en-US"), evidence.end.toLocaleString("en-US"))}</footer>
          </blockquote>
        ))}
      </details>
    )}
  </>;
}

function ConclusionList({ bullets }: { bullets: NonNullable<SecFilingWithSummary["summary"]>["bullets"] }) {
  if (!bullets.length) return <p className="sec-report-empty">{m.noTakeaways}</p>;
  return (
    <ul className="sec-report-conclusion-list" lang="en">
      {bullets.map((bullet, index) => (
        <li data-importance={bullet.importance} key={`${bullet.label}-${index}`}>
          <strong>{bullet.label}</strong><span>{bullet.detail}</span>
        </li>
      ))}
    </ul>
  );
}

function VerifiedMetrics({ report }: { report: PublishedSecReport | null | undefined }) {
  if (!report?.keyMetrics.length) return <p className="sec-report-empty">{m.noMetrics}</p>;
  const locale = getLocale();
  return (
    <div className="sec-report-metrics">
      {report.keyMetrics.map((metric) => (
        <article key={metric.metricKey}>
          <span>{formatSecMetricLabel(metric.metricKey, locale)}</span>
          <strong>{formatSecMetricValue(metric.metricKey, metric.currentValue, metric.unit, metric.currency, locale)}</strong>
          <small>{m.qoq(metric.qoq || m.none)} · {m.yoy(metric.yoy || m.none)}</small>
          <i>{metricStatus(metric.status)}</i>
          {metric.definition && <details><summary>{m.definition}</summary><p lang="en">{metric.definition}</p></details>}
        </article>
      ))}
    </div>
  );
}

function DataQuality({ report }: { report: PublishedSecReport | null | undefined }) {
  if (!report) return <p className="sec-report-empty">{m.noVerification}</p>;
  const quality = report.dataQuality;
  const locale = getLocale();
  const notes = [
    ...quality.warnings.map((warning) => localizeReaderWarning(warning, locale)),
    ...(quality.unresolvedQuestions ?? []).map((question) => m.openQuestion(question)),
    ...(quality.failedNodeIds ?? []).map((nodeId) => m.incompleteNode(nodeId)),
  ];
  return (
    <div className="sec-report-quality">
      {report.reader?.limitations.map((l, i) => <p key={i} lang="en"><strong>{l.issue}: </strong>{l.impact}</p>)}
      {report.financialLens?.limitations.map((l) => <p key={l} lang="en">{l}</p>)}
      <details><summary>{m.coverageLog}</summary>
      <dl>
        {report.discovery && <>
          <div><dt>{m.textScanned}</dt><dd>{report.discovery.totalCharacters ? Math.round(report.discovery.scannedCharacters/report.discovery.totalCharacters*100) : 0}%</dd></div>
          <div><dt>{m.disclosureCandidates}</dt><dd>{report.discovery.disclosures.length}</dd></div>
        </>}
        <div><dt>{m.metricCoverage}</dt><dd>{Math.round(quality.coverage * 100)}%</dd></div>
        <div><dt>{m.structuredCheck}</dt><dd>{verificationStatus(quality.verificationStatus)}</dd></div>
        <div><dt>{m.completeness}</dt><dd>{analysisStatus(quality.analysisStatus, quality.stopReason)}</dd></div>
        {typeof quality.managerCoverageScore === "number"
          ? <div><dt>{m.questionCoverage}</dt><dd>{Math.round(quality.managerCoverageScore * 100)}%</dd></div>
          : null}
        <div><dt>{m.reportVersion}</dt><dd>{report.reportVersion}</dd></div>
      </dl>
      {notes.length > 0
        ? <ul>{notes.map((note) => <li key={note}>{note}</li>)}</ul>
        : <p>{m.noIssues}</p>}
      </details>
    </div>
  );
}

function formatDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || getLocale() === "zh-CN") return value;
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

function metricStatus(value: PublishedSecReport["keyMetrics"][number]["status"]): string {
  return value === "verified" ? m.verified : value === "derived" ? m.derived : value === "not_disclosed" ? m.notDisclosed : m.notComparable;
}

function verificationStatus(value: PublishedSecReport["dataQuality"]["verificationStatus"]): string {
  return value === "verified" ? m.verified : value === "partial" ? m.partial : m.failed;
}

function analysisStatus(
  value: PublishedSecReport["dataQuality"]["analysisStatus"],
  stopReason: PublishedSecReport["dataQuality"]["stopReason"],
): string {
  if (value === "complete") return m.allAnswered;
  const reason = stopReason === "max_rounds"
    ? m.maxRounds
    : stopReason === "no_progress"
      ? m.noProgress
      : stopReason === "analysis_incomplete"
        ? m.insufficient
        : null;
  return reason ? m.partialBecause(reason) : m.partial;
}
