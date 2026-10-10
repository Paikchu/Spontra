import type { NarrativeFigure, PanelPlan } from "./business-narrative.ts";

/**
 * Figures a model planned for a company from what the map already holds: the explainer's businesses
 * and their offerings, and the operating metrics. The model decomposes (which layers, which items in
 * each, which metric pairs make a ladder); code checks every item against the material and draws.
 * A hand-written narrative's own figures take precedence on the page; this fills in for every
 * business the narrative does not cover, and for companies with no narrative at all.
 */
export type PlannedFigures = {
  schemaVersion: "business-figures.v1";
  ticker: string;
  generatedAt: string;
  model: string;
  /** Hash of the explainer, metrics and narrative the plan was made from; the sweep re-plans when it changes. */
  fingerprint: string;
  company: NarrativeFigure[];
  businesses: Array<{ nodeId: string; figures: NarrativeFigure[] }>;
  /** How the stage is composed for the company, each business and each finding the planner judged; absent means the flow. */
  layouts?: { company: PanelPlan | null; businesses: Array<{ nodeId: string; layout: PanelPlan }>; findings?: Array<{ findingId: string; layout: PanelPlan }> };
};

export type PlannedFiguresResponse = {
  schemaVersion: "business-figures-response.v1";
  status: "ready" | "preparing";
  figures: PlannedFigures | null;
};
