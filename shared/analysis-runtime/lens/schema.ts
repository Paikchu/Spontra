import { z } from "zod";
import { LENS_COLOR_TOKENS, LENS_LIMITS, LENS_MARK_TYPES, type LensDocument } from "../../analysis-contract/lens.ts";

const DIGIT = /\d/;
/** A short English label with no figure of any kind: a title names the chart, the numbers come from the data. */
const plain = (max: number) => z.string().trim().min(1).max(max).refine(v => !DIGIT.test(v), { message: "states a figure" });
const id = z.string().regex(/^[a-z][a-z0-9-]*$/).max(LENS_LIMITS.idChars);
const period = z.union([z.literal("first"), z.literal("latest"), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]);
const claim = z.object({ text: z.string().trim().min(1).max(LENS_LIMITS.paragraphChars), sourceIds: z.array(z.string().max(40)).max(6) });

/**
 * The lens document as the model writes it, read through the same reference schema the findings use
 * so a chart can only point at what a finding could. Structure only: whether every series resolves and
 * whether the layout holds is the compiler's and the audit's business.
 */
export function lensDocumentSchemaFor(ref: z.ZodTypeAny): z.ZodType<LensDocument> {
  const series = z.object({ id, ref, transform: z.enum(["value", "yoy", "qoq"]).optional(), label: plain(LENS_LIMITS.labelChars).optional() });
  const mark = z.object({ type: z.enum(LENS_MARK_TYPES), series: z.array(id).min(1).max(LENS_LIMITS.series), color: z.enum(LENS_COLOR_TOKENS).optional(), axis: z.enum(["left", "right"]).optional() });
  const annotation = z.object({ series: id, period, text: z.string().trim().min(1).max(LENS_LIMITS.annotationChars) });
  const band = z.object({ from: period, to: period, label: plain(LENS_LIMITS.labelChars).optional() });
  const chart = z.object({
    id, title: plain(LENS_LIMITS.titleChars).optional(), aspect: z.enum(["wide", "square", "tall"]), span: z.enum(["quarter", "fiscal_year"]),
    periods: z.number().int().min(2).max(LENS_LIMITS.periods),
    series: z.array(series).min(1).max(LENS_LIMITS.series), marks: z.array(mark).min(1).max(LENS_LIMITS.marks),
    annotations: z.array(annotation).max(LENS_LIMITS.annotations).optional(), bands: z.array(band).max(LENS_LIMITS.bands).optional(),
    periodLabels: z.enum(["all", "sparse"]).optional(), legend: z.enum(["top", "none"]).optional(),
  });
  const peerRef = z.union([z.object({ capital: z.string().max(40) }), z.object({ fundamental: z.string().max(60) }), z.object({ metric: z.string().max(40) })]);
  const tableRow = z.object({ ref: z.union([ref, peerRef]), label: plain(LENS_LIMITS.labelChars).optional(), compare: z.enum(["yoy", "qoq"]).optional() });
  const table = z.object({
    title: plain(LENS_LIMITS.titleChars).optional(), columns: z.enum(["periods", "peers"]), span: z.enum(["quarter", "fiscal_year"]),
    periods: z.number().int().min(2).max(LENS_LIMITS.tablePeriods).optional(), peers: z.array(z.string().regex(/^[A-Z][A-Z0-9.-]{0,11}$/)).max(LENS_LIMITS.tablePeers).optional(),
    rows: z.array(tableRow).min(1).max(LENS_LIMITS.tableRows),
  });
  const block = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("judgment") }),
    z.object({ kind: z.literal("prose"), paragraphs: z.array(claim).min(1).max(LENS_LIMITS.paragraphs) }),
    z.object({ kind: z.literal("chart"), chart }),
    z.object({ kind: z.literal("figures") }),
    z.object({ kind: z.literal("watch") }),
    z.object({ kind: z.literal("sources") }),
    z.object({ kind: z.literal("quote"), materialId: z.string().trim().min(1).max(40), text: z.string().trim().min(20).max(LENS_LIMITS.quoteChars), said: z.object({ speaker: z.string().max(80), role: z.string().max(80).optional() }).optional() }),
    z.object({ kind: z.literal("table"), table }),
    z.object({ kind: z.literal("record") }),
  ]);
  const cell = z.array(block).min(1).max(LENS_LIMITS.blocksPerCell);
  return z.object({ rows: z.array(z.object({ title: plain(LENS_LIMITS.titleChars).optional(), cells: z.array(cell).min(1).max(LENS_LIMITS.cells) })).min(1).max(LENS_LIMITS.rows) }) as unknown as z.ZodType<LensDocument>;
}
