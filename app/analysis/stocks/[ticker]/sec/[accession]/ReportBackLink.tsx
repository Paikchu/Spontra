"use client";

import { useReportReturnPath } from "@/app/app-navigation";

export function ReportBackLink({ ticker }: { ticker: string }) {
  const reportReturnPath = useReportReturnPath();
  return <a className="back-link" href={reportReturnPath ?? `/positions/${encodeURIComponent(ticker)}#sec-filings`}>
    ← 返回 {ticker} 财报与事件
  </a>;
}
