import type { SecPipelineEnv } from "../operations.ts";
import type { SecWorkflowParams } from "../core.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { aiIsEnabled, financialPolicy } from "../../../../shared/analysis-runtime/financial-data/policy.ts";
import { throttledSecReader, discoverDataIssuer, readSecDocumentBatch, type SecReader } from "../financial-data/provider.ts";
import { collectComplete } from "../financial-data/collect.ts";
import { D1CompleteStore, type Job } from "../financial-data/store.ts";
import { runHistoryStep } from "../financial-data/history.ts";
import { archiveFilingDisclosures, listFilingDisclosureAudits } from "../financial-data/disclosure-audit.ts";
import { FinancialMaintenanceStore, type MaintenanceRow, type MaintenanceState } from "./financial-maintenance-store.ts";

export interface MaintenanceDependencies {
  reader(env: SecPipelineEnv, ticker: string): SecReader;
  discover: typeof discoverDataIssuer;
  collect(env: SecPipelineEnv, job: Job, reader: SecReader): Promise<{ published: boolean; reasons: string[] }>;
  history: typeof runHistoryStep;
}
const dependencies: MaintenanceDependencies = {
  reader(env, ticker) {
    const reader = throttledSecReader(env.SEC_USER_AGENT, fetch, 1000);
    reader.archive = (source, html, metadata) => archiveFilingDisclosures({ DB: env.DB!, SEC_FILINGS: env.SEC_FILINGS }, ticker, source, html, metadata).then(() => undefined);
    return reader;
  },
  discover: discoverDataIssuer,
  collect: (env, job, reader) => collectComplete(job, financialPolicy({ SEC_DATA_TICKERS: job.ticker, SEC_AI_ENABLED: "false" }),
    new D1CompleteStore(env.DB!), j => readSecDocumentBatch(j, reader, 1)),
  history: runHistoryStep,
};

/** One bounded step per Cron invocation; state is D1-backed, so browser refreshes cannot interrupt it. */
export async function runFinancialMaintenanceTick(env: SecPipelineEnv, deps = dependencies, now = new Date()): Promise<{ processed: boolean; taskId?: string; stage?: string; blocksDataSweep?: boolean }> {
  if (!env.DB) return { processed: false };
  const store = new FinancialMaintenanceStore(env.DB), row = await store.claim(now);
  // Another Cron invocation may own a lease, or a retry may be backing off. Neither is permission
  // for the normal sweep to advance the same issuer's history cursor concurrently.
  if (!row) {
    const active = await store.hasActiveTasks();
    return { processed: active, ...(active && !await store.hasActiveDataTasks() ? { blocksDataSweep: false } : {}) };
  }
  const outcome = async () => ({ processed: true, taskId: row.task_id, stage: row.stage,
    ...(!await store.hasActiveDataTasks() ? { blocksDataSweep: false } : {}) });
  const state = JSON.parse(row.state_json) as MaintenanceState, reader = deps.reader(env, row.ticker);
  const issues = JSON.parse(row.issues_json) as string[];
  const finish = (stage: string, options: Partial<Parameters<typeof store.finishStep>[1]> = {}) => store.finishStep(row,
    { stage, state, issues, ...options }, new Date());
  try {
    if (row.stage === "identify" || row.stage === "waiting_issuer") {
      const issuer = await deps.discover(row.ticker, reader);
      if (!issuer.tickers.includes(row.ticker) || !/^\d{10}$/.test(issuer.cik)) throw new Error("ISSUER_IDENTITY_MISMATCH");
      if (!await store.claimIssuer(row, issuer.cik, new Date())) {
        // The queued waiter owns no issuer cursor and performs no data mutation. Persist that
        // distinction so a share class waiting on a long-lived model run cannot pause all data.
        state.waitingCik = issuer.cik;
        await finish("waiting_issuer", { delayMs: 120_000 });
        return outcome();
      }
      delete state.waitingCik;
      const previous = await env.DB.prepare("SELECT MAX(generation) generation FROM financial_collection_jobs WHERE cik=?").bind(issuer.cik).first<{ generation: number | null }>();
      state.cik = issuer.cik; state.name = issuer.name; state.generation = Math.max(Date.parse(row.created_at), (previous?.generation ?? 0)+1);
      state.collectionJobId = `admin:${row.task_id}`; state.workflowId = `financial-admin-${row.task_id}`;
      state.backupKey = `financial-maintenance-backups/${row.task_id}.json`;
      await backupMaintenanceTarget(env, row, state);
      await new D1SecRepository(env.DB).setCache(`admin:financial-issuer:${row.ticker}`, issuer, new Date().toISOString());
      // Force an explicit historical rescan, retaining the last good public history itself.
      await env.DB.prepare("DELETE FROM sec_cache WHERE cache_key=?").bind(`sec:revenue-history-cursor:v1:${state.cik}`).run();
      await finish("collect", { completedSteps: 1 });
    } else if (row.stage === "collect") {
      await collectStep(env, deps, row, state, reader, issues);
      const result = await env.DB.prepare("SELECT status,reasons_json FROM financial_collection_jobs WHERE job_id=?").bind(state.collectionJobId).first<{ status: string; reasons_json: string }>();
      if (result?.status === "succeeded") await finish("history", { completedSteps: 2 });
      else if (result?.status === "unavailable") {
        issues.push(...JSON.parse(result.reasons_json) as string[]);
        await finish("history", { completedSteps: 2, issues: [...new Set(issues)] });
      } else await finish("collect", { delayMs: result?.status === "retry" ? 120_000 : 0 });
    } else if (row.stage === "history") {
      const result = await deps.history(env.DB, reader, { ticker: row.ticker, cik: state.cik! }, new Date(), 1);
      const resolved = new Set(result.resolvedIssues ?? []);
      issues.splice(0, issues.length, ...issues.filter(issue => !resolved.has(issue)), ...result.issues);
      await finish(result.finished ? "audit" : "history", { completedSteps: result.finished ? 3 : 2, issues: [...new Set(issues)].slice(-100) });
    } else if (row.stage === "audit") {
      const audits = await listFilingDisclosureAudits(env.DB, row.ticker);
      if (!audits.length) issues.push("NO_ARCHIVED_DISCLOSURES");
      const unsupported = audits.reduce((count, audit) => count + audit.coverage.unsupported, 0);
      if (unsupported) issues.push(`UNSUPPORTED_SOURCE_FACTS:${unsupported}`);
      if (audits.some(audit => audit.coverage.unknownTaxonomy > 0)) issues.push("UNRESOLVED_TAXONOMY_NAMESPACE");
      if (row.action === "analyze") await finish("analysis_dispatch", { completedSteps: 4, issues: [...new Set(issues)] });
      else await finish("complete", { status: issues.length ? "partial" : "succeeded", completedSteps: 4, issues: [...new Set(issues)] });
    } else if (row.stage === "analysis_dispatch") {
      if (!aiIsEnabled(env)) await finish("analysis_dispatch", { status: "failed", errorCode: "AI_DISABLED" });
      else {
        const active = await env.DB.prepare("SELECT job_id FROM sec_analysis_jobs WHERE ticker=? AND status IN ('queued','running') AND updated_at>=? LIMIT 1")
          .bind(row.ticker, new Date(Date.now()-2*3600_000).toISOString()).first();
        if (active) { await finish("analysis_dispatch", { delayMs: 120_000 }); return outcome(); }
        try {
          await env.SEC_ANALYSIS_WORKFLOW.create({ id: state.workflowId!, params: { ticker: row.ticker, requestedBy: "manual", maintenanceTaskId: row.task_id,
            ...(row.accession_number ? { accessionNumber: row.accession_number } : {}) } });
        } catch {
          // Ambiguous dispatch is retried with the exact same Workflow id, never a new run.
          if (!env.SEC_ANALYSIS_WORKFLOW.get) throw new Error("WORKFLOW_DISPATCH_UNCONFIRMED");
          await (await env.SEC_ANALYSIS_WORKFLOW.get(state.workflowId!)).status();
        }
        await finish("analysis_wait");
      }
    } else if (row.stage === "analysis_wait") {
      if (!env.SEC_ANALYSIS_WORKFLOW.get) throw new Error("WORKFLOW_STATUS_UNAVAILABLE");
      const status = (await (await env.SEC_ANALYSIS_WORKFLOW.get(state.workflowId!)).status()).status;
      if (status === "complete") {
        const jobs = await env.DB.prepare("SELECT status FROM sec_analysis_jobs WHERE workflow_instance_id=?").bind(state.workflowId).all<{ status: string }>();
        if (!jobs.results.length || jobs.results.some(j=>j.status!=="complete")) issues.push("ANALYSIS_INCOMPLETE");
        await finish("complete", { status: issues.length ? "partial" : "succeeded", completedSteps: 5, issues: [...new Set(issues)] });
      } else if (["errored", "terminated"].includes(status)) await finish("analysis_wait", { status: "failed", errorCode: "ANALYSIS_FAILED" });
      else await finish("analysis_wait", { delayMs: 120_000 });
    } else await finish(row.stage, { status: "failed", errorCode: "UNKNOWN_STAGE" });
  } catch (error) {
    // Provider messages can contain query strings, credentials or raw document text; never persist them.
    if (error instanceof Error && ["SEC_ISSUER_NOT_FOUND", "ISSUER_IDENTITY_MISMATCH"].includes(error.message)) {
      await finish(row.stage, { status: "failed", errorCode: error.message });
    } else await store.failStep(row, new Date());
  }
  return outcome();
}

async function collectStep(env: SecPipelineEnv, deps: MaintenanceDependencies, row: MaintenanceRow, state: MaintenanceState, reader: SecReader, _issues: string[]) {
  const now = new Date(), token = row.lease_token!;
  await env.DB!.prepare(`INSERT INTO financial_collection_jobs(job_id,cik,ticker,generation,status,next_attempt_at,updated_at)
    VALUES(?,?,?,?,'queued',?,?) ON CONFLICT(job_id) DO NOTHING`).bind(state.collectionJobId,state.cik,row.ticker,state.generation,now.toISOString(),now.toISOString()).run();
  const job = await env.DB!.prepare(`UPDATE financial_collection_jobs SET status='running',lease_token=?,lease_until=?,attempt=attempt+1,updated_at=?
    WHERE job_id=? AND status IN ('queued','retry','running') AND (lease_until IS NULL OR lease_until<=?) RETURNING cursor_json,attempt`)
    .bind(token,row.lease_until,now.toISOString(),state.collectionJobId,now.toISOString()).first<{ cursor_json: string; attempt: number }>();
  if (job) await deps.collect(env, { id: state.collectionJobId!, cik: state.cik!, ticker: row.ticker, generation: state.generation!, lease: token, cursor: job.cursor_json, attempt: job.attempt }, reader);
}

/** Save the exact pre-mutation state once; previous complete versions themselves are immutable. */
async function backupMaintenanceTarget(env: SecPipelineEnv, row: MaintenanceRow, state: MaintenanceState) {
  if (await env.SEC_FILINGS.get(state.backupKey!)) return;
  const caches = await env.DB!.prepare(`SELECT * FROM sec_cache WHERE cache_key LIKE ? OR cache_key LIKE ? OR cache_key=? OR cache_key=?`)
    .bind(`%:${row.ticker}`, `%:${row.ticker}:%`, `sec:revenue-history:v1:${state.cik}`, `sec:revenue-history-cursor:v1:${state.cik}`).all();
  const current = await env.DB!.prepare("SELECT * FROM financial_complete_current WHERE cik=?").bind(state.cik).all();
  const versions = await env.DB!.prepare("SELECT * FROM financial_complete_versions WHERE cik=? ORDER BY generation DESC").bind(state.cik).all();
  await env.SEC_FILINGS.put(state.backupKey!, JSON.stringify({ schemaVersion: "financial-maintenance-backup.v1", taskId: row.task_id, ticker: row.ticker,
    cik: state.cik, createdAt: new Date().toISOString(), caches: caches.results, current: current.results, versions: versions.results }), { httpMetadata: { contentType: "application/json" } });
}

/** Only a persisted authenticated task grants a one-off ticker scope; global AI-off still wins. */
export async function maintenanceAnalysisEnvironment(env: SecPipelineEnv, params: SecWorkflowParams, instanceId: string): Promise<SecPipelineEnv> {
  if (!params.maintenanceTaskId) return env;
  if (!env.DB || !aiIsEnabled(env)) throw new Error("ADMIN_ANALYSIS_DENIED");
  const task = await new FinancialMaintenanceStore(env.DB).get(params.maintenanceTaskId);
  const state = task ? JSON.parse(task.state_json) as MaintenanceState : null;
  if (!task || task.action !== "analyze" || task.ticker !== params.ticker || params.requestedBy !== "manual" || state?.workflowId !== instanceId
    || !["analysis_dispatch","analysis_wait"].includes(task.stage) || !["queued","running"].includes(task.status)
    || task.accession_number !== (params.accessionNumber ?? null)) throw new Error("ADMIN_ANALYSIS_DENIED");
  return { ...env, SEC_AI_TICKERS: params.ticker, SEC_DATA_TICKERS: params.ticker };
}
