import type { SecFilingWithSummary } from "./report.ts";
import { ANALYSIS_API_SCHEMA_VERSION } from "./common.ts";

/**
 * Wire types for the filing resources. They live here rather than beside the D1 query code so the
 * Web Worker — and any other consumer — can depend on the shape without dragging a repository, a
 * database binding, or the analysis executor along with it.
 */

/**
 * Unchanged from the pre-refactor contract, and deliberately so: existing readers branch on these
 * four values. It describes the **published report**, not the latest run — `analysisRun` below is
 * where a queued/failed execution shows up.
 */
export type PublicAnalysisStatus = "complete" | "partial" | "processing" | "not_collected";

/**
 * The latest analysis execution known for a resource, kept separate from the published result so
 * the six situations in §4.4 of the refactor brief stay distinguishable:
 *
 * - `none` — the backend looked and there is genuinely no execution history.
 * - `queued` / `running` — an execution is in flight.
 * - `failed` — an execution ran and did not finish. Never collapsed into `none`.
 * - `succeeded` — the newest execution finished and published.
 * - `unknown` — run history could not be read. Absence of knowledge, not knowledge of absence.
 */
export type AnalysisRunState = "none" | "queued" | "running" | "failed" | "succeeded" | "unknown";

export type AnalysisRunSummary = {
  state: AnalysisRunState;
  /** When that run last changed state. Null when unknown or when there is no run. */
  updatedAt: string | null;
  /** A short machine code, never a provider message or trace. Null unless the run failed. */
  errorCode: string | null;
};

export type PublicSecFiling = {
  earningsGroup?: import("./report.ts").SecEarningsGroup;
  accessionNumber: string;
  ticker: string;
  companyName: string;
  form: string;
  filingDate: string;
  reportDate: string;
  description: string;
  summary: SecFilingWithSummary["summary"];
  analysis: SecFilingWithSummary["analysis"];
  analysisStatus: PublicAnalysisStatus;
  reportVersion: string | null;
  edgarUrl: string;
  documentUrl: string;
  /** Added by the backend refactor. Everything below is additive; nothing above changed. */
  provenance: "sec_edgar";
  /** Reporting period the structured report belongs to, or null for a summary-only filing. */
  periodId: string | null;
  /** The `<analysis schema>` half of `reportVersion`. */
  analysisSchemaVersion: string | null;
  /** The content-hash half of `reportVersion` — which revision of the report this is. */
  contentRevision: string | null;
  analysisRun: AnalysisRunSummary;
};

export type PublicFilingCompany = { ticker: string; name: string; cik: string };

export type PublicFilingPage = {
  apiSchemaVersion: typeof ANALYSIS_API_SCHEMA_VERSION;
  ticker: string;
  company: PublicFilingCompany | null;
  filings: PublicSecFiling[];
  nextCursor: string | null;
  /** Counted on the first page only; a later page reports null and the client keeps what it has. */
  total: number | null;
  checkedAt: string | null;
};

export type PublicFilingDetail = {
  apiSchemaVersion: typeof ANALYSIS_API_SCHEMA_VERSION;
  ticker: string;
  company: PublicFilingCompany | null;
  filing: PublicSecFiling;
};

/** Bounds the backend enforces on a filing page request. Published so consumers can page safely. */
export const ANALYSIS_FILING_PAGE_DEFAULT_LIMIT = 20;
export const ANALYSIS_FILING_PAGE_MAX_LIMIT = 50;
