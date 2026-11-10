import type { LibraryPassage, LibraryTable } from "../../analysis-contract/filing-library.ts";
import type { DisclosureFact, FilingDisclosures } from "../financial-data/disclosure-extraction.ts";
import { libraryHash } from "./parse.ts";

/**
 * Fact rows (docs/filing-analysis-optimization.md §4.11): every number a filing shows, as one row with its period, unit
 * and place. A tagged number takes its value, period and unit from the Inline XBRL fact it shows; an untagged table cell
 * takes them from its table, and gets a row only when both can be told. Pure and deterministic: the same passages and
 * inventory give the same rows and ids.
 */
export const FACT_ROWS_VERSION = "fact-rows.v1";

export type FilingFactRow = {
  factId: string; passageId: string; sectionId: string; ordinal: number;
  /** The cell in the table as read with its repeated columns merged; null for a number inside a paragraph. */
  row: number | null; col: number | null;
  label: string; concept: string | null;
  /** "Axis=Member;…" in axis order; empty for the company as a whole. */
  dimensions: string;
  periodStart: string | null; periodEnd: string | null;
  /** 0 for a balance at a date, the months covered for a flow, null when the table does not say. */
  periodMonths: number | null;
  /** The number in base units (dollars, shares, a percentage as written). */
  value: number;
  /** The number as the filing prints it. */
  shown: string;
  unit: string;
  tagged: boolean;
};

export type MergedTable = {
  unit: string | null; columns: string[];
  /** The original columns each merged column was made from. */
  from: number[][];
  /** `source` is the row's place in the table as stored, which is what a fact reference names. */
  rows: Array<{ label: string; path: string[]; source: number; cells: Array<{ text: string; value: number | null }> }>;
  notes: string[];
};
const UNIT_TEXT = /^\(?(?:(?:dollars|amounts|shares|in)\b[^)]{0,80})?(?:thousands|millions|billions)[^)]{0,80}\)?$/i;

/**
 * A table with its repeated columns merged: a filing prints one period over two or three grid columns (a currency sign,
 * the number, a closing bracket), so the same heading repeats and each row's number sits in a different one.
 */
export function mergeTable(table: LibraryTable): MergedTable {
  // A row that only states the unit ("(dollars in thousands)" under each group of columns) is the table's unit, not data.
  const unitRow = (r: LibraryTable["rows"][number]) => !r.label && r.cells.some(c => c.text) && r.cells.every(c => !c.text || UNIT_TEXT.test(c.text.trim()));
  const kept = table.rows.map((r, source) => ({ r, source })).filter(({ r }) => !unitRow(r));
  const stated = table.rows.find(unitRow)?.cells.find(c => c.text)?.text.trim().replace(/^\(|\)$/g, "") ?? null;
  const groups: number[][] = [];
  table.columns.forEach((header, c) => {
    const group = groups.at(-1);
    const joins = group && header && table.columns[group[0]!] === header && kept.every(({ r }) => !r.cells[c]?.text || group.every(g => !r.cells[g]?.text));
    if (joins) group.push(c); else groups.push([c]);
  });
  return {
    unit: table.unit ?? stated, notes: table.notes, columns: groups.map(g => table.columns[g[0]!] ?? ""), from: groups,
    rows: kept.map(({ r, source }) => ({ label: r.label, path: r.path, source, cells: groups.map(g => { const at = g.find(c => r.cells[c]?.text); return at === undefined ? { text: "", value: null } : r.cells[at]!; }) })),
  };
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DATE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2}),?\s+((?:19|20)\d{2})\b/i;
const pad = (n: number) => String(n).padStart(2, "0");

/** The period a column heading names: its end date, and the months it covers when the heading says (0 for a date alone is not assumed). */
export function headingPeriod(heading: string): { end: string | null; months: number | null } {
  const date = DATE.exec(heading);
  const month = date ? MONTHS.findIndex(m => m.startsWith(date[1]!.toLowerCase().slice(0, 3))) : -1;
  const end = date && month >= 0 ? `${date[3]}-${pad(month + 1)}-${pad(Number(date[2]))}` : null;
  const months = /\b(?:three|3)\s+months|\bquarters?\s+ended|\b(?:13|thirteen)\s+weeks/i.test(heading) ? 3
    : /\b(?:six|6)\s+months|\b(?:26|twenty-six)\s+weeks/i.test(heading) ? 6
    : /\b(?:nine|9)\s+months|\b(?:39|thirty-nine)\s+weeks/i.test(heading) ? 9
    : /\b(?:twelve|12)\s+months|\b(?:fiscal\s+)?years?\s+ended|\b(?:52|53|fifty-two|fifty-three)\s+weeks/i.test(heading) ? 12
    : /\bas\s+of\b/i.test(heading) ? 0 : null;
  return { end, months };
}

const scaleOf = (unit: string | null) => !unit ? null : /billions/i.test(unit) ? 1e9 : /millions/i.test(unit) ? 1e6 : /thousands/i.test(unit) ? 1e3 : null;
const local = (name: string) => name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;
const unitOf = (fact: DisclosureFact): string => {
  const side = (names: Array<{ name: string }>) => names.map(n => local(n.name)).join("*");
  const numerator = fact.unit ? side(fact.unit.numerator) : "", denominator = fact.unit ? side(fact.unit.denominator) : "";
  const name = denominator ? `${numerator}/${denominator}` : numerator || local(fact.unitRef ?? "");
  return name === "pure" ? "ratio" : name || "number";
};
const monthsBetween = (start: string, end: string) => Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / (30.4375 * 86_400_000)));
const periodOf = (fact: DisclosureFact): Pick<FilingFactRow, "periodStart" | "periodEnd" | "periodMonths"> => {
  const period = fact.context?.period;
  if (!period || !period.end) return { periodStart: null, periodEnd: null, periodMonths: null };
  if (period.kind === "instant") return { periodStart: null, periodEnd: period.end.slice(0, 10), periodMonths: 0 };
  return { periodStart: period.start?.slice(0, 10) ?? null, periodEnd: period.end.slice(0, 10), periodMonths: period.start ? monthsBetween(period.start, period.end) : null };
};
const dimensionsOf = (fact: DisclosureFact) => (fact.context?.dimensions ?? []).map(d => `${local(d.axis.name)}=${d.member ? local(d.member.name) : d.value.trim().slice(0, 60)}`).sort().join(";");
const labelOf = (path: string[], label: string) => [...path, label].filter(Boolean).join(" › ");
const humanise = (concept: string) => local(concept).replace(/([a-z0-9])([A-Z])/g, "$1 $2");

/** The fact rows of one document's passages, given the document's Inline XBRL inventory (null for a document without one). */
export function buildFactRows(documentId: string, passages: LibraryPassage[], inventory: Pick<FilingDisclosures, "facts"> | null): FilingFactRow[] {
  const byOffset = new Map<number, DisclosureFact>();
  for (const fact of inventory?.facts ?? []) if (fact.kind === "numeric" && fact.numericValue !== null && !fact.nil && Number.isFinite(Number(fact.numericValue))) byOffset.set(fact.source.locator.start, fact);
  const out = new Map<string, FilingFactRow>();
  const add = (row: FilingFactRow) => { if (!out.has(row.factId)) out.set(row.factId, row); };
  const taggedId = (at: number) => `f${libraryHash(`${documentId}|${at}`).slice(0, 14)}`;
  // What a column heading means in this document, learned from the tagged tables: a later untagged table under the same heading covers the same period.
  const headings = new Map<string, { end: string; months: number | null; start: string | null }>();
  const tables = passages.filter(p => p.table).map(p => ({ passage: p, merged: mergeTable(p.table!) }));
  for (const { passage, merged } of tables) {
    const mergedOf = new Map<number, number>();
    merged.from.forEach((group, i) => group.forEach(c => mergedOf.set(c, i)));
    for (const ref of passage.factRefs) {
      const fact = byOffset.get(ref.at);
      if (!fact || ref.row === undefined || ref.col === undefined) continue;
      const col = mergedOf.get(ref.col);
      const period = periodOf(fact);
      if (col === undefined || !period.periodEnd) continue;
      const heading = merged.columns[col]!.toLowerCase();
      if (heading && !headings.has(heading)) headings.set(heading, { end: period.periodEnd, months: period.periodMonths, start: period.periodStart });
    }
  }
  for (const passage of passages) {
    const base = { passageId: passage.passageId, sectionId: passage.sectionId, ordinal: passage.ordinal };
    if (!passage.table) {
      for (const ref of passage.factRefs) {
        const fact = byOffset.get(ref.at);
        if (!fact) continue;
        add({ ...base, factId: taggedId(ref.at), row: null, col: null, label: humanise(fact.concept.name), concept: fact.concept.name, dimensions: dimensionsOf(fact), ...periodOf(fact),
          value: Number(fact.numericValue), shown: ref.start !== undefined && ref.end !== undefined ? passage.text.slice(ref.start, ref.end).trim().slice(0, 60) : fact.rawValue.trim().slice(0, 60), unit: unitOf(fact), tagged: true });
      }
      continue;
    }
    const merged = tables.find(t => t.passage === passage)!.merged;
    const mergedOf = new Map<number, number>();
    merged.from.forEach((group, i) => group.forEach(c => mergedOf.set(c, i)));
    const taggedCells = new Map<string, DisclosureFact & { at: number }>();
    for (const ref of passage.factRefs) {
      const fact = byOffset.get(ref.at);
      const col = ref.col === undefined ? undefined : mergedOf.get(ref.col);
      if (!fact || ref.row === undefined || col === undefined) continue;
      const key = `${ref.row}|${col}`;
      if (!taggedCells.has(key)) taggedCells.set(key, { ...fact, at: ref.at });
    }
    // The scale the table prints in, from its own heading or, failing that, from what its tagged cells are worth.
    let scale = scaleOf(merged.unit);
    if (scale === null) {
      const ratios = new Map<number, number>();
      for (const [key, fact] of taggedCells) {
        const [r, c] = key.split("|").map(Number) as [number, number];
        const cell = merged.rows.find(x => x.source === r)?.cells[c];
        if (!cell?.value || /%/.test(cell.text) || unitOf(fact) !== "USD") continue;
        const ratio = Math.abs(Number(fact.numericValue)) / Math.abs(cell.value);
        const power = [1, 1e3, 1e6, 1e9].find(p => Math.abs(ratio - p) / p < 0.01);
        if (power) ratios.set(power, (ratios.get(power) ?? 0) + 1);
      }
      scale = [...ratios].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    }
    const columnPeriods = merged.columns.map((heading, c) => {
      const tagged = [...taggedCells].find(([key]) => Number(key.split("|")[1]) === c)?.[1];
      if (tagged) { const p = periodOf(tagged); if (p.periodEnd) return p; }
      const known = headings.get(heading.toLowerCase());
      if (known) return { periodStart: known.start, periodEnd: known.end, periodMonths: known.months };
      const read = headingPeriod(heading);
      return { periodStart: null, periodEnd: read.end, periodMonths: read.months };
    });
    merged.rows.forEach((r, row) => r.cells.forEach((cell, col) => {
      if (!cell.text) return;
      const label = labelOf(r.path, r.label);
      const tagged = taggedCells.get(`${r.source}|${col}`);
      if (tagged) {
        add({ ...base, factId: taggedId(tagged.at), row, col, label, concept: tagged.concept.name, dimensions: dimensionsOf(tagged), ...periodOf(tagged), value: Number(tagged.numericValue), shown: cell.text, unit: unitOf(tagged), tagged: true });
        return;
      }
      if (cell.value === null) return;
      const period = columnPeriods[col]!;
      // An untagged cell is a fact only when its period and its unit can both be told.
      if (!period.periodEnd) return;
      const percent = /%/.test(cell.text) || /^(?:%|percent)/i.test(merged.columns[col] ?? "") || /\b(?:margin|percentage|% of)\b/i.test(r.label) && Math.abs(cell.value) <= 100 && !/[$€£¥]/.test(cell.text);
      const perShare = /per (?:common )?share/i.test(label);
      const shares = !perShare && /\bshares\b/i.test(label) && !/[$€£¥]/.test(cell.text);
      let unit: string, value: number;
      if (percent) { unit = "percent"; value = cell.value; }
      else if (perShare) { unit = "USD/shares"; value = cell.value; }
      else if (scale === null) return;
      else { unit = shares ? "shares" : "USD"; value = cell.value * scale; }
      add({ ...base, factId: `f${libraryHash(`${passage.passageId}|${row}|${col}`).slice(0, 14)}`, row, col, label, concept: null, dimensions: "", ...period, value, shown: cell.text, unit, tagged: false });
    }));
  }
  return [...out.values()];
}

const SCALES: Array<[number, string]> = [[1e9, "bn"], [1e6, "m"], [1e3, "k"]];
/** A fact's value as a reader would write it, for a table or a tool result. */
export function factText(row: Pick<FilingFactRow, "value" | "unit">): string {
  if (row.unit === "percent") return `${row.value}%`;
  if (row.unit === "ratio") return String(row.value);
  const abs = Math.abs(row.value);
  const scale = SCALES.find(([s]) => abs >= s);
  const number = scale ? `${(row.value / scale[0]).toFixed(abs / scale[0] >= 100 ? 1 : 2)}${scale[1]}` : String(row.value);
  return row.unit === "USD" ? `$${number}` : `${number} ${row.unit}`;
}
export const periodText = (row: Pick<FilingFactRow, "periodEnd" | "periodMonths">) => !row.periodEnd ? "period not stated"
  : row.periodMonths === 0 ? `at ${row.periodEnd}` : row.periodMonths === null ? `ending ${row.periodEnd}` : `${row.periodMonths} months to ${row.periodEnd}`;
