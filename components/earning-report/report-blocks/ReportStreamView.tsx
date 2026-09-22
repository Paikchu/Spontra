"use client";

import type { ReportStreamState } from "@/shared/analysis-runtime/report-stream.ts";
import { ReportContentRenderer, type ReportContentContext } from "./ReportContentRenderer.tsx";

/** Transport-independent draft surface. Publishing remains an explicit server event. */
export function ReportStreamView({ state, context }: { state: ReportStreamState; context: ReportContentContext }) {
  const active = state.status === "generating" && !state.needsSnapshot
    ? state.blocks.findLast((block) => block.type === "markdown" && !state.completedBlockIds.includes(block.blockId))?.blockId
    : undefined;
  const label = state.needsSnapshot ? "正在同步报告内容…"
    : state.status === "published" ? "报告已发布"
    : state.status === "reviewing" ? "报告核验中，当前为草稿"
    : state.status === "failed" ? "生成失败，已保留当前草稿"
    : state.status === "cancelled" ? "生成已停止，已保留当前草稿"
    : "报告生成中，当前为草稿";
  return <section aria-label="报告生成内容">
    <p role="status">{label}</p>
    <ReportContentRenderer content={state.blocks} context={{ ...context, assets: state.assets }}
      surface="chat" phase={state.status === "published" ? "final" : "draft"} activeBlockId={active} />
  </section>;
}
