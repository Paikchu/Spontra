import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import type { PluggableList } from "unified";
import katex from "katex";
import { cjk } from "@streamdown/cjk";
import type { ReactNode } from "react";

/** Browser URL parsing, rather than a prefix regex, defines the same-origin boundary. */
export function safeReportUrl(value: string): string | undefined {
  if (!value || /[\s\\\u0000-\u001f\u007f]/.test(value)) return undefined;
  try {
    if (value.startsWith("#")) return value;
    const url = new URL(value, "https://report.invalid");
    if (url.username || url.password || url.protocol !== "https:") return undefined;
    if (value.startsWith("/") && !value.startsWith("//") && url.origin === "https://report.invalid") return value;
    if (/^https:\/\//i.test(value)) return url.href;
  } catch { /* An invalid URL remains readable text. */ }
  return undefined;
}

export const REPORT_REMARK_PLUGINS: PluggableList = [...cjk.remarkPluginsBefore, remarkGfm, ...cjk.remarkPluginsAfter, [remarkMath, { singleDollarTextMath: false }]];
export const REPORT_REHYPE_PLUGINS: PluggableList = [[rehypeKatex, { trust: false, strict: "warn", maxExpand: 100, maxSize: 10, macros: {} }]];
export const REPORT_MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children }) => {
    const safe = safeReportUrl(href ?? "");
    return safe ? <a href={safe} {...(safe.startsWith("https://") ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{children}</a> : <span>{children}</span>;
  },
  // Asset IDs are resolved by image blocks. Model-written Markdown must not initiate remote loads.
  img: ({ alt }) => <span className="report-content-inline-fallback">{alt ? `图片：${alt}` : "图片暂不可用"}</span>,
  h1: ({ children }) => <h3>{children}</h3>,
  h2: ({ children }) => <h3>{children}</h3>,
  h3: ({ children }) => <h3>{children}</h3>,
  h4: ({ children }) => <h4>{children}</h4>,
  table: ({ children }) => <div className="report-content-table-scroll" tabIndex={0} role="region" aria-label="报告表格"><table>{children}</table></div>,
};

/** The synchronous parser is evaluated inside the guard; server errors stay within this block. */
export function ReportMarkdown({ markdown }: { markdown: string }) {
  let content: ReactNode = markdown;
  let failed = false;
  try {
    content = Markdown({ children: markdown, skipHtml: true, components: REPORT_MARKDOWN_COMPONENTS, remarkPlugins: REPORT_REMARK_PLUGINS, rehypePlugins: REPORT_REHYPE_PLUGINS, urlTransform: (url) => safeReportUrl(url) ?? "" });
  } catch {
    failed = true;
  }
  return <div className={`report-content-markdown${failed ? " report-content-plain" : ""}`}>{content}</div>;
}

export function ReportFormula({ latex, displayMode, explanation, assumption }: { latex: string; displayMode: boolean; explanation?: string; assumption?: string }) {
  let html: string | undefined;
  try {
    if (latex.length > 6000) throw new Error("Formula exceeds display limit");
    // Only KaTeX-generated markup reaches this sink; arbitrary HTML and trusted macros are disabled.
    html = katex.renderToString(latex, { displayMode, throwOnError: true, trust: false, strict: "error", maxExpand: 100, maxSize: 10, macros: {}, output: "htmlAndMathml" });
  } catch { /* Preserve the source and surrounding explanation when a formula cannot be rendered. */ }
  return <figure className="report-content-formula">
    {html ? <div className="report-content-math-scroll" dangerouslySetInnerHTML={{ __html: html }} /> : <div className="report-content-fallback"><span>公式暂无法排版</span><code>{latex}</code></div>}
    {explanation && <figcaption>{explanation}</figcaption>}
    {assumption && <p className="report-content-caption">分析假设：{assumption}</p>}
  </figure>;
}
