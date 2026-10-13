import type { AnalysisFinding, FindingMaterial, FindingPassage } from "../../analysis-contract/findings.ts";
import type { LensBlock, LensDocument } from "../../analysis-contract/lens.ts";
import type { CompiledChart } from "../../analysis-contract/lens-frame.ts";
import { evidenceCandidates, numberSupported, proseNumbers, type FindingData, type ResolvedEvidence } from "../findings.ts";
import { compileChart, type CompileOptions, type CompileResult } from "./compile.ts";
import { compileTable, type CompiledTable } from "./table.ts";

/** A quotation the page can stand behind: the material it came from, the passage as served now, and where that passage sits. */
export type VerifiedQuote = { material: FindingMaterial; passage: FindingPassage };
export type VerifiedLens = {
  document: LensDocument;
  /** Every chart left in the document, compiled against the data the page holds. */
  charts: Record<string, CompiledChart>;
  /** Every table left, resolved; keyed by `tableKey` of its declaration. */
  tables: Record<string, CompiledTable>;
  /** Every quote left, by material id. */
  quotes: Record<string, VerifiedQuote>;
  /** What was taken out and why; empty when the document reads whole. */
  reasons: string[];
};

/** Letters and digits only, case-folded: how a quote is matched against its passage, so punctuation and spacing differences do not matter. */
/** A table's identity in the verified document: its declaration, which does not shift when blocks before it are dropped. */
export const tableKey = (table: unknown) => JSON.stringify(table);
export const compactText = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** A quote holds when its words appear, in order, in the passage the library serves for its material now. */
export function verifyQuote(materials: FindingMaterial[] | undefined, passages: FindingPassage[] | null | undefined, materialId: string, text: string): VerifiedQuote | null {
  const material = materials?.find(m => m.id === materialId);
  const passage = material?.passageId ? passages?.find(p => p.passageId === material.passageId) : undefined;
  if (!material || !passage) return null;
  return compactText(passage.text).includes(compactText(text)) ? { material, passage } : null;
}

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
export type VerifyContext = { ticker: string; materials?: FindingMaterial[]; record?: unknown[] };

export function verifyLensDocument(doc: LensDocument, finding: Pick<AnalysisFinding, "watch">, resolved: ResolvedEvidence[], data: FindingData, periodEnd: string, options: CompileOptions = {}, context: VerifyContext = { ticker: "" }): VerifiedLens | null {
  const reasons: string[] = [];
  const compiled = compileDocument(doc, data, periodEnd, options);
  const candidates = resolved.flatMap(evidenceCandidates);
  const charts: Record<string, CompiledChart> = {};
  const tables: Record<string, CompiledTable> = {};
  const quotes: Record<string, VerifiedQuote> = {};
  const keep = (block: LensBlock): LensBlock | null => {
    if (block.kind === "table") {
      const result = compileTable(block.table, data, context.ticker, periodEnd);
      if (!result.table) { reasons.push(`table ${block.table.title ?? block.table.columns}: ${result.errors.join("; ")}`); return null; }
      tables[tableKey(block.table)] = result.table;
      return block;
    }
    if (block.kind === "quote") {
      const verified = verifyQuote(context.materials, data.passages, block.materialId, block.text);
      if (!verified) { reasons.push(`quote ${block.materialId}: not found in the passage as served`); return null; }
      quotes[block.materialId] = verified;
      return block;
    }
    if (block.kind === "record" && !context.record?.length) return null;
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
  const rows = doc.rows.map(r => ({ ...(r.title ? { title: r.title } : {}), cells: r.cells.map(cell => cell.map(keep).filter((b): b is LensBlock => b != null)).filter(cell => cell.length) })).filter(r => r.cells.length);
  const kinds = new Set(rows.flatMap(r => r.cells.flat().map(c => c.kind)));
  if (!rows.length || !kinds.has("judgment")) return null;
  return { document: { rows }, charts, tables, quotes, reasons };
}
