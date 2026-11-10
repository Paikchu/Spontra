import type { FindingRef } from "../../../../shared/analysis-contract/findings.ts";
import { resolveEvidence, rpoBuckets, spanLabel, type FindingData, type ResolvedEvidence } from "../../../../shared/analysis-runtime/findings.ts";
import { formatDelta, formatResolved } from "../../../../shared/analysis-runtime/lens/format.ts";
import type { Ledger } from "./ledger.ts";

/** A reference the verifier can resolve, with how much history it has; what a chart or a stage scene may draw. */
export type CatalogueRow = { ref: FindingRef; label: string; latest: string; quarters: number; fiscalYears: number; yoy: boolean; qoq: boolean };
/** One of a finding's own figures, written the way prose may quote it. */
export type EvidenceRow = { ref: FindingRef; label: string; period: string; value: string; compare: string | null; change: string | null };

/** The catalogue from the ledger: one row per distinct reference, with how many spans it answers and whether its changes are known. */
export function seriesCatalogue(ledger: Ledger, data: FindingData, periodEnd: string): CatalogueRow[] {
  const rows = new Map<string, CatalogueRow>();
  for (const r of ledger.rows) {
    const key = JSON.stringify(r.ref);
    const row = rows.get(key) ?? { ref: r.ref, label: r.label, latest: r.value, quarters: 0, fiscalYears: 0, yoy: false, qoq: false };
    if (r.span === "quarter") row.quarters++; else row.fiscalYears++;
    if (r.periodEnd === ledger.periodEnd) { row.latest = r.value; row.label = r.label; }
    row.yoy ||= r.yoy != null; row.qoq ||= r.qoq != null;
    rows.set(key, row);
  }
  const rpo = data.capital?.quarters.find(q => Math.abs(Date.parse(q.periodEnd) - Date.parse(periodEnd)) <= 20 * 86_400_000)?.rpo;
  if (rpo) rpoBuckets(rpo).forEach((b, i) => {
    if (b.amount == null) return;
    const ref: FindingRef = { rpoBucket: i };
    const resolved = resolveEvidence(data, { ref, periodEnd, span: "quarter", compare: "yoy" }) ?? resolveEvidence(data, { ref, periodEnd, span: "quarter" });
    if (resolved) rows.set(JSON.stringify(ref), { ref, label: resolved.label, latest: formatResolved(resolved.current, ref), quarters: data.capital?.quarters.filter(q => q.rpo && rpoBuckets(q.rpo)[i]?.amount != null).length ?? 0, fiscalYears: 0, yoy: resolved.delta != null, qoq: false });
  });
  return [...rows.values()];
}

/** The figures a finding rests on, each with its comparison, as the page's evidence table writes them. */
export function evidenceRows(resolved: ResolvedEvidence[]): EvidenceRow[] {
  return resolved.map(r => ({
    ref: r.evidence.ref, label: r.label, period: spanLabel(r.current), value: formatResolved(r.current, r.evidence.ref),
    compare: r.compare ? `${r.compareLabel} ${formatResolved(r.compare, r.evidence.ref)}` : null,
    change: r.delta != null ? formatDelta(r.delta, r.current.unit, r.evidence.ref) : null,
  }));
}
