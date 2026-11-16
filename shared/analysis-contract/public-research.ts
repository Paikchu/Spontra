import type { sourceSnapshotSchema, observationSchema, researchClaimSchema, researchDependencySchema, publicResearchDraftSchema, companyResearchExposureSchema } from "../analysis-runtime/public-research-schema.ts";

export type SourceSnapshot = typeof sourceSnapshotSchema["_output"];
export type Observation = typeof observationSchema["_output"];
export type ResearchClaim = typeof researchClaimSchema["_output"];
export type ResearchDependency = typeof researchDependencySchema["_output"];
export type PublicResearchDraft = typeof publicResearchDraftSchema["_output"];
export type CompanyResearchExposure = typeof companyResearchExposureSchema["_output"];
export type ResearchFreshness = "valid" | "updating" | "review_required" | "stale" | "unavailable";
export type ResearchReview = {
  mode?: "human" | "automatic";
  reviewer: string; reviewedAt: string; authorRunId: string;
  claimChecks: Array<{ claimId: string; supported: boolean; notes: string }>;
  conclusion: "approved" | "rejected"; notes: string;
};
export type PublicReportVersion = PublicResearchDraft & {
  version: string; publishedAt: string; supersedes: string | null; freshnessStatus: ResearchFreshness;
  review: ResearchReview;
  bodyMarkdown: string;
  claimStates: Record<string, "valid" | "review_required" | "unavailable">;
};
export type PublicReportSummary = Pick<PublicReportVersion, "reportId" | "version" | "type" | "title" | "language" | "scope" | "asOf" | "publishedAt" | "freshnessStatus" | "coverage" | "summary" | "changes">;
export type PublicResearchList = { status: "ready" | "unavailable"; reports: PublicReportSummary[]; reason?: string };
export type PublicResearchRead = { status: "available" | "unavailable" | "withdrawn"; report: PublicReportVersion | null; history: PublicReportSummary[]; reason?: string };
export type FrozenCompanyResearch = {
  ticker: string; asOf: string; frozenAt: string; mappingVersions: string[];
  reports: Array<{ report: PublicReportVersion; exposures: CompanyResearchExposure[]; applicability: "requires_company_review" }>;
  gaps: Array<{ kind: "macro" | "industry"; industryId: string | null; reason: string }>;
};
