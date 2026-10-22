import type { LensDocument, LensPictureRender } from "../../analysis-contract/lens.ts";
import type { LensWarning } from "./audit.ts";
import type { CompileResult } from "./compile.ts";
import { htmlSummary } from "./html.ts";

/** One chart as text: every series, its values across the drawn periods, the scales, and what the annotations say. */
export function describeChart(id: string, result: CompileResult | undefined): string {
  if (!result) return `chart ${id}: not compiled`;
  if (!result.chart) return `chart ${id}: FAILED\n  ${result.errors.join("\n  ")}`;
  const c = result.chart;
  const lines = [`chart ${c.id} (${c.marks.map(m => m.type).join("+")}, ${c.aspect}${c.title ? `, "${c.title}"` : ""}): ${c.series.length - (c.periodNote ? 1 : 0)} series × ${c.periods.length} ${c.span} periods, ${c.periods[0]!.label} … ${c.periods.at(-1)!.label}`];
  for (const s of c.series) {
    const marks = s.id === c.periodNote ? "note under the periods" : c.marks.filter(m => m.series.includes(s.id)).map(m => m.type).join("/");
    lines.push(`  ${s.id} "${s.label}" [${marks}, ${s.axis}] ${s.text.map(t => t ?? "—").join(" → ")}`);
  }
  const axis = (side: "left" | "right") => { const a = c.axes[side]; return a ? `${side} axis ${a.unit}: ${a.ticks[0]!.label} … ${a.ticks.at(-1)!.label}${a.zero ? ", zero line" : ""}` : null; };
  lines.push(`  ${[axis("left"), axis("right")].filter(Boolean).join("; ")}`);
  if (c.subtitle) lines.push(`  subtitle "${c.subtitle}"`);
  const context = c.series.filter(s => s.id !== c.periodNote && !c.focus.series.includes(s.id)).map(s => s.id);
  lines.push(`  focus: ${c.focus.periods.map(i => c.periods[i]!.label).join(", ")} in colour with their figures${context.length ? `; ${context.join(", ")} drawn grey as context` : ""}; other periods muted`);
  for (const a of c.annotations) lines.push(`  annotation on ${a.series} at ${c.periods[a.period]!.label}: "${a.text}"`);
  for (const b of c.bands) lines.push(`  band ${c.periods[b.from]!.label} – ${c.periods[b.to]!.label}${b.label ? ` "${b.label}"` : ""}`);
  for (const n of result.notes) lines.push(`  note: ${n}`);
  return lines.join("\n");
}

/** The whole document as the harness reports it back: rows, charts, and every warning left. */
export function describeDocument(doc: LensDocument, compiled: Map<string, CompileResult>, warnings: LensWarning[], renders?: Map<string, LensPictureRender[]>): string {
  const lines: string[] = [];
  doc.rows.forEach((row, i) => lines.push(`row ${i + 1}${row.title ? ` "${row.title}"` : ""}: [${row.cells.map(cell => cell.map(c => c.kind === "chart" ? `chart ${c.chart.id}` : c.kind === "html" ? `html ${c.html.id}` : c.kind === "prose" ? `prose ×${c.paragraphs.length}` : c.kind === "quote" ? `quote ${c.materialId}` : c.kind === "table" ? `table(${c.table.columns}, ${c.table.rows.length} rows)` : c.kind).join(" + ")).join(" | ")}]`));
  for (const c of doc.rows.flatMap(r => r.cells.flat()).flatMap(c => c.kind === "chart" ? [c.chart] : [])) lines.push(describeChart(c.id, compiled.get(c.id)));
  for (const h of doc.rows.flatMap(r => r.cells.flat()).flatMap(c => c.kind === "html" ? [c.html] : [])) {
    lines.push(`html ${h.id} (${h.aspect}, "${h.title}"): ${htmlSummary(h.html)}`);
    // The browser's view, width by width; its problems are listed with the warnings below.
    for (const r of renders?.get(h.id) ?? []) lines.push("failed" in r ? `  drawn at ${r.width}px: not drawn (${r.failed})` : `  drawn at ${r.width}px: ${r.height}px tall, ${r.problems.length ? `${r.problems.length} problem${r.problems.length === 1 ? "" : "s"}` : "nothing overlaps or overflows"}${r.notes.length ? `; ${r.notes.join("; ")}` : ""}`);
  }
  const errors = warnings.filter(w => w.level === "error"), warns = warnings.filter(w => w.level === "warning");
  lines.push(errors.length ? `errors (${errors.length}):\n  ${errors.map(w => `${w.where}: ${w.message}`).join("\n  ")}` : "errors: none");
  lines.push(warns.length ? `warnings (${warns.length}):\n  ${warns.map(w => `${w.where}: ${w.message}`).join("\n  ")}` : "warnings: none");
  return lines.join("\n");
}
