import type { StepContext } from "./durable-runs/engine.ts";
import { SEC_ANALYSIS_SCHEMA_VERSION } from "./sec/analysis.ts";
import type { SecFiling } from "./sec/sec.ts";
import { SEC_SUMMARY_VERSION } from "./sec/sec.ts";
import type { SecWorkflowParams } from "./core.ts";

/**
 * Job lookup version. Event filings additionally key on the summary version, while periodic filings keep the
 * analysis-schema key.
 */
export function jobAnalysisVersionFor(form: string): string {
  return /^(8-K|6-K)(\/A)?$/.test(form)
    ? `${SEC_ANALYSIS_SCHEMA_VERSION}+summary-v${SEC_SUMMARY_VERSION}`
    : SEC_ANALYSIS_SCHEMA_VERSION;
}

export type WorkflowStepContextLike = StepContext;

export type WorkflowStepLike = {
  do<T>(name: string, callback: (context?: WorkflowStepContextLike) => Promise<T>): Promise<T>;
  /** Waits for work that runs outside the steps (a Pi session); see RunStep.waitFor. */
  waitFor?<T>(name: string, check: () => Promise<T | null>, recheck: number): Promise<T>;
};

export type WorkflowJobUpdate = {
  jobId: string;
  ticker: string;
  accessionNumber: string;
  analysisVersion: string;
  status: "queued" | "running" | "complete" | "failed";
  currentStage: string;
  attempt: number;
  errorCode?: string;
  errorDetail?: string;
  requestedBy: SecWorkflowParams["requestedBy"];
  workflowInstanceId: string;
  updatedAt: string;
  completedAt?: string;
};

export type AnalysisOperations = {
  loadFiling?(ticker: string, accessionNumber: string): Promise<SecFiling | null>;
  discover(ticker: string): Promise<{ feed: unknown; filings: SecFiling[] }>;
  publishFeed(feed: unknown): Promise<void>;
  updateJob(job: WorkflowJobUpdate): Promise<void>;
  /** Moves a running job's `current_stage` to the step it is entering. */
  markJobStage?(jobId: string, stage: string): Promise<void>;
};

/** The company's latest periodic report and its most recent current reports. */
export function selectLatestWorkflowFilings(filings: SecFiling[]): SecFiling[] {
  const primary = filings.find((filing) => /^(10-K|10-Q|20-F)(\/A)?$/.test(filing.form));
  const events = filings.slice(0, 5).filter((filing) => /^(8-K|6-K)(\/A)?$/.test(filing.form));
  return [...(primary ? [primary] : []), ...events]
    .filter((filing, index, all) => all.findIndex((candidate) => candidate.accessionNumber === filing.accessionNumber) === index);
}
