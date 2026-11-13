import { factText, periodText, type FilingFactRow } from "../../../../shared/analysis-runtime/filing-library/facts.ts";

export type StoredFact = FilingFactRow & { documentId: string };
export type FactQuery = { documents: string[]; label?: string; concept?: string; section?: string; periodEnd?: string; months?: number; limit?: number };

export const factLine = (f: StoredFact) => `${f.factId} | ${f.label} | ${factText(f)} | ${periodText(f)}${f.dimensions ? ` | ${f.dimensions}` : ""}${f.tagged ? "" : " | untagged"} | printed "${f.shown}"`;
/** What a cited fact is checked against: the number and how the filing prints it. */
export const factSourceText = (f: StoredFact) => `${f.label}: ${f.value} ${f.unit}, ${periodText(f)}. Printed as ${f.shown}.`;

// --- Arithmetic --------------------------------------------------------------------------------------------------------

export type Computed = { id: string; label: string; formula: string; inputs: Record<string, number>; value: number; unit: string };

type Token = { kind: "number"; value: number } | { kind: "name"; value: string } | { kind: "op"; value: string };
function tokens(formula: string): Token[] {
  const out: Token[] = [];
  const pattern = /\s*(?:(\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|([-+*/()]))/y;
  let at = 0;
  while (at < formula.length) {
    if (/^\s*$/.test(formula.slice(at))) break;
    pattern.lastIndex = at;
    const m = pattern.exec(formula);
    if (!m) throw new Error(`cannot read the formula at "${formula.slice(at, at + 12)}"`);
    out.push(m[1] !== undefined ? { kind: "number", value: Number(m[1]) } : m[2] !== undefined ? { kind: "name", value: m[2] } : { kind: "op", value: m[3]! });
    at = pattern.lastIndex;
  }
  return out;
}

/** Evaluates + − × ÷ and brackets over numbers and named values; nothing else is a formula. */
export function evaluate(formula: string, values: Record<string, number>): number {
  const list = tokens(formula);
  let at = 0;
  const peek = () => list[at];
  const primary = (): number => {
    const t = list[at++];
    if (!t) throw new Error("the formula ends early");
    if (t.kind === "number") return t.value;
    if (t.kind === "name") { const v = values[t.value]; if (v === undefined) throw new Error(`"${t.value}" is not a fact or result you have read`); return v; }
    if (t.value === "(") { const v = sum(); if (list[at++]?.value !== ")") throw new Error("a bracket is not closed"); return v; }
    if (t.value === "-") return -primary();
    if (t.value === "+") return primary();
    throw new Error(`"${t.value}" is out of place`);
  };
  const product = (): number => {
    let v = primary();
    for (let t = peek(); t?.kind === "op" && (t.value === "*" || t.value === "/"); t = peek()) { at++; const r = primary(); if (t.value === "/" && r === 0) throw new Error("division by zero"); v = t.value === "*" ? v * r : v / r; }
    return v;
  };
  const sum = (): number => {
    let v = product();
    for (let t = peek(); t?.kind === "op" && (t.value === "+" || t.value === "-"); t = peek()) { at++; const r = product(); v = t.value === "+" ? v + r : v - r; }
    return v;
  };
  const result = sum();
  if (at < list.length) throw new Error(`"${String(list[at]!.value)}" is out of place`);
  if (!Number.isFinite(result)) throw new Error("the result is not a number");
  return result;
}
export const namesIn = (formula: string) => [...new Set(tokens(formula).flatMap(t => t.kind === "name" ? [t.value] : []))];
export const computedText = (c: Computed) => `${c.label}: ${c.value} ${c.unit}. Computed as ${c.formula} from ${Object.entries(c.inputs).map(([k, v]) => `${k} = ${v}`).join(", ")}.`;
