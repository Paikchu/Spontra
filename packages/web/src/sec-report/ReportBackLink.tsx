"use client";

import { useReportReturnPath } from "@/packages/web/src/navigation";

export function ReportBackLink({ ticker }: { ticker: string }) {
  const reportReturnPath = useReportReturnPath();
  return <a className="back-link" href={reportReturnPath ?? `/positions/${encodeURIComponent(ticker)}#sec-filings`}>
    ← Back to {ticker} filings and events
  </a>;
}
