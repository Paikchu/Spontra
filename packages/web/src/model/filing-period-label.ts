import type { FiscalPeriodFields } from "../../../../shared/analysis-contract/period.ts";
import type { PublicSecFiling } from "../../../../shared/analysis-contract/filings.ts";
import { fiscalIdentity, periodLabel, quarterNumber } from "../../../../shared/analysis-runtime/fiscal-label.ts";
import type { Locale } from "../../../../shared/analysis-runtime/locale.ts";

const PERIODIC = /^(10-Q|10-K|20-F)(\/A)?$/;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Reporting period end for a periodic filing or an earnings group; null for a standalone event. */
export function filingPeriodEnd(filing: Pick<PublicSecFiling, "form" | "reportDate" | "earningsGroup" | "fiscalPeriod">): string | null {
  if (!filing.earningsGroup && !PERIODIC.test(filing.form)) return null;
  const end = filing.earningsGroup?.periodEnd || filing.fiscalPeriod?.periodEnd || filing.reportDate;
  return ISO.test(end) ? end : null;
}

/** Issuer quarter for a filing. DEI focus is kept when it agrees with the fiscal calendar; a missing focus is derived. */
export function filingFiscalFields(filing: Pick<PublicSecFiling, "ticker" | "form" | "reportDate" | "earningsGroup" | "fiscalPeriod" | "fiscalYearEndMonth">): (FiscalPeriodFields & { periodEnd: string }) | null {
  const periodEnd = filingPeriodEnd(filing);
  if (!periodEnd) return null;
  const focus = filing.fiscalPeriod;
  const quarter = focus && focus.periodEnd === periodEnd ? quarterNumber(focus.fiscalPeriod) : null;
  return { periodEnd, ...fiscalIdentity({ ticker: filing.ticker, fiscalYearEndMonth: filing.fiscalYearEndMonth, periodEnd, xbrl: quarter && focus ? { fiscalYear: focus.fiscalYear, fiscalQuarter: quarter } : null }) };
}

/** The issuer quarter, or the period-end phrase when the quarter cannot be determined. Events keep their form name. */
export function formatFilingPeriodLabel(filing: PublicSecFiling, locale: Locale = "en"): string {
  const fields = filingFiscalFields(filing);
  if (!fields) return filing.form;
  const labels = periodLabel({ ticker: filing.ticker, ...fields }, locale);
  return labels.primary ?? labels.unknown;
}
