import { Fragment, useId, type ReactNode } from "react";
import type { PublishedSecReport, SecNodeResult } from "@/shared/analysis-contract/report.ts";
import { SEC_READER_CONTENT_BLOCK_SCHEMA, SEC_READER_ASSET_SCHEMA, type SecReaderContentBlock, type SecReaderAsset } from "@/shared/analysis-runtime/sec-reader-schema.ts";
import { StreamingReportText } from "../rich-text/StreamingReportText.tsx";
import { ReportMarkdown, ReportFormula, safeReportUrl } from "./ReportMarkdown.tsx";
import { ReportAssetImage } from "./ReportAssetImage.tsx";
import { ReportMediaGroup } from "./ReportMediaGroup.tsx";
import { readableTrend, SecTrendFigure, SecTrendSource } from "./SecTrendFigure.tsx";

export type ReportContentContext = { report: PublishedSecReport; nodes?: SecNodeResult[]; assets?: SecReaderAsset[]; paragraphLabels?: Record<string, string> };
type RenderProps = { content: readonly SecReaderContentBlock[]; context: ReportContentContext; surface?: "article" | "chat"; phase?: "draft" | "final"; activeBlockId?: string };

/** A shared, closed registry. Unknown or damaged blocks cannot execute code or break their siblings. */
export function ReportContentRenderer({ content, context, surface = "article", phase = "final", activeBlockId }: RenderProps) {
  const instanceId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const rendered: ReactNode[] = [];
  const blocks = Array.isArray(content) ? content : [];
  for (let index = 0; index < blocks.length; index++) {
    const parsed = SEC_READER_CONTENT_BLOCK_SCHEMA.safeParse(blocks[index]);
    if (!parsed.success) { rendered.push(<p className="report-content-fallback" key={`invalid-${index}`}>此内容块暂无法显示，其他正文已保留。</p>); continue; }
    const block = parsed.data;
    const group = [block];
    if (block.groupId) {
      while (index + 1 < blocks.length && blocks[index + 1]?.groupId === block.groupId) {
        const next = SEC_READER_CONTENT_BLOCK_SCHEMA.safeParse(blocks[index + 1]);
        if (!next.success) break;
        group.push(next.data); index++;
      }
    }
    const media = group.filter((item) => item.type === "chart" || item.type === "image");
    const eligible = group.length > 1 && media.length === 1 && group.every((item) => ["markdown", "chart", "image", "callout"].includes(item.type));
    const render = (item: SecReaderContentBlock, includeSource = true) => {
      const domId = `${instanceId}-report-content-block-${item.blockId}`;
      return <div key={item.blockId} id={domId} data-block-id={item.blockId} data-report-block={item.type}><ContentBlock block={item} domId={domId} context={context} active={phase === "draft" && activeBlockId === item.blockId} />{includeSource && <BlockSource block={item} context={context} />}</div>;
    };
    if (eligible) {
      const position = group.indexOf(media[0]);
      rendered.push(<ReportMediaGroup key={block.groupId} surface={surface} phase={phase} layout={media[0].layout ?? block.layout ?? "wrap"}
        lead={position > 0 ? group.slice(0, position).map((item) => render(item)) : undefined}
        media={render(media[0], false)} sources={<BlockSource block={media[0]} context={context} />}>
        {group.slice(position + 1).map((item) => render(item))}
      </ReportMediaGroup>);
    } else {
      rendered.push(...group.map((item) => render(item)));
    }
  }
  return <div className="report-content" data-report-surface={surface} data-report-phase={phase}>{rendered}</div>;
}

function ContentBlock({ block, domId, context, active }: { block: SecReaderContentBlock; domId: string; context: ReportContentContext; active: boolean }) {
  switch (block.type) {
    case "markdown": return <>{context.paragraphLabels?.[block.blockId] && <h3 className="report-content-paragraph-label">{context.paragraphLabels[block.blockId]}</h3>}{active ? <StreamingReportText text={block.markdown} /> : <ReportMarkdown markdown={block.markdown} />}</>;
    case "chart": {
      const trend = readableTrend(context.report.trends?.find((t) => t.metricKey === block.metricKey));
      return trend ? <SecTrendFigure id={`${domId}-figure`} title={block.title} trend={trend} mark={block.mark} caption={block.caption} /> : <div className="report-content-fallback"><strong>{block.title}</strong><p>暂无可绘制的可比数据。</p><p>{block.caption}</p></div>;
    }
    case "image": {
      const candidate = (context.assets ?? context.report.reader?.assets)?.find((asset) => asset.assetId === block.assetId);
      const parsed = SEC_READER_ASSET_SCHEMA.safeParse(candidate);
      const asset = parsed.success ? parsed.data : undefined;
      const src = asset && safeReportUrl(asset.src);
      return <figure className="report-content-image">
        {asset && src && !src.startsWith("#") ? <ReportAssetImage key={src} src={src} width={asset.width} height={asset.height} alt={block.alt} /> : <div className="report-content-fallback">图片暂不可用：{block.alt}</div>}
        <figcaption>{block.caption}{asset && <><br /><span>{asset.source.kind === "generated" ? "生成插图" : "申报材料图片"} · {safeReportUrl(asset.source.url ?? "") ? <a href={safeReportUrl(asset.source.url!)} target="_blank" rel="noopener noreferrer">{asset.source.label}</a> : asset.source.label}</span></>}</figcaption>
      </figure>;
    }
    case "math": return <ReportFormula latex={block.latex} displayMode={block.displayMode} explanation={block.explanation} assumption={block.assumption} />;
    case "table": return block.rows.some((row) => row.length !== block.headers.length) || block.columnKinds && block.columnKinds.length !== block.headers.length
      ? <p className="report-content-fallback">表格列数不一致，暂无法显示。</p>
      : <figure className="report-content-data-table" data-density={block.density ?? "comfortable"}><figcaption>{block.caption}</figcaption><div className="report-content-table-scroll" tabIndex={0} role="region" aria-label={block.caption}><table><thead><tr>{block.headers.map((header, i) => <th scope="col" data-column-kind={block.columnKinds?.[i] ?? (i === 0 ? "label" : "text")} key={i}>{header}</th>)}</tr></thead><tbody>{block.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => j === 0 && (block.columnKinds?.[j] ?? "label") === "label" ? <th scope="row" data-column-kind="label" key={j}>{cell}</th> : <td data-column-kind={block.columnKinds?.[j] ?? "text"} key={j}>{cell}</td>)}</tr>)}</tbody></table></div></figure>;
    case "callout": return <aside className="report-content-callout" data-tone={block.tone}>{block.title && <strong>{block.title}</strong>}<ReportMarkdown markdown={block.text} /></aside>;
    case "evidence": {
      const nodes = context.nodes ?? context.report.publication?.summary.nodes ?? [];
      const evidence = nodes.filter((node) => node.evidenceIds?.some((id) => block.evidenceIds.includes(id))).flatMap((node) => node.evidence)
        .filter((item, index, all) => all.findIndex((other) => other.excerpt === item.excerpt) === index);
      return <details className="report-content-source report-content-evidence"><summary>{block.title ?? "相关研究摘录"} · {evidence.length} 段</summary>{evidence.length ? <><p className="report-content-caption">以下摘录来自包含所引证据的研究主题，尚未逐条对应本段论述。</p>{evidence.map((item, i) => <blockquote key={i}><p>{item.excerpt}</p><footer>字符位置 {item.start}–{item.end}</footer></blockquote>)}</> : <p>该内容块暂无可展开的原文摘录。</p>}</details>;
    }
  }
}

function BlockSource({ block, context }: { block: SecReaderContentBlock; context: ReportContentContext }) {
  if (block.type !== "chart") return null;
  const trend = readableTrend(context.report.trends?.find((t) => t.metricKey === block.metricKey));
  return trend ? <Fragment><SecTrendSource title={block.title} trend={trend} /></Fragment> : null;
}
