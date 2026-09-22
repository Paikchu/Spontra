import { SecComposedSection } from "@/components/earning-report/report-blocks/SecComposedSection.tsx";
import type { PublishedSecReport } from "@/shared/analysis-contract/report.ts";
import type { SecFilingWithSummary } from "@/shared/analysis-contract/report.ts";
import type { ReactNode } from "react";
import { ReportBackLink } from "./ReportBackLink";
import { RichText } from "@/components/earning-report/rich-text/RichText.tsx";
import { SecReportNavigator, type ReportSectionLink } from "@/app/analysis/stocks/[ticker]/sec/[accession]/SecReportNavigator.tsx";
import { FinancialBridge, QuarterChanges, ReaderSection, WatchConditions } from "@/components/earning-report/report-blocks/SecReaderContent.tsx";
import { formatSecMetricLabel, formatSecMetricValue } from "@/lib/earning-report/web/sec-metric-format.ts";

type ReportSectionDefinition = ReportSectionLink & {
  className?: string;
  content: ReactNode;
};

export function SecReportDocument({ companyName, filing }: { companyName: string; filing: SecFilingWithSummary }) {
  const summary = filing.summary;
  const group = filing.earningsGroup;
  const report = filing.analysis;
  const reader = report?.reader;
  const reportReady = Boolean(summary?.report);
  const composed = report?.presentation?.version === "sec-presentation.v1" && report.presentation.sections.length > 0;
  const nodeSectionIndex = composed ? String(report!.presentation!.sections.length + 1).padStart(2, "0") : "04";
  const nodeSectionTitle = "核对原文与分析依据";
  const nodeLinks: ReportSectionLink[] = (summary?.nodes ?? []).map((node, index) => ({
    id: `sec-report-node-${index + 1}`,
    index: `${nodeSectionIndex}.${String(index + 1).padStart(2, "0")}`,
    title: node.title,
    description: node.narrative || node.findings[0]?.detail || "展开查看该主题的分析发现与原文证据。",
    depth: 1,
    parentTitle: nodeSectionTitle,
  }));
  const reportSections: ReportSectionDefinition[] = reportReady ? [
    {
      id: "sec-report-conclusions",
      title: "核心结论",
      description: "先看经营结果、主要驱动和对投资判断的直接含义。",
      className: "sec-report-conclusions",
      content: (
        <>
          <ConclusionList bullets={summary?.bullets ?? []} />
          {summary?.analystView && <p className="sec-report-investment-view"><span>投资含义</span>{summary.analystView}</p>}
        </>
      ),
    },
    {
      id: "sec-report-metrics",
      title: "关键数据",
      description: "集中查看已验证的关键财务指标与同比、环比变化。",
      content: <VerifiedMetrics report={report} />,
    },
    {
      id: "sec-report-body",
      title: "报告概览",
      description: "阅读基于 SEC 申报材料形成的连续分析叙述。",
      content: (
        <div className="sec-report-body">
          <RichText text={summary?.report ?? ""} />
        </div>
      ),
    },
    {
      id: "sec-report-nodes",
      title: nodeSectionTitle,
      description: "按主题展开分析发现、叙述和对应的原文证据。",
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
      title: "数据质量",
      description: "检查证据覆盖率、验证状态和需要人工复核的提示。",
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
      ...report.presentation.sections.map((section) => ({ id: section.id, title: section.title, description: "围绕公司业务展开分析与证据。", content: <SecComposedSection section={section} report={report} /> })),
      { ...evidenceSection, title: "核对原文与分析依据", description: "按需展开研究依据和原文摘录。" },
      qualitySection,
    );
  }
  if (reportReady && reader && report) {
    const qualitySection = reportSections.find((s) => s.id === "sec-report-quality")!;
    const evidenceSection = reportSections.find((s) => s.id === "sec-report-nodes")!;
    reportSections.splice(0, reportSections.length,
      { id: "sec-report-conclusions", title: "这一季，判断变在哪里", description: "核心结论与影响投资判断的变化。", content: <><ConclusionList bullets={summary?.bullets ?? []} />{summary?.analystView && <p className="sec-report-investment-view"><span>投资含义</span>{summary.analystView}</p>}<FinancialBridge report={report} /></> },
      { id: "sec-report-changes", title: "本期与以前", description: "区分新增、变化、延续与尚缺基线的事项。", content: <QuarterChanges reader={reader} /> },
      { id: "sec-report-metrics", title: "关键数据", description: "同口径的本期数值及同比、环比。", content: <VerifiedMetrics report={report} /> },
      ...reader.sections.map((section) => ({ id: section.id, title: section.title, description: section.takeaway, className: `sec-reader-section sec-reader-role-${section.role}`, content: <ReaderSection section={section} report={report} nodes={summary?.nodes ?? []} /> })),
      { id: "sec-report-watch", title: "什么会改变这个判断", description: "下一次检查的条件、时点与需要修订的判断。", content: <WatchConditions reader={reader} /> },
      { ...evidenceSection, content: <details className="sec-reader-workpapers"><summary>展开研究依据与原文</summary>{evidenceSection.content}</details> },
      qualitySection,
    );
  }
  const navigationSections: ReportSectionLink[] = reportSections.flatMap((section, index) => {
    const sectionLink = { id: section.id, index: String(index + 1).padStart(2, "0"), title: section.title, description: section.description, depth: 0 as const };
    return section.id === "sec-report-nodes" && !reader ? [sectionLink, ...nodeLinks] : [sectionLink];
  });

  return (
    <main className="sec-report-shell">
      <ReportBackLink ticker={filing.ticker} />
      <header className="sec-report-header">
        <div>
          <span className="sec-report-kicker">{group ? "财报期合并报告" : `${filing.form} · SEC 分析报告`}</span>
          <h1>{companyName}</h1>
          <p>{summary?.headline || report?.headline || filing.description || "财报分析正在生成"}</p>
        </div>
        <dl className="sec-report-meta">
          <div><dt>股票</dt><dd>{filing.ticker}</dd></div>
          <div><dt>报告期</dt><dd>{formatDate(group?.periodEnd ?? filing.reportDate)}</dd></div>
          <div><dt>{group ? "业绩发布日" : "申报日"}</dt><dd>{formatDate(group?.earningsDate ?? filing.filingDate)}</dd></div>
          <div><dt>生成日期</dt><dd>{summary?.generatedAt.slice(0, 10) ?? "—"}</dd></div>
        </dl>
      </header>
      {!reportReady ? (
        <section className="sec-report-pending" aria-labelledby="sec-report-pending-title">
          <h2 id="sec-report-pending-title">完整报告生成中</h2>
          <p>当前保留上一份可用简析。完整研报通过验证后会在此替换。</p>
          {summary?.bullets.length ? <ConclusionList bullets={summary.bullets} /> : null}
        </section>
      ) : (
        <>
          <SecReportNavigator initialSections={navigationSections} />
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

      {report?.sourceMaterials?.length ? <section className="sec-report-section sec-materials" aria-label="分析材料">
        <h2>分析材料</h2>
        <ul>{report.sourceMaterials.map((material, index) => <li key={`${material.filename}-${index}`}>
          <a href={material.url} target="_blank" rel="noopener noreferrer">{material.type} · {material.filename}</a>
          <span>{material.status === "read" ? "已读取文本" : "未解析"}</span>
        </li>)}</ul>
      </section> : null}
      <footer className="sec-report-source">
        <div><span>SEC 原文</span><strong>{filing.form} · {filing.accessionNumber}</strong></div>
        <a href={filing.indexUrl} rel="noopener noreferrer" target="_blank">在 EDGAR 阅读原始申报 ↗</a>
        <p>报告用于研究记录，不构成投资建议。数字与判断应回到原始申报核对。</p>
      </footer>
    </main>
  );
}

function SectionHeading({ id, index, title }: { id: string; index: string; title: string }) {
  return <div className="sec-report-section-heading"><span>{index}</span><h2 id={id}>{title}</h2></div>;
}

function NodeContent({ node }: { node: NonNullable<NonNullable<SecFilingWithSummary["summary"]>["nodes"]>[number] }) {
  return <>
    {node.findings.length > 0 && <ConclusionList bullets={node.findings} />}
    {node.narrative && <RichText text={node.narrative} />}
    {node.error && <p className="sec-report-error">该主题尚未形成可用分析。</p>}
    {node.evidence.length > 0 && (
      <details className="sec-report-evidence">
        <summary>核对原文 · {node.evidence.length} 段</summary>
        {node.evidence.map((evidence, index) => (
          <blockquote key={`${evidence.start}-${index}`}>
            <p>{evidence.excerpt}</p>
            <footer>字符位置 {evidence.start.toLocaleString("zh-CN")}–{evidence.end.toLocaleString("zh-CN")}</footer>
          </blockquote>
        ))}
      </details>
    )}
  </>;
}

function ConclusionList({ bullets }: { bullets: NonNullable<SecFilingWithSummary["summary"]>["bullets"] }) {
  if (!bullets.length) return <p className="sec-report-empty">暂无可验证结论。</p>;
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
  if (!report?.keyMetrics.length) return <p className="sec-report-empty">结构化指标尚未通过验证。</p>;
  return (
    <div className="sec-report-metrics">
      {report.keyMetrics.map((metric) => (
        <article key={metric.metricKey}>
          <span>{formatSecMetricLabel(metric.metricKey)}</span>
          <strong>{formatSecMetricValue(metric.metricKey, metric.currentValue, metric.unit, metric.currency)}</strong>
          <small>{metric.qoq ? `环比 ${metric.qoq}` : "环比不可比"} · {metric.yoy ? `同比 ${metric.yoy}` : "同比不可比"}</small>
          <i>{metricStatus(metric.status)}</i>
          {metric.definition && <details><summary>指标口径</summary><p>{metric.definition}</p></details>}
        </article>
      ))}
    </div>
  );
}

function DataQuality({ report }: { report: PublishedSecReport | null | undefined }) {
  if (!report) return <p className="sec-report-empty">结构化验证结果尚不可用。</p>;
  const quality = report.dataQuality;
  const notes = [
    ...quality.warnings,
    ...(quality.unresolvedQuestions ?? []).map((question) => `未解决问题：${question}`),
    ...(quality.failedNodeIds ?? []).map((nodeId) => `未完成节点：${nodeId}`),
  ];
  return (
    <div className="sec-report-quality">
      <p>{quality.analysisStatus === "complete" ? "已完成本次研究问题，" : "部分研究问题尚未完成，"}财务数值核验与投资判断的正确性是两回事。</p>
      {report.reader?.limitations.map((l, i) => <p key={i}><strong>{l.issue}：</strong>{l.impact}</p>)}
      {report.financialLens?.limitations.map((l) => <p key={l}>{l}</p>)}
      <details><summary>核对数据覆盖与处理记录</summary>
      <dl>
        {report.discovery && <>
          <div><dt>已采集文本扫描</dt><dd>{report.discovery.totalCharacters ? Math.round(report.discovery.scannedCharacters/report.discovery.totalCharacters*100) : 0}%</dd></div>
          <div><dt>原文发现候选</dt><dd>{report.discovery.disclosures.length} 项（不代表全部已分析）</dd></div>
        </>}
        <div><dt>财务指标覆盖率</dt><dd>{Math.round(quality.coverage * 100)}%</dd></div>
        <div><dt>结构化数据核验</dt><dd>{verificationStatus(quality.verificationStatus)}</dd></div>
        <div><dt>分析完整性</dt><dd>{analysisStatus(quality.analysisStatus, quality.stopReason)}</dd></div>
        {typeof quality.managerCoverageScore === "number"
          ? <div><dt>研究问题覆盖（非可信度）</dt><dd>{Math.round(quality.managerCoverageScore * 100)}%</dd></div>
          : null}
        <div><dt>报告版本</dt><dd>{report.reportVersion}</dd></div>
      </dl>
      {notes.length > 0
        ? <ul>{notes.map((note) => <li key={note}>{note}</li>)}</ul>
        : <p>未发现需要单独提示的数据质量问题。</p>}
      </details>
    </div>
  );
}

function formatDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(date);
}

function metricStatus(value: PublishedSecReport["keyMetrics"][number]["status"]): string {
  return value === "verified" ? "已验证" : value === "derived" ? "推导值" : value === "not_disclosed" ? "未披露" : "不可比";
}

function verificationStatus(value: PublishedSecReport["dataQuality"]["verificationStatus"]): string {
  return value === "verified" ? "已验证" : value === "partial" ? "部分完成" : "未通过";
}

function analysisStatus(
  value: PublishedSecReport["dataQuality"]["analysisStatus"],
  stopReason: PublishedSecReport["dataQuality"]["stopReason"],
): string {
  if (value === "complete") return "全部问题已回答";
  const reason = stopReason === "max_rounds"
    ? "修复轮次用尽"
    : stopReason === "no_progress"
      ? "修复无进展"
      : stopReason === "analysis_incomplete"
        ? "原文未提供足够依据"
        : null;
  return reason ? `部分完成 · ${reason}` : "部分完成";
}
