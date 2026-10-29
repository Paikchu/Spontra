import { getLocale, messages } from "@/packages/web/src/i18n/core";
import { resolvePeriod } from "@/shared/analysis-runtime/fiscal-label";
import { currencyName, type Locale } from "@/shared/analysis-runtime/locale";
import type { BusinessFlowQuarter, FlowMetric, PublicBusinessFlow } from "@/shared/analysis-contract/business-flow";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const m = messages({
  fiscalEnds: (month: number) => `FY ends ${MONTHS_SHORT[month - 1] ?? month}`,
  fiscalExplain: (month: number, end: string, year: number, quarter: number) => `Fiscal year ends in ${MONTHS[month - 1] ?? month}, so the quarter ended ${end} is FY${year} Q${quarter}`,
  reportsIn: (currency: string) => `Reports in ${currency}`,
}, {
  fiscalEnds: (month: number) => `财年截至 ${month} 月`,
  fiscalExplain: (month: number, end: string, year: number, quarter: number) => `该公司财年截至每年 ${month} 月，所以 ${end} 结束的季度是 ${year} 财年 Q${quarter}`,
  reportsIn: (currency: string) => `报告货币：${currency}`,
});

/** The header's issuer line for one quarter: the fiscal year end, the filer context, and why the quarter has its fiscal year. */
export type IssuerHeader = { fiscalLabel: string | null; filingLabel: string | null; fiscalNote: string | null };

/**
 * What the page knows about the issuer it shows: the name a reader knows it by, its legal name, its fiscal calendar,
 * and the header line for its latest quarter (the map redoes the line for the quarter it shows).
 */
export type CompanyIdentity = { name: string | null; fullName: string | null; fiscalYearEndMonth: number | null; annualForm: string | null } & IssuerHeader;

type FilingForms = { filings: Array<{ form?: string | null }> } | null | undefined;
/** The issuer's filed events: a foreign issuer's 6-K reports, served even before its filings are collected. */
type EventForms = { events: Array<{ form?: string | null }> } | null | undefined;

const clean = (value: string | null | undefined) => value?.trim() || null;
const month = (value: number | null | undefined) => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 12 ? value : null;

/**
 * The company header's identity, from data only: the catalog's Chinese name first on the Chinese page, then the
 * issuer's own name from its filings, the generated publications, and the catalog's English name. The fiscal year-end
 * month is the issuer's (its submissions or latest annual report), else the catalog's latest period.
 */
export function companyIdentity(input: {
  locale: Locale;
  catalog?: { name?: string | null; nameZh?: string | null; latestPeriod?: { fiscalYearEndMonth?: number | null } | null } | null;
  /** The issuer as its submissions state it; `annualForm` is its latest annual report's form, "20-F" for a foreign issuer. */
  issuer?: { name?: string | null; fiscalYearEndMonth?: number | null; annualForm?: string | null } | null;
  explainerName?: string | null;
  treeName?: string | null;
  /** The business flow: its latest quarter's fiscal calendar and reporting currency. */
  flow?: Pick<PublicBusinessFlow, "quarters"> | null;
  /** The issuer's filings: a foreign issuer's annual form. */
  filings?: FilingForms;
  /** The issuer's filed events: a foreign issuer's 6-K. */
  events?: EventForms;
}): CompanyIdentity {
  const { locale, catalog, issuer } = input;
  const filed = clean(issuer?.name) ?? clean(input.explainerName) ?? clean(input.treeName) ?? clean(catalog?.name);
  const name = (locale === "zh-CN" ? clean(catalog?.nameZh) : null) ?? filed;
  const latest = input.flow?.quarters.reduce<BusinessFlowQuarter | null>((a, q) => !a || q.periodEnd > a.periodEnd ? q : a, null) ?? null;
  const fiscalYearEndMonth = month(issuer?.fiscalYearEndMonth) ?? month(catalog?.latestPeriod?.fiscalYearEndMonth) ?? month(latest?.fiscalYearEndMonth);
  const annualForm = clean(issuer?.annualForm);
  const { fiscalLabel, filingLabel, fiscalNote } = issuerHeader({ base: { fiscalYearEndMonth, annualForm }, quarter: latest, filings: input.filings, events: input.events }, locale);
  return { name, fullName: clean(issuer?.name) ?? clean(catalog?.name) ?? name, fiscalYearEndMonth, annualForm, fiscalLabel, filingLabel, fiscalNote };
}

/**
 * The issuer line for the quarter shown, "财年截至 12 月" + "20-F · 报告货币：新台币": the quarter's own fiscal calendar
 * first, else the issuer's; the currency is the quarter's, the form the filings', else the filed events' (a 6-K filer is a
 * 20-F filer), else the issuer's annual form, so an issuer with no filing collected yet still reads as a 20-F filer. Without a quarter the base's line stands.
 */
export function issuerHeader(input: { base?: Partial<CompanyIdentity> | null; quarter?: BusinessFlowQuarter | null; filings?: FilingForms; events?: EventForms }, locale: Locale): IssuerHeader & { fiscalYearEndMonth: number | null } {
  const { base, quarter } = input;
  const fiscalYearEndMonth = month(quarter?.fiscalYearEndMonth) ?? month(base?.fiscalYearEndMonth);
  const context = filerContext({ currency: quarter?.currency, forms: [...input.filings?.filings.map(f => f.form) ?? [], ...input.events?.events.map(e => e.form) ?? [], base?.annualForm] });
  return {
    fiscalYearEndMonth,
    fiscalLabel: fiscalYearEndText(fiscalYearEndMonth) ?? base?.fiscalLabel ?? null,
    filingLabel: (context.length ? context.join(" · ") : null) ?? (quarter ? null : base?.filingLabel ?? null),
    fiscalNote: quarter
      ? fiscalExplanation({ periodEnd: quarter.periodEnd, periodStart: quarter.periodStart, fiscalYear: quarter.fiscalYear, fiscalQuarter: quarter.fiscalQuarter, fiscalYearEndMonth, labelSource: quarter.labelSource }, locale)
      : base?.fiscalNote ?? null,
  };
}

/** "财年截至 1 月" / "FY ends Jan"; null when the month is not known. */
export const fiscalYearEndText = (fiscalYearEndMonth: number | null | undefined) => month(fiscalYearEndMonth) ? m.fiscalEnds(month(fiscalYearEndMonth)!) : null;

const endText = (periodEnd: string, locale: Locale) => {
  const [y, mo, d] = periodEnd.split("-").map(Number);
  if (!y || !mo || !d) return periodEnd;
  return locale === "zh-CN" ? periodEnd.replaceAll("-", ".") : `${MONTHS_SHORT[mo - 1]} ${d}, ${y}`;
};

/**
 * Why a quarter carries the fiscal year it does, for an issuer whose fiscal year does not end in December:
 * "该公司财年截至每年 1 月，所以 2026.07.26 结束的季度是 2027 财年 Q2". Null for a calendar-year issuer or an unknown quarter.
 */
export function fiscalExplanation(input: { periodEnd: string; periodStart?: string | null; fiscalYear?: number | null; fiscalQuarter?: number | null; fiscalYearEndMonth: number | null; labelSource?: Parameters<typeof resolvePeriod>[0]["labelSource"] }, locale: Locale): string | null {
  const endMonth = month(input.fiscalYearEndMonth);
  if (endMonth == null || endMonth === 12) return null;
  const period = resolvePeriod({ ...input, fiscalYearEndMonth: endMonth });
  if (period.fiscalYear == null || period.fiscalQuarter == null) return null;
  return m.fiscalExplain(endMonth, endText(input.periodEnd, locale), period.fiscalYear, period.fiscalQuarter);
}

/** The header's context line after the fiscal year: a reporting currency other than dollars, a foreign issuer's annual form. */
export function filerContext(input: { currency?: string | null; forms?: Array<string | null | undefined> }): string[] {
  const out: string[] = [];
  const foreign = input.forms?.find(form => form && /^(?:20-F|40-F|6-K)\b/.test(form));
  if (foreign) out.push(foreign.startsWith("6-K") ? "20-F" : foreign.replace(/\/A$/, ""));
  if (input.currency && input.currency !== "USD") out.push(m.reportsIn(currencyName(input.currency, getLocale())));
  return out;
}

/* ---------- The four headline figures ---------- */

export type CoreSlot = { key: "revenue" | "gross" | "pretax" | "operating" | "net"; metric: FlowMetric; value: number | null; missing: null | "model" | "undisclosed" };

/**
 * The four headline figures of the income statement, always four: revenue, gross profit (or income before taxes for a
 * model without one), operating income, net income. A figure the filing does not carry stays as an empty slot with its
 * reason: not part of the industry's statement model (a bank: no gross profit or operating income, but a pretax line),
 * or not disclosed. When operating income is missing but income before taxes is known and not shown yet, it takes the slot.
 */
export function coreSlots(figure: (key: FlowMetric) => number | null, options: { hideGross?: boolean } = {}): CoreSlot[] {
  const gross = options.hideGross ? null : figure("gross"), pretax = figure("pretax"), operating = figure("operating");
  const financial = gross == null && operating == null && pretax != null;
  const missing = (value: number | null): CoreSlot["missing"] => value != null ? null : financial ? "model" : "undisclosed";
  const second: CoreSlot = gross != null || pretax == null
    ? { key: "gross", metric: "gross", value: gross, missing: missing(gross) }
    : { key: "pretax", metric: "pretax", value: pretax, missing: null };
  const third: CoreSlot = operating == null && pretax != null && second.key === "gross"
    ? { key: "pretax", metric: "pretax", value: pretax, missing: null }
    : { key: "operating", metric: "operating", value: operating, missing: missing(operating) };
  const revenue = figure("revenue"), net = figure("net");
  return [
    { key: "revenue", metric: "revenue", value: revenue, missing: revenue == null ? "undisclosed" : null },
    second, third,
    { key: "net", metric: "net", value: net, missing: net == null ? "undisclosed" : null },
  ];
}
