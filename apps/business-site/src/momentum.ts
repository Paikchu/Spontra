/**
 * Growth momentum (R26): how year-over-year growth has moved over the latest quarters. Two quarters of rising growth in a
 * row read as accelerating, two of falling growth as slowing, and growth turning from positive to negative as turned
 * negative, which takes precedence. Every quarter compared must be present and consecutive; a gap in the run, or a
 * year-ago base at or below zero, gives no tag rather than a guess.
 */

export type ValuePoint = { periodEnd: string; value: number | null };
export type YoyPoint = { periodEnd: string; yoy: number | null };
export type MomentumKind = "accelerating" | "slowing" | "turnedNegative";
/** The verdict and the quarters it reads, oldest first, for the tag's breakdown. */
export type Momentum = { kind: MomentumKind; points: YoyPoint[] };

const monthIndex = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
const monthEnd = (index: number) => new Date(Date.UTC(Math.floor(index / 12), index % 12 + 1, 0)).toISOString().slice(0, 10);
/** Below this, in percentage points, two growth rates are the same. */
const EPSILON = 0.05;

/**
 * Year-over-year growth per quarter, on consecutive quarterly positions from the oldest value to the newest (or to
 * `until`): a quarter the values lack is a gap, and so is any quarter whose year-ago base is missing or not positive.
 */
export function yoyPoints(values: ValuePoint[], until: string | null = null): YoyPoint[] {
  const known = values.filter(v => v.value != null && Number.isFinite(v.value) && (!until || monthIndex(v.periodEnd) <= monthIndex(until) + 1))
    .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  if (!known.length) return [];
  const first = monthIndex(known[0]!.periodEnd), last = monthIndex(known.at(-1)!.periodEnd);
  const slots: ValuePoint[] = [];
  for (let at = last; at >= first - 1; at -= 3) slots.unshift(known.find(v => Math.abs(monthIndex(v.periodEnd) - at) <= 1) ?? { periodEnd: monthEnd(at), value: null });
  return slots.map((slot, i) => {
    const base = slots[i - 4]?.value;
    return { periodEnd: slot.periodEnd, yoy: slot.value != null && base != null && base > 0 ? (slot.value / base - 1) * 100 : null };
  }).filter((_, i) => i >= 4);
}

export function growthMomentum(points: YoyPoint[]): Momentum | null {
  const shown = points.slice(-5);
  const [a, b, c] = points.slice(-3).map(p => p.yoy);
  if (b != null && c != null && b > 0 && c < 0) return { kind: "turnedNegative", points: shown };
  if (points.length < 3 || a == null || b == null || c == null) return null;
  if (b - a > EPSILON && c - b > EPSILON) return { kind: "accelerating", points: shown };
  if (a - b > EPSILON && b - c > EPSILON) return { kind: "slowing", points: shown };
  return null;
}

/** The momentum of a quarterly series at the quarter ending `until` (the latest when absent). */
export const momentumOf = (values: ValuePoint[], until: string | null = null) => growthMomentum(yoyPoints(values, until));
