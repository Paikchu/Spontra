import type { PublicFilingDetail } from "@/shared/analysis-contract/filings";
import type { SecFilingWithSummary } from "@/shared/analysis-contract/report";
export function filingPresentation(result: PublicFilingDetail, ticker: string, preferredName?: string): { companyName: string; filing: SecFilingWithSummary } {
  const filing = result.filing;
  const companyName = preferredName ?? result.company?.name ?? ticker;
  return { companyName, filing: {
    earningsGroup: filing.earningsGroup, ticker, cik: result.company?.cik ?? "",
    cikNumber: Number(result.company?.cik ?? 0), companyName,
    form: filing.form, filingDate: filing.filingDate, reportDate: filing.reportDate,
    accessionNumber: filing.accessionNumber, primaryDocument: "", description: filing.description,
    items: "", documentUrl: filing.documentUrl, indexUrl: filing.edgarUrl,
    summary: filing.summary, analysis: filing.analysis,
  }};
}
