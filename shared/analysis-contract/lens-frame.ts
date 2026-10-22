import type { LensAspect, LensMarkType } from "./lens.ts";
import type { FindingSpan } from "./findings.ts";
import type { ValueUnit } from "../analysis-runtime/findings.ts";

/**
 * A chart after compilation: every figure resolved and formatted, scales fixed, nothing left to look
 * up. The host compiles it from the data it holds and hands it to the frame to draw; the harness
 * compiles the same object to describe it to the model. Plain JSON, so it crosses postMessage.
 */
export type CompiledPeriod = { end: string; label: string; current: boolean };
export type CompiledSeries = {
  id: string;
  label: string;
  unit: ValueUnit;
  currency: string | null;
  /** A CSS colour or `var(--token)`; the frame defines the same tokens as the page. */
  color: string;
  axis: "left" | "right";
  values: Array<number | null>;
  /** Each value formatted the way the page writes it, aligned with `values`. */
  text: Array<string | null>;
  /** A guided range per period, when the figure is a range. */
  ranges?: Array<{ low: number; high: number } | null>;
};
export type CompiledAxis = { unit: ValueUnit; currency: string | null; min: number; max: number; ticks: Array<{ value: number; label: string }>; zero: boolean };
export type CompiledMark = { type: LensMarkType; series: string[] };
export type CompiledAnnotation = { series: string; period: number; text: string };
export type CompiledBand = { from: number; to: number; label: string | null };
export type CompiledChart = {
  id: string;
  title: string | null;
  subtitle: string | null;
  /** Period indexes and series ids the chart's point rests on; the rest is drawn as context. */
  focus: { periods: number[]; series: string[] };
  /** A series written under the period labels, not drawn; it appears in `series` but in no mark. */
  periodNote: string | null;
  aspect: LensAspect;
  span: FindingSpan;
  periods: CompiledPeriod[];
  series: CompiledSeries[];
  marks: CompiledMark[];
  axes: { left: CompiledAxis | null; right: CompiledAxis | null };
  annotations: CompiledAnnotation[];
  bands: CompiledBand[];
  periodLabels: "all" | "sparse";
  legend: "top" | "none";
  /** One sentence naming what is drawn, for readers of the page without the picture. */
  summary: string;
};

export type LensFrameSize = { width: number; height: number };
export type LensFrameTheme = { scheme: "dark" | "light"; tokens: Record<string, string> };

/** Host and frame speak only these; each side accepts messages from its counterpart window alone. */
export type LensFrameMessage =
  | { type: "lens:ready" }
  | { type: "lens:render"; id: string; chart: CompiledChart; size: LensFrameSize; theme: LensFrameTheme }
  | { type: "lens:rendered"; id: string }
  | { type: "lens:size"; id: string; size: LensFrameSize }
  | { type: "lens:theme"; theme: LensFrameTheme }
  | { type: "lens:hover"; id: string; period: number | null }
  | { type: "lens:focus"; id: string; period: number | null };

/** The page tokens the frame mirrors; read from the page's root at render time, never written by hand twice. */
export const LENS_FRAME_TOKENS = [
  "--background", "--surface", "--border", "--hairline", "--foreground", "--muted-foreground", "--faint",
  "--up", "--loss", "--flow-revenue", "--flow-profit", "--flow-expense", "--biz-0", "--biz-1", "--biz-2", "--biz-3", "--biz-4", "--sans", "--ease",
] as const;

/**
 * The html picture frame (`/html-frame`): a sandboxed page with an opaque origin that runs the agent's
 * fragment. The host hands it the fragment with the page's tokens and font and sizes the frame
 * (`pictureHeight`); the fragment fills it, and the frame says when it has drawn. Neither side trusts the other's origin string: the host checks the source window,
 * the frame checks that the message came from its parent.
 */
export type HtmlFrameMessage =
  | { type: "html:ready" }
  | { type: "html:ping" }
  | { type: "html:render"; id: string; html: string; theme: LensFrameTheme; font: string | null; lang: string }
  /** The page's theme changed: the frame swaps its colour variables in place, without rerunning the picture. */
  | { type: "html:theme"; theme: LensFrameTheme }
  /** The fragment and its scripts have loaded; the host shows the frame. */
  | { type: "html:rendered"; id: string };
