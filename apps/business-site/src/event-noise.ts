import type { CompanyEvent } from "@/shared/analysis-contract/events";
import { eventImportance, isEsppTransaction, isPlannedInsiderTrade, isOpenMarketInsiderTrade, INSIDER_FOLD_WINDOW_DAYS } from "@/shared/analysis-runtime/events";
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
  | { kind: "plan"; id: string; date: string; name: string; ownerCik: string; direction: "buy" | "sell"; shares: number; amount: number; planned: boolean; espp: boolean; items: RailItem[] }
  | { kind: "routine"; id: string; date: string; items: RailItem[] };

const ownerName = (event: CompanyEvent) => (event.insider?.ownerName ?? "").replace(/\s+/g, " ").trim();

/** Fold each owner's trades by direction into anchored 90-day clusters; routine 6-Ks stay monthly. */
export function noiseRows(items: readonly RailItem[], filter: EventFilter): NoiseRow[] {
  const allEvents = items.flatMap(item => item.kind === "event" ? [item.event] : []);
  const picked = items.filter(item => matchesEventFilter(item, filter, allEvents, items)).sort((a, b) => b.date.localeCompare(a.date));
  const clusters = new Map<string, Extract<NoiseRow, { kind: "plan" }>>();
  const hosts = new Map<RailItem, NoiseRow>();
  const routines = new Map<string, Extract<NoiseRow, { kind: "routine" }>>();
  for (const item of picked) {
    if (item.kind !== "event") continue;
    const event = item.event;
    const direction = isOpenMarketInsiderTrade(event);
    if (direction) {
      const insider = event.insider!;
      const ownerKey = insider.ownerCik || ownerName(event);
      const key = `${ownerKey}:${direction}`;
      let cluster = clusters.get(key);
      if (!cluster || Date.parse(cluster.date) - Date.parse(event.filedAt) > INSIDER_FOLD_WINDOW_DAYS * DAY_MS) {
        cluster = { kind: "plan", id: `plan:${key}:${event.filedAt}`, date: item.date, ownerCik: insider.ownerCik, name: ownerName(event), direction, shares: 0, amount: 0, planned: false, espp: false, items: [] };
        clusters.set(key, cluster);
      }
      cluster.items.push(item);
      cluster.shares += direction === "sell" ? insider.sold!.shares : insider.bought!.shares;
      cluster.amount += direction === "sell" ? insider.sold!.proceeds : insider.bought!.cost;
      cluster.planned ||= isPlannedInsiderTrade(event);
      cluster.espp ||= isEsppTransaction(event);
      hosts.set(item, cluster);
    } else if (event.form.startsWith("6-K") && eventImportance(event, allEvents) === "routine") {
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
    if (!host || (host.kind === "plan" && host.items.length < 2)) return [{ kind: "item", id: item.id, date: item.date, item } as NoiseRow];
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

/** The readings whose rail opens with the latest earnings filing and folds the last 90 days of insider trades into one card. */
const PINNED_IN: ReadonlySet<EventFilter> = new Set<EventFilter>(["key", "all"]);
export const INSIDER_SUMMARY_DAYS = 90;

/** One person's open-market trades in the summary window, netted: negative is net sold. */
export type InsiderPerson = { key: string; name: string; sold: number; bought: number; net: number; planned: boolean; trades: number };

/** The last 90 days of open-market insider trades as one card: totals, the people, and the per-person rows behind it. */
export type InsiderSummary = {
  id: "insider-summary"; date: string;
  sold: number; bought: number; net: number;
  /** Everyone who traded, largest net amount first. */
  people: InsiderPerson[];
  /** How many of them traded under a 10b5-1 plan. */
  planned: number;
  /** The rows the card expands to: each person's trades folded by direction, as the Insiders reading shows them. */
  rows: NoiseRow[];
  /** Every insider filing of the window, the trades and the rest; the rail lists none of them outside the card. */
  items: RailItem[];
};

const isEarningsRow = (row: NoiseRow) => row.kind === "item" && (row.item.kind === "report"
  || (row.item.event.class === "earnings" && (row.item.event.items.includes("2.02") || !row.item.event.form.startsWith("8-K"))));

/**
 * Summarizes the open-market insider trades filed in the 90 days up to `now`; null when there are none. The card holds
 * every insider filing of the window (grants and withheld shares too), so none of them lists beside it until it opens.
 */
export function insiderSummary(items: readonly RailItem[], now: Date, days = INSIDER_SUMMARY_DAYS): InsiderSummary | null {
  const since = new Date(now.getTime() - days * DAY_MS).toISOString().slice(0, 10);
  const filings = items.filter((item): item is RailItem & { kind: "event" } => item.kind === "event" && item.date >= since && item.event.class === "insider");
  const trades = filings.filter(item => isOpenMarketInsiderTrade(item.event) != null);
  if (!trades.length) return null;
  const people = new Map<string, InsiderPerson>();
  let sold = 0, bought = 0;
  for (const { event } of trades) {
    const insider = event.insider!;
    const key = insider.ownerCik || ownerName(event);
    const person = people.get(key) ?? { key, name: ownerName(event), sold: 0, bought: 0, net: 0, planned: false, trades: 0 };
    const out = isOpenMarketInsiderTrade(event) === "sell" ? insider.sold!.proceeds : 0;
    const into = isOpenMarketInsiderTrade(event) === "buy" ? insider.bought!.cost : 0;
    person.sold += out; person.bought += into; person.net = person.bought - person.sold; person.trades += 1;
    person.planned ||= isPlannedInsiderTrade(event);
    people.set(key, person);
    sold += out; bought += into;
  }
  const ranked = [...people.values()].sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || b.trades - a.trades || a.name.localeCompare(b.name));
  const sorted = [...filings].sort((a, b) => b.date.localeCompare(a.date));
  return {
    id: "insider-summary", date: sorted[0]!.date, sold, bought, net: bought - sold,
    people: ranked, planned: ranked.filter(p => p.planned).length,
    rows: noiseRows(sorted, "insiders"), items: sorted,
  };
}

/**
 * The rail's order for a reading: the latest earnings filing (10-Q, 10-K or an 8-K under item 2.02) first, then the
 * insider summary, then the rest newest first without the trades the summary holds. Other readings keep plain date order.
 */
export function railLayout(items: readonly RailItem[], filter: EventFilter, now: Date): { pinned: NoiseRow | null; summary: InsiderSummary | null; rest: NoiseRow[] } {
  if (!PINNED_IN.has(filter)) return { pinned: null, summary: null, rest: noiseRows(items, filter) };
  const summary = insiderSummary(items, now);
  const held = new Set(summary?.items.map(item => item.id));
  // Matching runs over every filing (an insider row's importance reads the person's other trades); only the rows drop.
  const rows = noiseRows(items, filter).flatMap(row => {
    if (row.kind === "item") return held.has(row.item.id) ? [] : [row];
    if (row.kind === "routine") return [row];
    const left = row.items.filter(item => !held.has(item.id));
    return left.length === row.items.length ? [row] : left.map((item): NoiseRow => ({ kind: "item", id: item.id, date: item.date, item }));
  });
  const pinned = rows.find(isEarningsRow) ?? null;
  return { pinned, summary, rest: rows.filter(row => row !== pinned) };
}

/** The longest an earnings release follows the end of the period it reports; the next period's release comes later. */
const RELEASE_LAG_DAYS = 100;

/**
 * Whether a row is the filing a findings set was written from: a report of that period, or an earnings release (an 8-K
 * under item 2.02) filed within 100 days after the period ended. The findings carry only their period, so the date decides.
 */
export function reportsPeriod(row: NoiseRow, periodEnd: string | null): boolean {
  if (!periodEnd || row.kind !== "item") return false;
  const item = row.item;
  if (item.kind === "report") return item.report.periodEnd === periodEnd;
  if (!isEarningsRow(row)) return false;
  const lag = Date.parse(item.date) - Date.parse(periodEnd);
  return lag > 0 && lag <= RELEASE_LAG_DAYS * DAY_MS;
}

/** The readings that carry the report's findings beside its filings; the event-only readings leave them out. */
const FINDINGS_IN: ReadonlySet<EventFilter> = new Set<EventFilter>(["key", "earnings", "all"]);

export type StreamRow<F> = { kind: "noise"; id: string; date: string; row: NoiseRow } | { kind: "finding"; id: string; date: string; finding: F }
  | { kind: "insiders"; id: string; date: string; summary: InsiderSummary };

/**
 * The rail's rows in order: the latest earnings filing leads with its findings beneath it, then the insider summary card,
 * then everything else newest first. Findings follow the filing they were written from; findings of a period whose
 * filing is not among the rows lead the list, below the pinned filing and the card.
 */
export function streamRows<F extends { id: string }>(layout: ReturnType<typeof railLayout>, findings: readonly F[], periodEnd: string | null, filter: EventFilter): StreamRow<F>[] {
  const noise = layout.pinned ? [layout.pinned, ...layout.rest] : layout.rest;
  const rows: StreamRow<F>[] = noise.map(row => ({ kind: "noise", id: row.id, date: row.date, row }));
  let lead = layout.pinned ? 1 : 0;
  if (layout.summary) rows.splice(lead++, 0, { kind: "insiders", id: layout.summary.id, date: layout.summary.date, summary: layout.summary });
  if (findings.length && FINDINGS_IN.has(filter)) {
    const at = noise.findIndex(row => reportsPeriod(row, periodEnd));
    const date = at >= 0 ? noise[at]!.date : periodEnd ?? "";
    // The card sits right after the pinned filing, so a later row's place in `rows` is one past its place in `noise`.
    const after = at < 0 ? (layout.pinned ? lead : 0) : at === 0 && layout.pinned ? 1 : at + 1 + (layout.summary ? 1 : 0);
    rows.splice(after, 0, ...findings.map((finding): StreamRow<F> => ({ kind: "finding", id: finding.id, date, finding })));
  }
  return rows;
}
