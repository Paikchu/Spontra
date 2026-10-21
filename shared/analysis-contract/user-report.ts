import type { ComposedAnalysis } from "./findings.ts";

/**
 * A report a reader asked the stage for (docs/stage-agent-design.md §6). It has the shape of a finding — a judgment
 * whose every number its evidence produces, and a lens document laid out from charts, quotes and prose — so the page
 * verifies it with the finding page's own verifiers. The passages it quotes travel with it, as read when it was
 * written: a reader's report does not change when the library does.
 */
export type UserReport = ComposedAnalysis & {
  schemaVersion: "user-report.v1";
  id: string;
  ticker: string;
  question: string;
  /** The report the evidence is read at. */
  periodEnd: string;
  createdAt: string;
  locale: "en" | "zh-CN";
};
