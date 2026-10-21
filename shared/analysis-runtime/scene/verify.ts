import type { FindingMaterial } from "../../analysis-contract/findings.ts";
import type { CompiledChart } from "../../analysis-contract/lens-frame.ts";
import { SCENE_LIMITS, type SceneBlock, type SceneDocument, type SceneRow } from "../../analysis-contract/scene.ts";
import { numberSupported, proseNumbers, resolveRef, type FindingData, type VerifiedFinding } from "../findings.ts";
import { compileChart, type CompileOptions } from "../lens/compile.ts";
import { describeChart } from "../lens/describe.ts";
import { verifyLensDocument, type VerifiedLens } from "../lens/verify.ts";

/**
 * What a scene is checked against: the data the page draws, the findings as verified against that data, and the
 * numbers the turn's reads produced. The server and the page build it from the same publication, so both keep and
 * drop the same blocks.
 */
export type SceneContext = {
  ticker: string;
  data: FindingData;
  findings: VerifiedFinding[];
  /** Numbers a paragraph may state: what the turn's reads resolved. Empty on the page, which trusts the server's check. */
  candidates: number[] | null;
  materials?: FindingMaterial[];
  options?: CompileOptions;
};

export type VerifiedScene = {
  rows: SceneRow[];
  /** Standalone charts, compiled, by block id. */
  charts: Record<string, CompiledChart>;
  /** Lens blocks as the finding page would show them, by block id. */
  lenses: Record<string, VerifiedLens>;
  /** What was taken out and why. */
  reasons: string[];
};

/**
 * The scene as the page can stand behind it: a block whose references no longer resolve, a paragraph stating a number
 * the turn did not read, a finding the publication no longer holds, are taken out; a row left empty closes up, and
 * blocks past the limits are dropped. Nothing is repaired.
 */
export function verifyScene(scene: Pick<SceneDocument, "scope" | "rows">, ctx: SceneContext): VerifiedScene {
  const reasons: string[] = [];
  const charts: Record<string, CompiledChart> = {};
  const lenses: Record<string, VerifiedLens> = {};
  const byId = new Map(ctx.findings.map(f => [f.id, f]));
  let chartCount = 0, lensCount = 0;
  const keep = (block: SceneBlock): SceneBlock | null => {
    switch (block.kind) {
      case "lens": {
        const finding = byId.get(block.findingId);
        if (!finding) { reasons.push(`${block.id} lens: no finding ${block.findingId} in the publication`); return null; }
        if (++lensCount > SCENE_LIMITS.lenses) { reasons.push(`${block.id} lens: at most ${SCENE_LIMITS.lenses} findings per scene`); return null; }
        const lens = verifyLensDocument(block.document, finding, finding.resolved, ctx.data, finding.periodEnd, ctx.options, { ticker: ctx.ticker, materials: ctx.materials });
        if (!lens) { reasons.push(`${block.id} lens: the document needs its judgment block and at least one block that resolves`); return null; }
        lenses[block.id] = lens;
        return { ...block, document: lens.document };
      }
      case "chart": {
        if (++chartCount > SCENE_LIMITS.charts) { reasons.push(`${block.id} chart: at most ${SCENE_LIMITS.charts} standalone charts`); return null; }
        const result = compileChart(block.chart, ctx.data, block.periodEnd, ctx.options);
        if (!result.chart) { reasons.push(`${block.id} chart ${block.chart.id}: ${result.errors.join("; ")}`); return null; }
        charts[block.id] = result.chart;
        return block;
      }
      case "prose": {
        if (!ctx.candidates) return block;
        const candidates = ctx.candidates;
        const paragraphs = block.paragraphs.filter((p, i) => {
          const bad = proseNumbers(p.text).filter(n => !numberSupported(n, candidates));
          if (bad.length) reasons.push(`${block.id} prose paragraph ${i + 1}: number ${bad.join(", ")} was not read this turn`);
          return !bad.length;
        });
        return paragraphs.length ? { ...block, paragraphs } : null;
      }
      case "metric-trend":
        if (!resolveRef(ctx.data, block.ref, scene.scope.periodEnd, block.span)) { reasons.push(`${block.id} metric-trend: ${JSON.stringify(block.ref)} does not resolve at ${scene.scope.periodEnd}`); return null; }
        return block;
      case "findings": {
        if (!block.ids) return ctx.findings.length ? block : null;
        const ids = block.ids.filter(id => byId.has(id));
        if (ids.length < block.ids.length) reasons.push(`${block.id} findings: unknown ids ${block.ids.filter(id => !byId.has(id)).join(", ")}`);
        return ids.length ? { ...block, ids } : null;
      }
      case "business-flow":
      case "notice":
        return block;
    }
  };
  const rows = scene.rows.slice(0, SCENE_LIMITS.rows)
    .map(r => ({ ...(r.title ? { title: r.title } : {}), cells: r.cells.slice(0, SCENE_LIMITS.cells).map(cell => cell.slice(0, SCENE_LIMITS.blocksPerCell).map(keep).filter((b): b is SceneBlock => b != null)).filter(cell => cell.length) }))
    .filter(r => r.cells.length);
  return { rows, charts, lenses, reasons };
}

/** The scene as text for the model: its rows, what each standalone chart draws, and what was taken out. */
export function describeScene(verified: VerifiedScene): string {
  const lines: string[] = [];
  const label = (b: SceneBlock) => b.kind === "lens" ? `lens ${b.findingId}` : b.kind === "chart" ? `chart ${b.chart.id}` : b.kind === "prose" ? `prose ×${b.paragraphs.length}`
    : b.kind === "metric-trend" ? `metric-trend ${JSON.stringify(b.ref)} ${b.span}×${b.periods}` : b.kind === "findings" ? `findings ${(b.ids ?? ["all"]).join(",")}` : b.kind === "business-flow" ? `business-flow${b.focus ? ` ${b.focus}` : ""}` : `notice ${b.code}`;
  verified.rows.forEach((row, i) => lines.push(`row ${i + 1}${row.title ? ` "${row.title}"` : ""}: [${row.cells.map(cell => cell.map(label).join(" + ")).join(" | ")}]`));
  for (const [id, chart] of Object.entries(verified.charts)) lines.push(describeChart(id, { chart, errors: [], notes: [] }));
  lines.push(verified.reasons.length ? `taken out (${verified.reasons.length}):\n  ${verified.reasons.join("\n  ")}` : "taken out: nothing");
  return lines.join("\n");
}
