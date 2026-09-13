import type { SecFilingWithSummary } from "../shared/analysis-contract/report.ts";
import type { PublicFilingPage, PublicSecFiling } from "../shared/analysis-contract/filings.ts";
import { getAnalysisBackendRuntime } from "./earning-report/web/analysis-backend-runtime.ts";

type PublicCompany = PublicFilingPage["company"];
type PublicFiling = PublicSecFiling;

/** Compatibility response for old feed clients; all reads now use the current Pipeline. */
export async function getCloudflareSecFeed(ticker: string) {
  const runtime = await getAnalysisBackendRuntime();
  if (!runtime.configured) throw new Error("SEC backend unavailable");
  const response = await runtime.client.listFilings(ticker, { limit: "50" });
  if (response.status !== 200) throw new Error("SEC backend unavailable");
  const page = response.body as PublicFilingPage;
  return {
    ticker, company: page.company,
    filings: page.filings.map((filing) => mapFiling(filing, page.company)),
    fetchedAt: page.checkedAt, status: page.filings.length ? "ready" : "empty",
  };
}

function mapFiling(filing: PublicFiling, company: PublicCompany): SecFilingWithSummary {
  const cik = company?.cik ?? "";
  return {
    earningsGroup: filing.earningsGroup,
    ticker: filing.ticker,
    cik,
    cikNumber: Number(cik.replace(/\D/g, "")) || 0,
    companyName: company?.name ?? filing.ticker,
    form: filing.form,
    filingDate: filing.filingDate,
    reportDate: filing.reportDate,
    accessionNumber: filing.accessionNumber,
    primaryDocument: filing.documentUrl.split("/").at(-1) ?? "",
    description: filing.description,
    items: "",
    documentUrl: filing.documentUrl,
    indexUrl: filing.edgarUrl,
    summary: filing.summary,
    analysis: filing.analysis,
  };
}
