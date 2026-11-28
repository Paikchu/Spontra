import { fiscalPeriodKey, readFiscalPeriod } from "./fiscal-period.ts";
import type { SecFiscalPeriod } from "../report-contract.ts";
import { normalizeTicker } from "../../financials/runtime/policy.ts";
import { cleanSecAccession, type SecFilingWithSummary } from "./sec.ts";
import { decodePageCursor } from "./config.ts";
import { D1SecRepository } from "./d1.ts";
import { readCachedSecFeed } from "./feed.ts";
import { companyName } from "../../../lib/catalog/issuer-directory.ts";
import { AnalysisRequestError } from "../../../api/public/contract-support/errors.ts";
import {
  ANALYSIS_FILING_PAGE_DEFAULT_LIMIT,
  ANALYSIS_FILING_PAGE_MAX_LIMIT,
  type AnalysisRunSummary,
  type FilingReportBundleMeta,
  type PublicAnalysisStatus,
  type PublicFilingCompany,
  type PublicFilingDetail,
  type PublicFilingPage,
  type PublicSecFiling,
} from "../filings-contract.ts";
import { ANALYSIS_API_SCHEMA_VERSION, splitReportVersion } from "../../../api/public/contract-support/versions.ts";

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
  const ticker = normalizeTicker(rawTicker);
  if (!ticker) throw new AnalysisRequestError("INVALID_TICKER", "Ticker is invalid.");
  if (rawCursor && !decodePageCursor(rawCursor)) throw new AnalysisRequestError("INVALID_CURSOR", "Cursor is invalid.");
  const limit = parseFilingLimit(rawLimit);
  const cursor = decodePageCursor(rawCursor);
  // Membership and the canonical report can change after discovery. Page the durable grouping,
  // never an older per-file feed window; otherwise releases reappear or cross page boundaries.
  const [cachedFeed, total, page] = await Promise.all([
    typeof repository.getCache === "function" ? readCachedSecFeed(repository, ticker) : Promise.resolve(null),
    cursor ? Promise.resolve(null) : repository.countPublicFilings(ticker),
    repository.listPublicFilings(ticker, rawCursor, limit),
  ]);
  const company = cachedFeed?.company ?? (page.filings[0] ? companyFromFiling(page.filings[0]) : await companyFromDirectory(repository, ticker));
  const resolved = page.filings.map(resolvePublishedFiling);
  const [jobs, fiscalPeriods, bundleRows] = await Promise.all([
    readJobSummaries(repository, ticker, page.filings.map(f => f.accessionNumber)),
    readFiscalPeriodsBatch(repository, resolved),
    typeof repository.listCacheByPrefix === "function"
      ? repository.listCacheByPrefix<FilingReportBundleMeta>(`filing-quarter-report:v1:${ticker}:`).catch(() => [])
      : Promise.resolve([]),
  ]);
  const bundlesByAccession = new Map<string, FilingReportBundleMeta>();
  for (const row of bundleRows) {
    bundlesByAccession.set(row.payload.canonicalAccession, row.payload);
    for (const src of row.payload.sources) {
      if (!bundlesByAccession.has(src.accessionNumber)) bundlesByAccession.set(src.accessionNumber, row.payload);
    }
  }
  const filings = await Promise.all(page.filings.map((filing, index) =>
    toPublicFiling(repository, filing, company?.name ?? ticker, {
      resolved: resolved[index],
      job: jobs ? jobs.get(filing.accessionNumber) ?? { status: null, updatedAt: null, errorCode: null } : undefined,
      fiscalPeriod: fiscalPeriods ? fiscalPeriods.get(resolved[index]!.accessionNumber) ?? null : undefined,
      reportBundle: bundlesByAccession.get(filing.accessionNumber) ?? null,
    })));
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
  const ticker = normalizeTicker(rawTicker);
  const accession = cleanSecAccession(rawAccession);
  if (!ticker || !accession) return null;
  if (snapshot) {
    const filing = await repository.getReportSnapshot(ticker, accession, snapshot.reportDate, snapshot.reportVersion);
    if (!filing) return null;
    const company = companyFromFiling(filing) ?? await companyFromDirectory(repository, ticker);
    return { apiSchemaVersion: ANALYSIS_API_SCHEMA_VERSION, ticker, company,
      filing: await toPublicFiling(repository, filing, company?.name ?? ticker) };
  }
  const [cachedFeed, alias] = await Promise.all([
    typeof repository.getCache === "function" ? readCachedSecFeed(repository, ticker) : Promise.resolve(null),
    typeof repository.getCache === "function"
      ? repository.getCache<{ canonicalAccession: string; periodEnd: string }>(`filing-quarter-alias:v1:${ticker}:${accession}`).then(r => r?.payload ?? null).catch(() => null)
      : Promise.resolve(null),
  ]);
  const targetAccession = alias?.canonicalAccession ?? accession;
  const filing = (await repository.getPublicFiling(ticker, targetAccession)) ?? (targetAccession !== accession ? await repository.getPublicFiling(ticker, accession) : null);
  if (!filing) return null;
  let reportBundle: FilingReportBundleMeta | null = null;
  if (typeof repository.getCache === "function") {
    const bundlePeriod = alias?.periodEnd ?? (filing.reportDate ? filing.reportDate.slice(0, 10) : null);
    if (bundlePeriod) {
      reportBundle = (await repository.getCache<FilingReportBundleMeta>(`filing-quarter-report:v1:${ticker}:${bundlePeriod}`).catch(() => null))?.payload ?? null;
    }
  }
  const company = cachedFeed?.company ?? companyFromFiling(filing) ?? await companyFromDirectory(repository, ticker);
  return {
    apiSchemaVersion: ANALYSIS_API_SCHEMA_VERSION,
    ticker,
    company,
    filing: await toPublicFiling(repository, filing, company?.name ?? ticker, { reportBundle }),
  };
}

function resolvePublishedFiling(filing: SecFilingWithSummary): SecFilingWithSummary {
  // A report the filing path published is the whole of what a reader sees for this filing, whatever an earlier run left.
  if (filing.summary?.generatedBy === "pi"||filing.summary?.generatedBy === "operator") filing = { ...filing, analysis: undefined };
  if (filing.analysis?.publication) {
    const { filing: published, summary } = filing.analysis.publication;
    // A report first published under the earnings release stays on this filing's own row.
    filing = { ...(published.accessionNumber === filing.accessionNumber ? published : filing), summary, analysis: filing.analysis };
  }
  return filing;
}

async function toPublicFiling(
  repository: D1SecRepository,
  rawFiling: SecFilingWithSummary,
  companyName: string,
  prefetched?: { resolved?: SecFilingWithSummary; job?: JobSummary | null; fiscalPeriod?: SecFiscalPeriod | null; reportBundle?: FilingReportBundleMeta | null },
): Promise<PublicSecFiling> {
  const jobAccession = rawFiling.accessionNumber;
  const filing = prefetched?.resolved ?? resolvePublishedFiling(rawFiling);
  const job = prefetched && "job" in prefetched && prefetched.job !== undefined
    ? prefetched.job
    : await readJobSummary(repository, filing.ticker, jobAccession);
  const report = filing.analysis;
  /**
   * Unchanged mapping — existing readers branch on these four values. It describes the *published
   * report*: a report that exists is complete or partial according to its own verification status,
   * and one that does not is `processing` while a run is in flight, `not_collected` otherwise.
   * `not_collected` covering a failed run is exactly why `analysisRun` below exists; the failure is
   * reported there rather than by quietly redefining this field.
   */
  const analysisStatus: PublicAnalysisStatus = report
    ? report.dataQuality.verificationStatus === "verified" && report.dataQuality.analysisStatus !== "partial" ? "complete" : "partial"
    : job?.status === "queued" || job?.status === "running" ? "processing" : "not_collected";
  const { analysisSchemaVersion, contentRevision } = splitReportVersion(report?.reportVersion ?? null);
  const fiscalPeriod = report?.fiscalPeriod !== undefined
    ? report.fiscalPeriod
    : prefetched && "fiscalPeriod" in prefetched && prefetched.fiscalPeriod !== undefined
      ? prefetched.fiscalPeriod
      : typeof repository.getCache === "function" ? await readFiscalPeriod(repository, filing) : null;
  return {
    fiscalPeriod,
    ...(prefetched?.reportBundle ? { reportBundle: prefetched.reportBundle } : {}),
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

async function readJobSummaries(repository: D1SecRepository, ticker: string, accessionNumbers: readonly string[]): Promise<Map<string, JobSummary> | null> {
  if (typeof repository.getLatestAnalysisJobSummaries !== "function") return null;
  try {
    return await repository.getLatestAnalysisJobSummaries(ticker, accessionNumbers);
  } catch {
    return null;
  }
}

async function readFiscalPeriodsBatch(repository: D1SecRepository, filings: readonly SecFilingWithSummary[]): Promise<Map<string, SecFiscalPeriod | null> | null> {
  if (typeof repository.getCaches !== "function") return null;
  const needed = filings.filter(f => f.analysis?.fiscalPeriod === undefined && /^(10-Q|10-K|20-F)(\/A)?$/.test(f.form));
  if (!needed.length) return new Map();
  const cached = await repository.getCaches<SecFiscalPeriod | null>(needed.map(fiscalPeriodKey));
  const out = new Map<string, SecFiscalPeriod | null>();
  for (const filing of needed) {
    const entry = cached.get(fiscalPeriodKey(filing));
    const period = entry?.payload?.periodEnd === filing.reportDate && entry.payload.sourceAccession === filing.accessionNumber ? entry.payload : null;
    out.set(filing.accessionNumber, period);
  }
  return out;
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

async function companyFromDirectory(repository: D1SecRepository, ticker: string): Promise<PublicFilingCompany | null> {
  const name = typeof repository.getCache === "function" ? await companyName(repository, ticker) : null;
  return name ? { ticker, name, cik: "" } : null;
}
