import type { SecFiling, SecFilingSummary } from "./sec.ts";
import type { ReportContinuity } from "./continuity.ts";
import type {
  ComparisonResult,
  CompanyMemoryItem,
  FilingBlock,
  ManagerReview,
  PublishedSecReport,
  SecAnalysisBrief,
  SecHistorySnapshot,
} from "./analysis.ts";

export type SecCacheRecord<T> = {
  payload: T;
  fetchedAt: string;
};

export type SecRepository = {
  getCache<T>(key: string): Promise<SecCacheRecord<T> | null>;
  setCache<T>(key: string, payload: T, fetchedAt: string): Promise<void>;
  getSummary(ticker: string, accessionNumber: string): Promise<SecFilingSummary | null>;
  setSummary(filing: Pick<SecFiling, "ticker" | "accessionNumber" | "form">, summary: SecFilingSummary): Promise<void>;
  getPublishedReport?(ticker: string, periodId: string): Promise<PublishedSecReport | null>;
  getAnalysisContext?(filing: SecFiling): Promise<SecAnalysisContext>;
  saveAnalysis?(artifact: SecAnalysisArtifact): Promise<void>;
};

export type SecAnalysisContext = {
  marketSnapshot?: import("../../../../shared/analysis-contract/sec-reader.ts").SecMarketSnapshot;
  reportContinuity?: ReportContinuity;
  currentPeriodId: string;
  qoqPeriodId: string | null;
  yoyPeriodId: string | null;
  history?: SecHistorySnapshot;
  companyMemorySummary?: string;
  memoryItems?: CompanyMemoryItem[];
};

export type SecAnalysisArtifact = {
  filing: SecFiling;
  periodId: string;
  periodScope: "quarter" | "annual";
  blocks: FilingBlock[];
  comparisons: ComparisonResult[];
  report: PublishedSecReport;
  brief?: SecAnalysisBrief;
  managerReview?: ManagerReview;
  validEvidenceIds?: string[];
  artifactKeys?: Record<string, string>;
};
