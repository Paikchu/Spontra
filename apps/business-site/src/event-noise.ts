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
