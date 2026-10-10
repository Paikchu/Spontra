import type { BusinessNarrative, CompanyNarrative, NarrativeCheck, NarrativeLink, NarrativeTie } from "@/shared/analysis-contract/business-narrative";
import { resolveEvidence, resolveRef, type FindingData, type FindingFundamentalSeries, type ResolvedEvidence, type ResolvedValue } from "@/shared/analysis-runtime/findings";
import type { PublicCapitalStructure } from "@/shared/analysis-contract/capital-structure";

/**
 * The narrative's figures are never written down: a check, a tie or a rail anchor names a statement
 * figure and the page resolves it against the data the stage already draws, at the quarter on
 * stage, falling back to the report the narrative was written from.
 */
export type ResolvedCheck = NarrativeCheck & { resolved: ResolvedEvidence | null };

function at<T>(periods: string[], resolve: (periodEnd: string) => T | null): T | null {
  for (const end of periods) { const value = resolve(end); if (value) return value; }
  return null;
}

export function resolveCheck(data: FindingData, check: NarrativeCheck, periods: string[]): ResolvedCheck {
  const ref = check.ref;
  if (!ref) return { ...check, resolved: null };
  return { ...check, resolved: at(periods, end => resolveEvidence(data, { ref, periodEnd: end, span: check.span ?? "quarter", compare: check.compare })) };
}

export function resolveTie(data: FindingData, tie: NarrativeTie, periods: string[]): ResolvedEvidence | null {
  return at(periods, end => resolveEvidence(data, { ref: tie.ref, periodEnd: end, span: tie.span, compare: tie.compare, label: tie.label }));
}

export function resolveAnchor(data: FindingData, anchor: NonNullable<BusinessNarrative["anchor"]>, periods: string[]): ResolvedValue | null {
  return at(periods, end => resolveRef(data, anchor.ref, end, anchor.span));
}

/** Every check in the document, the company's and each business's, by id; links cite across the two. */
export function checkIndex(narrative: CompanyNarrative): Map<string, NarrativeCheck> {
  return new Map([...narrative.checks, ...narrative.businesses.flatMap(b => b.checks)].map(c => [c.id, c]));
}

/** The checks a link names, in the link's order, skipping any the document no longer carries. */
export function linkChecks(link: NarrativeLink, index: Map<string, NarrativeCheck>): NarrativeCheck[] {
  return link.checkIds.flatMap(id => { const c = index.get(id); return c ? [c] : []; });
}

/** `2026-03-31` reads 2026.03, `2026-03` the same, `2025` as the year alone. */
export const milestoneDate = (date: string) => date.length >= 7 ? date.slice(0, 7).replace("-", ".") : date;

/**
 * Remaining performance obligations as a chartable series, read from each filing's capital projection
 * when the SEC fundamentals carry no series of their own; one point per quarter that disclosed a total.
 */
export function rpoSeriesFromCapital(capital: PublicCapitalStructure | null): FindingFundamentalSeries | null {
  const disclosed = (capital?.quarters ?? []).filter(q => q.rpo?.total);
  if (disclosed.length < 2) return null;
  const points = disclosed.map(q => ({ periodEnd: q.periodEnd, valueDecimal: q.rpo!.total, sourceAccession: q.rpo!.source.accession }));
  return { metricKey: "remaining_performance_obligation", label: "剩余履约义务", category: "balance_sheet", unitFamily: "currency", currency: disclosed[0].rpo!.currency, available: true, points };
}
