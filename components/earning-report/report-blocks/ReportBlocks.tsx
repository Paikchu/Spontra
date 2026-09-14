import { FundamentalChartRenderer } from "@/components/earning-report/fundamentals/FundamentalChart.tsx";
import { ReportBlockBoundary } from "@/components/earning-report/report-blocks/ReportBlockBoundary.tsx";
import { RichText } from "@/components/earning-report/rich-text/RichText.tsx";
import { formatSecMetricLabel, formatSecMetricValue } from "@/lib/earning-report/web/sec-metric-format.ts";
import type { PublicFundamentalsResponse } from "@/shared/analysis-contract/fundamentals.ts";
import type { PublishedSecReport } from "@/shared/analysis-contract/report.ts";
import type {
  ReportBlock,
  ReportBlockDocument,
  ReportBlockSection,
} from "@/shared/analysis-contract/report-blocks.ts";

/**
 * The renderer for a model-composed report: a registry keyed by block type, over a section list of
 * variable length. The analysis decides how many pieces a filing needs and which form each takes;
 * this decides what any of that is allowed to look like.
 *
 * Values are resolved here, not carried by the block. `metrics` reads the verified figures the
 * Pipeline published and `chart` reads the fundamentals response, so a block can name a number to
 * show but never supply one.
 */
export type ReportBlockRenderContext = {
  metrics: PublishedSecReport["keyMetrics"];
  fundamentals: PublicFundamentalsResponse | null;
};

export function ReportBlocks({ document, context }: { document: ReportBlockDocument; context: ReportBlockRenderContext }) {
  if (document.sections.length === 0) return null;
  return (
    <div className="report-blocks" data-report-sections>
      {document.sections.map((section, index) => (
        <Section context={context} index={index} key={section.id} section={section} />
      ))}
    </div>
  );
}

function Section({ context, index, section }: { context: ReportBlockRenderContext; index: number; section: ReportBlockSection }) {
  const order = String(index + 1).padStart(2, "0");
  return (
    <section
      aria-labelledby={`${section.id}-title`}
      className="sec-report-section report-block-section scroll-mt-24"
      data-report-depth="0"
      data-report-description={section.description}
      data-report-index={order}
      // Only navigable sections reach the table of contents; a variable block list would otherwise
      // grow a contents panel longer than the report it indexes.
      {...(section.navigable ? { "data-report-nav-item": true } : {})}
      data-report-section
      data-report-title={section.title}
      id={section.id}
      tabIndex={-1}
    >
      <div className="sec-report-section-heading">
        <span>{order}</span><h2 id={`${section.id}-title`}>{section.title}</h2>
      </div>
      {section.blocks.map((block) => <Block block={block} context={context} key={block.id} />)}
    </section>
  );
}

/**
 * A bare run of blocks, for a surface that composes its own frame rather than a section list — the
 * outlook renders these under a judgment's prose. Same registry, same resolution rules.
 */
export function ReportBlockList({ blocks, context }: { blocks: readonly ReportBlock[]; context: ReportBlockRenderContext }) {
  if (blocks.length === 0) return null;
  return <>{blocks.map((block) => <Block block={block} context={context} key={block.id} />)}</>;
}

function Block({ block, context }: { block: ReportBlock; context: ReportBlockRenderContext }) {
  switch (block.type) {
    case "prose":
      return (
        <div className="report-block report-block-prose sec-report-body" id={block.id}>
          {block.title && <h3 className="report-block-title">{block.title}</h3>}
          <RichText text={block.text} />
        </div>
      );
    case "callout":
      return (
        <aside className="report-block report-block-callout" data-tone={block.tone} id={block.id}>
          {block.title && <strong>{block.title}</strong>}
          <RichText text={block.text} />
        </aside>
      );
    case "key_points":
      return (
        <div className="report-block report-block-points" id={block.id}>
          {block.title && <h3 className="report-block-title">{block.title}</h3>}
          <ul className="report-block-points-list">
            {block.points.map((point, index) => (
              <li data-importance={point.importance} key={`${point.label}-${index}`}>
                <strong>{point.label}</strong><span>{point.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      );
    case "metrics": {
      const metrics = block.metricKeys
        .map((key) => context.metrics.find((metric) => metric.metricKey === key))
        .filter((metric): metric is PublishedSecReport["keyMetrics"][number] => metric !== undefined);
      if (metrics.length === 0) return null;
      return (
        <div className="report-block report-block-metrics" id={block.id}>
          {block.title && <h3 className="report-block-title">{block.title}</h3>}
          <div className="sec-report-metrics">
            {metrics.map((metric) => (
              <article key={metric.metricKey}>
                <span>{formatSecMetricLabel(metric.metricKey)}</span>
                    <strong>{formatSecMetricValue(metric.metricKey, metric.currentValue, metric.unit, metric.currency)}</strong>
                <small>{metric.qoq ? `环比 ${metric.qoq}` : "环比不可比"} · {metric.yoy ? `同比 ${metric.yoy}` : "同比不可比"}</small>
              </article>
            ))}
          </div>
        </div>
      );
    }
    case "chart": {
      // Validation already proved every series is available, but the data can go missing between
      // composing the report and rendering it, and a missing panel is worse than a stated absence.
      if (!context.fundamentals) {
        return <p className="report-block report-block-empty" id={block.id}>{block.title}：基本面数据暂不可用。</p>;
      }
      // Whether a metric is actually in this response is knowable only here — the Pipeline vets a
      // chart against the feature pack it reasoned over, which is a different read. A series the
      // response does not carry makes the builder throw, and the reader gets 「这组指标暂时不能叠加」,
      // wording meant for someone choosing metrics by hand. Drop it here instead.
      const series = block.series.filter((entry) => context.fundamentals!.series.some(
        (candidate) => candidate.metricKey === entry.metricKey && candidate.available,
      ));
      if (series.length === 0) {
        return <p className="report-block report-block-empty" id={block.id}>{block.title}：这组指标暂无可用数据。</p>;
      }
      return (
        <figure className="report-block report-block-chart" id={block.id}>
          <ReportBlockBoundary label={block.title}>
            <FundamentalChartRenderer
              data={context.fundamentals}
              description={block.caption}
              series={series}
              title={block.title}
            />
          </ReportBlockBoundary>
        </figure>
      );
    }
    case "evidence":
      return (
        <details className="report-block sec-report-evidence" id={block.id}>
          <summary>{block.title ?? "原文摘录与位置"} · {block.items.length}</summary>
          {block.items.map((item, index) => (
            <blockquote key={`${item.start}-${index}`}>
              <p>{item.excerpt}</p>
              <footer>字符 {item.start.toLocaleString("zh-CN")}–{item.end.toLocaleString("zh-CN")} · 相关性 {item.score}/100</footer>
            </blockquote>
          ))}
        </details>
      );
  }
}
