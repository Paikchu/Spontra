import type { LensDocument } from "../../analysis-contract/lens.ts";
import type { LensWarning } from "./audit.ts";
import type { CompileResult } from "./compile.ts";

/** One chart as text: every series, its values across the drawn periods, the scales, and what the annotations say. */
export function describeChart(id: string, result: CompileResult | undefined): string {
  if (!result) return `chart ${id}: not compiled`;
  if (!result.chart) return `chart ${id}: FAILED\n  ${result.errors.join("\n  ")}`;
  const c = result.chart;
  const lines = [`chart ${c.id} (${c.marks.map(m => m.type).join("+")}, ${c.aspect}${c.title ? `, "${c.title}"` : ""}): ${c.series.length} series × ${c.periods.length} ${c.span} periods, ${c.periods[0]!.label} … ${c.periods.at(-1)!.label}`];
  for (const s of c.series) {
    const marks = c.marks.filter(m => m.series.includes(s.id)).map(m => m.type).join("/");
    lines.push(`  ${s.id} "${s.label}" [${marks}, ${s.axis}] ${s.text.map(t => t ?? "—").join(" → ")}`);
  }
  const axis = (side: "left" | "right") => { const a = c.axes[side]; return a ? `${side} axis ${a.unit}: ${a.ticks[0]!.label} … ${a.ticks.at(-1)!.label}${a.zero ? ", zero line" : ""}` : null; };
  lines.push(`  ${[axis("left"), axis("right")].filter(Boolean).join("; ")}`);
  for (const a of c.annotations) lines.push(`  annotation on ${a.series} at ${c.periods[a.period]!.label}: "${a.text}"`);
  for (const b of c.bands) lines.push(`  band ${c.periods[b.from]!.label} – ${c.periods[b.to]!.label}${b.label ? ` "${b.label}"` : ""}`);
  for (const n of result.notes) lines.push(`  note: ${n}`);
  return lines.join("\n");
}

/** The whole document as the harness reports it back: rows, charts, and every warning left. */
export function describeDocument(doc: LensDocument, compiled: Map<string, CompileResult>, warnings: LensWarning[]): string {
  const lines: string[] = [];
  doc.rows.forEach((row, i) => lines.push(`row ${i + 1}: [${row.cells.map(cell => cell.map(c => c.kind === "chart" ? `chart ${c.chart.id}` : c.kind === "prose" ? `prose ×${c.paragraphs.length}` : c.kind).join(" + ")).join(" | ")}]`));
  for (const c of doc.rows.flatMap(r => r.cells.flat()).flatMap(c => c.kind === "chart" ? [c.chart] : [])) lines.push(describeChart(c.id, compiled.get(c.id)));
  const errors = warnings.filter(w => w.level === "error"), warns = warnings.filter(w => w.level === "warning");
  lines.push(errors.length ? `errors (${errors.length}):\n  ${errors.map(w => `${w.where}: ${w.message}`).join("\n  ")}` : "errors: none");
  lines.push(warns.length ? `warnings (${warns.length}):\n  ${warns.map(w => `${w.where}: ${w.message}`).join("\n  ")}` : "warnings: none");
  return lines.join("\n");
}
