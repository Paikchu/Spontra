/**
 * Analysis artifacts (docs/analysis-html-artifact.md): every analysis builds one HTML document of blocks, written with
 * shadcn/ui data-display markup and Tailwind classes, rendered in the `/artifact-frame` sandbox. This file is the
 * specification both sides check against: which elements, attributes and component slots a block may hold, which
 * class variants are allowed, and which blocks each kind of artifact must contain.
 */

export const ARTIFACT_SCHEMA = "analysis-artifact.v1";

export const ARTIFACT_KINDS = ["filing-report", "company-analysis", "dossier", "stage-report"] as const;
export type ArtifactKind = typeof ARTIFACT_KINDS[number];

/**
 * The blocks an artifact of each kind must hold. A required block is never removed: when its content cannot be
 * settled it is replaced by its conservative version (docs/analysis-html-artifact.md §6.3).
 */
export const ARTIFACT_REQUIRED_BLOCKS: Record<ArtifactKind, readonly string[]> = {
  "filing-report": ["summary"],
  "company-analysis": ["business", "mechanics", "revenue", "financials", "industry", "moat", "risks", "investment"],
  "dossier": ["thesis"],
  "stage-report": ["answer"],
};

/** Block ids are short slugs; the order of blocks is the document's order. */
export const ARTIFACT_BLOCK_ID = /^[a-z][a-z0-9-]{0,47}$/;
export const ARTIFACT_MAX_BLOCKS = 40;
export const ARTIFACT_MAX_BLOCK_CHARS = 40_000;

/** Elements a block may contain. `svg` and its children appear only where the harness inserts a compiled chart. */
export const ARTIFACT_ELEMENTS = [
  "div", "span", "p", "h2", "h3", "h4", "ul", "ol", "li", "strong", "em", "small", "sub", "sup", "br", "a",
  "blockquote", "cite", "data", "figure", "figcaption", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
  "kbd", "button", "dl", "dt", "dd", "hr", "mark", "abbr",
] as const;
export const ARTIFACT_VOID_ELEMENTS = ["br", "hr"] as const;

/** Attributes a block may use, per element ("*" for every element). Event handlers, `style`, `id` and `aria-*` are never allowed. */
export const ARTIFACT_ATTRIBUTES: Record<string, readonly string[]> = {
  "*": ["class", "data-slot", "data-pattern", "data-orientation", "data-side", "data-align", "lang", "title"],
  a: ["href", "data-source"],
  data: ["value", "data-ref", "data-unit"],
  blockquote: ["data-source"],
  cite: ["data-source"],
  figure: ["data-chart", "data-aspect"],
  th: ["colspan", "rowspan", "scope", "data-sort"],
  td: ["colspan", "rowspan", "data-sort-value"],
  div: ["data-value", "data-default", "data-type", "data-sortable", "data-max"],
  button: ["data-value"],
  span: ["data-content"],
  abbr: ["data-content"],
};

/**
 * shadcn/ui data-display component slots. `interactive` slots get their behaviour from the frame's component script;
 * `parent` is the slot an element must sit inside (directly or deeper).
 */
export type ArtifactSlot = { interactive?: true; parent?: string };
export const ARTIFACT_SLOTS: Record<string, ArtifactSlot> = {
  "card": {}, "card-header": { parent: "card" }, "card-title": { parent: "card" }, "card-description": { parent: "card" },
  "card-action": { parent: "card" }, "card-content": { parent: "card" }, "card-footer": { parent: "card" },
  "badge": {}, "kbd": {}, "separator": {},
  "alert": {}, "alert-title": { parent: "alert" }, "alert-description": { parent: "alert" },
  "item": {}, "item-media": { parent: "item" }, "item-content": { parent: "item" }, "item-title": { parent: "item" },
  "item-description": { parent: "item" }, "item-actions": { parent: "item" }, "item-group": {},
  "empty": {}, "empty-title": { parent: "empty" }, "empty-description": { parent: "empty" },
  "table-container": {}, "table": {}, "table-header": { parent: "table" }, "table-body": { parent: "table" },
  "table-footer": { parent: "table" }, "table-row": { parent: "table" }, "table-head": { parent: "table" },
  "table-cell": { parent: "table" }, "table-caption": { parent: "table" },
  "progress": {}, "progress-indicator": { parent: "progress" },
  "aspect-ratio": {}, "scroll-area": {},
  "chart": {},
  "tabs": { interactive: true }, "tabs-list": { interactive: true, parent: "tabs" }, "tabs-trigger": { interactive: true, parent: "tabs" },
  "tabs-content": { interactive: true, parent: "tabs" },
  "accordion": { interactive: true }, "accordion-item": { interactive: true, parent: "accordion" },
  "accordion-trigger": { interactive: true, parent: "accordion" }, "accordion-content": { interactive: true, parent: "accordion" },
  "collapsible": { interactive: true }, "collapsible-trigger": { interactive: true, parent: "collapsible" },
  "collapsible-content": { interactive: true, parent: "collapsible" },
  "tooltip": { interactive: true }, "hover-card": { interactive: true },
  "carousel": { interactive: true }, "carousel-content": { interactive: true, parent: "carousel" },
  "carousel-item": { interactive: true, parent: "carousel" }, "carousel-previous": { interactive: true, parent: "carousel" },
  "carousel-next": { interactive: true, parent: "carousel" },
};

/**
 * Layouts the theme owns (docs/filing-analysis-optimization.md §4.7): a block names one with `data-pattern` on the
 * element given here and writes plain children; spacing, columns and type come from the frame's stylesheet at every width.
 */
export const ARTIFACT_PATTERNS: Record<string, { on: readonly string[]; markup: string }> = {
  "metrics": { on: ["dl"], markup: '<dl data-pattern="metrics"><div><dt>label</dt><dd>figure</dd><dd>change or note</dd></div>…</dl> — two to six key figures in a row' },
  "compare": { on: ["div"], markup: '<div data-slot="table-container" data-pattern="compare"><table data-slot="table">…</table></div> — a table of figures: first column labels, the rest right-aligned numbers' },
  "figure-note": { on: ["div"], markup: '<div data-pattern="figure-note"><figure data-chart="id"></figure><div><p>what the chart shows…</p></div></div> — a chart with its reading beside it' },
  "timeline": { on: ["ol"], markup: '<ol data-pattern="timeline"><li><strong>date or period</strong><p>what happened</p></li>…</ol> — dated events in order' },
  "qa": { on: ["dl"], markup: '<dl data-pattern="qa"><dt>question or item to check</dt><dd>answer, level to watch, what it would mean</dd>…</dl> — questions with answers, or items with their reading' },
};

/** What code can tell about a layout before it is drawn; a block past one of these is not saved. */
export const ARTIFACT_LAYOUT_LIMITS = { headingChars: 130, subheadingChars: 100, tableColumns: 6, cellChars: 260, wordChars: 40, cards: 4, badges: 6 } as const;

/**
 * Class rules. Responsive styles use container queries, because the stage is narrower than the viewport; colours come
 * from the site theme alone. The harness compiles every class with the site's Tailwind theme and rejects one that
 * produces no CSS.
 */
export const ARTIFACT_CLASS_RULES = {
  /** Variants allowed in front of a utility. */
  variants: ["@3xs", "@2xs", "@xs", "@sm", "@md", "@lg", "@xl", "@2xl", "@3xl", "@4xl", "@5xl", "hover", "focus-visible", "first", "last", "odd", "even", "group-hover", "data-open", "data-closed", "data-active", "aria-expanded", "aria-selected", "not-last", "not-first", "*"],
  /** Utility roots never allowed. */
  roots: ["fixed", "sticky", "z", "animate", "transition", "duration", "ease", "delay", "will-change", "cursor", "pointer-events", "select", "contents", "hidden", "invisible", "sr-only"],
  /** Theme colours a colour utility may name; Tailwind's own palette is not part of the site's design. */
  colors: ["background", "foreground", "card", "card-foreground", "popover", "popover-foreground", "primary", "primary-foreground",
    "secondary", "secondary-foreground", "muted", "muted-foreground", "accent", "accent-foreground", "destructive", "border", "input", "ring",
    "chart-1", "chart-2", "chart-3", "chart-4", "chart-5", "gain", "gain-soft", "loss", "loss-soft", "caution", "caution-soft", "brand", "brand-soft",
    "highlight", "highlight-soft", "transparent", "current", "inherit"],
} as const;

/** One block as stored: its id, title for the outline, the sources it cites, and its canonical inner HTML. */
export type ArtifactBlock = {
  id: string;
  title: string;
  sources: string[];
  html: string;
  /** How the block was settled: written and passed, the conservative content version, or the harness's safe layout. */
  state: "draft" | "passed" | "conservative" | "safe-layout";
  /** Why a block was settled by the harness, for the record. */
  note?: string;
};

/** A compiled chart the document embeds; `svg` is drawn by the harness, `chart` feeds the frame's hover values. */
export type ArtifactChart = { id: string; title: string; svg: string; points: Array<{ series: string; period: string; text: string }> };

export type ArtifactDocument = {
  schema: typeof ARTIFACT_SCHEMA;
  kind: ArtifactKind;
  ticker: string;
  subject: string;
  version: number;
  lang: string;
  title: string;
  blocks: ArtifactBlock[];
  charts: ArtifactChart[];
  /** Sources the blocks cite: id, label and, for a public source, its URL. */
  sources: Array<{ id: string; title: string; url: string | null; kind: "sec" | "web" | "data" }>;
};

/** A published artifact as the map reads it: the HTML the frame renders, the CSS compiled for its classes, and what it is. */
export type PublishedArtifact = {
  id: string;
  kind: ArtifactKind;
  ticker: string;
  subject: string;
  version: number;
  title: string;
  html: string;
  css: string;
  hash: string;
  publishedAt: string;
  /** Blocks the harness settled with the conservative version or the safe layout; they are rewritten on the next trigger. */
  degraded: string[];
};

/** One problem a check found, addressed to a block. */
export type ArtifactIssue = {
  block: string;
  /** content: evidence review; render: deterministic browser checks; interaction; visual: the design review. */
  kind: "content" | "render" | "interaction" | "visual";
  severity: "blocker" | "major" | "minor";
  problem: string;
  suggestion?: string;
  viewport?: string;
  /** The region of the screenshot, in CSS pixels of the stage. */
  region?: { x: number; y: number; width: number; height: number };
};

/** Host and frame speak only these; each side accepts messages from its counterpart window alone. */
export type ArtifactFrameMessage =
  | { type: "artifact:ready" }
  | { type: "artifact:ping" }
  | { type: "artifact:render"; html: string; css: string; dark: boolean; lang: string }
  | { type: "artifact:theme"; dark: boolean }
  | { type: "artifact:rendered"; height: number }
  | { type: "artifact:size"; height: number }
  | { type: "artifact:link"; href: string };
