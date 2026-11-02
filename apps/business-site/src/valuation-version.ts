import type { ValuationPublication } from "@/shared/analysis-contract/valuation";

/** The read of one older version: still loading, failed, or its report. It always names the version it is for. */
export type VersionRead = { id: string; phase: "loading" | "failed"; report: null } | { id: string; phase: "ready"; report: ValuationPublication };

/** What the panel shows under the picked version: a report, or the loading or failed state of that version's read. */
export type VersionView = { phase: "ready"; report: ValuationPublication | null } | { phase: "loading" | "failed" };

export const versionLoading = (id: string): VersionRead => ({ id, phase: "loading", report: null });
/** A finished read; no report means the version could not be read. */
export const versionSettled = (id: string, report: ValuationPublication | null): VersionRead => report ? { id, phase: "ready", report } : { id, phase: "failed", report: null };

/**
 * The current version shows the response's report. An older one shows only the read made for that same id, so a report never
 * appears under another version's label: until its own read settles it is loading, and a failed read stays failed.
 */
export function versionView(versionId: string | null, current: ValuationPublication | null, read: VersionRead | null): VersionView {
  if (!versionId || versionId === current?.versionId) return { phase: "ready", report: current };
  if (!read || read.id !== versionId) return { phase: "loading" };
  return read.phase === "ready" ? { phase: "ready", report: read.report } : { phase: read.phase };
}
