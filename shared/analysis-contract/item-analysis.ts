import type { ComposedAnalysis } from "./findings.ts";

/**
 * What a row of the map's filings rail is: a periodic report (or an earnings group), a current report (8-K/6-K), or a
 * Form 4 the insider rules flagged for attention.
 */
export type ItemKind = "report" | "current" | "insider";
export const ITEM_KINDS = ["report", "current", "insider"] as const;

/**
 * The analysis of one rail row, written when the filing arrives by the same agent loop, tools and verifiers the
 * findings and a reader's report go through; only the prompt and the materials it starts from differ by kind. The
 * page draws it on the whole stage the way it draws a finding.
 */
export type ItemAnalysis = ComposedAnalysis & {
  schemaVersion: "item-analysis.v1";
  ticker: string;
  /** The rail row's id: the report's or the filing's accession number. */
  itemId: string;
  itemKind: ItemKind;
  /** The report the evidence and charts are read at: the report's own period, or the latest report filed by the event's date. */
  periodEnd: string;
  generatedAt: string;
  /** The recipe version that wrote it; a new version writes every item again. */
  version: string;
};

export type ItemAnalysisResponse = {
  schemaVersion: "item-analysis-response.v1";
  status: "ready" | "unavailable";
  analysis: ItemAnalysis | null;
};
