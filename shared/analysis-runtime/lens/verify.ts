import type { AnalysisFinding } from "../../analysis-contract/findings.ts";
import type { LensBlock, LensDocument } from "../../analysis-contract/lens.ts";
import type { CompiledChart } from "../../analysis-contract/lens-frame.ts";
import { evidenceCandidates, numberSupported, proseNumbers, type FindingData, type ResolvedEvidence } from "../findings.ts";
import { compileChart, type CompileOptions, type CompileResult } from "./compile.ts";

export type VerifiedLens = {
  document: LensDocument;
  /** Every chart left in the document, compiled against the data the page holds. */
  charts: Record<string, CompiledChart>;
  /** What was taken out and why; empty when the document reads whole. */
  reasons: string[];
};

/** Compiles each chart of a document once; a chart id maps to its result. */
export function compileDocument(doc: LensDocument, data: FindingData, periodEnd: string, options: CompileOptions = {}): Map<string, CompileResult> {
  const out = new Map<string, CompileResult>();
  for (const block of doc.rows.flatMap(r => r.cells.flat())) if (block.kind === "chart" && !out.has(block.chart.id)) out.set(block.chart.id, compileChart(block.chart, data, periodEnd, options));
  return out;
}

/**
 * The document as the page can stand behind it: a chart whose series no longer resolve is taken out
 * (the data was restated, or a quarter went missing), a paragraph stating a number the evidence does
 * not produce is taken out, and a row left empty closes up. Nothing is repaired. Null when nothing is
 * left to show, so the caller falls back to a document built from the evidence alone.
 */
export function verifyLensDocument(doc: LensDocument, finding: Pick<AnalysisFinding, "watch">, resolved: ResolvedEvidence[], data: FindingData, periodEnd: string, options: CompileOptions = {}): VerifiedLens | null {
  const reasons: string[] = [];
  const compiled = compileDocument(doc, data, periodEnd, options);
  const candidates = resolved.flatMap(evidenceCandidates);
  const charts: Record<string, CompiledChart> = {};
  const keep = (block: LensBlock): LensBlock | null => {
    if (block.kind === "chart") {
      const result = compiled.get(block.chart.id);
      if (!result?.chart) { reasons.push(`chart ${block.chart.id}: ${result?.errors.join("; ") ?? "not compiled"}`); return null; }
      charts[block.chart.id] = result.chart;
      return block;
    }
    if (block.kind === "prose") {
      const paragraphs = block.paragraphs.filter((p, i) => { const bad = proseNumbers(p.text).filter(n => !numberSupported(n, candidates)); if (bad.length) reasons.push(`prose paragraph ${i + 1}: number ${bad.join(", ")} unsupported`); return !bad.length; });
      return paragraphs.length ? { kind: "prose", paragraphs } : null;
    }
    if (block.kind === "watch" && !finding.watch) return null;
    return block;
  };
  const rows = doc.rows.map(r => ({ cells: r.cells.map(cell => cell.map(keep).filter((b): b is LensBlock => b != null)).filter(cell => cell.length) })).filter(r => r.cells.length);
  const kinds = new Set(rows.flatMap(r => r.cells.flat().map(c => c.kind)));
  if (!rows.length || !kinds.has("judgment")) return null;
  return { document: { rows }, charts, reasons };
}
