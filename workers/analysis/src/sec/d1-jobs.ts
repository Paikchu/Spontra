import type { D1Like } from "./d1-support.ts";

export type SecAnalysisJobUpdate = {
  jobId: string;
  ticker: string;
  accessionNumber: string;
  analysisVersion: string;
  status: "queued" | "running" | "complete" | "failed";
  currentStage: string;
  attempt: number;
  errorCode?: string;
  errorDetail?: string;
  requestedBy: "scheduled" | "manual";
  workflowInstanceId: string;
  updatedAt: string;
  completedAt?: string;
};

export type SecAnalysisJobStatus = SecAnalysisJobUpdate["status"];

/**
 * How long a job may sit in a non-terminal state before another run is allowed to take it over.
 *
 * Model progress renews the row at least every 30 seconds; a
 * workflow that dies in between — the model provider rate-limiting a whole batch does exactly this
 * — leaves `running` as the newest row for that filing forever. `shouldAnalyze` only proceeds on a
 * missing or `failed` status, so without a lease that filing is skipped by every later scheduled
 * run and silently stops being re-analysed.
 *
 * This covers a full 60-minute step plus backoff. It is not a total report-duration limit.
 */
export const SEC_ANALYSIS_JOB_LEASE_MS = 2 * 60 * 60 * 1_000;

/**
 * Job error codes are published; job error details are not. A stored value that does not look like
 * a machine code is reduced to a generic one rather than echoed to a reader.
 */
function safeJobErrorCode(status: SecAnalysisJobStatus | null, errorCode: string | null): string | null {
  if (status !== "failed") return null;
  const code = (errorCode ?? "").trim();
  if (!code) return null;
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(code) ? code : "ANALYSIS_FAILED";
}

export class SecAnalysisJobRepository {
  private readonly database: D1Like;

  constructor(database: D1Like) { this.database = database; }

  async upsertAnalysisJob(job: SecAnalysisJobUpdate): Promise<void> {
    await this.database.prepare(`
      INSERT INTO sec_analysis_jobs (
        job_id, ticker, accession_number, analysis_version, status, current_stage,
        attempt, error_code, error_detail, requested_by, workflow_instance_id,
        updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        status = excluded.status,
        current_stage = excluded.current_stage,
        attempt = excluded.attempt,
        error_code = excluded.error_code,
        error_detail = excluded.error_detail,
        requested_by = excluded.requested_by,
        workflow_instance_id = excluded.workflow_instance_id,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at
    `).bind(
      job.jobId,
      job.ticker,
      job.accessionNumber,
      job.analysisVersion,
      job.status,
      job.currentStage,
      job.attempt,
      job.errorCode ?? null,
      job.errorDetail ?? null,
      job.requestedBy,
      job.workflowInstanceId,
      job.updatedAt,
      job.completedAt ?? null,
    ).run();
  }

  async getAnalysisJobStatus(
    ticker: string,
    accessionNumber: string,
    analysisVersion: string,
    now = Date.now(),
  ): Promise<SecAnalysisJobStatus | null> {
    const row = await this.database.prepare(`
      SELECT status, updated_at AS updatedAt
      FROM sec_analysis_jobs
      WHERE ticker = ? AND accession_number = ? AND analysis_version = ?
      ORDER BY CASE WHEN status IN ('running', 'queued') AND updated_at >= ? THEN 0 ELSE 1 END, updated_at DESC
      LIMIT 1
    `).bind(ticker, accessionNumber, analysisVersion, new Date(now - SEC_ANALYSIS_JOB_LEASE_MS).toISOString()).first<{ status: SecAnalysisJobStatus; updatedAt: string }>();
    if (!row) return null;
    // Reported as failed rather than dropped to null so the caller keeps treating it as a job that
    // ran and did not finish, which is what an expired lease means.
    return isExpiredJobLease(row.status, row.updatedAt, now) ? "failed" : row.status;
  }

  async getLatestAnalysisJobStatus(ticker: string, accessionNumber: string): Promise<SecAnalysisJobStatus | null> {
    return (await this.getLatestAnalysisJobSummary(ticker, accessionNumber)).status;
  }

  /**
   * The newest analysis job for a filing, with the two extra columns a reader needs to tell a
   * failed run from a filing nothing ever ran against. `getLatestAnalysisJobStatus` keeps its
   * signature and delegates here, so the same single query serves both and paging a filing list
   * still costs exactly one job lookup per filing.
   *
   * `error_detail` is deliberately not selected: it can hold a provider message, and nothing
   * outside this Worker has any business seeing one.
   */
  async getLatestAnalysisJobSummary(ticker: string, accessionNumber: string): Promise<{
    status: SecAnalysisJobStatus | null;
    updatedAt: string | null;
    errorCode: string | null;
  }> {
    const row = await this.database.prepare(`
      SELECT status, updated_at AS updatedAt, error_code AS errorCode
      FROM sec_analysis_jobs
      WHERE ticker = ? AND accession_number = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).bind(ticker, accessionNumber).first<{ status: SecAnalysisJobStatus; updatedAt: string | null; errorCode: string | null }>();
    if (!row) return { status: null, updatedAt: null, errorCode: null };
    return { status: row.status, updatedAt: row.updatedAt ?? null, errorCode: safeJobErrorCode(row.status, row.errorCode) };
  }

}

/**
 * A `queued` or `running` row older than the lease belongs to a workflow that never wrote its
 * terminal state. An unparseable timestamp keeps the stored status: a row that cannot be dated
 * must not be handed to a second workflow on a guess.
 */
function isExpiredJobLease(status: SecAnalysisJobStatus, updatedAt: string, now: number): boolean {
  if (status !== "queued" && status !== "running") return false;
  const updated = Date.parse(updatedAt);
  return Number.isFinite(updated) && now - updated > SEC_ANALYSIS_JOB_LEASE_MS;
}
