import type { FinancialMaintenanceTask, FinancialMaintenanceTaskStatus } from "../../../../shared/analysis-contract/financial-maintenance.ts";
import type { D1Like } from "../sec/d1-support.ts";

export type MaintenanceState = {
  cik?: string; name?: string; collectionJobId?: string; generation?: number;
  waitingCik?: string;
  workflowId?: string; backupKey?: string;
};
export type MaintenanceRow = {
  task_id: string; request_id: string; ticker: string; cik: string | null; action: "extract" | "analyze";
  accession_number: string | null; retry_of: string | null; status: FinancialMaintenanceTaskStatus;
  stage: string; state_json: string; issues_json: string; error_code: string | null;
  completed_steps: number; total_steps: number; attempt: number; lease_token: string | null; lease_until: string | null;
  created_at: string; updated_at: string; completed_at: string | null;
};
export const MAINTENANCE_LEASE_MS = 5 * 60_000;
export const ACTIVE_MAINTENANCE = ["queued", "running", "cancel_requested"];
export function taskView(row: MaintenanceRow): FinancialMaintenanceTask {
  return { id: row.task_id, ticker: row.ticker, action: row.action, accessionNumber: row.accession_number,
    status: row.status, stage: row.stage, createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at,
    errorCode: row.error_code, issues: JSON.parse(row.issues_json), progress: { completed: row.completed_steps, total: row.total_steps },
    canRetry: ["failed", "partial", "cancelled"].includes(row.status), canCancel: ["queued", "running"].includes(row.status) && !["analysis_dispatch", "analysis_wait"].includes(row.stage) };
}

export class FinancialMaintenanceStore {
  readonly db: D1Like;
  constructor(db: D1Like) { this.db = db; }
  async get(id: string) { return this.db.prepare("SELECT * FROM financial_maintenance_tasks WHERE task_id = ?").bind(id).first<MaintenanceRow>(); }
  async byRequest(id: string) { return this.db.prepare("SELECT * FROM financial_maintenance_tasks WHERE request_id = ?").bind(id).first<MaintenanceRow>(); }
  async list(ticker: string) { return (await this.db.prepare("SELECT * FROM financial_maintenance_tasks WHERE ticker = ? ORDER BY created_at DESC, task_id DESC LIMIT 30").bind(ticker).all<MaintenanceRow>()).results; }
  async active(ticker: string) { return this.db.prepare("SELECT * FROM financial_maintenance_tasks WHERE ticker = ? AND status IN ('queued','running','cancel_requested')").bind(ticker).first<MaintenanceRow>(); }
  async hasActiveTasks() { return Boolean(await this.db.prepare("SELECT task_id FROM financial_maintenance_tasks WHERE status IN ('queued','running','cancel_requested') LIMIT 1").bind().first()); }
  async hasActiveDataTasks() {
    return Boolean(await this.db.prepare(`SELECT task_id FROM financial_maintenance_tasks
      WHERE status IN ('queued','running','cancel_requested') AND stage NOT IN ('analysis_dispatch','analysis_wait')
        AND NOT (stage='waiting_issuer' AND status='queued') LIMIT 1`).bind().first());
  }
  async claimIssuer(row: MaintenanceRow, cik: string, now: Date): Promise<boolean> {
    if (!/^\d{10}$/.test(cik)) throw new Error("ISSUER_IDENTITY_MISMATCH");
    // OR IGNORE and the partial unique index make this atomic across isolates. Ordinary share
    // class contention is a wait, not a source failure, and cannot reset the other task's cursor.
    return Boolean(await this.db.prepare(`UPDATE OR IGNORE financial_maintenance_tasks SET cik=?
      WHERE task_id=? AND lease_token=? AND status='running' AND lease_until>? RETURNING task_id`)
      .bind(cik,row.task_id,row.lease_token,now.toISOString()).first());
  }
  async create(input: { requestId: string; ticker: string; action: "extract" | "analyze"; accessionNumber?: string; retryOf?: string }, now: Date) {
    return this.db.prepare(`INSERT INTO financial_maintenance_tasks
      (task_id,request_id,ticker,action,accession_number,retry_of,status,total_steps,next_attempt_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'queued',?,?,?,?) ON CONFLICT DO NOTHING RETURNING *`)
      .bind(input.requestId, input.requestId, input.ticker, input.action, input.accessionNumber ?? null, input.retryOf ?? null,
        input.action === "analyze" ? 5 : 4, now.toISOString(), now.toISOString(), now.toISOString()).first<MaintenanceRow>();
  }
  async cancel(id: string, now: Date) {
    // An active call completes at its next checkpoint. A request cannot erase a completed result.
    await this.db.prepare(`UPDATE financial_maintenance_tasks SET status=CASE WHEN lease_until>? THEN 'cancel_requested' ELSE 'cancelled' END,
      completed_at=CASE WHEN lease_until>? THEN NULL ELSE ? END,updated_at=?
      WHERE task_id=? AND status IN ('queued','running') AND stage NOT IN ('analysis_dispatch','analysis_wait')`)
      .bind(now.toISOString(), now.toISOString(), now.toISOString(), now.toISOString(), id).run();
    return this.get(id);
  }
  async claim(now: Date) {
    // A cancelled lease never becomes runnable again; stale workers cannot advance it.
    await this.db.prepare(`UPDATE financial_maintenance_tasks SET status='cancelled',completed_at=?,updated_at=?,lease_token=NULL,lease_until=NULL
      WHERE status='cancel_requested' AND (lease_until IS NULL OR lease_until<=?)`).bind(now.toISOString(), now.toISOString(), now.toISOString()).run();
    await this.db.prepare(`UPDATE financial_maintenance_tasks SET status='failed',error_code='LEASE_EXPIRED',completed_at=?,updated_at=?,lease_token=NULL,lease_until=NULL
      WHERE status='running' AND lease_until<=? AND attempt>=3 AND stage NOT IN ('analysis_dispatch','analysis_wait')`)
      .bind(now.toISOString(),now.toISOString(),now.toISOString()).run();
    await this.db.prepare(`UPDATE financial_collection_jobs SET status='unavailable',reasons_json='["MAINTENANCE_STOPPED"]',lease_token=NULL,lease_until=NULL,updated_at=?
      WHERE status IN ('queued','retry','running') AND (lease_until IS NULL OR lease_until<=?)
      AND job_id IN (SELECT 'admin:'||task_id FROM financial_maintenance_tasks WHERE status IN ('cancelled','failed'))`)
      .bind(now.toISOString(),now.toISOString()).run();
    return this.db.prepare(`UPDATE financial_maintenance_tasks SET status='running',lease_token=?,lease_until=?,attempt=attempt+1,updated_at=?
      WHERE task_id=(SELECT task_id FROM financial_maintenance_tasks WHERE status IN ('queued','running')
        AND next_attempt_at<=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY next_attempt_at,created_at LIMIT 1) RETURNING *`)
      .bind(crypto.randomUUID(), new Date(now.getTime()+MAINTENANCE_LEASE_MS).toISOString(), now.toISOString(), now.toISOString(), now.toISOString()).first<MaintenanceRow>();
  }
  async finishStep(row: MaintenanceRow, update: { stage: string; state: MaintenanceState; issues?: string[]; status?: FinancialMaintenanceTaskStatus; errorCode?: string; delayMs?: number; completedSteps?: number }, now: Date) {
    const status = update.status ?? "queued", terminal = !ACTIVE_MAINTENANCE.includes(status);
    await this.db.prepare(`UPDATE financial_maintenance_tasks SET
      status=CASE WHEN status='cancel_requested' THEN 'cancelled' ELSE ? END,stage=?,state_json=?,issues_json=?,error_code=?,completed_steps=?,
      completed_at=CASE WHEN status='cancel_requested' OR ? THEN ? ELSE NULL END,
      updated_at=?,next_attempt_at=?,lease_token=NULL,lease_until=NULL,attempt=0
      WHERE task_id=? AND lease_token=? AND status IN ('running','cancel_requested') AND lease_until>?`)
      .bind(status, update.stage, JSON.stringify(update.state), JSON.stringify(update.issues ?? JSON.parse(row.issues_json)), update.errorCode ?? null,
        update.completedSteps ?? row.completed_steps, terminal ? 1 : 0, now.toISOString(), now.toISOString(), new Date(now.getTime()+(update.delayMs ?? 0)).toISOString(),
        row.task_id, row.lease_token, now.toISOString()).run();
  }
  async failStep(row: MaintenanceRow, now: Date) {
    if (["analysis_dispatch", "analysis_wait"].includes(row.stage)) {
      // A provider timeout is not proof that a Workflow did not start. Keep its id and lock until
      // the same instance is observable; a new retry task would risk duplicate model runs.
      await this.db.prepare(`UPDATE financial_maintenance_tasks SET status='queued',error_code='WORKFLOW_STATUS_UNAVAILABLE',
        next_attempt_at=?,updated_at=?,lease_token=NULL,lease_until=NULL WHERE task_id=? AND lease_token=? AND lease_until>?`)
        .bind(new Date(now.getTime()+120_000).toISOString(),now.toISOString(),row.task_id,row.lease_token,now.toISOString()).run();
      return;
    }
    await this.db.prepare(`UPDATE financial_maintenance_tasks SET status=CASE WHEN status='cancel_requested' THEN 'cancelled' WHEN attempt>=3 THEN 'failed' ELSE 'queued' END,
      error_code='SOURCE_TEMPORARILY_UNAVAILABLE',completed_at=CASE WHEN status='cancel_requested' OR attempt>=3 THEN ? ELSE NULL END,
      next_attempt_at=?,updated_at=?,lease_token=NULL,lease_until=NULL WHERE task_id=? AND lease_token=? AND lease_until>?`)
      .bind(now.toISOString(), new Date(now.getTime()+120_000).toISOString(), now.toISOString(), row.task_id, row.lease_token, now.toISOString()).run();
  }
}
