import { factText, mergeTable, periodText, type FilingFactRow } from "../../../../shared/analysis-runtime/filing-library/facts.ts";
import type { LibraryPassageView } from "../../../../shared/analysis-contract/filing-library.ts";

/**
 * Reading numbers (docs/filing-analysis-optimization.md §4.11): the fact rows the library wrote when it prepared a
 * document, looked up by id, by what they are, and through the company's earlier filings; and the arithmetic over them,
 * done by code so a derived figure can be checked.
 */
type Row = { fact_id: string; document_id: string; passage_id: string; section_id: string; ordinal: number; row_index: number | null; col_index: number | null; label: string; concept: string | null;
  dimensions: string; period_start: string | null; period_end: string | null; period_months: number | null; value: number; shown: string; unit: string; tagged: number };
export type StoredFact = FilingFactRow & { documentId: string };
const COLUMNS = "fact_id, document_id, passage_id, section_id, ordinal, row_index, col_index, label, concept, dimensions, period_start, period_end, period_months, value, shown, unit, tagged";
const factOf = (r: Row): StoredFact => ({ factId: r.fact_id, documentId: r.document_id, passageId: r.passage_id, sectionId: r.section_id, ordinal: r.ordinal, row: r.row_index, col: r.col_index, label: r.label,
  concept: r.concept, dimensions: r.dimensions, periodStart: r.period_start, periodEnd: r.period_end, periodMonths: r.period_months, value: r.value, shown: r.shown, unit: r.unit, tagged: !!r.tagged });

export async function factsById(db: D1Database, ids: string[]): Promise<StoredFact[]> {
  if (!ids.length) return [];
  const rows = await db.prepare(`SELECT ${COLUMNS} FROM sec_fact_rows WHERE fact_id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)).all<Row>();
  // The same number tagged in two documents of one filing keeps one id per document; the first is enough to read it.
  const seen = new Set<string>();
  return rows.results.map(factOf).filter(f => !seen.has(f.factId) && seen.add(f.factId));
}

export async function factsOfPassages(db: D1Database, passageIds: string[]): Promise<Map<string, StoredFact[]>> {
  const out = new Map<string, StoredFact[]>();
  if (!passageIds.length) return out;
  const rows = await db.prepare(`SELECT ${COLUMNS} FROM sec_fact_rows WHERE passage_id IN (SELECT value FROM json_each(?)) ORDER BY ordinal, row_index, col_index`).bind(JSON.stringify(passageIds)).all<Row>();
  for (const r of rows.results) out.set(r.passage_id, [...out.get(r.passage_id) ?? [], factOf(r)]);
  return out;
}

export type FactQuery = { documents: string[]; label?: string; concept?: string; section?: string; periodEnd?: string; months?: number; limit?: number };
export async function queryFacts(db: D1Database, q: FactQuery): Promise<StoredFact[]> {
  if (!q.documents.length) return [];
  const where = ["document_id IN (SELECT value FROM json_each(?1))"], binds: unknown[] = [JSON.stringify(q.documents)];
  const add = (sql: string, value: unknown) => { binds.push(value); where.push(sql.replace("?", `?${binds.length}`)); };
  if (q.label) for (const word of q.label.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5)) add("instr(lower(label || ' ' || COALESCE(concept, '')), ?) > 0", word);
  if (q.concept) add("lower(concept) = ?", q.concept.toLowerCase());
  if (q.section) add("section_id = ?", q.section);
  if (q.periodEnd) add("period_end = ?", q.periodEnd);
  if (q.months !== undefined) add("period_months = ?", q.months);
  const rows = await db.prepare(`SELECT ${COLUMNS} FROM sec_fact_rows WHERE ${where.join(" AND ")} ORDER BY ordinal, row_index, col_index LIMIT ${Math.min(120, Math.max(1, q.limit ?? 60))}`).bind(...binds).all<Row>();
  return rows.results.map(factOf);
}

/**
 * The same thing in earlier periods: the tagged facts of the company's filings under the same concept, breakdown and
 * period length, one per period end, each from the filing that last reported it (a restated figure wins).
 */
export async function factHistory(db: D1Database, ticker: string, fact: StoredFact, periods: number): Promise<Array<StoredFact & { form: string; filedAt: string }>> {
  if (!fact.concept || fact.periodMonths === null) return [];
  const rows = await db.prepare(`SELECT ${COLUMNS.split(", ").map(c => `f.${c}`).join(", ")}, d.form, d.filed_at FROM sec_fact_rows f JOIN sec_documents d ON d.document_id = f.document_id
    WHERE f.ticker = ? AND f.concept = ? AND f.dimensions = ? AND f.period_months = ? AND f.tagged = 1 AND f.period_end <= ? ORDER BY f.period_end DESC, d.filed_at DESC LIMIT 400`)
    .bind(ticker, fact.concept, fact.dimensions, fact.periodMonths, fact.periodEnd ?? "9999").all<Row & { form: string; filed_at: string }>();
  const seen = new Set<string>();
  const out: Array<StoredFact & { form: string; filedAt: string }> = [];
  for (const r of rows.results) {
    if (!r.period_end || seen.has(r.period_end)) continue;
    seen.add(r.period_end);
    out.push({ ...factOf(r), form: r.form, filedAt: r.filed_at });
    if (out.length >= periods) break;
  }
  return out;
}

export const factLine = (f: StoredFact) => `${f.factId} | ${f.label} | ${factText(f)} | ${periodText(f)}${f.dimensions ? ` | ${f.dimensions}` : ""}${f.tagged ? "" : " | untagged"} | printed "${f.shown}"`;
/** What a cited fact is checked against: the number and how the filing prints it. */
export const factSourceText = (f: StoredFact) => `${f.label}: ${f.value} ${f.unit}, ${periodText(f)}. Printed as ${f.shown}.`;

/** A passage as the session reads it: its number in the document, and for a table its merged columns with each cell's fact id. */
export function renderPassage(p: LibraryPassageView, facts: StoredFact[]): string {
  const mark = `¶${p.ordinal}`;
  if (!p.table) {
    const tagged = facts.filter(f => f.row === null);
    return `${mark} ${p.text}${tagged.length ? `\n   facts: ${tagged.map(f => `${f.factId} = ${f.shown} (${f.label}, ${periodText(f)})`).join("; ")}` : ""}`;
  }
  const merged = mergeTable(p.table);
  const cell = new Map(facts.filter(f => f.row !== null).map(f => [`${f.row}|${f.col}`, f]));
  const periodOf = (c: number) => { const f = facts.find(x => x.col === c && x.periodEnd); return f ? periodText(f) : ""; };
  const head = merged.columns.map((heading, c) => `(${c + 1}) ${heading || "(blank)"}${periodOf(c) ? ` [${periodOf(c)}]` : ""}`).join(" | ");
  const lines = merged.rows.map((r, row) => `${[...r.path, r.label].filter(Boolean).join(" › ") || "(no label)"} | ${r.cells.map((x, c) => { const f = cell.get(`${row}|${c}`); return x.text ? `${x.text}${f ? ` ${f.factId}` : ""}` : "—"; }).join(" | ")}`);
  return `${mark} [table${merged.unit ? `, ${merged.unit}` : ", unit not stated"}] columns: ${head}\n${lines.join("\n")}${merged.notes.length ? `\n${merged.notes.map(n => `note: ${n}`).join("\n")}` : ""}`;
}

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
