import type { FindingRef, FindingSpan, PeerBaseRef } from "../../analysis-contract/findings.ts";
import type { LensTable } from "../../analysis-contract/lens.ts";
import { refLabel, resolveEvidence, resolveRef, type FindingData } from "../findings.ts";
import { chartPeriods } from "./compile.ts";
import type { Locale } from "../locale.ts";
import { formatDelta, formatResolved, periodLabel } from "./format.ts";

/** A table with every figure resolved and written; rows and columns that nothing answers are gone. */
export type CompiledTable = {
  title: string | null;
  columns: Array<{ key: string; label: string; sub: string | null }>;
  rows: Array<{ label: string; cells: Array<{ text: string; change: string | null } | null> }>;
  /** Tickers (peers table) or periods (periods table) that were asked for but had nothing to show. */
  dropped: string[];
};
export type TableResult = { table: CompiledTable | null; errors: string[]; dropped: string[] };

/** Peers of the company: those sharing an industry category with it, as the projection lists them. */
export function peersOf(data: FindingData, ticker: string): string[] {
  const companies = data.peers?.companies ?? [];
  const mine = new Set(companies.find(c => c.ticker === ticker)?.categories ?? []);
  return companies.filter(c => c.ticker !== ticker && c.categories.some(cat => mine.has(cat))).map(c => c.ticker);
}

const ownRef = (ref: FindingRef | PeerBaseRef): FindingRef => ref as FindingRef;

/**
 * Resolves a table at the finding's report. A periods table reads each row at the latest periods; a peers
 * table reads each row for the company and for each peer at that peer's aligned period. A row with no cell is
 * left out; a peers table needs two peer columns with a figure, a periods table one row.
 */
export function compileTable(spec: LensTable, data: FindingData, ticker: string, periodEnd: string, locale: Locale = "en"): TableResult {
  const errors: string[] = [];
  const dropped: string[] = [];
  const cell = (ref: FindingRef, end: string, compare?: "yoy" | "qoq") => {
    const r = compare ? resolveEvidence(data, { ref, periodEnd: end, span: spec.span, compare }) : null;
    const v = r?.current ?? resolveRef(data, ref, end, spec.span);
    return v ? { text: formatResolved(v, ref, locale), change: r && r.delta != null ? formatDelta(r.delta, r.current.unit, ref, locale) : null } : null;
  };
  if (spec.columns === "periods") {
    const ends = chartPeriods(periodEnd, spec.span, spec.periods ?? (spec.span === "quarter" ? 4 : 3));
    // A table cell read from a filing passage is one figure as filed; it sits in the newest column only.
    const rows = spec.rows.map(row => ({ label: row.label ?? refLabel(data, ownRef(row.ref), locale), cells: ends.map((end, i) => "passageCell" in row.ref && i < ends.length - 1 ? null : cell(ownRef(row.ref), end, row.compare)) })).filter(r => r.cells.some(c => c));
    for (const row of spec.rows) if (!rows.some(r => r.label === (row.label ?? refLabel(data, ownRef(row.ref), locale)))) errors.push(`row ${refLabel(data, ownRef(row.ref))} resolves at none of the periods`);
    if (!rows.length) return { table: null, errors: ["no row resolves"], dropped };
    // Leading periods no row answers are left out, as a chart does.
    const lead = ends.findIndex((_, i) => rows.some(r => r.cells[i]));
    const columns = ends.slice(lead).map(end => ({ key: end, label: periodLabel(end, spec.span, locale), sub: null }));
    return { table: { title: spec.title ?? null, columns, rows: rows.map(r => ({ ...r, cells: r.cells.slice(lead) })), dropped }, errors, dropped };
  }
  const peers = (spec.peers?.length ? spec.peers : peersOf(data, ticker)).filter(t => t !== ticker);
  if (!peers.length) return { table: null, errors: ["no tracked peer shares a category with the company"], dropped };
  const tickers = [ticker, ...peers];
  const rows = spec.rows.map(row => ({
    label: row.label ?? refLabel(data, ownRef(row.ref), locale),
    cells: tickers.map(t => t === ticker ? cell(ownRef(row.ref), periodEnd, row.compare) : ("capital" in row.ref || "metric" in row.ref || "fundamental" in row.ref) ? cell({ peer: { ticker: t, ref: row.ref } }, periodEnd, row.compare) : null),
  })).filter(r => r.cells.some(c => c));
  if (!rows.length) return { table: null, errors: ["no row resolves for the company or any peer"], dropped };
  // Columns with nothing to show are dropped; fewer than two peers left means the comparison is not one.
  const keep = tickers.map((t, i) => rows.some(r => r.cells[i]) ? i : -1).filter(i => i >= 0);
  dropped.push(...tickers.filter((_, i) => !keep.includes(i)));
  const peerColumns = keep.filter(i => i > 0);
  if (peerColumns.length < 2) return { table: null, errors: [`only ${peerColumns.length} peer${peerColumns.length === 1 ? "" : "s"} with a figure (${tickers.slice(1).join(", ")} asked); a peers table needs two`], dropped };
  const columns = keep.map(i => { const t = tickers[i]!; const company = data.peers?.companies.find(c => c.ticker === t); const end = i === 0 ? periodEnd : company?.quarters.find(q => q.periodEnd <= periodEnd)?.periodEnd ?? null; return { key: t, label: t, sub: end ? periodLabel(end, "quarter").replace("FY to ", "") : null }; });
  return { table: { title: spec.title ?? null, columns, rows: rows.map(r => ({ ...r, cells: keep.map(i => r.cells[i] ?? null) })), dropped }, errors, dropped };
}

export const spanOf = (span: FindingSpan) => span === "quarter" ? "quarter" : "four quarters";
