import { SecComposedSection } from "@/packages/web/src/report/report-blocks/SecComposedSection.tsx";
import type { PublishedSecReport } from "@/shared/analysis-contract/report.ts";
import type { SecFilingWithSummary } from "@/shared/analysis-contract/report.ts";
import type { ReactNode } from "react";
import { ReportBackLink } from "./ReportBackLink";
import { RichText } from "@/packages/web/src/report/rich-text/RichText.tsx";
import { SecReportNavigator, type ReportSectionLink } from "@/packages/web/src/sec-report/SecReportNavigator.tsx";
import { FinancialBridge, QuarterChanges, ReaderSection, WatchConditions } from "@/packages/web/src/report/report-blocks/SecReaderContent.tsx";
import { formatSecMetricLabel, formatSecMetricValue } from "@/packages/web/src/model/sec-metric-format.ts";
import { parseSecReaderReport } from "@/shared/analysis-runtime/sec-reader-schema.ts";

type ReportSectionDefinition = ReportSectionLink & {
  className?: string;
  content: ReactNode;
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
  const nodeSectionTitle = "Sources and analysis basis";
  const nodeLinks: ReportSectionLink[] = (summary?.nodes ?? []).map((node, index) => ({
    id: `sec-report-node-${index + 1}`,
    index: `${nodeSectionIndex}.${String(index + 1).padStart(2, "0")}`,
    title: node.title,
    description: node.narrative || node.findings[0]?.detail || "Findings and filing excerpts for this topic.",
    depth: 1,
    parentTitle: nodeSectionTitle,
  }));
  const reportSections: ReportSectionDefinition[] = reportReady ? [
    {
      id: "sec-report-conclusions",
      title: "Key takeaways",
      description: "Operating results, main drivers and what they mean for the investment case.",
      className: "sec-report-conclusions",
      content: (
        <>
          <ConclusionList bullets={summary?.bullets ?? []} />
          {summary?.analystView && <p className="sec-report-investment-view"><span>Investment view</span>{summary.analystView}</p>}
        </>
      ),
    },
    {
      id: "sec-report-metrics",
      title: "Key metrics",
      description: "Verified financial metrics with year-over-year and quarter-over-quarter changes.",
      content: <VerifiedMetrics report={report} />,
    },
    {
      id: "sec-report-body",
      title: "Report overview",
      description: "The full analysis based on the SEC filing.",
      content: (
        <div className="sec-report-body">
          <RichText text={summary?.report ?? ""} />
        </div>
      ),
    },
    {
      id: "sec-report-nodes",
      title: nodeSectionTitle,
      description: "Findings, analysis and filing excerpts by topic.",
      content: (
        <div className="sec-report-node-list">
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
      title: "Data quality",
      description: "Evidence coverage, verification status and items that need manual review.",
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
    })));
  }
  if (reportReady && report?.presentation?.version === "sec-presentation.v1" && report.presentation.sections.length) {
    const evidenceSection = reportSections.find((section) => section.id === "sec-report-nodes")!;
    const qualitySection = reportSections.find((section) => section.id === "sec-report-quality")!;
    reportSections.splice(0, reportSections.length,
      ...report.presentation.sections.map((section) => ({ id: section.id, title: section.title, description: "Analysis and evidence on the company's business.", content: <SecComposedSection section={section} report={report} /> })),
      { ...evidenceSection, title: "Sources and analysis basis", description: "Research basis and filing excerpts." },
      qualitySection,
    );
  }
  if (reportReady && reader && report) {
    const qualitySection = reportSections.find((s) => s.id === "sec-report-quality")!;
    const evidenceSection = reportSections.find((s) => s.id === "sec-report-nodes")!;
    reportSections.splice(0, reportSections.length,
      { id: "sec-report-conclusions", title: "Key takeaways", description: "Key takeaways and changes that affect the investment case.", content: <><ConclusionList bullets={summary?.bullets ?? []} />{summary?.analystView && <p className="sec-report-investment-view"><span>Investment view</span>{summary.analystView}</p>}<FinancialBridge report={report} /></> },
      { id: "sec-report-changes", title: "Changes this period", description: "What is new, changed, continuing or lacks a baseline.", content: <QuarterChanges reader={reader} /> },
      { id: "sec-report-metrics", title: "Key metrics", description: "Current values on a consistent basis, with YoY and QoQ changes.", content: <VerifiedMetrics report={report} /> },
      ...reader.sections.map((section) => ({ id: section.id, title: section.title, description: section.takeaway, className: `sec-reader-section sec-reader-role-${section.role}`, content: <ReaderSection section={section} report={report} nodes={summary?.nodes ?? []} /> })),
      { id: "sec-report-watch", title: "What to check next", description: "Conditions and timing for the next check, and the views they would revise.", content: <WatchConditions reader={reader} /> },
      { ...evidenceSection, content: <details className="sec-reader-workpapers"><summary>Research basis and filing text</summary>{evidenceSection.content}</details> },
      qualitySection,
    );
  }
  const navigationSections: ReportSectionLink[] = reportSections.flatMap((section, index) => {
    const sectionLink = { id: section.id, index: String(index + 1).padStart(2, "0"), title: section.title, description: section.description, depth: 0 as const };
    return section.id === "sec-report-nodes" && !reader ? [sectionLink, ...nodeLinks] : [sectionLink];
  });

  const Container = embedded ? "article" : "main";
  return (
    <Container className="sec-report-shell">
      {!embedded && <ReportBackLink ticker={filing.ticker} />}
      {!embedded && <header className="sec-report-header">
        <div>
          <span className="sec-report-kicker">{group ? "Earnings period report" : `${filing.form} · SEC filing analysis`}</span>
          <h1>{companyName}</h1>
          <p>{summary?.headline || report?.headline || filing.description || "Analysis in progress"}</p>
        </div>
        <dl className="sec-report-meta">
          <div><dt>Ticker</dt><dd>{filing.ticker}</dd></div>
          <div><dt>Period end</dt><dd>{formatDate(group?.periodEnd ?? filing.reportDate)}</dd></div>
          <div><dt>{group ? "Earnings date" : "Filed"}</dt><dd>{formatDate(group?.earningsDate ?? filing.filingDate)}</dd></div>
          <div><dt>Generated</dt><dd>{summary?.generatedAt.slice(0, 10) ?? "—"}</dd></div>
        </dl>
      </header>}
      {renderWarnings.length > 0 && <p role="status" className="sec-report-empty">Some charts or text could not be shown. The available text is kept; see Data quality for details.</p>}
      {!reportReady ? (
        <section className="sec-report-pending" aria-labelledby="sec-report-pending-title">
          <h2 id="sec-report-pending-title">{embedded ? summary ? "Key takeaways" : "No report available" : "Full report in progress"}</h2>
          <p>{embedded ? summary ? summary.headline : "Check the run history for progress and failure reasons." : "Showing the last available summary. The full report replaces it once verified."}</p>
          {summary?.bullets.length ? <ConclusionList bullets={summary.bullets} /> : null}
          {embedded && summary?.analystView && <p>{summary.analystView}</p>}
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
                aria-labelledby={`${section.id}-title`}
              >
                <SectionHeading index={String(index + 1).padStart(2, "0")} title={section.title} id={`${section.id}-title`} />
                {section.content}
              </section>
            ))}
          </div>
        </>
      )}

      {report?.sourceMaterials?.length ? <section className="sec-report-section sec-materials" aria-label="Source materials">
        <h2>Source materials</h2>
        <ul>{report.sourceMaterials.map((material, index) => <li key={`${material.filename}-${index}`}>
          <a href={material.url} target="_blank" rel="noopener noreferrer">{material.type} · {material.filename}</a>
          <span>{material.status === "read" ? "Text read" : "Not parsed"}</span>
        </li>)}</ul>
      </section> : null}
      <footer className="sec-report-source">
        <div><span>SEC filing</span><strong>{filing.form} · {filing.accessionNumber}</strong></div>
        <a href={filing.indexUrl} rel="noopener noreferrer" target="_blank">View filing on EDGAR ↗</a>
        <p>For research only. Not investment advice. Check figures and conclusions against the original filing.</p>
      </footer>
    </Container>
  );
}

function SectionHeading({ id, index, title }: { id: string; index: string; title: string }) {
  return <div className="sec-report-section-heading"><span>{index}</span><h2 id={id}>{title}</h2></div>;
}

function NodeContent({ node }: { node: NonNullable<NonNullable<SecFilingWithSummary["summary"]>["nodes"]>[number] }) {
  return <>
    {node.findings.length > 0 && <ConclusionList bullets={node.findings} />}
    {node.narrative && <RichText text={node.narrative} />}
    {node.error && <p className="sec-report-error">No analysis is available for this topic yet.</p>}
    {node.evidence.length > 0 && (
      <details className="sec-report-evidence">
        <summary>Filing excerpts · {node.evidence.length}</summary>
        {node.evidence.map((evidence, index) => (
          <blockquote key={`${evidence.start}-${index}`}>
            <p>{evidence.excerpt}</p>
            <footer>Characters {evidence.start.toLocaleString("en-US")}–{evidence.end.toLocaleString("en-US")}</footer>
          </blockquote>
        ))}
      </details>
    )}
  </>;
}

function ConclusionList({ bullets }: { bullets: NonNullable<SecFilingWithSummary["summary"]>["bullets"] }) {
  if (!bullets.length) return <p className="sec-report-empty">No verifiable takeaways yet.</p>;
  return (
    <ul className="sec-report-conclusion-list">
      {bullets.map((bullet, index) => (
        <li data-importance={bullet.importance} key={`${bullet.label}-${index}`}>
          <strong>{bullet.label}</strong><span>{bullet.detail}</span>
        </li>
      ))}
    </ul>
  );
}

function VerifiedMetrics({ report }: { report: PublishedSecReport | null | undefined }) {
  if (!report?.keyMetrics.length) return <p className="sec-report-empty">Structured metrics have not been verified yet.</p>;
  return (
    <div className="sec-report-metrics">
      {report.keyMetrics.map((metric) => (
        <article key={metric.metricKey}>
          <span>{formatSecMetricLabel(metric.metricKey)}</span>
          <strong>{formatSecMetricValue(metric.metricKey, metric.currentValue, metric.unit, metric.currency)}</strong>
          <small>{metric.qoq ? `QoQ ${metric.qoq}` : "QoQ n/a"} · {metric.yoy ? `YoY ${metric.yoy}` : "YoY n/a"}</small>
          <i>{metricStatus(metric.status)}</i>
          {metric.definition && <details><summary>Definition</summary><p>{metric.definition}</p></details>}
        </article>
      ))}
    </div>
  );
}

function DataQuality({ report }: { report: PublishedSecReport | null | undefined }) {
  if (!report) return <p className="sec-report-empty">Verification results are not available yet.</p>;
  const quality = report.dataQuality;
  const notes = [
    ...quality.warnings,
    ...(quality.unresolvedQuestions ?? []).map((question) => `Open question: ${question}`),
    ...(quality.failedNodeIds ?? []).map((nodeId) => `Incomplete node: ${nodeId}`),
  ];
  return (
    <div className="sec-report-quality">
      <p>{quality.analysisStatus === "complete" ? "All research questions answered. " : "Some research questions are unanswered. "}Verified figures do not make the investment view correct.</p>
      {report.reader?.limitations.map((l, i) => <p key={i}><strong>{l.issue}: </strong>{l.impact}</p>)}
      {report.financialLens?.limitations.map((l) => <p key={l}>{l}</p>)}
      <details><summary>Data coverage and processing log</summary>
      <dl>
        {report.discovery && <>
          <div><dt>Collected text scanned</dt><dd>{report.discovery.totalCharacters ? Math.round(report.discovery.scannedCharacters/report.discovery.totalCharacters*100) : 0}%</dd></div>
          <div><dt>Disclosure candidates</dt><dd>{report.discovery.disclosures.length} (not all analyzed)</dd></div>
        </>}
        <div><dt>Metric coverage</dt><dd>{Math.round(quality.coverage * 100)}%</dd></div>
        <div><dt>Structured data check</dt><dd>{verificationStatus(quality.verificationStatus)}</dd></div>
        <div><dt>Analysis completeness</dt><dd>{analysisStatus(quality.analysisStatus, quality.stopReason)}</dd></div>
        {typeof quality.managerCoverageScore === "number"
          ? <div><dt>Research question coverage (not confidence)</dt><dd>{Math.round(quality.managerCoverageScore * 100)}%</dd></div>
          : null}
        <div><dt>Report version</dt><dd>{report.reportVersion}</dd></div>
      </dl>
      {notes.length > 0
        ? <ul>{notes.map((note) => <li key={note}>{note}</li>)}</ul>
        : <p>No data quality issues to flag.</p>}
      </details>
    </div>
  );
}

function formatDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

function metricStatus(value: PublishedSecReport["keyMetrics"][number]["status"]): string {
  return value === "verified" ? "Verified" : value === "derived" ? "Derived" : value === "not_disclosed" ? "Not disclosed" : "Not comparable";
}

function verificationStatus(value: PublishedSecReport["dataQuality"]["verificationStatus"]): string {
  return value === "verified" ? "Verified" : value === "partial" ? "Partial" : "Failed";
}

function analysisStatus(
  value: PublishedSecReport["dataQuality"]["analysisStatus"],
  stopReason: PublishedSecReport["dataQuality"]["stopReason"],
): string {
  if (value === "complete") return "All questions answered";
  const reason = stopReason === "max_rounds"
    ? "Repair rounds exhausted"
    : stopReason === "no_progress"
      ? "Repairs made no progress"
      : stopReason === "analysis_incomplete"
        ? "Filing lacks enough support"
        : null;
  return reason ? `Partial · ${reason}` : "Partial";
}
