import type { FindingRef, FindingSpan } from "./findings.ts";
import type { ExplainerClaim } from "./business-explainer.ts";

/**
 * How a finding is shown once it has the whole stage: a document of rows, each holding one or two
 * blocks, written by the lens agent under the harness (docs/finding-lens-agent.md). A chart is a
 * declaration bound to references, never to values: the page resolves every figure from the data it
 * already draws, so the document carries no number and cannot execute anything.
 */

export type LensAspect = "wide" | "square" | "tall";
/** Height as a share of width for each aspect; the host's CSS and the harness's audit use the same numbers. */
export const LENS_ASPECT = { wide: 0.42, square: 0.78, tall: 1.05 } as const;

/** Colours by what the figure is, named for the page's design tokens; a business node defaults to its own hue. */
export type LensColorToken = "revenue" | "profit" | "expense" | "loss" | "up" | "muted" | "biz-0" | "biz-1" | "biz-2" | "biz-3" | "biz-4";
export const LENS_COLOR_TOKENS = ["revenue", "profit", "expense", "loss", "up", "muted", "biz-0", "biz-1", "biz-2", "biz-3", "biz-4"] as const;

/** The figure itself, or its change against a year earlier or the previous period, computed by the compiler. */
export type LensTransform = "value" | "yoy" | "qoq";
export type LensSeries = {
  id: string;
  ref: FindingRef;
  transform?: LensTransform;
  /** Overrides the resolved label; at most 40 characters and no figure. */
  label?: string;
};

export type LensMarkType = "bar" | "line" | "area" | "step" | "dot" | "stacked_bar" | "stacked_area" | "waterfall" | "rule";
export const LENS_MARK_TYPES = ["bar", "line", "area", "step", "dot", "stacked_bar", "stacked_area", "waterfall", "rule"] as const;
export type LensMark = {
  type: LensMarkType;
  /** Series ids the mark draws; a waterfall takes exactly one. */
  series: string[];
  color?: LensColorToken;
  /** A second scale on the right for series in another unit, e.g. a growth line over amount bars. */
  axis?: "left" | "right";
};

/** A callout at one point: `text` is a template of `{value}`, `{change}`, `{label}` and `{period}` plus words; it states no figure of its own. */
export type LensAnnotation = { series: string; period: "first" | "latest" | string; text: string };
/** A shaded stretch of periods, e.g. the quarters a programme ran. */
export type LensBand = { from: "first" | "latest" | string; to: "first" | "latest" | string; label?: string };

export type LensChart = {
  id: string;
  /** At most 60 characters, no figure. */
  title?: string;
  aspect: LensAspect;
  span: FindingSpan;
  /** Periods drawn, ending at the finding's report: 2–12. */
  periods: number;
  series: LensSeries[];
  marks: LensMark[];
  annotations?: LensAnnotation[];
  bands?: LensBand[];
  /** Every period label, or every other one when they would collide. */
  periodLabels?: "all" | "sparse";
  legend?: "top" | "none";
};

export type LensBlock =
  /** The finding's verified judgment paragraph with its citations; exactly one per document. */
  | { kind: "judgment" }
  /** Further paragraphs the agent writes; every number must be one the finding's evidence produces. */
  | { kind: "prose"; paragraphs: ExplainerClaim[] }
  | { kind: "chart"; chart: LensChart }
  /** The finding's evidence as resolved figures with their comparisons; exactly one per document. */
  | { kind: "figures" }
  /** The watch item and, once published, its outcome. */
  | { kind: "watch" }
  | { kind: "sources" };

/** A cell stacks one to three blocks; a row holds one or two cells, side by side, that stack on a narrow screen. */
export type LensCell = LensBlock[];
export type LensRow = { cells: LensCell[] };
export type LensDocument = { rows: LensRow[] };

export const LENS_LIMITS = {
  rows: 6, cells: 2, blocksPerCell: 3, charts: 3, series: 6, marks: 6, periods: 12, annotations: 6, bands: 3,
  paragraphs: 3, paragraphChars: 1400, titleChars: 60, labelChars: 40, annotationChars: 60, idChars: 24,
} as const;
