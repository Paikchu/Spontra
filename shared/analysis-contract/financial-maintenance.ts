import type { DisclosureAuditSummary } from "./disclosure-audit.ts";
/** Private admin DTOs; amounts always carry an explicit unit and scale. */
export type FinancialMaintenanceCompany = {
  ticker: string; name: string; cik: string | null; tracked: boolean; dataEnabled: boolean;
  latestPeriodEnd: string | null; lastUpdatedAt: string | null;
};
export type FinancialMaintenanceTaskStatus = "queued" | "running" | "succeeded" | "partial" | "failed" | "cancel_requested" | "cancelled";
export type FinancialMaintenanceTask = {
  id: string; ticker: string; action: "extract" | "analyze"; status: FinancialMaintenanceTaskStatus;
  stage: string; createdAt: string; updatedAt: string; completedAt: string | null;
  errorCode: string | null; issues: string[]; progress: { completed: number; total: number };
  canRetry: boolean; canCancel: boolean; accessionNumber: string | null;
};
export type FinancialMaintenanceMetric = {
  id: string; label: string; value: string | null; unit: string; scale: number;
  basis: "reported" | "derived"; sourceUrl?: string; sourceAccession?: string;
  formula?: string; missingReason?: string;
};
export type FinancialMaintenancePeriod = {
  periodEnd: string; periodStart?: string; fiscalLabel?: string;
  status: "complete" | "partial" | "missing"; metrics: FinancialMaintenanceMetric[]; issues: string[];
};
export type FinancialMaintenanceCompanyList = {
  companies: FinancialMaintenanceCompany[];
  environment: { aiEnabled: boolean; dataCollectionEnabled: boolean; workflowAvailable: boolean };
};
export type FinancialMaintenanceCompanyDetail = {
  company: FinancialMaintenanceCompany; periods: FinancialMaintenancePeriod[]; tasks: FinancialMaintenanceTask[];
  coverage: { scope: string[]; limitations: string[] };
  documents: DisclosureAuditSummary[];
};
export type FinancialMaintenanceActionResponse = { task: FinancialMaintenanceTask; reused: boolean };
