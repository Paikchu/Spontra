import type { PublishedArtifact } from "./artifact.ts";
import type { ComposedAnalysis } from "./findings.ts";

/**
 * A report a reader asked the stage for: an artifact composed and checked like every analysis
 * (docs/analysis-html-artifact.md), carried whole so a reader's report does not change when the library does. Reports
 * written before artifacts have the shape of a finding and are verified with the finding page's own verifiers.
 */
export type UserReport = (ComposedAnalysis | { artifact: PublishedArtifact }) & {
  schemaVersion: "user-report.v1";
  id: string;
  ticker: string;
  question: string;
  /** The report the evidence is read at. */
  periodEnd: string;
  createdAt: string;
  locale: "en" | "zh-CN";
};
