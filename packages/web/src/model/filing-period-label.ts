import type { PublicSecFiling } from "../../../../shared/analysis-contract/filings.ts";
import type { Locale } from "../../../../shared/analysis-runtime/locale.ts";

const ZH_PERIOD: Record<string, string> = { Q1: "第一季度", Q2: "第二季度", Q3: "第三季度", Q4: "第四季度", H1: "上半年", H2: "下半年", M9: "前三季度" };

/**
 * Display SEC-reported fiscal focus ("Q3 FY2026", "FY2026" / "2026 财年第三季度", "2026 财年"); never infer it
 * from prose or calendar dates.
 */
export function formatFilingPeriodLabel(filing: PublicSecFiling, locale: Locale = "en"): string {
  if (!filing.earningsGroup && !/^(10-Q|10-K|20-F)(\/A)?$/.test(filing.form)) return filing.form;
  const period = filing.fiscalPeriod;
  const zh = locale === "zh-CN";
  if (!period || period.periodEnd !== (filing.earningsGroup?.periodEnd || filing.reportDate)) return zh ? "财季待确认" : "Fiscal quarter pending";
  if (zh) return period.fiscalPeriod === "FY" ? `${period.fiscalYear} 财年` : `${period.fiscalYear} 财年${ZH_PERIOD[period.fiscalPeriod] ?? period.fiscalPeriod}`;
  const year = `FY${period.fiscalYear}`;
  if (period.fiscalPeriod === "FY") return year;
  const labels = { M9: "9M" } as Record<string, string>;
  return `${labels[period.fiscalPeriod] ?? period.fiscalPeriod} ${year}`;
}
