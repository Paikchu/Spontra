"use client";

import { memo } from "react";
import { Streamdown } from "streamdown";
import { ReportMarkdown, REPORT_MARKDOWN_COMPONENTS, REPORT_REMARK_PLUGINS, REPORT_REHYPE_PLUGINS, safeReportUrl } from "../report-blocks/ReportMarkdown.tsx";

/** Preview only: callers persist model text, never the display-only Markdown repair. */
export const StreamingReportText = memo(function StreamingReportText({ text, isStreaming = true }: {
  text: string;
  isStreaming?: boolean;
}) {
  if (!isStreaming) return <ReportMarkdown markdown={text} />;
  return <Streamdown className="report-content-markdown" mode="streaming" isAnimating={false}
    parseIncompleteMarkdown skipHtml controls={false}
    components={REPORT_MARKDOWN_COMPONENTS} remarkPlugins={REPORT_REMARK_PLUGINS}
    rehypePlugins={REPORT_REHYPE_PLUGINS} urlTransform={(url) => safeReportUrl(url) ?? ""}>
    {text}
  </Streamdown>;
});
