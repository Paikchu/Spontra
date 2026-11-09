import { z } from "zod";
import type { ValuationFact } from "../../../../shared/analysis-contract/valuation.ts";
import { edgarArchiveCik } from "../../../../shared/analysis-runtime/sec-sources.ts";
import { readStoredAudits, type DisclosureArchiveEnv } from "../financial-data/disclosure-audit.ts";

const source = z.object({ ticker: z.string(), accessionNumber: z.string(), documentUrl: z.string(), form: z.string(), reportDate: z.string(), filedAt: z.string() });
const qname = z.object({ name: z.string(), namespaceUri: z.string().nullable() });
const inventorySchema = z.object({ source, facts: z.array(z.object({
  id: z.string(), concept: qname, kind: z.string(), status: z.string(), numericValue: z.string().nullable(), decimals: z.string().nullable(),
  context: z.object({ entity: z.object({ identifier: z.string() }).nullable(), period: z.object({ kind: z.string(), start: z.string().nullable(), end: z.string().nullable() }), dimensions: z.array(z.unknown()) }).nullable(),
  unit: z.object({ numerator: z.array(qname), denominator: z.array(qname) }).nullable(), source,
})) });
const CONCEPTS = { operating: ["OperatingLeaseLiability", "OperatingLeaseLiabilityCurrent", "OperatingLeaseLiabilityNoncurrent"], finance: ["FinanceLeaseLiability", "FinanceLeaseLiabilityCurrent", "FinanceLeaseLiabilityNoncurrent"] } as const;
const local = (name: string) => name.split(":").at(-1)!;
export type FilingLeaseFacts = { facts: ValuationFact[]; unresolved: string[] };

/** A date-only filing date does not prove intraday availability; an already archived copy does. */
function availableAt(filedAt: string, researchAsOf: string, archivedAt?: string): boolean {
  const day = filedAt.slice(0, 10), cutoffDay = researchAsOf.slice(0, 10);
  return day < cutoffDay || (day === cutoffDay && (filedAt.includes("T") ? Date.parse(filedAt) <= Date.parse(researchAsOf) : !!archivedAt && Date.parse(archivedAt) <= Date.parse(researchAsOf)));
}

/** Consolidated instant facts from one filing, never an annual payment schedule or a mixture of filing versions. */
function filingLeaseFacts(value: unknown, query: { ticker: string; periodEnd: string; currency: string; researchAsOf: string; archivedAt?: string }): FilingLeaseFacts {
  const parsed = inventorySchema.safeParse(value);
  if (!parsed.success) return { facts: [], unresolved: [] };
  const inventory = parsed.data, src = inventory.source;
  const cik = edgarArchiveCik(src.documentUrl);
  if (src.ticker !== query.ticker || cik == null || !availableAt(src.filedAt, query.researchAsOf, query.archivedAt)) return { facts: [], unresolved: [] };
  const rows = inventory.facts.filter(f => f.kind === "numeric" && f.status === "parsed" && /^https?:\/\/(?:www\.)?fasb\.org\/us-gaap\//.test(f.concept.namespaceUri ?? "") && f.numericValue != null && f.context?.period.kind === "instant" && f.context.period.end === query.periodEnd && !f.context.dimensions.length
    && Number(f.context.entity?.identifier) === cik && f.unit?.denominator.length === 0 && f.unit.numerator.length === 1 && local(f.unit.numerator[0]!.name) === query.currency && f.unit.numerator[0]!.namespaceUri === "http://www.xbrl.org/2003/iso4217"
    && f.source.accessionNumber === src.accessionNumber && f.source.ticker === query.ticker && f.source.documentUrl === src.documentUrl && availableAt(f.source.filedAt, query.researchAsOf, query.archivedAt));
  const facts: ValuationFact[] = [], unresolved: string[] = [];
  for (const kind of ["operating", "finance"] as const) {
    const names = CONCEPTS[kind];
    const grouped = names.map(name => rows.filter(f => local(f.concept.name) === name));
    if (!grouped.some(g => g.length)) continue;
    const amounts = grouped.map(group => [...new Set(group.map(f => Number(f.numericValue)))]);
    if (amounts.some(a => a.length > 1 || a.some(v => !Number.isFinite(v) || v < 0))) throw new Error(`Conflicting or invalid ${kind}_leases facts in ${src.accessionNumber}`);
    const total = amounts[0]![0], current = amounts[1]![0], noncurrent = amounts[2]![0];
    if (total == null && (current == null || noncurrent == null)) { unresolved.push(`${kind}_leases: missing total or current/noncurrent pair in ${src.accessionNumber}`); continue; }
    const precision = (i: number) => Math.max(0, ...grouped[i]!.map(f => f.decimals && /^-?\d+$/.test(f.decimals) ? 0.5 * 10 ** -Number(f.decimals) : 0));
    if (total != null && current != null && noncurrent != null && Math.abs(total - current - noncurrent) > precision(0) + precision(1) + precision(2)) throw new Error(`${kind}_leases total conflicts with current + noncurrent in ${src.accessionNumber}`);
    const used = total != null ? grouped[0]! : [...grouped[1]!, ...grouped[2]!];
    facts.push({ id: `${kind}_leases`, label: `${kind === "operating" ? "Operating" : "Finance"} lease liabilities, complete disclosure`, value: total ?? current! + noncurrent!, unit: query.currency, currency: query.currency, periodType: "instant", periodStart: null, periodEnd: query.periodEnd,
      basis: total != null ? "reported" : "derived", formula: total != null ? null : `${names[1]} + ${names[2]}`, sourceRefs: [...new Set([src.accessionNumber, src.documentUrl, ...used.flatMap(f => [f.concept.name, f.id])])], rationale: `Consolidated lease disclosure filed ${src.filedAt}; total and current/noncurrent facts are read from one accession.` });
  }
  const op = facts.find(f => f.id === "operating_leases"), finance = facts.find(f => f.id === "finance_leases");
  if (op && finance) facts.push({ ...op, id: "leases", label: "Total operating and finance lease liabilities", value: op.value + finance.value, basis: "derived", formula: "operating_leases + finance_leases", sourceRefs: [...new Set([...op.sourceRefs, ...finance.sourceRefs])] });
  return { facts, unresolved };
}

/** Read the filing inventory already archived in R2; no SEC fetch and no writes or model calls. */
export async function readFilingLeaseFacts(env: DisclosureArchiveEnv, query: { ticker: string; periodEnd: string; currency: string; researchAsOf: string; preferredAccession?: string }): Promise<FilingLeaseFacts> {
  const audits = (await readStoredAudits(env.DB, query.ticker, query.periodEnd)).filter(a => /^(10-[QK]|20-F|40-F)(\/A)?$/.test(a.source.form) && a.periodEnds.includes(query.periodEnd) && availableAt(a.source.filedAt, query.researchAsOf, a.archivedAt));
  audits.sort((a, b) => Number(b.source.accessionNumber === query.preferredAccession) - Number(a.source.accessionNumber === query.preferredAccession) || b.source.filedAt.localeCompare(a.source.filedAt));
  for (const audit of audits.slice(0, 4)) {
    const object = await env.SEC_FILINGS.get(audit.inventoryKey);
    if (!object) continue;
    let inventory: unknown;
    try { inventory = JSON.parse(await object.text()); } catch { continue; }
    const result = filingLeaseFacts(inventory, { ...query, archivedAt: audit.archivedAt });
    if (result.facts.length || result.unresolved.length) return result;
  }
  return { facts: [], unresolved: [] };
}
