"use client";

import { useReportReturnPath } from "@/packages/web/src/navigation";
import { messages } from "@/packages/web/src/i18n";

const m = messages({ back: (ticker: string) => `← ${ticker} filings and events` }, { back: (ticker: string) => `← ${ticker} 文件与事件` });

export function ReportBackLink({ ticker }: { ticker: string }) {
  const reportReturnPath = useReportReturnPath();
  return <a className="back-link" href={reportReturnPath ?? `/positions/${encodeURIComponent(ticker)}#sec-filings`}>
    {m.back(ticker)}
  </a>;
}
