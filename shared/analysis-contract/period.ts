/**
 * Issuer-fiscal period identity carried on read APIs.
 * `fiscalLabel` on the homepage stays the calendar quarter for older clients; these fields are the company's own quarter.
 */

export type FiscalLabelSource = "xbrl" | "derived" | "unknown";
export type FiscalQuarterNumber = 1 | 2 | 3 | 4;

export type FiscalPeriodFields = {
  fiscalYear: number | null;
  fiscalQuarter: FiscalQuarterNumber | null;
  /** Month the fiscal year ends, 1–12. Null when the issuer is not in the fiscal calendar. */
  fiscalYearEndMonth: number | null;
  labelSource: FiscalLabelSource;
};
