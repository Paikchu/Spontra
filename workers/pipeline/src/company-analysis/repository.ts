import type { AnalysisRunSummary } from "../../../../shared/analysis-contract/filings.ts";
import {
  COMPANY_ANALYSIS_PROMPT_VERSION,
  normalizeCompanyAnalysisPublication,
  type CompanyAnalysisPublication,
  type CompanyAnalysisRunStatus,
} from "./contracts.ts";

export type CompanyAnalysisD1Statement = {
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
};

export type CompanyAnalysisD1Database = {
  prepare(sql: string): { bind(...values: unknown[]): CompanyAnalysisD1Statement };
  batch(statements: CompanyAnalysisD1Statement[]): Promise<unknown[]>;
};

export type CompanyAnalysisRunUpdate = {
  analysisId: string;
  workflowInstanceId?: string;
  ticker: string;
  triggerRef: string;
  periodId: string;
  inputHash?: string;
  memoryVersion: number;
  fundamentalsDataVersion?: string;
  status: CompanyAnalysisRunStatus;
  coverageStatus?: "complete" | "partial";
  modelVersion: string;
  promptVersion: string;
  errorCode?: string;
  errorDetail?: string;
  updatedAt: string;
};

export type CompanyAnalysisBackfillCandidate = {
  analysisId?: string;
  recoveryAttempt?: number;
  expectedUpdatedAt?: string;
  waitingForData?: boolean;
  ticker: string;
  memoryJobId: string;
  memoryVersion: number;
  periodId: string;
  reportDate: string;
  triggerRef: string;
};

export const COMPANY_ANALYSIS_MAX_RECOVERIES = 3;
const RECOVERY_BACKOFF_MS = [15 * 60_000, 2 * 60 * 60_000, 8 * 60 * 60_000];

type PublicationRow = {
  analysisId: string;
  ticker: string;
  triggerRef: string;
  periodId: string;
  periodEnd: string;
  reportLabel: string;
  inputHash: string;
  memoryVersion: number;
  fundamentalsDataVersion: string;
  status: "ready";
  coverageStatus: "complete" | "partial";
  overviewJson: string;
  modelVersion: string;
  promptVersion: string;
  generatedAt: string;
};

export class D1CompanyAnalysisRepository {
  private readonly database: CompanyAnalysisD1Database;

  constructor(database: CompanyAnalysisD1Database) {
    this.database = database;
  }

  async getLatestPublication(ticker: string): Promise<CompanyAnalysisPublication | null> {
    const row = await this.database.prepare(`${publicationSelect()}
      WHERE ticker = ? AND status = 'ready'
      ORDER BY generated_at DESC, analysis_id DESC
      LIMIT 1
    `).bind(ticker).first<PublicationRow>();
    return row ? publicationFromRow(row) : null;
  }

  async getPublication(ticker: string, analysisId: string): Promise<CompanyAnalysisPublication | null> {
    const row = await this.database.prepare(`${publicationSelect()}
      WHERE ticker = ? AND analysis_id = ? AND status = 'ready'
      LIMIT 1
    `).bind(ticker, analysisId).first<PublicationRow>();
    return row ? publicationFromRow(row) : null;
  }

  async hasNewerActiveRun(ticker: string, generatedAt: string): Promise<boolean> {
    const row = await this.database.prepare(`
      SELECT analysis_id AS analysisId
      FROM company_analysis_runs
      WHERE ticker = ? AND status IN ('waiting_fundamentals', 'calculating', 'analyzing', 'validating')
        AND updated_at > ?
      LIMIT 1
    `).bind(ticker, generatedAt).first<{ analysisId: string }>();
    return Boolean(row);
  }

  /**
   * The newest run for a company, whatever state it is in — the counterpart to
   * `getLatestPublication`, which only ever sees rows that reached `ready`. Without this a failed
   * or queued first run is indistinguishable from a company nothing has ever been requested for.
   *
   * Only `error_code` is read, never `error_detail`: the detail column holds provider text and has
   * no business crossing the API boundary.
   */
  async getLatestRunSummary(ticker: string): Promise<AnalysisRunSummary> {
    const row = await this.database.prepare(`
      SELECT status, updated_at AS updatedAt, error_code AS errorCode, recovery_count AS recoveryCount
      FROM company_analysis_runs
      WHERE ticker = ?
      ORDER BY updated_at DESC, analysis_id DESC
      LIMIT 1
    `).bind(ticker).first<{ status: CompanyAnalysisRunStatus; updatedAt: string; errorCode: string | null; recoveryCount: number }>();
    if (!row) return { state: "none", updatedAt: null, errorCode: null };
    return {
      state: runStateFor(row.status),
      updatedAt: row.updatedAt ?? null,
      errorCode: row.status === "failed" && row.recoveryCount >= COMPANY_ANALYSIS_MAX_RECOVERIES
        ? "RECOVERY_EXHAUSTED" : safeErrorCode(row.status, row.errorCode),
    };
  }

  async listBackfillCandidates(tickers: string[], limit = 100, includeIncomplete = false, now = Date.now()): Promise<CompanyAnalysisBackfillCandidate[]> {
    const allowed = [...new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean))];
    if (!allowed.length) return [];
    const boundedLimit = Math.min(500, Math.max(1, Math.trunc(limit)));
    const placeholders = allowed.map(() => "?").join(", ");
    const rows = await this.database.prepare(`
      WITH ranked_memory AS (
        SELECT j.job_id AS memoryJobId, j.ticker, j.period_id AS periodId,
          p.end_date AS reportDate,
          ROW_NUMBER() OVER (
            PARTITION BY j.ticker
            ORDER BY p.end_date DESC, j.completed_at DESC, j.job_id DESC
          ) AS memoryRank
        FROM sec_memory_jobs j
        JOIN sec_periods p ON p.period_id = j.period_id AND p.ticker = j.ticker
        WHERE j.status = 'complete' AND j.ticker IN (${placeholders})
      )
      SELECT m.ticker, m.memoryJobId, t.version AS memoryVersion,
        m.periodId, m.reportDate, r.analysis_id AS analysisId,
        r.trigger_ref AS recoveryTriggerRef, r.status AS runStatus, r.prompt_version AS runPromptVersion,
        r.recovery_count AS recoveryCount, r.updated_at AS expectedUpdatedAt
      FROM ranked_memory m
      JOIN sec_company_memory_threads t ON t.ticker = m.ticker
      LEFT JOIN company_analysis_runs r ON r.analysis_id = (
        SELECT prior.analysis_id FROM company_analysis_runs prior
        WHERE prior.ticker = m.ticker AND prior.period_id = m.periodId AND prior.memory_version = t.version
        ORDER BY prior.updated_at DESC, prior.analysis_id DESC LIMIT 1
      )
      WHERE m.memoryRank = 1
        AND (r.analysis_id IS NULL OR r.status IN ('failed', 'insufficient_data')
          OR (r.status = 'ready' AND r.prompt_version <> ?))
        AND NOT EXISTS (
          SELECT 1 FROM company_analysis_runs done
          WHERE done.ticker = m.ticker AND done.period_id = m.periodId
            AND done.memory_version = t.version AND done.status = 'ready' AND done.prompt_version = ?
        )
      ORDER BY COALESCE(r.updated_at, ''), m.ticker
    `).bind(...allowed, COMPANY_ANALYSIS_PROMPT_VERSION, COMPANY_ANALYSIS_PROMPT_VERSION).all<Omit<CompanyAnalysisBackfillCandidate, "triggerRef" | "expectedUpdatedAt"> & {
      analysisId: string | null;
      recoveryTriggerRef: string | null;
      runStatus: CompanyAnalysisRunStatus | null;
      runPromptVersion: string | null;
      recoveryCount: number | null;
      expectedUpdatedAt: string | null;
    }>();
    return rows.results.filter((row) => {
      if (!row.analysisId || includeIncomplete || row.runStatus === "insufficient_data" || row.runStatus === "ready") return true;
      const count = row.recoveryCount ?? 0;
      return count < COMPANY_ANALYSIS_MAX_RECOVERIES
        && now - Date.parse(row.expectedUpdatedAt ?? "") >= RECOVERY_BACKOFF_MS[count]!;
    }).slice(0, boundedLimit).map((row) => {
      const { recoveryTriggerRef, analysisId, runStatus, runPromptVersion, recoveryCount, expectedUpdatedAt, ...candidate } = row;
      const revision = runStatus === "ready" && runPromptVersion !== COMPANY_ANALYSIS_PROMPT_VERSION;
      return {
        ...candidate,
        ...(analysisId && !revision ? {
          analysisId,
          // Waiting for data is not a failed model attempt and does not consume the retry budget.
          recoveryAttempt: (recoveryCount ?? 0) + (runStatus === "failed" ? 1 : 0),
          expectedUpdatedAt: expectedUpdatedAt!,
          waitingForData: runStatus === "insufficient_data",
        } : {}),
        triggerRef: revision
          ? `${row.memoryJobId}:${row.memoryVersion}:${COMPANY_ANALYSIS_PROMPT_VERSION}`
          : recoveryTriggerRef || `${row.memoryJobId}:${row.memoryVersion}`,
      };
    });
  }

  /**
   * The trigger one ticker needs to be analysed again, without the exclusion `listBackfillCandidates`
   * applies.
   *
   * The sweep upgrades older reports at a bounded rate. This endpoint lets an operator request
   * one company's current version immediately and ask for a fresh read of changing web evidence.
   *
   * Recovery fields are absent on purpose. A manual run is a fresh attempt, not a retry of a failed
   * one, and must not consume that ticker's recovery budget.
   */
  async findAnalysisTrigger(ticker: string): Promise<CompanyAnalysisBackfillCandidate | null> {
    const symbol = ticker.trim().toUpperCase();
    if (!symbol) return null;
    const row = await this.database.prepare(`
      SELECT j.job_id AS memoryJobId, j.period_id AS periodId,
        p.end_date AS reportDate, t.version AS memoryVersion
      FROM sec_memory_jobs j
      JOIN sec_periods p ON p.period_id = j.period_id AND p.ticker = j.ticker
      JOIN sec_company_memory_threads t ON t.ticker = j.ticker
      WHERE j.status = 'complete' AND j.ticker = ?
      ORDER BY p.end_date DESC, j.completed_at DESC, j.job_id DESC
      LIMIT 1
    `).bind(symbol).first<{ memoryJobId: string; periodId: string; reportDate: string; memoryVersion: number }>();
    if (!row) return null;
    return {
      ticker: symbol,
      memoryJobId: row.memoryJobId,
      memoryVersion: row.memoryVersion,
      periodId: row.periodId,
      reportDate: row.reportDate,
      // The same shape the sweep builds, so the workflow cannot tell the two apart.
      triggerRef: `${row.memoryJobId}:${row.memoryVersion}`,
    };
  }

  /** Atomic ownership at execution time. A duplicate enqueue cannot start a second Agent. */
  async beginRun(update: CompanyAnalysisRunUpdate & { workflowInstanceId: string }, recoveryAttempt: number, expectedUpdatedAt?: string): Promise<boolean> {
    const row = await this.database.prepare(`
      INSERT INTO company_analysis_runs (
        analysis_id, ticker, trigger_ref, period_id, memory_version, status,
        model_version, prompt_version, updated_at, workflow_instance_id, recovery_count
      ) VALUES (?, ?, ?, ?, ?, 'waiting_fundamentals', ?, ?, ?, ?, ?)
      ON CONFLICT(trigger_ref) DO UPDATE SET
        status = 'waiting_fundamentals', model_version = excluded.model_version,
        prompt_version = excluded.prompt_version, updated_at = excluded.updated_at,
        workflow_instance_id = excluded.workflow_instance_id, recovery_count = excluded.recovery_count,
        error_code = NULL, error_detail = NULL
      WHERE company_analysis_runs.analysis_id = excluded.analysis_id
        AND company_analysis_runs.status IN ('failed', 'insufficient_data')
        AND company_analysis_runs.updated_at = ?
      RETURNING analysis_id AS analysisId
    `).bind(update.analysisId, update.ticker, update.triggerRef, update.periodId, update.memoryVersion,
      update.modelVersion, update.promptVersion, update.updatedAt, update.workflowInstanceId,
      recoveryAttempt, expectedUpdatedAt ?? null).first<{ analysisId: string }>();
    if (row) return true;
    // The DB write may have succeeded before a step response was lost. Replaying that step is safe.
    return Boolean(await this.database.prepare(`
      SELECT analysis_id FROM company_analysis_runs
      WHERE analysis_id = ? AND workflow_instance_id = ?
        AND status IN ('waiting_fundamentals', 'calculating', 'analyzing', 'validating')
    `).bind(update.analysisId, update.workflowInstanceId).first());
  }

  async listActiveExecutions(tickers: string[], before: string): Promise<Array<{ analysisId: string; workflowInstanceId: string }>> {
    if (!tickers.length) return [];
    const rows = await this.database.prepare(`
      SELECT analysis_id AS analysisId, workflow_instance_id AS workflowInstanceId
      FROM company_analysis_runs
      WHERE ticker IN (${tickers.map(() => "?").join(",")}) AND workflow_instance_id IS NOT NULL
        AND status IN ('waiting_fundamentals', 'calculating', 'analyzing', 'validating')
        AND updated_at < ? ORDER BY updated_at LIMIT 100
    `).bind(...tickers, before).all<{ analysisId: string; workflowInstanceId: string }>();
    return rows.results;
  }

  /** Reconcile only a confirmed terminal platform instance, never infer death from age alone. */
  async markStoppedExecution(analysisId: string, workflowInstanceId: string, now: string): Promise<void> {
    await this.database.prepare(`
      UPDATE company_analysis_runs SET status = 'failed', error_code = 'WORKFLOW_STOPPED', updated_at = ?
      WHERE analysis_id = ? AND workflow_instance_id = ?
        AND status IN ('waiting_fundamentals', 'calculating', 'analyzing', 'validating')
    `).bind(now, analysisId, workflowInstanceId).run();
  }

  async upsertRun(update: CompanyAnalysisRunUpdate): Promise<void> {
    await this.database.prepare(`
      INSERT INTO company_analysis_runs (
        analysis_id, ticker, trigger_ref, period_id, input_hash, memory_version,
        fundamentals_data_version, status, coverage_status, model_version,
        prompt_version, error_code, error_detail, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(analysis_id) DO UPDATE SET
        input_hash = COALESCE(excluded.input_hash, company_analysis_runs.input_hash),
        fundamentals_data_version = COALESCE(excluded.fundamentals_data_version, company_analysis_runs.fundamentals_data_version),
        status = excluded.status,
        coverage_status = COALESCE(excluded.coverage_status, company_analysis_runs.coverage_status),
        error_code = excluded.error_code,
        error_detail = excluded.error_detail,
        updated_at = excluded.updated_at
      WHERE company_analysis_runs.status <> 'ready'
        AND (? IS NULL OR company_analysis_runs.workflow_instance_id = ?)
    `).bind(
      update.analysisId,
      update.ticker,
      update.triggerRef,
      update.periodId,
      update.inputHash ?? null,
      update.memoryVersion,
      update.fundamentalsDataVersion ?? null,
      update.status,
      update.coverageStatus ?? null,
      update.modelVersion,
      update.promptVersion,
      update.errorCode ?? null,
      update.errorDetail?.slice(0, 1_000) ?? null,
      update.updatedAt,
      update.workflowInstanceId ?? null,
      update.workflowInstanceId ?? null,
    ).run();
  }

  async publish(publicationInput: unknown): Promise<{ duplicate: boolean; publication: CompanyAnalysisPublication }> {
    const publication = normalizeCompanyAnalysisPublication(publicationInput);
    const existing = await this.getPublication(publication.ticker, publication.analysisId);
    if (existing) {
      if (existing.inputHash !== publication.inputHash) {
        throw new Error("Published company analysis is immutable.");
      }
      return { duplicate: true, publication: existing };
    }
    await this.database.prepare(`
      INSERT INTO company_analysis_runs (
        analysis_id, ticker, trigger_ref, period_id, period_end, report_label,
        input_hash, memory_version, fundamentals_data_version, status,
        coverage_status, overview_json, model_version, prompt_version,
        generated_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(analysis_id) DO UPDATE SET
        period_end = excluded.period_end,
        report_label = excluded.report_label,
        input_hash = excluded.input_hash,
        fundamentals_data_version = excluded.fundamentals_data_version,
        status = excluded.status,
        coverage_status = excluded.coverage_status,
        overview_json = excluded.overview_json,
        model_version = excluded.model_version,
        prompt_version = excluded.prompt_version,
        generated_at = excluded.generated_at,
        updated_at = excluded.updated_at
      WHERE company_analysis_runs.status <> 'ready'
    `).bind(
      publication.analysisId,
      publication.ticker,
      publication.triggerRef,
      publication.periodId,
      publication.periodEnd,
      publication.reportLabel,
      publication.inputHash,
      publication.memoryVersion,
      publication.fundamentalsDataVersion,
      publication.coverageStatus,
      JSON.stringify(publication.overview),
      publication.modelVersion,
      publication.promptVersion,
      publication.generatedAt,
      publication.generatedAt,
    ).run();
    const stored = await this.getPublication(publication.ticker, publication.analysisId);
    if (!stored) throw new Error("Company analysis publication was not committed.");
    if (stored.inputHash !== publication.inputHash) {
      throw new Error("Published company analysis is immutable.");
    }
    return { duplicate: false, publication: stored };
  }
}

function runStateFor(status: CompanyAnalysisRunStatus): AnalysisRunSummary["state"] {
  if (status === "ready") return "succeeded";
  if (status === "failed" || status === "insufficient_data") return "failed";
  // `waiting_fundamentals` is the run sitting in line for its inputs, not yet doing work.
  return status === "waiting_fundamentals" ? "queued" : "running";
}

/**
 * Error codes are published; error details are not. A stored code is additionally bounded to the
 * shape a machine code has, so a value that somehow carried prose is dropped rather than echoed.
 */
function safeErrorCode(status: CompanyAnalysisRunStatus, errorCode: string | null): string | null {
  if (runStateFor(status) !== "failed") return null;
  if (status === "insufficient_data" && !errorCode) return "INSUFFICIENT_DATA";
  const code = (errorCode ?? "").trim();
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(code) ? code : errorCode ? "ANALYSIS_FAILED" : null;
}

function publicationSelect(): string {
  return `
    SELECT analysis_id AS analysisId, ticker, trigger_ref AS triggerRef,
      period_id AS periodId, period_end AS periodEnd, report_label AS reportLabel,
      input_hash AS inputHash, memory_version AS memoryVersion,
      fundamentals_data_version AS fundamentalsDataVersion, status,
      coverage_status AS coverageStatus, overview_json AS overviewJson,
      model_version AS modelVersion, prompt_version AS promptVersion,
      generated_at AS generatedAt
    FROM company_analysis_runs
  `;
}

function publicationFromRow(row: PublicationRow): CompanyAnalysisPublication {
  return normalizeCompanyAnalysisPublication({
    schemaVersion: "company-analysis.v1",
    ...row,
    overview: JSON.parse(row.overviewJson),
  });
}
