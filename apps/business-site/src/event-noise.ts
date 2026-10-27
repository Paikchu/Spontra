import type { CompanyEvent } from "@/shared/analysis-contract/events";
import { eventImportance, isPlannedSale } from "@/shared/analysis-runtime/events";
import { getLocale } from "@/packages/web/src/i18n";
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
export function matchesEventFilter(item: RailItem, filter: EventFilter, items: readonly RailItem[] = []): boolean {
  if (filter === "all") return true;
  if (item.kind === "report") {
    if (filter === "earnings") return true;
    if (filter !== "key") return false;
    return reportInKey(item, items);
  }
  const event = item.event;
  if (filter === "key") return eventImportance(event) === "key";
  if (filter === "earnings") return event.class === "earnings" || event.class === "guidance";
  if (filter === "insiders") return event.class === "insider";
  if (MATERIAL.has(event.class)) return true;
  return event.class === "other" && eventImportance(event) !== "routine";
}

export type NoiseRow =
  | { kind: "item"; id: string; date: string; item: RailItem }
  | { kind: "plan"; id: string; date: string; name: string; shares: number; items: RailItem[] }
  | { kind: "routine"; id: string; date: string; items: RailItem[] };

const ownerName = (event: CompanyEvent) => (event.insider?.ownerName ?? "").replace(/\s+/g, " ").trim();

/**
 * The filtered rail, with two folds applied on the way:
 * one person's 10b5-1 sales in the same month become one row (two or more filings), and
 * 6-Ks with no summary and no document title become one row per month.
 * Every other filing stays a row. The leaves of the result are exactly the filings the filter selected.
 */
export function noiseRows(items: readonly RailItem[], filter: EventFilter): NoiseRow[] {
  const picked = items.filter(item => matchesEventFilter(item, filter, items));
  const plans = new Map<string, RailItem[]>();
  const routines = new Map<string, RailItem[]>();
  for (const item of picked) {
    if (item.kind !== "event") continue;
    const event = item.event;
    if (isPlannedSale(event)) {
      const key = `${event.insider!.ownerCik}|${event.filedAt.slice(0, 7)}`;
      plans.set(key, [...(plans.get(key) ?? []), item]);
    } else if (event.form.startsWith("6-K") && eventImportance(event) === "routine") {
      const key = event.filedAt.slice(0, 7);
      routines.set(key, [...(routines.get(key) ?? []), item]);
    }
  }
  const emitted = new Set<string>();
  const rows: NoiseRow[] = [];
  for (const item of picked) {
    if (item.kind === "event" && isPlannedSale(item.event)) {
      const key = `${item.event.insider!.ownerCik}|${item.event.filedAt.slice(0, 7)}`;
      const group = plans.get(key) ?? [];
      if (group.length >= 2) {
        const id = `plan:${key}`;
        if (emitted.has(id)) continue;
        emitted.add(id);
        const shares = group.reduce((sum, entry) => sum + (entry.kind === "event" ? entry.event.insider!.sold!.shares : 0), 0);
        rows.push({ kind: "plan", id, date: group[0]!.date, name: ownerName(item.event), shares, items: group });
        continue;
      }
    }
    if (item.kind === "event" && item.event.form.startsWith("6-K") && eventImportance(item.event) === "routine") {
      const key = item.event.filedAt.slice(0, 7);
      const id = `routine:${key}`;
      if (emitted.has(id)) continue;
      emitted.add(id);
      const group = routines.get(key) ?? [];
      rows.push({ kind: "routine", id, date: group[0]!.date, items: group });
      continue;
    }
    rows.push({ kind: "item", id: item.id, date: item.date, item });
  }
  return rows;
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
