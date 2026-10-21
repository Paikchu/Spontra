import type { ExplainerClaim } from "./business-explainer.ts";
import type { FindingRef, FindingSpan } from "./findings.ts";
import type { LensChart, LensDocument } from "./lens.ts";
import type { MapRevisions } from "./revisions.ts";

/**
 * What the stage shows while a reader talks with it (docs/stage-agent-design.md §5.1). Like a lens document it is a
 * declaration bound to references, never to values: the page resolves every figure from the data it already holds,
 * so a scene carries no number of its own and cannot execute anything. A finding's own lens document travels inside
 * a `lens` block, unchanged, so everything said about a finding stays anchored to it.
 */
export type SceneDocument = {
  schemaVersion: "scene.v1";
  /** The report the scene is about; standalone charts end here unless they name their own period. */
  scope: { periodEnd: string; findingId?: string };
  /** The resource revisions the scene was compiled against, so the page reads the same data before drawing it. */
  basis: MapRevisions;
  rows: SceneRow[];
};

/** `title`: an AI-written heading, at most 60 characters and no figure. One or two cells, side by side. */
export type SceneRow = { title?: string; cells: SceneCell[] };
/** One to four blocks stacked. */
export type SceneCell = SceneBlock[];

/** Notices are codes the page words in its own language; the server never sends reader-facing text of its own. */
export const NOTICE_CODES = [
  "stage-off", "quota-reached", "global-cap-reached", "turn-interrupted", "turn-failed", "conversation-unavailable",
  "report-started", "report-ready", "report-failed", "retention",
] as const;
export type NoticeCode = typeof NOTICE_CODES[number];

export type SceneBlockBody =
  /** One finding's whole lens document, laid out as the finding page lays it out. */
  | { kind: "lens"; findingId: string; document: LensDocument }
  /** A chart on its own; `periodEnd` is the period its last column ends at. */
  | { kind: "chart"; periodEnd: string; chart: LensChart }
  /** Paragraphs; every number in them must be one the turn's reads produced. */
  | { kind: "prose"; paragraphs: ExplainerClaim[] }
  /** The revenue-to-profit flow the map opens on, optionally with a business picked. */
  | { kind: "business-flow"; focus?: string }
  /** One company-level series over time. */
  | { kind: "metric-trend"; ref: FindingRef; span: FindingSpan; periods: number }
  /** The findings list, or some of it. */
  | { kind: "findings"; ids?: string[] }
  | { kind: "notice"; code: NoticeCode; params?: Record<string, string> };

/** Every block carries an id the server assigns, so the page keeps a block mounted while the scene around it changes. */
export type SceneBlock = { id: string } & SceneBlockBody;
export type SceneBlockKind = SceneBlockBody["kind"];

export const SCENE_LIMITS = { rows: 8, cells: 2, blocksPerCell: 4, charts: 3, lenses: 2, titleChars: 60, idChars: 24 } as const;

/** The scene the page opens on: the map as it is today. */
export const DEFAULT_SCENE_ROWS: SceneRow[] = [{ cells: [[{ id: "map", kind: "business-flow" }]] }];
