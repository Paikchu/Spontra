import type { FindingWatch } from "../../analysis-contract/findings.ts";
import { LENS_LIMITS, type LensBlock, type LensDocument } from "../../analysis-contract/lens.ts";
import { numberSupported, proseNumbers } from "../findings.ts";
import { chartHeight, type CompileResult } from "./compile.ts";
import { htmlProblems } from "./html.ts";

export type LensWarning = { level: "error" | "warning"; where: string; message: string };
/** Cell widths the audit lays the document out at: a phone, a two-cell row on a laptop, a one-cell row on a wide screen. */
export const WIDTH_CLASSES = { narrow: 340, medium: 500, wide: 720 } as const;
/** The page's text metrics: 13px type at 1.65 line height, about 6.6px per character. */
const LINE = 21.5, CHAR = 6.6, PERIOD_LABEL_CHAR = 6.3, LEGEND_CHAR = 6.4;

export type AuditInput = {
  document: LensDocument;
  compiled: Map<string, CompileResult>;
  /** Numbers the finding's evidence can produce, for the paragraphs the agent adds. */
  candidates: number[];
  watch: FindingWatch | undefined;
  /** What `verifyLensDocument` took out of this document (quotes not found, tables that resolve nothing); each is an error. */
  verifyReasons?: string[];
  /** "html": charts must be html pictures, as the lens agent writes them; grammar charts are errors. Unset accepts both. */
  pictures?: "html";
};

function cellHeight(block: LensBlock, width: number, compiled: Map<string, CompileResult>, judgmentChars: number, figures: number): number | null {
  const prose = (chars: number) => Math.ceil(chars / (width / CHAR)) * LINE + 12;
  switch (block.kind) {
    case "judgment": return prose(judgmentChars);
    case "prose": return block.paragraphs.reduce((sum, p) => sum + prose(p.text.length), 0);
    case "chart": return compiled.get(block.chart.id)?.chart ? chartHeight(width, block.chart.aspect) + 18 : null;
    case "html": return chartHeight(width, block.html.aspect) + 18;
    case "figures": return figures * 44 + 16;
    case "watch": return 72;
    case "sources": return 48;
    case "quote": return prose(block.text.length) + 28;
    case "table": return block.table.rows.length * 30 + 44;
    case "record": return 96;
  }
}

/**
 * What the layout would look like, without drawing it: whether the document has the blocks a finding
 * needs, whether a chart's labels fit, and whether two cells of a row stand at very different heights.
 * Errors stop a document from being accepted; warnings are what the agent should fix before it finishes.
 */
export function auditDocument(input: AuditInput & { judgmentChars: number; figures: number }): LensWarning[] {
  const out: LensWarning[] = [];
  const error = (where: string, message: string) => out.push({ level: "error", where, message });
  const warn = (where: string, message: string) => out.push({ level: "warning", where, message });
  const blocks = input.document.rows.flatMap(r => r.cells.flat());
  const count = (kind: LensBlock["kind"]) => blocks.filter(b => b.kind === kind).length;
  if (count("judgment") !== 1) error("document", "exactly one judgment block is required");
  if (count("figures") !== 1) error("document", "exactly one figures block is required");
  if (count("sources") > 1) error("document", "at most one sources block");
  if (count("watch") > 1) error("document", "at most one watch block");
  if (input.watch && count("watch") === 0) error("document", "the finding has a watch item; add a watch block");
  if (!input.watch && count("watch") > 0) error("document", "the finding has no watch item; remove the watch block");
  const charts = blocks.flatMap(b => b.kind === "chart" ? [b.chart] : []);
  const pictures = blocks.flatMap(b => b.kind === "html" ? [b.html] : []);
  if (charts.length + pictures.length > LENS_LIMITS.charts) error("document", `at most ${LENS_LIMITS.charts} charts and html pictures together`);
  if (count("quote") > LENS_LIMITS.quotes) error("document", `at most ${LENS_LIMITS.quotes} quotes`);
  if (count("table") > LENS_LIMITS.tables) error("document", `at most ${LENS_LIMITS.tables} tables`);
  if (count("record") > 1) error("document", "at most one record block");
  for (const [i, w] of input.verifyReasons?.entries() ?? []) error(`verify ${i + 1}`, w);
  if (!charts.length && !pictures.length) warn("document", "no chart: a finding reads better with one");
  const chartIds = new Set<string>();
  for (const c of [...charts, ...pictures]) { if (chartIds.has(c.id)) error(`chart ${c.id}`, "chart id used twice"); chartIds.add(c.id); }
  for (const p of pictures) for (const problem of htmlProblems(p.html)) error(`html ${p.id}`, problem);
  if (input.pictures === "html") for (const c of charts) error(`chart ${c.id}`, "draw this chart as an html picture ({\"kind\":\"html\",...}); chart blocks are not accepted here");
  const seen = new Map<string, string>();
  for (const c of charts) {
    const key = JSON.stringify(c.series.map(s => [s.ref, s.transform ?? "value"]).sort());
    const other = seen.get(key);
    if (other) warn(`chart ${c.id}`, `draws the same series as chart ${other}`); else seen.set(key, c.id);
  }
  for (const c of charts) {
    const result = input.compiled.get(c.id);
    if (!result) { error(`chart ${c.id}`, "not compiled"); continue; }
    for (const e of result.errors) error(`chart ${c.id}`, e);
    for (const n of result.notes) warn(`chart ${c.id}`, n);
    const chart = result.chart;
    if (!chart) continue;
    const labelWidth = Math.max(...chart.periods.map(p => p.label.length)) * PERIOD_LABEL_CHAR + 10;
    const shown = chart.periodLabels === "sparse" ? Math.ceil(chart.periods.length / 2) : chart.periods.length;
    const collide = (Object.entries(WIDTH_CLASSES) as Array<[string, number]>).filter(([, w]) => shown * labelWidth > w - 16).map(([name]) => name);
    if (collide.length) warn(`chart ${c.id}`, `${shown} period labels collide at ${collide.join(", ")} width; ${chart.periodLabels === "sparse" ? "draw fewer periods" : 'set periodLabels "sparse" or draw fewer periods'}`);
    const bars = chart.marks.filter(m => m.type === "bar").reduce((n, m) => n + m.series.length, 0);
    if (bars * chart.periods.length > 40) warn(`chart ${c.id}`, `${bars} bar series over ${chart.periods.length} periods leaves each bar thin; stack them, draw fewer periods, or use a line`);
    if (chart.legend === "top") {
      const legend = chart.series.reduce((w, s) => w + s.label.length * LEGEND_CHAR + 24, 0);
      if (legend > WIDTH_CLASSES.medium) warn(`chart ${c.id}`, "the legend wraps to several lines at medium width; shorten series labels");
    }
    const lines = chart.marks.filter(m => m.type === "line" || m.type === "step").reduce((n, m) => n + m.series.length, 0);
    if (lines > 4) warn(`chart ${c.id}`, `${lines} lines are hard to tell apart; keep at most four`);
  }
  input.document.rows.forEach((row, i) => {
    for (const b of row.cells.flat()) if (b.kind === "table") {
      const columns = b.table.columns === "periods" ? (b.table.periods ?? (b.table.span === "quarter" ? 4 : 3)) : (b.table.peers?.length ?? 3) + 1;
      if (row.cells.length === 2 && columns > 4) warn(`row ${i + 1}`, `a table with ${columns} figure columns shares the row with another cell; give it a row of its own or draw fewer periods`);
      if (columns > 8) warn(`row ${i + 1}`, `a table with ${columns} figure columns is wider than the page; draw at most eight`);
    }
    if (row.cells.length === 2 && row.cells.every(c => c.some(b => b.kind === "chart" || b.kind === "html"))) warn(`row ${i + 1}`, "two charts side by side each get half the width; one chart per row reads larger");
    if (row.cells.length !== 2) return;
    const name = (cell: LensBlock[]) => cell.map(b => b.kind === "chart" ? `chart ${b.chart.id}` : b.kind === "html" ? `html ${b.html.id}` : b.kind).join(" + ");
    for (const [cls, width] of Object.entries(WIDTH_CLASSES) as Array<[string, number]>) {
      if (cls === "narrow") continue; // Cells stack on a phone.
      const heights = row.cells.map(cell => cell.reduce<number | null>((sum, b) => { const h = cellHeight(b, width, input.compiled, input.judgmentChars, input.figures); return sum == null || h == null ? null : sum + h; }, 0));
      if (heights.some(h => h == null)) continue;
      const [a, b] = heights as [number, number];
      const ratio = Math.max(a, b) / Math.max(1, Math.min(a, b));
      if (ratio > 1.7 && Math.abs(a - b) > 120) warn(`row ${i + 1}`, `${name(row.cells[0]!)} ≈ ${Math.round(a)}px beside ${name(row.cells[1]!)} ≈ ${Math.round(b)}px at ${cls} width; change the chart's aspect, stack another block in the shorter cell, or give the taller block its own row`);
    }
  });
  blocks.forEach((b, i) => {
    if (b.kind !== "prose") return;
    b.paragraphs.forEach((p, j) => {
      const bad = proseNumbers(p.text).filter(n => !numberSupported(n, input.candidates));
      if (bad.length) error(`prose block ${i + 1} paragraph ${j + 1}`, `number${bad.length > 1 ? "s" : ""} ${bad.join(", ")} not among the finding's evidence; quote only figures the evidence table shows`);
    });
  });
  return out;
}
