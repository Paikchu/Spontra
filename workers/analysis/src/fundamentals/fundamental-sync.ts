import {
  FundamentalDataQualityError,
  normalizeYahooFundamentals,
  type FundamentalDataQuality,
} from "./fundamental-normalization.ts";
import {
  FundamentalSyncLeaseLostError,
  type FundamentalSyncCommitResult,
  type FundamentalsRepository,
} from "./fundamentals-d1.ts";
import { FUNDAMENTAL_METRIC_CATALOG_VERSION } from "./fundamental-metrics.ts";
import {
  YahooFundamentalsRequestError,
  buildYahooFundamentalsRequest,
  fetchYahooFundamentals,
  type YahooFundamentalsFetchOptions,
  type YahooFundamentalsFetchResult,
  type YahooFundamentalsRequest,
} from "./yahoo-fundamentals-client.ts";
import { YAHOO_FUNDAMENTALS_SCHEMA_VERSION } from "./yahoo-fundamentals-schema.ts";

export const FUNDAMENTAL_SYNC_LEASE_MS = 5 * 60 * 1_000;

export type FundamentalSyncResult = {
  runId: string;
  ticker: string;
  fetchedAt: string;
  qualityStatus: FundamentalDataQuality;
  issueCount: number;
  periodCount: number;
  observationCount: number;
  attempts: number;
  writes: FundamentalSyncCommitResult;
};

export type FundamentalSyncServiceOptions = {
  clock?: () => Date;
  idFactory?: () => string;
  leaseMs?: number;
  fetchOptions?: YahooFundamentalsFetchOptions;
  fetchFundamentals?: (
    request: YahooFundamentalsRequest,
    options?: YahooFundamentalsFetchOptions,
  ) => Promise<YahooFundamentalsFetchResult>;
};

export class FundamentalSyncService {
  private readonly repository: FundamentalsRepository;
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly leaseMs: number;
  private readonly fetchOptions: YahooFundamentalsFetchOptions;
  private readonly fetchFundamentals: NonNullable<FundamentalSyncServiceOptions["fetchFundamentals"]>;

  constructor(
    repository: FundamentalsRepository,
    options: FundamentalSyncServiceOptions = {},
  ) {
    this.repository = repository;
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.leaseMs = clampLeaseMs(options.leaseMs ?? FUNDAMENTAL_SYNC_LEASE_MS);
    this.fetchOptions = options.fetchOptions ?? {};
    this.fetchFundamentals = options.fetchFundamentals ?? fetchYahooFundamentals;
  }

  async syncTicker(rawTicker: string): Promise<FundamentalSyncResult> {
    const startedAtDate = this.clock();
    const request = await buildYahooFundamentalsRequest(rawTicker, startedAtDate);
    const runId = this.idFactory();
    const leaseOwner = this.idFactory();
    const startedAt = startedAtDate.toISOString();
    const leaseUntil = new Date(startedAtDate.getTime() + this.leaseMs).toISOString();
    let claimed = false;

    try {
      await this.repository.claimRun({
        runId,
        ticker: request.ticker,
        requestHash: request.requestHash,
        parserVersion: YAHOO_FUNDAMENTALS_SCHEMA_VERSION,
        catalogVersion: FUNDAMENTAL_METRIC_CATALOG_VERSION,
        leaseOwner,
        leaseUntil,
        startedAt,
      });
      claimed = true;

      const fetched = await this.fetchFundamentals(request, {
        ...this.fetchOptions,
        clock: this.fetchOptions.clock ?? this.clock,
      });
      const snapshot = normalizeYahooFundamentals(fetched.parsed);
      const completedAt = this.clock().toISOString();
      const writes = await this.repository.commitSuccessfulRun({
        runId,
        leaseOwner,
        payloadHash: fetched.payloadHash,
        fetchedAt: fetched.fetchedAt,
        completedAt,
        snapshot,
      });

      return {
        runId,
        ticker: snapshot.ticker,
        fetchedAt: fetched.fetchedAt,
        qualityStatus: snapshot.qualityStatus,
        issueCount: snapshot.issueCount,
        periodCount: snapshot.periods.length,
        observationCount: snapshot.observations.length,
        attempts: fetched.attempts,
        writes,
      };
    } catch (error) {
      if (claimed) {
        const failure = classifySyncFailure(error);
        try {
          await this.repository.failRun(
            runId,
            leaseOwner,
            failure.code,
            failure.detail,
            this.clock().toISOString(),
          );
        } catch {
          // Preserve the fetch, validation, or commit error that caused the run to fail.
        }
      }
      throw error;
    }
  }
}

function classifySyncFailure(error: unknown): { code: string; detail: string } {
  if (error instanceof YahooFundamentalsRequestError) {
    return { code: `YAHOO_${error.code}`, detail: sanitizeFailureDetail(error.message) };
  }
  if (error instanceof FundamentalDataQualityError) {
    return { code: `QUALITY_${error.code}`, detail: sanitizeFailureDetail(error.message) };
  }
  if (error instanceof FundamentalSyncLeaseLostError) {
    return { code: "LEASE_LOST", detail: sanitizeFailureDetail(error.message) };
  }
  return {
    code: "SYNC_FAILED",
    detail: sanitizeFailureDetail(error instanceof Error ? error.message : "Fundamentals sync failed."),
  };
}

function sanitizeFailureDetail(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, 500);
}

function clampLeaseMs(value: number): number {
  return Math.min(15 * 60 * 1_000, Math.max(30_000, Math.trunc(value)));
}
