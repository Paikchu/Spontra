import { ReportShare } from "./ReportShare.tsx";
import { SecComposedSection } from "@/components/earning-report/report-blocks/SecComposedSection.tsx";
import type { PublishedSecReport } from "@/shared/analysis-contract/report.ts";
import type { SecFilingWithSummary, SecNodeResult } from "@/shared/analysis-contract/report.ts";
import type { ReactNode } from "react";
import Link from "next/link";
import { RichText } from "@/components/earning-report/rich-text/RichText.tsx";
import { SecReportNavigator, type ReportSectionLink } from "@/app/analysis/stocks/[ticker]/sec/[accession]/SecReportNavigator.tsx";

type ReportSectionDefinition = ReportSectionLink & {
  className?: string;
  content: ReactNode;
};

export function SecReportDocument({ companyName, filing }: { companyName: string; filing: SecFilingWithSummary }) {
  const summary = filing.summary;
  const group = filing.earningsGroup;
  const report = filing.analysis;
  const reportReady = Boolean(summary?.report);
  const composed = report?.presentation?.version === "sec-presentation.v1" && report.presentation.sections.length > 0;
  const nodeSectionIndex = composed ? String(report!.presentation!.sections.length + 1).padStart(2, "0") : "04";
  const nodeSectionTitle = composed ? "分析底稿与证据" : "动态分段分析";
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
      title: "验证指标",
      description: "集中查看已验证的关键财务指标与同比、环比变化。",
      content: <VerifiedMetrics report={report} />,
    },
    {
      id: "sec-report-body",
      title: "完整正文",
      description: "阅读基于 SEC 申报材料形成的连续分析叙述。",
      content: (
        <div className="sec-report-body">
          <RichText text={summary?.report ?? ""} />
        </div>
      ),
    },
    {
      id: "sec-report-nodes",
      title: "动态分段分析",
      description: "按主题展开分析发现、叙述和对应的原文证据。",
      content: (
        <div className="sec-report-node-list">
          {(summary?.nodes ?? []).map((node, index) => (
            <details
              id={nodeLinks[index].id}
              open
              tabIndex={-1}
              data-report-nav-item
              data-report-index={nodeLinks[index].index}
              data-report-title={nodeLinks[index].title}
              data-report-description={nodeLinks[index].description}
              data-report-depth="1"
              data-report-parent-title={nodeSectionTitle}
              className="sec-report-node scroll-mt-24"
              key={node.id}
            >
              <summary><span>{node.title}</span><small>{nodeStatus(node.status)}</small></summary>
              <div>
                {node.findings.length > 0 && <ConclusionList bullets={node.findings} />}
                {node.narrative && <RichText text={node.narrative} />}
                {node.error && <p className="sec-report-error">{node.error}</p>}
                {node.evidence.length > 0 && (
                  <details className="sec-report-evidence">
                    <summary>原文摘录与位置 · {node.evidence.length}</summary>
                    {node.evidence.map((evidence, index) => (
                      <blockquote key={`${evidence.start}-${index}`}>
                        <p>{evidence.excerpt}</p>
                        <footer>字符 {evidence.start.toLocaleString("zh-CN")}–{evidence.end.toLocaleString("zh-CN")} · 相关性 {evidence.score}/100</footer>
                      </blockquote>
                    ))}
                  </details>
                )}
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
  if (reportReady && report?.presentation?.version === "sec-presentation.v1" && report.presentation.sections.length) {
    const evidenceSection = reportSections.find((section) => section.id === "sec-report-nodes")!;
    const qualitySection = reportSections.find((section) => section.id === "sec-report-quality")!;
    reportSections.splice(0, reportSections.length,
      ...report.presentation.sections.map((section) => ({ id: section.id, title: section.title, description: "围绕公司业务展开分析与证据。", content: <SecComposedSection section={section} report={report} /> })),
      { ...evidenceSection, title: "分析底稿与证据", description: "保留全部分析节点、未完成状态与原文摘录，供核查。" },
      qualitySection,
    );
  }
  const navigationSections: ReportSectionLink[] = reportSections.flatMap((section, index) => {
    const sectionLink = { id: section.id, index: String(index + 1).padStart(2, "0"), title: section.title, description: section.description, depth: 0 as const };
    return section.id === "sec-report-nodes" ? [sectionLink, ...nodeLinks] : [sectionLink];
  });

  return (
    <main className="sec-report-shell">
      <Link className="back-link" href={`/positions/${encodeURIComponent(filing.ticker)}#sec-filings`}>← 返回 {filing.ticker} 财报与事件</Link>
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
          <div><dt>Accession</dt><dd>{filing.accessionNumber}</dd></div>
        </dl>
      </header>

      {group && <section className="sec-report-pending" aria-label="本期材料">
        <h2>本期材料</h2>
        <p>{summary?.earningsGroup?.inputKey === group.inputKey
          ? group.sources.some((source) => /^(10-K|10-Q|20-F)/.test(source.form)) ? "以下报告基于本期材料合并分析。" : "业绩初报；后续定期报告将补充到本报告。"
          : "新增材料待合并分析，当前保留已有报告。"}</p>
        <ul>{group.sources.map((source) => <li key={source.accessionNumber}><a href={source.indexUrl} target="_blank" rel="noopener noreferrer">{source.form} · {source.filingDate} · {source.accessionNumber} ↗</a></li>)}</ul>
      </section>}
      {report?.publication && <ReportShare ticker={filing.ticker} accession={filing.accessionNumber}
        reportDate={filing.reportDate || filing.filingDate} reportVersion={report.reportVersion}
        generatedAt={report.publication.summary.generatedAt} />}
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
          <span>{metric.metricKey}</span>
          <strong>{metric.currentValue}</strong>
          <small>{metric.qoq ? `环比 ${metric.qoq}` : "环比不可比"} · {metric.yoy ? `同比 ${metric.yoy}` : "同比不可比"}</small>
          <i>{metricStatus(metric.status)}</i>
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
      <dl>
        <div><dt>证据覆盖率</dt><dd>{Math.round(quality.coverage * 100)}%</dd></div>
        <div><dt>验证状态</dt><dd>{verificationStatus(quality.verificationStatus)}</dd></div>
        <div><dt>分析完整性</dt><dd>{analysisStatus(quality.analysisStatus, quality.stopReason)}</dd></div>
        {typeof quality.managerCoverageScore === "number"
          ? <div><dt>主编覆盖度</dt><dd>{Math.round(quality.managerCoverageScore * 100)}%</dd></div>
          : null}
        <div><dt>报告版本</dt><dd>{report.reportVersion}</dd></div>
      </dl>
      {notes.length > 0
        ? <ul>{notes.map((note) => <li key={note}>{note}</li>)}</ul>
        : <p>未发现需要单独提示的数据质量问题。</p>}
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

function nodeStatus(value: SecNodeResult["status"]): string {
  return value === "complete" ? "完成" : value === "error" ? "失败" : "无有效内容";
}
