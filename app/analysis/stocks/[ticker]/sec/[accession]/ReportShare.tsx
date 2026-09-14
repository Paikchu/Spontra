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
  return <details className="mb-6 text-sm text-muted-foreground">
    <summary>报告链接与版本</summary>
    <div className="flex min-w-0 flex-wrap items-center gap-3 py-2">
      <time dateTime={generatedAt}>生成于 {generatedAt.slice(0, 10)}</time>
      <a data-app-local-anchor className="underline" href={href}>本报告固定链接</a>
      {reportVersion && <span className="break-all">版本：{reportVersion}</span>}
    </div>
  </details>;
}
