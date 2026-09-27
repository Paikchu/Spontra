import type { ReactNode } from "react";
import { TodayDashboard, PortfolioDashboard, StockWorkspace, SecReportDocument, ReportShare } from "@/packages/ui/src/screens";
import { filingPresentation } from "@/packages/client/src/report";
import type { PortfolioData, StockContext } from "@/packages/client/src/contracts";
import type { PublicFilingDetail } from "@/shared/analysis-contract/filings";
import { refreshClientData } from "@/packages/client/src/refresh";
import { useResource } from "./resource";
function DataState({ error, ready, children }: { error?: string; ready: boolean; children: ReactNode }) {
  return <>{error && <p className="desktop-status" role="alert">{error}<button onClick={refreshClientData}>重新加载</button></p>}
    {!ready && !error && <p className="desktop-status" role="status">正在加载…</p>}{children}</>;
}
export function PortfolioPage({ today = false }: { today?: boolean }) {
  const { data, error } = useResource<PortfolioData>("/api/portfolio");
  return <main className={`page-shell ${today ? "today-shell" : "ledger-shell"}`}>
    <DataState error={error} ready={!!data}>{data && <>
      {data.source === "fallback" && <p role="status" className="desktop-status">暂时无法读取最新持仓，显示截至 {data.asOf} 的历史快照。</p>}
      {today ? <TodayDashboard {...data.presentation} /> : <PortfolioDashboard {...data.presentation} />}
    </>}</DataState></main>;
}
export function StockPage({ ticker }: { ticker: string }) {
  const { data, error } = useResource<StockContext>(`/api/stocks/${encodeURIComponent(ticker)}`);
  return <DataState error={error} ready={!!data}>{data && <StockWorkspace stock={data} />}</DataState>;
}
export function FilingPage({ ticker, accession, query }: { ticker: string; accession: string; query: string }) {
  const { data, error } = useResource<PublicFilingDetail>(`/api/analysis/v1/companies/${encodeURIComponent(ticker)}/filings/${encodeURIComponent(accession)}${query}`);
  const params = new URLSearchParams(query);
  return <div className="earning-report"><DataState error={error} ready={!!data}>{data && <>
    <ReportShare ticker={ticker} accession={accession} reportDate={params.get("reportDate") ?? data.filing.reportDate ?? ""} reportVersion={params.get("reportVersion") ?? data.filing.reportVersion ?? undefined} generatedAt={data.filing.summary?.generatedAt ?? ""} />
    <SecReportDocument {...filingPresentation(data, ticker)} />
  </>}</DataState></div>;
}
