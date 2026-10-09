import type { BusinessFlowQuarter } from "@/shared/analysis-contract/business-flow";
import type { CompanyEvent, EventsPublication } from "@/shared/analysis-contract/events";
import type { PublicFilingDigest, PublicFilingDigestPage } from "@/shared/analysis-contract/filings";
import { DAY_MS } from "@/shared/analysis-runtime/events";
import { eventTitle, isQuietInsider, type TimelinePoint } from "./events-model";

/** A report the rail lists: a 10-Q/10-K/20-F or an earnings group, never a standalone current report. */
export const isReport = (f: PublicFilingDigest) => f.periodEnd != null;

export type RailItem =
  | { kind: "report"; id: string; date: string; report: PublicFilingDigest }
  | { kind: "event"; id: string; date: string; event: CompanyEvent };

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

/** Current reports an earnings group already merged are listed once, as the report. */
function mergedAccessions(filings: PublicFilingDigest[]): Set<string> {
  const merged = new Set<string>();
  for (const f of filings) { merged.add(f.accessionNumber); for (const s of f.sources) merged.add(s.accessionNumber); }
  return merged;
}

const byDate = (a: RailItem, b: RailItem) => b.date.localeCompare(a.date) || (a.kind === "report" ? -1 : b.kind === "report" ? 1 : 0);

/**
 * Reports and events in one chronological list. The recent section opens at the newest report so the
 * period reads as "the report, then what was filed after it"; with fewer than three rows it opens at
 * the report before, and without any report it falls back to the last 90 days or the last five rows.
 */
export function railItems(filings: PublicFilingDigestPage | null, events: EventsPublication | null, now = new Date()): RailItems | null {
  const reports = (filings?.filings ?? []).filter(isReport);
  const merged = mergedAccessions(reports);
  const all = events?.events ?? [];
  const loud = all.filter(e => !isQuietInsider(e) && !merged.has(e.id));
  const items: RailItem[] = [
    ...reports.map((r): RailItem => ({ kind: "report", id: r.accessionNumber, date: r.date, report: r })),
    ...loud.map((e): RailItem => ({ kind: "event", id: e.id, date: e.filedAt, event: e })),
  ].sort(byDate);
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

/** Everything on the time axis: reports from the filings, events from the publication, merged current reports once. Oldest first. */
export function timelineFromFilings(filings: PublicFilingDigestPage | null, events: EventsPublication | null, months = 24, now = new Date(), quarters: BusinessFlowQuarter[] = []): TimelinePoint[] {
  const floor = new Date(now.getTime() - months * 30.4 * DAY_MS).toISOString().slice(0, 10);
  const reports = (filings?.filings ?? []).filter(isReport);
  const merged = mergedAccessions(reports);
  const points: TimelinePoint[] = reports.filter(r => r.date >= floor)
    .map(r => ({ id: r.accessionNumber, date: r.date, kind: "report" as const, periodEnd: r.periodEnd!, title: `${r.periodLabel ?? r.form} · ${r.headline || r.form}`, weight: 3 as const }));
  // The axis is the only quarter control, so a flow quarter the filing list does not cover still gets a tick that switches the stage.
  const covered = new Set(points.map(p => p.periodEnd));
  for (const q of quarters) {
    const date = q.reportedAt ?? q.periodEnd;
    if (!covered.has(q.periodEnd) && date >= floor) { covered.add(q.periodEnd); points.push({ id: "report:" + q.id, date, kind: "report", periodEnd: q.periodEnd, title: `${q.periodEnd.slice(0, 7).replace("-", ".")} 财报`, weight: 3 }); }
  }
  for (const e of events?.events ?? []) {
    if (e.filedAt < floor || merged.has(e.id)) continue;
    points.push({ id: e.id, date: e.filedAt, kind: "event", cls: e.class, title: eventTitle(e), weight: e.class === "insider" ? (isQuietInsider(e) ? 0 : 1) : 2 });
  }
  return points.sort((a, b) => a.date.localeCompare(b.date) || b.weight - a.weight);
}

/** The rail's one-line title for a report: its headline, or its period and form while the analysis is still running. */
export function reportTitle(r: PublicFilingDigest): string {
  return r.headline || `${r.periodLabel ?? r.form} 报告 · 解读生成中`;
}
