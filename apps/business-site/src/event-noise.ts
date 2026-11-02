import type { CompanyEvent } from "@/shared/analysis-contract/events";
import type { InsiderPersonSummary } from "@/shared/analysis-contract/insiders";
import { eventImportance } from "@/shared/analysis-runtime/events";
import { insiderPersonKey } from "@/shared/analysis-runtime/insiders";
import { getLocale } from "@/packages/web/src/i18n";
import { insiderCompactMoney as formatInsiderMoney } from "./insider-money";
import type { Locale } from "@/shared/analysis-runtime/locale";

export const insiderCompactMoney = (value: number, locale: Locale = getLocale()) => formatInsiderMoney(value, locale);
import type { RailItem } from "./reports-model";

/** The rail's filters. `key` is the default and the one the time axis draws first. */
export const EVENT_FILTERS = ["key", "earnings", "material", "insiders", "all"] as const;
export type EventFilter = (typeof EVENT_FILTERS)[number];

const MATERIAL = new Set(["executive", "vote", "deal", "financing", "capital_return", "legal"]);

/** Reads `?events=`. An absent or unknown value is the default, Key. */
export function readEventFilter(search: string): EventFilter {
  const raw = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("events");
  return EVENT_FILTERS.includes(raw as EventFilter) ? raw as EventFilter : "key";
}

/** Only the implicit default falls back; explicit category links keep the reader's choice. */
export function defaultEventFilter(search: string, items: readonly RailItem[] | null, now: Date): { filter: EventFilter; fallback: boolean } {
  const filter = readEventFilter(search);
  const explicit = EVENT_FILTERS.includes(new URLSearchParams(search).get("events") as EventFilter);
  const since = new Date(now.getTime() - 90 * 86_400_000).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  const events = items?.filter(item => item.kind === "event") ?? [];
  const recent = events.filter(item => item.date >= since && item.date <= today);
  const allEvents = events.flatMap(item => item.kind === "event" ? [item.event] : []);
  const fallback = !explicit && filter === "key" && recent.length > 0
    && !recent.some(item => matchesEventFilter(item, "key", allEvents));
  return { filter: fallback ? "all" : filter, fallback };
}

/** Writes the filter into a query, leaving every other parameter where it is. Key stays in the URL so a shared link names it. */
export function withEventFilter(search: string, filter: EventFilter): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  params.set("events", filter);
  const query = params.toString();
  return query ? `?${query}` : "";
}

const DAY_MS = 86_400_000;

/**
 * A periodic report belongs in Key when it has something to read, or when it is the only earnings row for that filing.
 * A 10-Q that only says the analysis is still running, filed within three days of an earnings release already in the
 * list, is the same news twice: it stays under Earnings and All, and Key keeps the release.
 */
function reportInKey(item: RailItem & { kind: "report" }, items: readonly RailItem[]): boolean {
  const report = item.report;
  if (report.headline.trim()) return true;
  const covered = new Set([report.accessionNumber, ...report.sources.map(source => source.accessionNumber)]);
  const day = Date.parse(report.date);
  const besideRelease = items.some(other => other.kind === "event"
    && (other.event.class === "earnings" || other.event.class === "guidance")
    && !covered.has(other.id)
    && Math.abs(Date.parse(other.date) - day) <= 3 * DAY_MS);
  return !besideRelease;
}

/** Whether one rail row belongs in a filter. Reports are earnings, so they are in Key, Earnings and All. */
export function matchesEventFilter(item: RailItem, filter: EventFilter, allEvents?: readonly CompanyEvent[], items: readonly RailItem[] = []): boolean {
  if (filter === "all") return true;
  if (item.kind === "report") {
    if (filter === "earnings") return true;
    if (filter !== "key") return false;
    return reportInKey(item, items);
  }
  const event = item.event;
  if (filter === "key") return eventImportance(event, allEvents) === "key";
  if (filter === "earnings") return event.class === "earnings" || event.class === "guidance";
  if (filter === "insiders") return event.class === "insider";
  if (MATERIAL.has(event.class)) return true;
  return event.class === "other" && eventImportance(event, allEvents) !== "routine";
}

export type NoiseRow =
  | { kind: "item"; id: string; date: string; item: RailItem }
  | { kind: "routine"; id: string; date: string; items: RailItem[] };

/** The rows of a reading: routine 6-Ks fold by month; everything else lists as itself. Insider trades list by person (`streamRows`). */
export function noiseRows(items: readonly RailItem[], filter: EventFilter): NoiseRow[] {
  const allEvents = items.flatMap(item => item.kind === "event" ? [item.event] : []);
  const picked = items.filter(item => matchesEventFilter(item, filter, allEvents, items)).sort((a, b) => b.date.localeCompare(a.date));
  const hosts = new Map<RailItem, NoiseRow>();
  const routines = new Map<string, Extract<NoiseRow, { kind: "routine" }>>();
  for (const item of picked) {
    if (item.kind !== "event") continue;
    const event = item.event;
    if (event.form.startsWith("6-K") && eventImportance(event, allEvents) === "routine") {
      const key = event.filedAt.slice(0, 7);
      const group = routines.get(key) ?? { kind: "routine", id: `routine:${key}`, date: item.date, items: [] };
      group.items.push(item);
      routines.set(key, group);
      hosts.set(item, group);
    }
  }
  const emitted = new Set<string>();
  return picked.flatMap(item => {
    const host = hosts.get(item);
    if (!host) return [{ kind: "item", id: item.id, date: item.date, item } as NoiseRow];
    if (emitted.has(host.id)) return [];
    emitted.add(host.id);
    return [host];
  });
}

/** How many rows each filter shows, after folding. */
export function filterCounts(items: readonly RailItem[]): Record<EventFilter, number> {
  return {
    key: noiseRows(items, "key").length,
    earnings: noiseRows(items, "earnings").length,
    material: noiseRows(items, "material").length,
    insiders: noiseRows(items, "insiders").length,
    all: noiseRows(items, "all").length,
  };
}

/** The filings a row stands for, in list order. */
export function rowLeaves(row: NoiseRow): RailItem[] {
  return row.kind === "item" ? [row.item] : row.items;
}

/** Share counts in the fold row use grouping digits (4,725), not the compact form the single rows use. */
export function exactShares(shares: number): string {
  return new Intl.NumberFormat(getLocale() === "zh-CN" ? "zh-CN" : "en-US", { maximumFractionDigits: 0 }).format(Math.round(shares));
}

/** Accession numbers and event ids the filter draws, after folding is expanded back to filings. */
export function timelineIds(items: readonly RailItem[], filter: EventFilter): Set<string> {
  return new Set(noiseRows(items, filter).flatMap(row => rowLeaves(row).map(item => item.id)));
}

/** The readings whose rail opens with the latest earnings filing. */
const PINNED_IN: ReadonlySet<EventFilter> = new Set<EventFilter>(["key", "all"]);
/** The readings that list insider trades: one row per person, among the other rows. */
const INSIDERS_IN: ReadonlySet<EventFilter> = new Set<EventFilter>(["key", "all", "insiders"]);

export type InsiderFiling = RailItem & { kind: "event" };

/**
 * Every Form 4 on the rail, of any age, newest first. None of them lists as its own row: they reach the rail through their
 * people (from Spontra Analysis's ledger, or grouped from these filings until it answers), each with their whole history.
 */
export function insiderFilings(items: readonly RailItem[]): InsiderFiling[] {
  return items.filter((item): item is InsiderFiling => item.kind === "event" && item.event.class === "insider").sort((a, b) => b.date.localeCompare(a.date));
}

const isEarningsRow = (row: NoiseRow) => row.kind === "item" && (row.item.kind === "report"
  || (row.item.event.class === "earnings" && (row.item.event.items.includes("2.02") || !row.item.event.form.startsWith("8-K"))));

/**
 * The rail's order for a reading: the latest earnings filing (10-Q, 10-K or an 8-K under item 2.02) first, then the rest
 * newest first without the insider filings, which list through their people. Other readings keep plain date order.
 */
export function railLayout(items: readonly RailItem[], filter: EventFilter): { pinned: NoiseRow | null; insiders: InsiderFiling[]; rest: NoiseRow[]; items: readonly RailItem[] } {
  const insiders = INSIDERS_IN.has(filter) ? insiderFilings(items) : [];
  const held = new Set(insiders.map(item => item.id));
  // Matching runs over every filing (an insider row's importance reads the person's other trades); only the rows drop.
  const rows = noiseRows(items, filter).filter(row => row.kind !== "item" || !held.has(row.item.id));
  const pinned = PINNED_IN.has(filter) ? rows.find(isEarningsRow) ?? null : null;
  return { pinned, insiders, rest: rows.filter(row => row !== pinned), items };
}

/** Quarter ends this close are one quarter: a 52/53-week year ends its quarters on a weekday near the month's end. */
const SAME_QUARTER_DAYS = 10;

const sameQuarter = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= SAME_QUARTER_DAYS * DAY_MS;

/** A date `months` later (earlier when negative); a month's last day stays the last day. */
function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const to = new Date(Date.UTC(y, m - 1 + months, 1));
  const day = d === lastDay(y, m - 1) ? lastDay(to.getUTCFullYear(), to.getUTCMonth()) : Math.min(d, lastDay(to.getUTCFullYear(), to.getUTCMonth()));
  return new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), day)).toISOString().slice(0, 10);
}

const isEarningsRelease = (item: RailItem): item is RailItem & { kind: "event" } => item.kind === "event" && isEarningsRow({ kind: "item", id: item.id, date: item.date, item });

/**
 * The quarter an earnings release (an 8-K under item 2.02) reports: the latest quarter that ended before it was filed,
 * on the three-month grid of `anchor` (a known period end) and the periods of the reports listed. Null when another
 * release came out between that quarter's end and this one, or when nothing dates the quarters.
 */
export function releasedPeriod(release: RailItem, items: readonly RailItem[], anchor: string | null): string | null {
  const filed = release.date;
  const ends = items.flatMap(item => item.kind === "report" && item.report.periodEnd && item.report.periodEnd < filed ? [item.report.periodEnd] : []);
  if (anchor) {
    let step = 0;
    while (addMonths(anchor, 3 * step) >= filed && step > -400) step -= 1;
    while (addMonths(anchor, 3 * (step + 1)) < filed && step < 400) step += 1;
    ends.push(addMonths(anchor, 3 * step));
  }
  if (!ends.length) return null;
  const quarter = ends.reduce((a, b) => b > a ? b : a);
  const earlier = items.some(item => item.id !== release.id && isEarningsRelease(item) && item.date > quarter && item.date < filed);
  return earlier ? null : quarter;
}

/**
 * Whether a row is the filing a findings set was written from: a report of that period, or the earnings release that
 * reports that quarter. A release of any other quarter never carries them.
 */
export function reportsPeriod(row: NoiseRow, periodEnd: string | null, items: readonly RailItem[]): boolean {
  if (!periodEnd || row.kind !== "item") return false;
  const item = row.item;
  if (item.kind === "report") return item.report.periodEnd === periodEnd;
  if (!isEarningsRow(row)) return false;
  const quarter = releasedPeriod(item, items, periodEnd);
  return quarter != null && sameQuarter(quarter, periodEnd);
}

/** The readings that carry the report's findings beside its filings; the event-only readings leave them out. */
const FINDINGS_IN: ReadonlySet<EventFilter> = new Set<EventFilter>(["key", "earnings", "all"]);

export type StreamRow<F> = { kind: "noise"; id: string; date: string; row: NoiseRow } | { kind: "finding"; id: string; date: string; finding: F }
  | { kind: "person"; id: string; date: string; person: InsiderPersonSummary; items: InsiderFiling[] };

export const personRowId = (key: string) => `insider:${key}`;
/** The person a rail filing belongs to, by the ledger's own rule. */
const personKeyOf = (event: CompanyEvent): string | null => event.insider ? insiderPersonKey(event.insider) : null;

/**
 * The rail's rows in order: the latest earnings filing leads with its findings beneath it, then everything else newest
 * first, each insider at the date of their latest trade. Findings follow the filing of their quarter; when no row is that
 * filing they are left out, never put under another quarter's filing. A rail with no rows at all lists them alone.
 * `persons` are the people of the reading's insider filings; a reading without those lists none.
 */
export function streamRows<F extends { id: string }>(layout: ReturnType<typeof railLayout>, findings: readonly F[], periodEnd: string | null, filter: EventFilter, persons: readonly InsiderPersonSummary[] = []): StreamRow<F>[] {
  const rest: StreamRow<F>[] = layout.rest.map(row => ({ kind: "noise", id: row.id, date: row.date, row }));
  if (layout.insiders.length) {
    for (const person of persons) {
      const date = person.lastTradeAt ?? person.latest?.date ?? "";
      const row: StreamRow<F> = { kind: "person", id: personRowId(person.key), date, person, items: layout.insiders.filter(item => personKeyOf(item.event) === person.key) };
      // Before the first older row, so the rows already listed keep their order and a person follows rows of the same day.
      const at = rest.findIndex(r => r.date < date);
      rest.splice(at < 0 ? rest.length : at, 0, row);
    }
  }
  const rows: StreamRow<F>[] = layout.pinned ? [{ kind: "noise", id: layout.pinned.id, date: layout.pinned.date, row: layout.pinned }, ...rest] : rest;
  if (findings.length && FINDINGS_IN.has(filter)) {
    const at = rows.findIndex(row => row.kind === "noise" && reportsPeriod(row.row, periodEnd, layout.items));
    if (at >= 0 || !rows.length) {
      const date = at >= 0 ? rows[at]!.date : periodEnd ?? "";
      rows.splice(at + 1, 0, ...findings.map((finding): StreamRow<F> => ({ kind: "finding", id: finding.id, date, finding })));
    }
  }
  return rows;
}
