import { notFound } from "next/navigation";
import { getAnalysisBackendRuntime } from "@/lib/earning-report/web/analysis-backend-runtime.ts";
import { isAnalysisErrorBody } from "@/lib/earning-report/web/analysis-client.ts";
import type { PublicFilingDetail } from "@/shared/analysis-contract/filings.ts";
import { findSecurity } from "@/lib/earning-report/web/site-data.ts";
import { normalizeTrackedTicker } from "@/lib/earning-report/web/ticker.ts";
import { SecReportDocument } from "@/app/analysis/stocks/[ticker]/sec/[accession]/SecReportDocument.tsx";

export const dynamic = "force-dynamic";

/**
 * Server-rendered report page. It reads through the backend client like every other consumer —
 * there is no database binding in this Worker to fall back to, and deliberately so: a silent
 * fallback would have preserved exactly the coupling this refactor removed.
 */
export default async function StockSecReportPage({ params, searchParams }: { params: Promise<{ ticker: string; accession: string }>; searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const route = await params;
  const ticker = normalizeTrackedTicker(route.ticker);
  const query = await searchParams ?? {};
  const pinned = query.reportVersion !== undefined || query.reportDate !== undefined;
  if (pinned && (typeof query.reportVersion !== "string" || typeof query.reportDate !== "string")) notFound();
  const snapshot = pinned ? { reportVersion: query.reportVersion as string, reportDate: query.reportDate as string } : undefined;
  const result = await loadFiling(ticker, route.accession, snapshot);
  if (result === "unavailable") throw new Error("The analysis backend is unavailable.");
  if (!result) notFound();
  const security = findSecurity(ticker);
  const filing = result.filing;
  return <SecReportDocument companyName={security?.name ?? result.company?.name ?? ticker} filing={{
    earningsGroup: filing.earningsGroup,
    ticker,
    cik: result.company?.cik ?? "",
    cikNumber: Number(result.company?.cik ?? 0),
    companyName: security?.name ?? result.company?.name ?? ticker,
    form: filing.form,
    filingDate: filing.filingDate,
    reportDate: filing.reportDate,
    accessionNumber: filing.accessionNumber,
    primaryDocument: "",
    description: filing.description,
    items: "",
    documentUrl: filing.documentUrl,
    indexUrl: filing.edgarUrl,
    summary: filing.summary,
    analysis: filing.analysis,
  }} />;
}

/**
 * Three outcomes, kept apart on purpose: the filing, a genuine 404, and a backend that could not
 * answer. Collapsing the third into the second would render an outage as "this report does not
 * exist", which is the one thing a reader must not be told when it is untrue.
 */
async function loadFiling(ticker: string, accession: string, snapshot?: { reportDate: string; reportVersion: string }): Promise<PublicFilingDetail | null | "unavailable"> {
  if (!ticker) return null;
  const runtime = await getAnalysisBackendRuntime();
  if (!runtime.configured) {
    console.error(JSON.stringify({ event: "analysis-backend-unconfigured", reason: runtime.reason }));
    return "unavailable";
  }
  try {
    const response = await runtime.client.getFiling(ticker, accession, snapshot);
    if (response.status === 404) return null;
    if (response.status !== 200 || isAnalysisErrorBody(response.body)) {
      console.error(JSON.stringify({ event: "analysis-backend-refused", status: response.status }));
      return "unavailable";
    }
    return response.body as PublicFilingDetail;
  } catch {
    return "unavailable";
  }
}
