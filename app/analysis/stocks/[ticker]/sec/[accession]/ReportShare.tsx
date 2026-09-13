"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};
const browserOrigin = () => window.location.origin;
const serverOrigin = () => "";

export function ReportShare({ ticker, accession, reportDate, reportVersion, generatedAt }: {
  ticker: string; accession: string; reportDate: string; reportVersion?: string; generatedAt: string;
}) {
  const origin = useSyncExternalStore(subscribe, browserOrigin, serverOrigin);
  const path = `/analysis/stocks/${encodeURIComponent(ticker)}/sec/${encodeURIComponent(accession)}`
    + (reportVersion ? `?${new URLSearchParams({ reportDate, reportVersion })}` : "");
  const href = origin + path;
  return <div className="mb-8 flex min-w-0 flex-wrap items-center gap-3 text-sm text-muted-foreground">
    {reportVersion && <span className="break-all">分析编码：{reportVersion.slice(reportVersion.lastIndexOf(":") + 1)}</span>}
    <time dateTime={generatedAt}>生成于 {generatedAt}</time>
    <a data-app-local-anchor className="min-w-0 break-all underline" href={href} aria-label={`文章链接：${href}`}>{href}</a>
  </div>;
}
