import type { EventsPublication } from "@/shared/analysis-contract/events";
import type { PublicFilingDigest, PublicFilingDigestPage } from "@/shared/analysis-contract/filings";
import { DAY_MS } from "@/shared/analysis-runtime/events";
import { isReport, railEntries, type RailEntry } from "@/shared/analysis-runtime/rail";
import { getLocale, messages } from "@/packages/web/src/i18n";
import { langOf } from "@/packages/web/src/i18n/SourceLanguage";
import { periodLabel } from "@/shared/analysis-runtime/fiscal-label";
import { isQuietInsider } from "./events-model";

const m = messages({
  pending: (period: string) => `${period} report · Analysis in progress`, unanalysed: (period: string) => `${period} report`,
}, {
  pending: (period: string) => `${period} 财报 · 分析中`, unanalysed: (period: string) => `${period} 财报`,
});

export { isReport };
export type RailItem = RailEntry;

export type RailItems = {
  /** From the newest report onward (or the one before it when that leaves too few), newest first. */
  recent: RailItem[];
  /** Everything older, newest first. */
  earlier: RailItem[];
  /** Form 4 filings with nothing traded, counted rather than listed. */
  quiet: number;
  /** The date the recent section starts at. */
  since: string;
};

/**
 * Reports and events in one chronological list. The recent section opens at the newest report so the
 * period reads as "the report, then what was filed after it"; with fewer than three rows it opens at
 * the report before, and without any report it falls back to the last 90 days or the last five rows.
 */
export function railItems(filings: PublicFilingDigestPage | null, events: EventsPublication | null, now = new Date()): RailItems | null {
  const reports = (filings?.filings ?? []).filter(isReport);
  const all = events?.events ?? [];
  const items = railEntries(filings, events);
  if (!items.length) return null;
  const today = now.toISOString().slice(0, 10);
  const reportDates = reports.map(r => r.date).filter(d => d <= today).sort((a, b) => b.localeCompare(a));
  const ninety = new Date(now.getTime() - 90 * DAY_MS).toISOString().slice(0, 10);
  let since = reportDates[0] ?? ninety;
  let recent = items.filter(i => i.date >= since);
  if (recent.length < 3 && reportDates[1]) { since = reportDates[1]; recent = items.filter(i => i.date >= since); }
  if (recent.length < 3) { recent = items.slice(0, Math.max(recent.length, Math.min(5, items.length))); since = recent[recent.length - 1]?.date ?? since; }
  const ids = new Set(recent.map(i => i.id));
  return { recent, earlier: items.filter(i => !ids.has(i.id)), quiet: all.length - all.filter(e => !isQuietInsider(e)).length, since };
}

/** The issuer quarter for a listed filing. The stored `periodLabel` is ignored so an older payload cannot keep "财季待确认". */
export function filingQuarterLabel(ticker: string, filing: Pick<PublicFilingDigest, "periodEnd" | "fiscalYear" | "fiscalQuarter" | "fiscalYearEndMonth" | "labelSource">): string | null {
  if (!filing.periodEnd) return null;
  const labels = periodLabel({
    ticker, periodEnd: filing.periodEnd, fiscalYear: filing.fiscalYear, fiscalQuarter: filing.fiscalQuarter,
    fiscalYearEndMonth: filing.fiscalYearEndMonth, labelSource: filing.labelSource,
  }, getLocale());
  return labels.primary ?? labels.unknown;
}

/** A quarter frame's heading: the fiscal quarter ("FY26 Q4") and its end ("截至 2026.09.27"), or the end alone when the fiscal quarter is unknown. */
export function quarterHeading(ticker: string, source: { periodEnd: string; fiscalYear?: number | null; fiscalQuarter?: number | null; fiscalYearEndMonth?: number | null; labelSource?: PublicFilingDigest["labelSource"] | null }): { title: string; end: string | null } {
  const labels = periodLabel({ ticker, ...source }, getLocale());
  return labels.primary ? { title: labels.primary, end: labels.secondary } : { title: labels.unknown, end: null };
}

/** The rail's one-line title for a report: its headline, or its period and form until it has one. */
export function reportTitle(r: PublicFilingDigest, ticker = ""): string {
  const period = filingQuarterLabel(ticker, r) ?? r.form;
  return r.headline || (r.analysisStatus === "processing" ? m.pending(period) : m.unanalysed(period));
}

/** The language of the generated headline while it is the title (Chinese once translated); undefined while the title is composed in the reader's language. */
export const reportTitleLang = (r: PublicFilingDigest): ReturnType<typeof langOf> | undefined => r.headline ? langOf(r.headline) : undefined;
