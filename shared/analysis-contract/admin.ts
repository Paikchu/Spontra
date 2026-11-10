import type { PublicSecFiling } from "./filings.ts";

export type ReportAdminStatus = "unreviewed" | "reviewed" | "processing" | "failed" | "pending";
export type ReportAdminItem = {
  ticker: string; companyName: string; accessionNumber: string; form: string;
  reportDate: string; filingDate: string; reportVersion: string | null;
  generatedAt: string | null; updatedAt: string; status: ReportAdminStatus;
  stage: string | null; errorCode: string | null; reviewedAt: string | null;
  canRegenerate: boolean; workflowInstanceId: string | null;
};
export type ReportAdminPage = { reports: ReportAdminItem[]; nextCursor: string | null };
export type ReportAdminJob = {
  jobId: string; status: string; currentStage: string; attempt: number;
  requestedBy: string; updatedAt: string; completedAt: string | null; errorCode: string | null;
};
export type ReportAdminDetail = {
  filing: PublicSecFiling; reviewedAt: string | null; canRegenerate: boolean;
  versions: Array<{ reportVersion: string; generatedAt: string; verificationStatus: string; reviewedAt: string | null }>;
  jobs: ReportAdminJob[];
};
export type ReportRunTurn = { turn: number; thought: string; action: string; input: string; observation: string; failed?: boolean };
export type ReportRunProcess = {
  status: string | null; error: { message?: string } | null; step: string | null; updatedAt: string | null;
  sessions: Array<{ operationId: string; kind: string; turns: number; spent: number; active: boolean; trail: ReportRunTurn[] }>;
  /** The run's summary row, once it has one (docs/filing-analysis-optimization.md §4.9). */
  summary?: ReportRunSummary | null;
};
export type ReportRunSummary = {
  status: string; settledBy: string | null; startedAt: string | null; endedAt: string; turns: number; tools: Record<string, number>;
  reviewRounds: number; renderRounds: number; sectionsRead: number; charsRead: number; compactions: number; blocks: number; degraded: string[];
  detail: Record<string, unknown>;
};
