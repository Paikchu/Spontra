import type { PublicSecFiling } from "./filings.ts";

export type ReportAdminStatus = "unreviewed" | "reviewed" | "processing" | "failed" | "pending";
export type ReportAdminItem = {
  ticker: string; companyName: string; accessionNumber: string; form: string;
  reportDate: string; filingDate: string; reportVersion: string | null;
  generatedAt: string | null; updatedAt: string; status: ReportAdminStatus;
  stage: string | null; errorCode: string | null; reviewedAt: string | null;
  canRegenerate: boolean;
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
