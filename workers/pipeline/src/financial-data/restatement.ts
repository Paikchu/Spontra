import type { BusinessFlowQuarter, FlowAmount, FlowMetric, PublicBusinessFlow } from '../../../../shared/analysis-contract/business-flow.ts';
import type { Fact } from './parser.ts';

/**
 * A restatement is what two filings disagree on: the same concept for the same period, reported with different values.
 * Nothing here reads the filing's wording ("reclassified", "recast"); a reclassification that moves no figure changes
 * nothing, and a figure that moved is found whatever the note says. Each finding names the newer and the older filing
 * and the concepts whose values the newer one changed.
 */
export type Restated = { newer: string; older: string; newerFiledAt: string; concepts: string[] };

const local = (concept: string) => concept.split(':').at(-1)!;

export function restatedConcepts(facts: Fact[]): Restated[] {
  const groups = new Map<string, Fact[]>();
  for (const f of facts) {
    if (f.operands || Object.keys(f.dimensions).length) continue;
    const key = [local(f.tag), f.start, f.end, f.currency].join('|');
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const found = new Map<string, Restated>();
  for (const group of groups.values()) {
    const byFiling = new Map<string, Fact>();
    for (const f of group) { const old = byFiling.get(f.source.accession); if (!old || f.precision > old.precision) byFiling.set(f.source.accession, f); }
    const filings = [...byFiling.values()].sort((a, b) => b.source.filedAt.localeCompare(a.source.filedAt));
    for (let i = 0; i < filings.length; i++) for (let j = i + 1; j < filings.length; j++) {
      const newer = filings[i], older = filings[j];
      if (newer.source.filedAt === older.source.filedAt) continue;
      const rounding = 10 ** -Math.min(newer.precision, older.precision);
      if (Math.abs(newer.value - older.value) <= Math.max(1, Number.isFinite(rounding) ? rounding * 1.5 : 1)) continue;
      const key = newer.source.accession + '|' + older.source.accession;
      const entry = found.get(key) ?? { newer: newer.source.accession, older: older.source.accession, newerFiledAt: newer.source.filedAt, concepts: [] };
      if (!entry.concepts.includes(local(newer.tag))) entry.concepts.push(local(newer.tag));
      found.set(key, entry);
    }
  }
  return [...found.values()];
}

const accessions = (q: BusinessFlowQuarter) => new Set(Object.values(q.figures).flatMap(a => a?.lineage?.map(l => l.accession) ?? []));
const filedAt = (q: BusinessFlowQuarter, accession: string) => q.sources.find(s => s.id === accession)?.publishedAt ?? '';

/**
 * Marks the previous quarter's lines that a later filing restated: their comparability key changes, so the page shows
 * no change for them, and the current quarter lists them so the publication gate accepts the pair. Lines no filing
 * changed keep comparing. The figures themselves stay as their own filing reported them.
 */
export function markBasisChanges(flow: PublicBusinessFlow, restated: Restated[] | undefined): PublicBusinessFlow {
  const [current, previous] = [...flow.quarters].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
  if (!current || !previous || !restated?.length) return flow;
  const older = accessions(previous), newer = accessions(current);
  const latestOlder = [...older].map(a => filedAt(previous, a)).sort().at(-1) ?? '';
  const concepts = new Set(restated.filter(r => older.has(r.older) && !older.has(r.newer) && (newer.has(r.newer) || r.newerFiledAt > latestOlder)).flatMap(r => r.concepts));
  if (!concepts.size) return flow;
  const by = [...newer].sort()[0] ?? 'later-filing';
  const touched = (a: FlowAmount | null | undefined) => !!a?.lineage?.some(l => older.has(l.accession) && concepts.has(local(l.concept)));
  const mark = <T extends FlowAmount | null>(a: T): T => a && touched(a) ? { ...a, comparabilityKey: `${a.comparabilityKey ?? 'reported'}|restated-by:${by}` } : a;
  const changed = (Object.keys(previous.figures) as FlowMetric[]).filter(k => touched(previous.figures[k]));
  if (!changed.length) return flow;
  const marked: BusinessFlowQuarter = {
    ...previous,
    figures: Object.fromEntries(Object.entries(previous.figures).map(([k, a]) => [k, mark(a ?? null)])) as BusinessFlowQuarter['figures'],
    ...(previous.expenseComponents ? { expenseComponents: previous.expenseComponents.map(c => ({ ...c, amount: mark(c.amount) })) } : {}),
    ...(previous.otherComponents ? { otherComponents: previous.otherComponents.map(c => ({ ...c, amount: mark(c.amount) })) } : {}),
    ...(previous.afterTaxComponents ? { afterTaxComponents: previous.afterTaxComponents.map(c => ({ ...c, amount: mark(c.amount) })) } : {}),
  };
  const basisChanges = [...new Set([...(current.basisChanges ?? []), ...changed])];
  return { ...flow, quarters: flow.quarters.map(q => q === previous ? marked : q === current ? { ...current, basisChanges } : q) };
}
