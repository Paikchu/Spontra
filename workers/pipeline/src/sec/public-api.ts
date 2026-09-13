import { cleanSecAccession, type SecFilingWithSummary } from "./sec.ts";
import { decodePageCursor, normalizeTrackedTicker } from "./config.ts";
import { D1SecRepository } from "./d1.ts";
import { readCachedSecFeed } from "./feed.ts";
import { findSecurity } from "../catalog/security-directory.ts";
import { AnalysisRequestError } from "../read-api/contract-support/errors.ts";
import {
  ANALYSIS_FILING_PAGE_DEFAULT_LIMIT,
  ANALYSIS_FILING_PAGE_MAX_LIMIT,
  type AnalysisRunSummary,
  type PublicAnalysisStatus,
  type PublicFilingCompany,
  type PublicFilingDetail,
  type PublicFilingPage,
  type PublicSecFiling,
} from "../../../../shared/analysis-contract/filings.ts";
import { ANALYSIS_API_SCHEMA_VERSION, splitReportVersion } from "../read-api/contract-support/versions.ts";

/**
 * The filing read queries. This module reaches storage, so it belongs to the analysis backend and
 * nothing in the Web Worker may import it — the wire types it used to define now live in
 * `lib/analysis-contract/filings.ts` and are re-exported here so existing importers keep resolving.
 */
export type {
  AnalysisRunSummary,
  PublicAnalysisStatus,
  PublicFilingCompany,
  PublicFilingDetail,
  PublicFilingPage,
  PublicSecFiling,
};

export async function getPublicFilingPage(
  repository: D1SecRepository,
  rawTicker: string,
  rawCursor: string | null,
  rawLimit: string | null,
): Promise<PublicFilingPage> {
  const ticker = normalizeTrackedTicker(rawTicker);
  if (!ticker) throw new AnalysisRequestError("INVALID_TICKER", "Ticker is invalid.");
  if (rawCursor && !decodePageCursor(rawCursor)) throw new AnalysisRequestError("INVALID_CURSOR", "Cursor is invalid.");
  const limit = parseFilingLimit(rawLimit);
  const cursor = decodePageCursor(rawCursor);
  const cachedFeed = typeof repository.getCache === "function" ? await readCachedSecFeed(repository, ticker) : null;
  // Membership and the canonical report can change after discovery. Page the durable grouping,
  // never an older per-file feed window; otherwise releases reappear or cross page boundaries.
  const total = cursor ? null : await repository.countPublicFilings(ticker);
  const page = await repository.listPublicFilings(ticker, rawCursor, limit);
  const company = cachedFeed?.company ?? (page.filings[0] ? companyFromFiling(page.filings[0]) : companyFromDirectory(ticker));
  const filings = await Promise.all(page.filings.map(async (filing) => toPublicFiling(repository, filing, company?.name ?? ticker)));
  return {
    apiSchemaVersion: ANALYSIS_API_SCHEMA_VERSION,
    ticker,
    company,
    filings,
    nextCursor: page.nextCursor,
    total,
    checkedAt: cachedFeed?.fetchedAt ?? null,
  };
}

/**
 * A limit is a bound, not a suggestion. Anything unparseable falls back to the default rather than
 * rejecting, which is what this endpoint has always done; anything out of range is clamped, so no
 * caller can widen the page beyond what the backend is willing to serve.
 */
function parseFilingLimit(rawLimit: string | null): number {
  const parsed = Math.trunc(Number(rawLimit ?? ANALYSIS_FILING_PAGE_DEFAULT_LIMIT));
  const requested = Number.isFinite(parsed) && parsed !== 0 ? parsed : ANALYSIS_FILING_PAGE_DEFAULT_LIMIT;
  return Math.min(ANALYSIS_FILING_PAGE_MAX_LIMIT, Math.max(1, requested));
}

export async function getPublicFiling(
  repository: D1SecRepository,
  rawTicker: string,
  rawAccession: string,
  snapshot?: { reportDate: string; reportVersion: string },
): Promise<PublicFilingDetail | null> {
  const ticker = normalizeTrackedTicker(rawTicker);
  const accession = cleanSecAccession(rawAccession);
  if (!ticker || !accession) return null;
  if (snapshot) {
    const filing = await repository.getReportSnapshot(ticker, accession, snapshot.reportDate, snapshot.reportVersion);
    if (!filing) return null;
    const company = companyFromFiling(filing) ?? companyFromDirectory(ticker);
    return { apiSchemaVersion: ANALYSIS_API_SCHEMA_VERSION, ticker, company,
      filing: await toPublicFiling(repository, filing, company?.name ?? ticker) };
  }
  const cachedFeed = typeof repository.getCache === "function" ? await readCachedSecFeed(repository, ticker) : null;
  const filing = await repository.getPublicFiling(ticker, accession);
  if (!filing) return null;
  const company = cachedFeed?.company ?? companyFromFiling(filing) ?? companyFromDirectory(ticker);
  return {
    apiSchemaVersion: ANALYSIS_API_SCHEMA_VERSION,
    ticker,
    company,
    filing: await toPublicFiling(repository, filing, company?.name ?? ticker),
  };
}

async function toPublicFiling(repository: D1SecRepository, filing: SecFilingWithSummary, companyName: string): Promise<PublicSecFiling> {
  const jobAccession = filing.earningsGroup?.canonicalAccession ?? filing.accessionNumber;
  if (filing.analysis?.publication) {
    filing = { ...filing.analysis.publication.filing, summary: filing.analysis.publication.summary, analysis: filing.analysis,
      ...(filing.earningsGroup ? { earningsGroup: filing.earningsGroup } : {}) };
  }
  const job = await readJobSummary(repository, filing.ticker, jobAccession);
  const report = filing.analysis;
  /**
   * Unchanged mapping — existing readers branch on these four values. It describes the *published
   * report*: a report that exists is complete or partial according to its own verification status,
   * and one that does not is `processing` while a run is in flight, `not_collected` otherwise.
   * `not_collected` covering a failed run is exactly why `analysisRun` below exists; the failure is
   * reported there rather than by quietly redefining this field.
   */
  const analysisStatus: PublicAnalysisStatus = report
    ? report.dataQuality.verificationStatus === "verified" ? "complete" : "partial"
    : job?.status === "queued" || job?.status === "running" ? "processing" : "not_collected";
  const { analysisSchemaVersion, contentRevision } = splitReportVersion(report?.reportVersion ?? null);
  return {
    ...(filing.earningsGroup ? { earningsGroup: filing.earningsGroup } : {}),
    accessionNumber: filing.accessionNumber,
    ticker: filing.ticker,
    companyName,
    form: filing.form,
    filingDate: filing.filingDate,
    reportDate: filing.reportDate,
    description: filing.description,
    summary: filing.summary,
    analysis: report,
    analysisStatus,
    reportVersion: report?.reportVersion ?? null,
    edgarUrl: filing.indexUrl,
    documentUrl: filing.documentUrl,
    provenance: "sec_edgar",
    // The report carries the period it was written for. A summary-only filing — an 8-K, say — has
    // no structured report and therefore no report period; that is a real null, not a gap.
    periodId: report?.periodId ?? null,
    analysisSchemaVersion,
    contentRevision,
    analysisRun: toRunSummary(job),
  };
}

type JobSummary = { status: "queued" | "running" | "complete" | "failed" | null; updatedAt: string | null; errorCode: string | null };

/**
 * Job history is metadata about the run, not the result. A repository that cannot answer reports
 * `unknown` rather than taking a readable filing down with it — but the filing itself, and its
 * published report, still propagate their failures.
 */
async function readJobSummary(repository: D1SecRepository, ticker: string, accessionNumber: string): Promise<JobSummary | null> {
  try {
    return await repository.getLatestAnalysisJobSummary(ticker, accessionNumber);
  } catch {
    return null;
  }
}

function toRunSummary(job: JobSummary | null): AnalysisRunSummary {
  if (!job) return { state: "unknown", updatedAt: null, errorCode: null };
  if (!job.status) return { state: "none", updatedAt: null, errorCode: null };
  const state = job.status === "complete" ? "succeeded" : job.status === "failed" ? "failed" : job.status;
  return { state, updatedAt: job.updatedAt, errorCode: job.errorCode };
}

function companyFromFiling(filing: SecFilingWithSummary): PublicFilingCompany | null {
  if (!filing.companyName || filing.companyName === filing.ticker) return null;
  return { ticker: filing.ticker, name: filing.companyName, cik: filing.cik };
}

function companyFromDirectory(ticker: string): PublicFilingCompany | null {
  const security = findSecurity(ticker);
  return security ? { ticker: security.symbol, name: security.name, cik: "" } : null;
}
