import type { PublicSecFiling } from "../../../../shared/analysis-contract/filings.ts";

/** Display SEC-reported fiscal focus ("Q3 FY2026", "FY2026"); never infer it from prose or calendar dates. */
export function formatFilingPeriodLabel(filing: PublicSecFiling): string {
  if (!filing.earningsGroup && !/^(10-Q|10-K|20-F)(\/A)?$/.test(filing.form)) return filing.form;
  const period = filing.fiscalPeriod;
  if (!period || period.periodEnd !== (filing.earningsGroup?.periodEnd || filing.reportDate)) return "Fiscal quarter pending";
  const year = `FY${period.fiscalYear}`;
  if (period.fiscalPeriod === "FY") return year;
  const labels = { M9: "9M" } as Record<string, string>;
  return `${labels[period.fiscalPeriod] ?? period.fiscalPeriod} ${year}`;
}
