import { z } from "zod";
import { LENS_LIMITS } from "../../analysis-contract/lens.ts";
import { NOTICE_CODES, SCENE_LIMITS, type SceneBlockBody, type SceneRow } from "../../analysis-contract/scene.ts";
import { findingRefSchema, readLensDocument } from "../findings.ts";
import { lensDocumentSchemaFor } from "../lens/schema.ts";

const DIGIT = /\d/;
const plain = (max: number) => z.string().trim().min(1).max(max).refine(v => !DIGIT.test(v), { message: "states a figure" });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const span = z.preprocess(v => typeof v === "string" ? (/^q/i.test(v.trim()) ? "quarter" : /^(fy|fiscal|annual|year|ttm)/i.test(v.trim()) ? "fiscal_year" : v) : v, z.enum(["quarter", "fiscal_year"]));
const claim = z.object({ text: z.string().trim().min(1).max(LENS_LIMITS.paragraphChars), sourceIds: z.array(z.string().max(40)).optional().default([]).transform(ids => ids.slice(0, 6)) });
/** A standalone chart reads through the lens chart grammar: the schema of a one-chart lens document, unwrapped. */
const lensChart = z.unknown().transform((value, ctx) => {
  const doc = readLensDocument({ rows: [{ cells: [[{ kind: "judgment" }, { kind: "chart", chart: value }]] }] });
  const block = doc?.rows[0]?.cells[0]?.[1];
  if (!block || block.kind !== "chart") { ctx.addIssue({ code: "custom", message: "chart does not match the lens chart grammar (id, aspect, span, periods 2–12, series, marks; no digits in titles or labels)" }); return z.NEVER; }
  return block.chart;
});
const lensDocument = lensDocumentSchemaFor(findingRefSchema);

const body = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("lens"), findingId: z.string().trim().min(1).max(80), document: lensDocument }),
  z.object({ kind: z.literal("chart"), periodEnd: date.optional(), chart: lensChart }),
  z.object({ kind: z.literal("prose"), paragraphs: z.array(claim).min(1).max(LENS_LIMITS.paragraphs) }),
  z.object({ kind: z.literal("business-flow"), focus: z.string().trim().min(1).max(200).optional() }),
  z.object({ kind: z.literal("metric-trend"), ref: findingRefSchema, span, periods: z.number().int().min(2).max(LENS_LIMITS.periods) }),
  z.object({ kind: z.literal("findings"), ids: z.array(z.string().max(80)).max(12).optional() }),
  z.object({ kind: z.literal("notice"), code: z.enum(NOTICE_CODES), params: z.record(z.string(), z.string().max(200)).optional() }),
  z.object({ kind: z.literal("report"), reportId: z.string().regex(/^[0-9a-f]{32}$/) }),
]);
const cell = z.array(body).min(1).max(SCENE_LIMITS.blocksPerCell);
const row = z.object({ title: plain(SCENE_LIMITS.titleChars).optional(), cells: z.array(cell).min(1).max(SCENE_LIMITS.cells) });

/** A scene as the model writes it: rows only, with its period. Block ids and the data basis are the harness's. */
export const sceneDraftSchema = z.object({
  periodEnd: date.optional(),
  findingId: z.string().max(80).optional(),
  rows: z.array(row).min(1).max(SCENE_LIMITS.rows),
});
export type SceneDraft = { periodEnd?: string; findingId?: string; rows: Array<{ title?: string; cells: SceneBlockBody[][] }> };

/** A scene draft through the contract, or the first few violations with their paths for the model to fix. */
export function readSceneDraft(value: unknown): { draft: SceneDraft } | { issues: string[] } {
  const parsed = sceneDraftSchema.safeParse(value);
  if (parsed.success) return { draft: parsed.data as SceneDraft };
  return { issues: parsed.error.issues.slice(0, 8).map(i => `${i.path.join(".") || "scene"}: ${i.message}`) };
}

/** What a block is about, for keeping its id across revisions: the same kind of block about the same thing keeps its id. */
function identity(block: SceneBlockBody): string {
  switch (block.kind) {
    case "lens": return `lens:${block.findingId}`;
    case "chart": return `chart:${block.chart.id}`;
    case "metric-trend": return `trend:${JSON.stringify(block.ref)}:${block.span}`;
    case "business-flow": return `flow:${block.focus ?? ""}`;
    case "findings": return `findings:${(block.ids ?? []).join(",")}`;
    case "notice": return `notice:${block.code}`;
    case "prose": return "prose";
    case "report": return `report:${block.reportId}`;
    case "progress": return `progress:${block.runId}`;
  }
}

/**
 * Block ids for a new revision: a block about the same thing as one in the previous revision keeps that block's id,
 * so the page keeps it mounted; others get fresh ids. Ids are short and stable for a given scene.
 */
export function assignIds(rows: SceneDraft["rows"], previous: SceneRow[] = []): SceneRow[] {
  const known = new Map<string, string[]>();
  for (const b of previous.flatMap(r => r.cells.flat())) { const key = identity(b); known.set(key, [...(known.get(key) ?? []), b.id]); }
  const used = new Set<string>();
  let n = 0;
  const fresh = () => { let id: string; do id = `b${(n++).toString(36)}`; while (used.has(id) || previous.some(r => r.cells.flat().some(b => b.id === id))); return id; };
  return rows.map(r => ({ ...(r.title ? { title: r.title } : {}), cells: r.cells.map(cell => cell.map(block => {
    const reuse = known.get(identity(block))?.find(id => !used.has(id));
    const id = reuse ?? fresh();
    used.add(id);
    return { id, ...block };
  })) }));
}
