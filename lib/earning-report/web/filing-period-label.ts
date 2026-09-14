import type { PublicSecFiling } from "../../../shared/analysis-contract/filings.ts";

/** Display SEC-reported fiscal focus; never infer it from prose or calendar dates. */
export function formatFilingPeriodLabel(filing: PublicSecFiling): string {
  if (!filing.earningsGroup && !/^(10-Q|10-K|20-F)(\/A)?$/.test(filing.form)) return filing.form;
  const period = filing.fiscalPeriod;
  if (!period || period.periodEnd !== (filing.earningsGroup?.periodEnd || filing.reportDate)) return "财季待确认";
  const labels = { FY: "全年", H1: "上半年", H2: "下半年", M9: "前九个月" };
  const label = period.fiscalPeriod in labels ? labels[period.fiscalPeriod as keyof typeof labels] : period.fiscalPeriod;
  return `FY${period.fiscalYear} ${label}`;
}
