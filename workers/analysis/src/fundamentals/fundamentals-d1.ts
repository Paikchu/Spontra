import type {
  FundamentalDataQuality,
  NormalizedFundamentalObservation,
  NormalizedFundamentalsSnapshot,
} from "./fundamental-normalization.ts";
import type { FundamentalMetricKey, FundamentalUnitFamily } from "./fundamental-metrics.ts";
import type { YahooFundamentalPeriodType } from "./yahoo-fundamentals-schema.ts";

export type FundamentalsD1Statement = {
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
};

export type FundamentalsD1Database = {
  prepare(sql: string): {
    bind(...values: unknown[]): FundamentalsD1Statement;
  };
  batch(statements: FundamentalsD1Statement[]): Promise<unknown[]>;
};

export type FundamentalSyncRunClaim = {
  runId: string;
  ticker: string;
  requestHash: string;
  parserVersion: string;
  catalogVersion: string;
  leaseOwner: string;
  leaseUntil: string;
  startedAt: string;
};

export type FundamentalSyncCommit = {
  runId: string;
  leaseOwner: string;
  payloadHash: string;
  fetchedAt: string;
  completedAt: string;
  snapshot: NormalizedFundamentalsSnapshot;
};

export type FundamentalSyncCommitResult = {
  inserted: number;
  confirmed: number;
  revised: number;
};

export type FundamentalCurrentObservation = {
  observationId: string;
  periodId: string;
  ticker: string;
  periodType: YahooFundamentalPeriodType;
  periodEnd: string;
  metricKey: FundamentalMetricKey;
  sourceField: string | null;
  valueDecimal: string;
  unitFamily: FundamentalUnitFamily;
  unit: string;
  currency: string;
  basis: "reported" | "derived";
  derivationFormula: string | null;
  derivationVersion: string | null;
  sourceRunId: string;
  revision: number;
  updatedAt: string;
};

export type FundamentalLastGoodSnapshot = {
  ticker: string;
  runId: string;
  fetchedAt: string;
  qualityStatus: FundamentalDataQuality;
  parserVersion: string;
  catalogVersion: string;
  payloadHash: string;
  issueCount: number;
  observations: FundamentalCurrentObservation[];
};

export interface FundamentalsRepository {
  claimRun(input: FundamentalSyncRunClaim): Promise<void>;
  failRun(runId: string, leaseOwner: string, errorCode: string, errorDetail: string, completedAt: string): Promise<void>;
  commitSuccessfulRun(input: FundamentalSyncCommit): Promise<FundamentalSyncCommitResult>;
  getLastGoodSnapshot(ticker: string): Promise<FundamentalLastGoodSnapshot | null>;
}

export class FundamentalSyncInProgressError extends Error {
  readonly ticker: string;

  constructor(ticker: string) {
    super(`A fundamentals sync is already running for ${ticker}.`);
    this.name = "FundamentalSyncInProgressError";
    this.ticker = ticker;
  }
}

export class FundamentalSyncLeaseLostError extends Error {
  constructor(runId: string) {
    super(`Fundamentals sync lease is no longer active for run ${runId}.`);
    this.name = "FundamentalSyncLeaseLostError";
  }
}

type ExistingObservationRow = {
  observationId: string;
  periodId: string;
  metricKey: FundamentalMetricKey;
  valueDecimal: string;
  revision: number;
};

type LatestSuccessRow = {
  runId: string;
  ticker: string;
  fetchedAt: string;
  qualityStatus: FundamentalDataQuality;
  parserVersion: string;
  catalogVersion: string;
  payloadHash: string;
  issueCount: number;
};

export class D1FundamentalsRepository implements FundamentalsRepository {
  private readonly database: FundamentalsD1Database;

  constructor(database: FundamentalsD1Database) {
    this.database = database;
  }

  async claimRun(input: FundamentalSyncRunClaim): Promise<void> {
    try {
      await this.database.batch([
        this.database.prepare(`
          UPDATE fundamental_fetch_runs
          SET status = 'failed', quality_status = 'rejected', completed_at = ?,
            error_code = 'LEASE_EXPIRED', error_detail = 'Previous fundamentals sync lease expired.',
            lease_owner = NULL, lease_until = NULL
          WHERE ticker = ? AND status = 'running' AND lease_until IS NOT NULL AND lease_until <= ?
        `).bind(input.startedAt, input.ticker, input.startedAt),
        this.database.prepare(`
          INSERT INTO fundamental_fetch_runs (
            run_id, ticker, source, status, quality_status, request_hash,
            parser_version, catalog_version, lease_owner, lease_until, started_at
          ) VALUES (?, ?, 'yahoo_finance', 'running', 'pending', ?, ?, ?, ?, ?, ?)
        `).bind(
          input.runId,
          input.ticker,
          input.requestHash,
          input.parserVersion,
          input.catalogVersion,
          input.leaseOwner,
          input.leaseUntil,
          input.startedAt,
        ),
      ]);
    } catch (error) {
      const active = await this.database.prepare(`
        SELECT run_id AS runId
        FROM fundamental_fetch_runs
        WHERE ticker = ? AND status = 'running' AND lease_until > ?
        LIMIT 1
      `).bind(input.ticker, input.startedAt).first<{ runId: string }>();
      if (active) throw new FundamentalSyncInProgressError(input.ticker);
      throw error;
    }
  }

  async failRun(
    runId: string,
    leaseOwner: string,
    errorCode: string,
    errorDetail: string,
    completedAt: string,
  ): Promise<void> {
    await this.database.prepare(`
      UPDATE fundamental_fetch_runs
      SET status = 'failed', quality_status = 'rejected', completed_at = ?,
        error_code = ?, error_detail = ?, lease_owner = NULL, lease_until = NULL
      WHERE run_id = ? AND status = 'running' AND lease_owner = ?
    `).bind(completedAt, errorCode, errorDetail, runId, leaseOwner).run();
  }

  async commitSuccessfulRun(input: FundamentalSyncCommit): Promise<FundamentalSyncCommitResult> {
    const activeRun = await this.database.prepare(`
      SELECT run_id AS runId
      FROM fundamental_fetch_runs
      WHERE run_id = ? AND status = 'running' AND lease_owner = ? AND lease_until > ?
      LIMIT 1
    `).bind(input.runId, input.leaseOwner, input.completedAt).first<{ runId: string }>();
    if (!activeRun) throw new FundamentalSyncLeaseLostError(input.runId);

    const existing = await this.database.prepare(`
      SELECT observation_id AS observationId, period_id AS periodId, metric_key AS metricKey,
        value_decimal AS valueDecimal, revision
      FROM fundamental_observations
      WHERE ticker = ?
    `).bind(input.snapshot.ticker).all<ExistingObservationRow>();
    const existingByIdentity = new Map(existing.results.map((row) => [identityKey(row.periodId, row.metricKey), row]));
    const statements: FundamentalsD1Statement[] = [];
    let inserted = 0;
    let confirmed = 0;
    let revised = 0;

    for (const period of input.snapshot.periods) {
      statements.push(this.database.prepare(`
        INSERT INTO fundamental_periods (
          period_id, ticker, source, period_type, period_end, currency, updated_at
        )
        SELECT ?, ?, 'yahoo_finance', ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM fundamental_fetch_runs
          WHERE run_id = ? AND status = 'running' AND lease_owner = ? AND lease_until > ?
        )
        ON CONFLICT(ticker, period_type, period_end) DO UPDATE SET
          currency = excluded.currency, updated_at = excluded.updated_at
      `).bind(
        period.periodId,
        period.ticker,
        period.periodType,
        period.periodEnd,
        period.currency,
        input.completedAt,
        input.runId,
        input.leaseOwner,
        input.completedAt,
      ));
    }

    for (const observation of input.snapshot.observations) {
      const previous = existingByIdentity.get(identityKey(observation.periodId, observation.metricKey));
      const valueChanged = previous !== undefined && previous.valueDecimal !== observation.valueDecimal;
      const revision = previous ? previous.revision + (valueChanged ? 1 : 0) : 1;

      if (!previous) inserted += 1;
      else if (valueChanged) revised += 1;
      else confirmed += 1;

      statements.push(this.observationUpsertStatement(
        observation,
        input.runId,
        input.leaseOwner,
        revision,
        input.completedAt,
      ));
    }

    statements.push(this.database.prepare(`
      UPDATE fundamental_fetch_runs
      SET status = 'success', quality_status = ?, payload_hash = ?, fetched_at = ?, completed_at = ?,
        issue_count = ?, observation_count = ?, period_count = ?, error_code = NULL, error_detail = NULL,
        lease_owner = NULL, lease_until = NULL
      WHERE run_id = ? AND status = 'running' AND lease_owner = ? AND lease_until > ?
    `).bind(
      input.snapshot.qualityStatus,
      input.payloadHash,
      input.fetchedAt,
      input.completedAt,
      input.snapshot.issueCount,
      input.snapshot.observations.length,
      input.snapshot.periods.length,
      input.runId,
      input.leaseOwner,
      input.completedAt,
    ));

    await this.database.batch(statements);
    const committed = await this.database.prepare(`
      SELECT run_id AS runId
      FROM fundamental_fetch_runs
      WHERE run_id = ? AND status = 'success'
      LIMIT 1
    `).bind(input.runId).first<{ runId: string }>();
    if (!committed) throw new FundamentalSyncLeaseLostError(input.runId);
    return { inserted, confirmed, revised };
  }

  /**
   * When each of these tickers last had a successful fetch, for the scheduled staleness sweep.
   * One query for the whole watchlist rather than one snapshot read per ticker: the snapshot read
   * pulls every observation a company has, which is far more than "when did this last succeed"
   * needs, and the sweep runs on every Cron tick.
   *
   * A ticker with no successful run at all comes back with `fetchedAt: null` rather than being
   * omitted, because "never fetched" is precisely the case the sweep exists to fix.
   */
  async listFundamentalsFreshness(tickers: string[]): Promise<Array<{ ticker: string; fetchedAt: string | null }>> {
    const wanted = [...new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean))];
    if (!wanted.length) return [];
    const placeholders = wanted.map(() => "?").join(", ");
    const rows = await this.database.prepare(`
      SELECT ticker, MAX(fetched_at) AS fetchedAt
      FROM fundamental_fetch_runs
      WHERE status = 'success' AND ticker IN (${placeholders})
      GROUP BY ticker
    `).bind(...wanted).all<{ ticker: string; fetchedAt: string | null }>();
    const byTicker = new Map(rows.results.map((row) => [row.ticker, row.fetchedAt ?? null]));
    return wanted.map((ticker) => ({ ticker, fetchedAt: byTicker.get(ticker) ?? null }));
  }

  async listFundamentalsAttempts(tickers: string[]): Promise<Array<{ ticker: string; lastAttemptAt: string; leaseUntil: string | null }>> {
    if (!tickers.length) return [];
    const rows = await this.database.prepare(`
      SELECT ticker, MAX(started_at) AS lastAttemptAt,
        MAX(CASE WHEN status = 'running' THEN lease_until END) AS leaseUntil
      FROM fundamental_fetch_runs
      WHERE ticker IN (${tickers.map(() => "?").join(", ")})
      GROUP BY ticker
    `).bind(...tickers).all<{ ticker: string; lastAttemptAt: string; leaseUntil: string | null }>();
    return rows.results;
  }

  async getLastGoodSnapshot(ticker: string): Promise<FundamentalLastGoodSnapshot | null> {
    const latest = await this.database.prepare(`
      SELECT run_id AS runId, ticker, fetched_at AS fetchedAt, quality_status AS qualityStatus,
        parser_version AS parserVersion, catalog_version AS catalogVersion,
        payload_hash AS payloadHash, issue_count AS issueCount
      FROM fundamental_fetch_runs
      WHERE ticker = ? AND status = 'success'
      ORDER BY fetched_at DESC, completed_at DESC
      LIMIT 1
    `).bind(ticker).first<LatestSuccessRow>();
    if (!latest) return null;

    const rows = await this.database.prepare(`
      SELECT observation_id AS observationId, o.period_id AS periodId, o.ticker,
        p.period_type AS periodType, o.period_end AS periodEnd, metric_key AS metricKey,
        source_field AS sourceField, value_decimal AS valueDecimal, unit_family AS unitFamily,
        unit, o.currency, basis, derivation_formula AS derivationFormula,
        derivation_version AS derivationVersion, source_run_id AS sourceRunId,
        revision, o.updated_at AS updatedAt
      FROM fundamental_observations o
      JOIN fundamental_periods p ON p.period_id = o.period_id
      WHERE o.ticker = ?
      ORDER BY o.period_end ASC, metric_key ASC
    `).bind(ticker).all<FundamentalCurrentObservation>();

    return { ...latest, observations: rows.results };
  }

  private observationUpsertStatement(
    observation: NormalizedFundamentalObservation,
    sourceRunId: string,
    leaseOwner: string,
    revision: number,
    updatedAt: string,
  ): FundamentalsD1Statement {
    return this.database.prepare(`
      INSERT INTO fundamental_observations (
        observation_id, period_id, ticker, period_end, metric_key, source_field,
        value_decimal, unit_family, unit, currency, basis, derivation_formula,
        derivation_version, source_run_id, revision, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM fundamental_fetch_runs
        WHERE run_id = ? AND status = 'running' AND lease_owner = ? AND lease_until > ?
      )
      ON CONFLICT(period_id, metric_key) DO UPDATE SET
        ticker = excluded.ticker, period_end = excluded.period_end,
        source_field = excluded.source_field, value_decimal = excluded.value_decimal,
        unit_family = excluded.unit_family, unit = excluded.unit, currency = excluded.currency,
        basis = excluded.basis, derivation_formula = excluded.derivation_formula,
        derivation_version = excluded.derivation_version, source_run_id = excluded.source_run_id,
        revision = excluded.revision, updated_at = excluded.updated_at
    `).bind(
      observation.observationId,
      observation.periodId,
      observation.ticker,
      observation.periodEnd,
      observation.metricKey,
      observation.sourceField,
      observation.valueDecimal,
      observation.unitFamily,
      observation.unit,
      observation.currency,
      observation.basis,
      observation.derivationFormula,
      observation.derivationVersion,
      sourceRunId,
      revision,
      updatedAt,
      sourceRunId,
      leaseOwner,
      updatedAt,
    );
  }
}

function identityKey(periodId: string, metricKey: string): string {
  return `${periodId}\u0000${metricKey}`;
}
