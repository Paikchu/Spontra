import type { PublicSecFiling } from "../../../shared/analysis-contract/filings.ts";

/** Use an explicit fiscal period in the report opening, never the calendar quarter. */
export function formatFilingPeriodLabel(filing: PublicSecFiling): string {
  const group = filing.earningsGroup;
  if (!group && !/^(10-Q|10-K|20-F)(\/A)?$/.test(filing.form)) return filing.form;
  const periodEnd = group?.periodEnd || filing.reportDate;
  const published = filing.analysis?.publication;
  const summary = published ? published.summary : filing.summary;
  const summaryPeriod = published?.filing.reportDate ?? filing.summary?.earningsGroup?.periodEnd ?? filing.reportDate;
  if (summaryPeriod === periodEnd) {
    // Restrict extraction to the introduction so later comparisons/guidance cannot label this report.
    const opening = (summary?.report ?? "").split(/\n\s*\n/)[0]?.slice(0, 600) ?? "";
    const match = /(?:FY\s*|(?:财年\s*))(20\d{2})\s*(?:财年)?\s*(?:Q([1-4])|第?([一二三四1-4])季度)/i.exec(opening)
      ?? /(20\d{2})\s*财年\s*(?:Q([1-4])|第?([一二三四1-4])季度)/i.exec(opening);
    if (match) {
      const quarter = match[2] ?? String("一二三四".indexOf(match[3]!) + 1 || Number(match[3]));
      return `FY${match[1]} Q${quarter}`;
    }
  }
  // An exact period end remains useful when fiscal metadata is unavailable.
  return periodEnd ? `${periodEnd} 财报` : "财报";
}
