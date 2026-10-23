/** Query key for the timeline's multi-select. Absent means every type that the page has. */
export const TIMELINE_PARAM = "tl";

export function pointType(point: { kind: string; cls?: string }): string {
  return point.kind === "report" ? "report" : (point.cls || "other");
}

/** null is "all". An empty or unknown-only query is also all. */
export function readTimelineTypes(search: string): string[] | null {
  const raw = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get(TIMELINE_PARAM);
  if (!raw) return null;
  const types = [...new Set(raw.split(",").map(part => part.trim()).filter(Boolean))];
  return types.length ? types : null;
}

/** Drop types the current page does not have. A selection of every present type collapses back to all. */
export function narrowTypes(selected: string[] | null, present: readonly string[]): string[] | null {
  if (!selected) return null;
  const known = selected.filter(type => present.includes(type));
  if (!known.length || present.every(type => known.includes(type))) return null;
  return known;
}

export function timelineSearch(search: string, types: string[] | null): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (!types?.length) params.delete(TIMELINE_PARAM);
  else params.set(TIMELINE_PARAM, types.join(","));
  const query = params.toString();
  return query ? `?${query}` : "";
}

export type TimelineCluster<T extends { id: string }> = { id: string; items: T[]; x: number };

/**
 * Points that sit within `gap` px of a cluster's first point share its marker.
 * Measuring from the anchor, not the previous point, keeps a dense run from swallowing the axis:
 * each cluster spans less than `gap`, and the next marker starts at least `gap` px further on,
 * so the hit targets (the same size as `gap`) do not cover each other.
 */
export function clusterByGap<T extends { id: string }>(items: readonly T[], xOf: (item: T) => number, gap: number): TimelineCluster<T>[] {
  const sorted = [...items].sort((a, b) => xOf(a) - xOf(b) || a.id.localeCompare(b.id));
  const out: Array<TimelineCluster<T> & { anchor: number }> = [];
  for (const item of sorted) {
    const x = xOf(item);
    const last = out.at(-1);
    if (last && x - last.anchor < gap) {
      last.items.push(item);
      last.id = last.items.map(entry => entry.id).join("\n");
    } else out.push({ id: item.id, items: [item], x, anchor: x });
  }
  return out;
}
