import type { CompanyEvent, EventsPublication } from "../analysis-contract/events.ts";
import type { PublicFilingDigest, PublicFilingDigestPage } from "../analysis-contract/filings.ts";
import { isQuietInsider } from "./events.ts";

/**
 * The company's filings as the map's rail lists them, one entry each: every report and every current report or traded
 * Form 4. The page lays these rows out; Spontra Analysis writes an analysis for the same rows, so the two read one list.
 */
export type RailEntry =
  | { kind: "report"; id: string; date: string; report: PublicFilingDigest }
  | { kind: "event"; id: string; date: string; event: CompanyEvent };

/** A report the rail lists: a 10-Q/10-K/20-F or an earnings group, never a standalone current report. */
export const isReport = (f: PublicFilingDigest) => f.periodEnd != null;

/** Current reports an earnings group already merged are listed once, as the report. */
export function mergedAccessions(filings: PublicFilingDigest[]): Set<string> {
  const merged = new Set<string>();
  for (const f of filings) { merged.add(f.accessionNumber); for (const s of f.sources) merged.add(s.accessionNumber); }
  return merged;
}

const byDate = (a: RailEntry, b: RailEntry) => b.date.localeCompare(a.date) || (a.kind === "report" ? -1 : b.kind === "report" ? 1 : 0);

/** Reports and events in one list, newest first; a Form 4 with nothing traded is left out. */
export function railEntries(filings: PublicFilingDigestPage | null, events: EventsPublication | null): RailEntry[] {
  const reports = (filings?.filings ?? []).filter(isReport);
  const merged = mergedAccessions(reports);
  const loud = (events?.events ?? []).filter(e => !isQuietInsider(e) && !merged.has(e.id));
  return [
    ...reports.map((r): RailEntry => ({ kind: "report", id: r.accessionNumber, date: r.date, report: r })),
    ...loud.map((e): RailEntry => ({ kind: "event", id: e.id, date: e.filedAt, event: e })),
  ].sort(byDate);
}
