export type TimelineCluster<T extends { id: string }> = { id: string; items: T[]; x: number };

/**
 * Points that sit within `gap` px of a cluster's first point share its marker.
 * Measuring from the anchor, not the previous point, keeps a dense run from swallowing the axis:
 * each cluster spans less than `gap`, and the next marker starts at least `gap` px further on.
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

/** Keep 12px date labels apart without hiding any event markers. */
export function readableTicks<T extends { at: number }>(ticks: T[], width: number): T[] {
  const visible: T[] = [];
  let previous = -Infinity;
  for (const tick of ticks) {
    const x = tick.at / 100 * width;
    if (x < 28 || x > width - 28 || x - previous < 64) continue;
    visible.push(tick);
    previous = x;
  }
  return visible;
}
