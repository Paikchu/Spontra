/** Admin view of the model-written business-map outputs: who ran them, how far a run got, and every version published. */
export const AI_RUN_KINDS = ["findings", "explainer", "guidance"] as const;
export type AiRunKind = typeof AI_RUN_KINDS[number];
export type AiRunStatus = "queued" | "running" | "waiting" | "succeeded" | "empty" | "superseded" | "failed";
export type AiRunTrigger = "manual" | "schedule";

export type AiRunStep = { stage: string; at: string; attempt?: number };
export type AiRun = {
  runId: string;
  kind: AiRunKind;
  ticker: string;
  trigger: AiRunTrigger;
  status: AiRunStatus;
  /** The step in progress, or the last one reached. */
  stage: string | null;
  log: AiRunStep[];
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  /** Guidance runs name the earnings filing they read. */
  accession: string | null;
  /** The workflow's own summary, e.g. findings published and withheld with reasons. */
  result: unknown;
  error: string | null;
};

export type AiVersionSummary = { items: number; sources: number; periodEnd: string | null; model: string | null };
export type AiVersion = { id: string; savedAt: string; summary: AiVersionSummary; current: boolean };

export type AiKindState = {
  /** Configuration that stops a manual run from starting; null when it can run. */
  blocked: string | null;
  /** The sweep starts runs on its own only when this is true. */
  automatic: boolean;
  current: AiVersion | null;
  latestRun: Pick<AiRun, "runId" | "status" | "stage" | "trigger" | "startedAt" | "updatedAt"> | null;
};

export type AiCompanies = { companies: Array<{ ticker: string; name: string; kinds: Record<AiRunKind, AiKindState> }> };

export type AiEarningsEvent = { accession: string; eventDate: string; status: string | null; transcriptStatus: string | null };
export type AiCompanyDetail = {
  ticker: string;
  name: string;
  kind: AiRunKind;
  state: AiKindState;
  runs: AiRun[];
  versions: AiVersion[];
  /** Guidance only: earnings releases a run can read, newest first. */
  events: AiEarningsEvent[];
};
export type AiVersionDetail = { kind: AiRunKind; ticker: string; version: AiVersion; publication: unknown };
export type AiRunStarted = { runId: string; reused: boolean };
