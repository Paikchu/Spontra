import type { BusinessFlowQuarter } from "@/shared/analysis-contract/business-flow";
import type { EventsPublication } from "@/shared/analysis-contract/events";
import type { PublicFilingDigest, PublicFilingDigestPage } from "@/shared/analysis-contract/filings";
import { DAY_MS } from "@/shared/analysis-runtime/events";
import { isReport, mergedAccessions, railEntries, type RailEntry } from "@/shared/analysis-runtime/rail";
import { getLocale, messages } from "@/packages/web/src/i18n";
import { langOf } from "@/packages/web/src/i18n/SourceLanguage";
import { periodLabel } from "@/shared/analysis-runtime/fiscal-label";
import { eventTitle, isQuietInsider, periodReport, type TimelinePoint } from "./events-model";

const m = messages({
  pending: (period: string) => `${period} report · Analysis in progress`,
}, {
  pending: (period: string) => `${period} 财报 · 分析中`,
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

/** Everything on the time axis: reports from the filings, events from the publication, merged current reports once. Oldest first. */
export function timelineFromFilings(filings: PublicFilingDigestPage | null, events: EventsPublication | null, months = 24, now = new Date(), quarters: BusinessFlowQuarter[] = [], ticker = ""): TimelinePoint[] {
  const floor = new Date(now.getTime() - months * 30.4 * DAY_MS).toISOString().slice(0, 10);
  const reports = (filings?.filings ?? []).filter(isReport);
  const merged = mergedAccessions(reports);
  const points: TimelinePoint[] = reports.filter(r => r.date >= floor)
    .map(r => ({ id: r.accessionNumber, date: r.date, kind: "report" as const, periodEnd: r.periodEnd!, title: `${filingQuarterLabel(ticker, r) ?? r.form} · ${r.headline || r.form}`, weight: 3 as const }));
  // The axis is the only quarter control, so a flow quarter the filing list does not cover still gets a tick that switches the stage.
  const covered = new Set(points.map(p => p.periodEnd));
  for (const q of quarters) {
    const date = q.reportedAt ?? q.periodEnd;
    if (!covered.has(q.periodEnd) && date >= floor) { covered.add(q.periodEnd); points.push({ id: "report:" + q.id, date, kind: "report", periodEnd: q.periodEnd, title: filingQuarterLabel(ticker, q) ?? periodReport(q.periodEnd), weight: 3 }); }
  }
  for (const e of events?.events ?? []) {
    if (e.filedAt < floor || merged.has(e.id)) continue;
    points.push({ id: e.id, date: e.filedAt, kind: "event", cls: e.class, title: eventTitle(e), weight: e.class === "insider" ? (isQuietInsider(e) ? 0 : 1) : 2 });
  }
  return points.sort((a, b) => a.date.localeCompare(b.date) || b.weight - a.weight);
}

/** The rail's one-line title for a report: its headline, or its period and form while the analysis is still running. */
export function reportTitle(r: PublicFilingDigest, ticker = ""): string {
  return r.headline || m.pending(filingQuarterLabel(ticker, r) ?? r.form);
}

/** The language of the generated headline while it is the title (Chinese once translated); undefined while the title is composed in the reader's language. */
export const reportTitleLang = (r: PublicFilingDigest): ReturnType<typeof langOf> | undefined => r.headline ? langOf(r.headline) : undefined;

/**
 * The rail's digest while its full list is closed: the newest report and the latest `events` filings, newest first.
 * The focused row stays in the digest wherever it falls, so closing the list never hides the pick on stage.
 */
export function railDigest(rail: RailItems, focus: string | null, events = 3): RailItem[] {
  const all = [...rail.recent, ...rail.earlier];
  const picked = new Set<RailItem>(all.filter(i => i.kind === "event").slice(0, events));
  const report = all.find(i => i.kind === "report");
  if (report) picked.add(report);
  const focused = all.find(i => i.id === focus);
  if (focused) picked.add(focused);
  return all.filter(i => picked.has(i));
}
