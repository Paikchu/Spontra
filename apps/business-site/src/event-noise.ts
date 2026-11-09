import type { CompanyEvent } from "@/shared/analysis-contract/events";
import { eventImportance } from "@/shared/analysis-runtime/events";
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
function readEventFilter(search: string): EventFilter {
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

const DAY_MS = 86_400_000;

/**
 * A periodic report belongs in Key when it has something to read, or when it is the only earnings row for that filing.
 * A 10-Q with nothing to read yet, filed within three days of an earnings release already in the
 * list, is the same news twice: it stays under Earnings and All, and Key keeps the release.
 */
function reportInKey(item: RailItem & { kind: "report" }, items: readonly RailItem[]): boolean {
  const report = item.report;
  if (report.headline.trim()) return true;
  const day = Date.parse(report.date);
  const besideRelease = items.some(other => other.kind === "event"
    && (other.event.class === "earnings" || other.event.class === "guidance")
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

/** The rows of a reading: routine 6-Ks fold by month; everything else, each Form 4 included, lists as itself at its date. */
function noiseRows(items: readonly RailItem[], filter: EventFilter): NoiseRow[] {
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

/** The filings a row stands for, in list order. */
export function rowLeaves(row: NoiseRow): RailItem[] {
  return row.kind === "item" ? [row.item] : row.items;
}

/** Share counts in the fold row use grouping digits (4,725), not the compact form the single rows use. */
export function exactShares(shares: number): string {
  return new Intl.NumberFormat(getLocale() === "zh-CN" ? "zh-CN" : "en-US", { maximumFractionDigits: 0 }).format(Math.round(shares));
}

const isEarningsRow = (row: NoiseRow) => row.kind === "item" && (row.item.kind === "report"
  || (row.item.event.class === "earnings" && (row.item.event.items.includes("2.02") || !row.item.event.form.startsWith("8-K"))));

/** The rail's order for a reading: every row newest first, reports and Form 4s included, each at its own date. */
export function railLayout(items: readonly RailItem[], filter: EventFilter): { rows: NoiseRow[]; items: readonly RailItem[] } {
  return { rows: noiseRows(items, filter), items };
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
function releasedPeriod(release: RailItem, items: readonly RailItem[], anchor: string | null): string | null {
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

/** The tabs over the rail's filings, under the findings. Either or both can be on; both are by default. */
export const RAIL_TABS = ["reports", "management"] as const;
export type RailTab = (typeof RAIL_TABS)[number];

/** Reads `?tabs=` (comma separated). Absent, empty or unknown values leave every tab on. */
export function readRailTabs(search: string): ReadonlySet<RailTab> {
  const raw = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("tabs") ?? "";
  const picked = raw.split(",").filter((tab): tab is RailTab => RAIL_TABS.includes(tab as RailTab));
  return new Set(picked.length ? picked : RAIL_TABS);
}

/** Writes the tabs into a query; the default, every tab on, leaves the parameter out. */
export function withRailTabs(search: string, tabs: ReadonlySet<RailTab>): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (RAIL_TABS.every(tab => tabs.has(tab))) params.delete("tabs");
  else params.set("tabs", RAIL_TABS.filter(tab => tabs.has(tab)).join(","));
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** Management: officer and director changes and every insider trade. Everything else filed is a report. */
const MANAGEMENT = new Set(["executive", "insider"]);
export const itemTab = (item: RailItem): RailTab => item.kind === "event" && MANAGEMENT.has(item.event.class) ? "management" : "reports";
const rowTab = (row: NoiseRow): RailTab => row.kind === "item" ? itemTab(row.item) : "reports";

export type StreamBlock =
  | { kind: "row"; id: string; row: NoiseRow }
  | { kind: "quarter"; id: string; periodEnd: string; rows: NoiseRow[] };

/** The quarter a row is about: a report's period, or the quarter an earnings release reports. */
function rowPeriod(row: NoiseRow, items: readonly RailItem[], anchor: string | null): string | null {
  if (row.kind !== "item") return null;
  const item = row.item;
  if (item.kind === "report") return item.report.periodEnd ?? null;
  return isEarningsRow(row) ? releasedPeriod(item, items, anchor) : null;
}

/**
 * The rows of the tabs that are on, with the filings about one fiscal quarter (its earnings release, its 10-Q or
 * 10-K) framed together. A frame stands where its newest row would; rows about no quarter keep their own place.
 * `known` is a quarter end that dates the releases; without it the latest listed report's period does.
 */
export function streamBlocks(rows: readonly NoiseRow[], tabs: ReadonlySet<RailTab>, items: readonly RailItem[], known: string | null = null): StreamBlock[] {
  const anchor = known ?? items.reduce<string | null>((latest, item) => item.kind === "report" && item.report.periodEnd && (!latest || item.report.periodEnd > latest) ? item.report.periodEnd : latest, null);
  const blocks: StreamBlock[] = [];
  const frames: Array<Extract<StreamBlock, { kind: "quarter" }>> = [];
  for (const row of rows) {
    if (!tabs.has(rowTab(row))) continue;
    const period = rowPeriod(row, items, anchor);
    if (!period) { blocks.push({ kind: "row", id: row.id, row }); continue; }
    let frame = frames.find(f => sameQuarter(f.periodEnd, period));
    if (!frame) {
      frame = { kind: "quarter", id: `quarter:${period}`, periodEnd: period, rows: [] };
      frames.push(frame);
      blocks.push(frame);
    }
    frame.rows.push(row);
  }
  return blocks;
}
