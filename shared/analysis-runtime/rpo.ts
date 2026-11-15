import type { RpoBucket } from "../analysis-contract/capital-structure.ts";

type TimingBucket = Pick<RpoBucket, "start" | "months">;
export type RpoWindow<T extends TimingBucket> = {
  bucket: T;
  from: number;
  to: number | null;
  timingBasis: "reported_duration" | "next_start" | "unknown";
};

const monthIndex = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;

/** Recognition windows after the disclosure date; an unbounded final period stays unknown. */
export function resolveRpoWindows<T extends TimingBucket>({ asOf, buckets }: { asOf: string; buckets: readonly T[] }): RpoWindow<T>[] {
  const base = monthIndex(asOf);
  const ordered = buckets.map(bucket => ({ bucket, from: bucket.start ? Math.max(0, monthIndex(bucket.start) - base - 1) : 0 })).sort((a, b) => a.from - b.from);
  return ordered.map(({ bucket, from }, index): RpoWindow<T> => {
    if (bucket.months != null) return { bucket, from, to: from + bucket.months, timingBasis: "reported_duration" };
    const next = ordered[index + 1];
    return next && next.from > from
      ? { bucket, from, to: next.from, timingBasis: "next_start" }
      : { bucket, from, to: null, timingBasis: "unknown" };
  });
}
