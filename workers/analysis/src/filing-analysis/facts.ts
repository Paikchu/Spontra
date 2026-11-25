import { factText, periodText } from "../../../../shared/analysis-runtime/filing-facts.ts";
import type { FilingFactRow } from "../../../../shared/analysis-contract/filing-content.ts";
import { arithmeticNames, calculateTyped, type ArithmeticInput, type ComputationProvenance } from "../../../../shared/analysis-runtime/computed-units.ts";
export { arithmeticNames as namesIn, evaluateArithmetic as evaluate } from "../../../../shared/analysis-runtime/computed-units.ts";

export type StoredFact = FilingFactRow & { documentId: string };
export type FactQuery = { label?: string; anchor?: string; periodEnd?: string; months?: number };

/** A mixed financial/KPI table can carry a monetary header over a row counting entities.
 * Keep the frozen record intact and direct the reader to the printed cell for its count. */
export function countUnitConflict(f: FilingFactRow): string | null {
  if (f.tagged || !/^[A-Z]{3}(?:thousands|millions|billions)?$/.test(f.unit)) return null;
  const label=f.label.split(" > ").at(-1)!.replace(/\([^()]*\)/g, "").trim();
  if (!/^(?:(?:number of|total|paying|active|new|large|enterprise|registered|unique) )*(?:customers|users|subscribers|stores|locations|employees)$/i.test(label)) return null;
  return `${f.label} is a count. Its printed cell is "${f.shown}" in ${f.passageId}. The untagged fact inherited the table's currency; cite the printed cell and do not calculate with that currency value.`;
}

export const factLine = (f: StoredFact) => countUnitConflict(f) ?? `${f.factId} | ${f.label} | ${factText(f)} | ${periodText(f)}${f.dimensions ? ` | ${f.dimensions}` : ""}${f.tagged ? "" : " | untagged"} | printed "${f.shown}"`;
/** What a cited fact is checked against: the number and how the filing prints it. */
export const factSourceText = (f: StoredFact) => `${f.label}: ${f.value} ${f.unit}, ${periodText(f)}. Printed as ${f.shown}.`;

// --- Arithmetic --------------------------------------------------------------------------------------------------------

export type Computed = { id: string; label: string; formula: string; inputs: Record<string, number>; value: number; unit: string; provenance?: ComputationProvenance };
const sameNumber = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Number.EPSILON * 32 * Math.max(1, Math.abs(a), Math.abs(b));

/** Replay source units and every dependency. A legacy match receives only a receipt, never revised stored numbers. */
export function replayComputed(id: string, computed: Record<string, Computed>, source: (id: string) => ArithmeticInput | null, seen = new Set<string>()): Computed {
  if (seen.has(id)) throw new Error(`Recompute ${id}: cyclic calculation dependency`);
  const saved = computed[id]; if (!saved) throw new Error(`Missing saved computation ${id}`);
  const inputs: Record<string, ArithmeticInput> = {};
  for (const name of arithmeticNames(saved.formula)) {
    if (computed[name]) { const prior = replayComputed(name, computed, source, new Set([...seen, id])); inputs[name] = { value: prior.value, unit: prior.unit, kind: "computed" }; }
    else { const fact = source(name); if (!fact) throw new Error(`Recompute ${id}: ${name} has no typed original source in the pinned materials`); inputs[name] = fact; }
  }
  let replay: ReturnType<typeof calculateTyped>;
  try { replay = calculateTyped(saved.formula, inputs, saved.unit); }
  catch (error) { throw new Error(`Recompute ${id}: ${error instanceof Error ? error.message : String(error)}`); }
  if (!sameNumber(saved.value, replay.value)) throw new Error(`Recompute ${id}: saved ${saved.value} ${saved.unit} differs from typed source replay ${replay.value} ${saved.unit}; the stored calculation is unchanged`);
  const basis = saved.provenance?.inputValueBasis ?? "source_declared";
  const expected = basis === "base" ? replay.inputs : Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, input.value]));
  if (Object.keys(saved.inputs).length !== Object.keys(expected).length || Object.entries(expected).some(([name, value]) => !sameNumber(value, saved.inputs[name]!))) throw new Error(`Recompute ${id}: saved input numbers do not match their typed source/dependency lineage`);
  const receipt: ComputationProvenance = { ...replay.provenance, mode: saved.provenance?.mode ?? "legacy_reverified", inputValueBasis: basis };
  if (saved.provenance && JSON.stringify(saved.provenance) !== JSON.stringify(receipt)) throw new Error(`Recompute ${id}: saved unit provenance does not match deterministic source replay`);
  saved.provenance ??= receipt;
  return saved;
}
export const computedText = (c: Computed) => `${c.label}: ${c.value} ${c.unit}. Computed as ${c.formula} from ${Object.entries(c.inputs).map(([k, v]) => `${k} = ${v}`).join(", ")}.${c.provenance ? ` Typed unit replay: ${JSON.stringify(c.provenance)}.` : ""}`;
