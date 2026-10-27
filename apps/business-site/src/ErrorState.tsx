import { ChartColumn, CircleAlert, CloudOff, SearchX, Timer } from "lucide-react";
import { useLayoutEffect, type ReactNode } from "react";
import { messages, useLocale } from "@/packages/web/src/i18n";
import type { CompanyFault } from "./error-model";

const m = messages({
  notFoundTitle: (ticker: string) => `${ticker} is not covered yet`,
  notFoundBody: "We do not have a filing read for this company yet. These covered companies are ready.",
  notFoundBodyAlone: "We do not have a filing read for this company yet.",
  thinTitle: (ticker: string) => `${ticker} does not have enough data yet`,
  thinBody: "An analysis needs at least two quarters of filings. It fills in after the next report is published.",
  limitTitle: "Too many requests",
  limitBody: "Try again in about a minute.",
  serverTitle: "This page did not load",
  serverBody: "The network or the server failed. Try again.",
  missingTitle: "Page not found",
  missingBody: "This address does not match a page. Go home, or open a company we already cover.",
  missingBodyAlone: "This address does not match a page.",
  backHome: "Back to home",
  retry: "Retry",
  searchOther: "Search other companies",
  covered: "Covered companies",
  code: (code: string) => `Error code: ${code}`,
  titleMissing: "Not found",
  titleThin: "Not enough data",
  titleLimit: "Try again soon",
  titleServer: "Unavailable",
}, {
  notFoundTitle: (ticker: string) => `暂未收录 ${ticker}`,
  notFoundBody: "我们还没有这家公司的财报解析，可以先看看已收录的公司。",
  notFoundBodyAlone: "我们还没有这家公司的财报解析。",
  thinTitle: (ticker: string) => `${ticker} 的数据还不够`,
  thinBody: "至少需要两个季度的财报才能生成分析，下一份财报发布后会自动补上。",
  limitTitle: "请求过于频繁",
  limitBody: "大约一分钟后可以重试。",
  serverTitle: "页面没有载入",
  serverBody: "网络或服务器出错了，可以再试一次。",
  missingTitle: "未找到",
  missingBody: "这个地址没有对应的页面。可以回到首页，或看看已收录的公司。",
  missingBodyAlone: "这个地址没有对应的页面。",
  backHome: "返回首页",
  retry: "重试",
  searchOther: "搜索其他公司",
  covered: "已收录公司",
  code: (code: string) => `错误代码：${code}`,
  titleMissing: "未找到",
  titleThin: "数据不足",
  titleLimit: "请稍后再试",
  titleServer: "暂时无法打开",
});

export type ErrorKind = CompanyFault["kind"] | "missing";

const ICONS: Record<ErrorKind, ReactNode> = {
  "not-found": <SearchX strokeWidth={1.5} />,
  insufficient: <ChartColumn strokeWidth={1.5} />,
  "rate-limit": <Timer strokeWidth={1.5} />,
  server: <CloudOff strokeWidth={1.5} />,
  missing: <CircleAlert strokeWidth={1.5} />,
};

export function ErrorState({ kind, code, ticker, companies, onHome, onRetry, onSearch, restoredTitle }: {
  kind: ErrorKind;
  code: string;
  ticker?: string | null;
  companies: Array<{ ticker: string; name: string }>;
  onHome: () => void;
  onRetry?: () => void;
  onSearch: () => void;
  /** Title to put back when this page leaves, so a recovered company does not keep the error title. */
  restoredTitle?: string;
}) {
  useLocale();
  const name = ticker ?? "";
  const retryable = kind === "rate-limit" || kind === "server";
  const title = kind === "not-found" && name ? m.notFoundTitle(name)
    : kind === "insufficient" && name ? m.thinTitle(name)
    : kind === "rate-limit" ? m.limitTitle
    : kind === "server" ? m.serverTitle
    : m.missingTitle;
  // Copy that points at the covered companies only while there are some to show.
  const listed = companies.length > 0;
  const body = kind === "not-found" && name ? (listed ? m.notFoundBody : m.notFoundBodyAlone)
    : kind === "insufficient" ? m.thinBody
    : kind === "rate-limit" ? m.limitBody
    : kind === "server" ? m.serverBody
    : listed ? m.missingBody : m.missingBodyAlone;
  const pageTitle = kind === "insufficient" ? m.titleThin
    : kind === "rate-limit" ? m.titleLimit
    : kind === "server" ? m.titleServer
    : m.titleMissing;
  useLayoutEffect(() => {
    document.documentElement.dataset.pageTitle = "error";
    document.title = `${pageTitle} · Spontra`;
    return () => {
      delete document.documentElement.dataset.pageTitle;
      if (restoredTitle) document.title = restoredTitle;
    };
  }, [pageTitle, restoredTitle]);
  return <div className="error-page">
    <section className="error-state" role={retryable ? "alert" : "status"}>
      <div className="error-icon" aria-hidden="true">{ICONS[kind]}</div>
      <h1>{title}</h1>
      <p className="error-body">{body}</p>
      <div className="error-actions">
        <button type="button" className="error-primary" onClick={onHome}>{m.backHome}</button>
        {retryable
          ? <button type="button" className="error-secondary" onClick={onRetry}>{m.retry}</button>
          : <button type="button" className="error-secondary" onClick={onSearch}>{m.searchOther}</button>}
      </div>
      {listed && <>
        <h2>{m.covered}</h2>
        <ul className="error-picks">
          {companies.map(company => <li key={company.ticker}>
            <a href={`/companies/${company.ticker}`} data-nav>
              <b lang="en">{company.ticker}</b>
              <small lang={/[\u3400-\u9fff]/.test(company.name) ? "zh-CN" : "en"}>{company.name}</small>
            </a>
          </li>)}
        </ul>
      </>}
      <p className="error-code">{m.code(code)}</p>
    </section>
  </div>;
}
