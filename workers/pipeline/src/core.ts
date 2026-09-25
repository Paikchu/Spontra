import { D1CompanyAnalysisRepository } from "./company-analysis/repository.ts";
import { D1SecRepository } from "./sec/d1.ts";
import { isTrackedTicker, normalizeTrackedTicker, parseTrackedTickers } from "./sec/config.ts";
import { hashString } from "./sec/analysis.ts";
import { sha256 } from "./company-analysis/api.ts";

export type SecWorkflowBinding<T = SecWorkflowParams> = {
  create(options: { id: string; params: T }): Promise<{ id: string }>;
  get?(id: string): Promise<{ status(): Promise<{ status: string }> }>;
};

export type SecWorkflowParams = {
  ticker: string;
  requestedBy: "scheduled" | "manual";
  backfill?: boolean;
  accessionNumber?: string;
  regenerateReport?: boolean;
};

export type SecMemoryWorkflowParams = {
  jobId: string;
  ticker: string;
  ownerToken?: string;
};

export type CompanyAnalysisWorkflowParams = {
  analysisId?: string;
  recoveryAttempt?: number;
  expectedUpdatedAt?: string;
  ticker: string;
  memoryJobId: string;
  memoryVersion: number;
  periodId: string;
  reportDate: string;
  triggerRef: string;
};

export type CompanyAnalysisBackfillParams = {
  requestedBy?: "manual" | "scheduled";
  forceIncomplete?: boolean;
};

export type SecCronEnv = {
  /** This Worker's own copy of the whitelist — nothing here asks another Worker for it. */
  SEC_TRACKED_TICKERS?: string;
  SEC_REFRESH_KEY: string;
  /** The same D1 database the Web Worker binds. Optional only so tests can build a partial env. */
  DB?: D1Database;
  SEC_ANALYSIS_WORKFLOW: SecWorkflowBinding;
  SEC_MEMORY_WORKFLOW?: SecWorkflowBinding<SecMemoryWorkflowParams>;
  COMPANY_ANALYSIS_WORKFLOW?: SecWorkflowBinding<CompanyAnalysisWorkflowParams>;
};

/**
 * Reads this Worker's own copy of the whitelist. There is deliberately no other Worker to ask: a
 * second copy living on the Web Worker is exactly what let the two sides disagree silently — one
 * side would start analysis the other side then refused, and the jobs just failed on repeat. The
 * whitelist now has exactly one home, this one, and this Worker is also the one deciding whether to
 * start a run — so the two can no longer drift apart.
 */
export function trackedTickersFor(env: Pick<SecCronEnv, "SEC_TRACKED_TICKERS">): string[] {
  return parseTrackedTickers(env.SEC_TRACKED_TICKERS);
}

export function assertTrackedTicker(env: Pick<SecCronEnv, "SEC_TRACKED_TICKERS">, ticker: string): void {
  if (!isTrackedTicker(ticker, trackedTickersFor(env))) throw new Error("Ticker is not tracked");
}

export function requireDb(env: Pick<SecCronEnv, "DB">): D1Database {
  if (!env.DB) throw new Error("SEC pipeline D1 binding is not configured");
  return env.DB;
}

export async function runCompanyAnalysisSweep(
  env: SecCronEnv,
  options: { forceIncomplete?: boolean } = {},
): Promise<{ candidates: number; started: string[]; failed: string[] }> {
  if (!env.COMPANY_ANALYSIS_WORKFLOW) return { candidates: 0, started: [], failed: [] };
  const repository = new D1CompanyAnalysisRepository(requireDb(env));
  const tickers = trackedTickersFor(env);
  if (env.COMPANY_ANALYSIS_WORKFLOW.get) {
    const executions = await repository.listActiveExecutions(tickers, new Date(Date.now() - 60 * 60_000).toISOString());
    for (const execution of executions) {
      try {
        const instance = await env.COMPANY_ANALYSIS_WORKFLOW.get(execution.workflowInstanceId);
        const state = (await instance.status()).status;
        if (["errored", "terminated", "complete"].includes(state)) {
          await repository.markStoppedExecution(execution.analysisId, execution.workflowInstanceId, new Date().toISOString());
        }
      } catch {
        // Unknown platform state is not permission to launch a duplicate running Agent.
        console.warn(JSON.stringify({ event: "company-analysis-status-unavailable", analysisId: execution.analysisId }));
      }
    }
  }
  // Deep research fetches several sources per company; pace older-version backfills over Cron ticks.
  const candidates = await repository.listBackfillCandidates(tickers, 2, options.forceIncomplete === true);
  const started: string[] = [];
  const failed: string[] = [];
  for (const candidate of candidates) {
    const ticker = normalizeTrackedTicker(candidate.ticker);
    if (!ticker || !candidate.triggerRef) continue;
    try {
      // The business-model Agent can use published SEC reports even when Yahoo has no matching quarter.
      await env.COMPANY_ANALYSIS_WORKFLOW.create({
        // A terminal run version has exactly one recovery id, even across concurrent Cron ticks
        // or an ambiguous create response. The id changes only after that attempt actually ends.
        id: candidate.analysisId
          ? `company-recovery-${await sha256(`${candidate.analysisId}:${candidate.expectedUpdatedAt}`)}`
          : `company-${hashString(candidate.triggerRef)}`,
        params: { ...candidate, ticker },
      });
      started.push(ticker);
    } catch (error) {
      if (/already exists|duplicate/i.test(String(error))) {
        started.push(ticker);
      } else {
        failed.push(ticker);
      }
    }
  }
  return { candidates: candidates.length, started, failed };
}

export async function runSecRefresh(env: SecCronEnv, now = Date.now()) {
  if (!env.SEC_REFRESH_KEY || !env.SEC_ANALYSIS_WORKFLOW) {
    throw new Error("SEC cron environment is incomplete");
  }
  const tickers = [...new Set(trackedTickersFor(env))];
  const started: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];
  for (const ticker of tickers) {
    try {
      // A complex report can outlive many Cron ticks. Progress renews these jobs; avoid
      // filling the Workflow queue with identical sweeps while a ticker is being analyzed.
      if (env.DB) {
        const active = await env.DB.prepare("SELECT job_id FROM sec_analysis_jobs WHERE ticker = ? AND status IN ('running', 'queued') AND updated_at >= ? LIMIT 1")
          .bind(ticker, new Date(now - 2 * 60 * 60_000).toISOString()).first();
        if (active) { skipped.push(ticker); continue; }
      }
      await startWorkflow(env.SEC_ANALYSIS_WORKFLOW, ticker, "scheduled", now, false);
      started.push(ticker);
    } catch {
      failed.push(ticker);
    }
  }
  /**
   * A watchlist that yielded tickers but started nothing is a failure, not an empty success: it
   * used to return the same shape a healthy run returns, so the Cron handler — the only reader
   * there is — could not tell it apart from "there was nothing to do". An empty watchlist stays a
   * no-op, because turning generation off entirely is a supported configuration.
   */
  if (tickers.length && !started.length && !skipped.length) throw new Error(`SEC refresh started no workflows (watchlist: ${tickers.length}, failed: ${failed.length})`);
  return { started, failed, ...(skipped.length ? { skipped } : {}) };
}

export async function runSecMemorySweep(env: SecCronEnv): Promise<{ started: string[] }> {
  if (!env.SEC_MEMORY_WORKFLOW) return { started: [] };
  const ownerToken = `sweeper:${crypto.randomUUID()}`;
  const claim = await new D1SecRepository(requireDb(env)).claimMemoryJob(null, ownerToken, new Date(), undefined, trackedTickersFor(env));
  if (!claim) return { started: [] };
  await env.SEC_MEMORY_WORKFLOW.create({
    id: `memory-${crypto.randomUUID()}`,
    params: { jobId: claim.jobId, ticker: claim.ticker, ownerToken },
  });
  return { started: [claim.jobId] };
}

export async function handleSecAnalysisRequest(request: Request, env: SecCronEnv, now = Date.now()): Promise<Response> {
  if (request.method !== "POST") return new Response("Not found", { status: 404 });
  if (!env.SEC_REFRESH_KEY || request.headers.get("x-sec-refresh-key") !== env.SEC_REFRESH_KEY) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const match = new URL(request.url).pathname.match(/^\/(jobs|backfill)\/([^/]+)$/);
  const mode = match?.[1] ?? "jobs";
  let rawTicker = "";
  try {
    rawTicker = decodeURIComponent(match?.[2] ?? "");
  } catch {
    return Response.json({ error: "Invalid ticker" }, { status: 400 });
  }
  const ticker = normalizeTrackedTicker(rawTicker);
  if (!ticker) return Response.json({ error: "Invalid ticker" }, { status: 400 });
  let trackedTickers: string[];
  try {
    trackedTickers = trackedTickersFor(env);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to read the SEC watchlist" }, { status: 503 });
  }
  if (!isTrackedTicker(ticker, trackedTickers)) return Response.json({ error: "Ticker is not tracked" }, { status: 403 });
  try {
    const instance = await startWorkflow(env.SEC_ANALYSIS_WORKFLOW, ticker, "manual", now, mode === "backfill");
    return Response.json({ status: "queued", jobId: instance.id, ticker, mode }, { status: 202 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to queue analysis" }, { status: 503 });
  }
}

/**
 * Starts one company analysis on demand.
 *
 * The Cron sweep is the only other way this workflow runs, and it skips a company that already has
 * a published run for the current memory version — correctly, or it would re-analyse the watchlist
 * every tick. The cost is that a prompt or model change is invisible until a filing advances memory,
 * which can be a quarter away. This route is how a change gets looked at.
 *
 * Deliberately not folded into `handleSecAnalysisRequest`: that one drives the filing workflow, and
 * a shared handler with a mode flag would put two different workflows one typo apart.
 */
export async function handleCompanyAnalysisRequest(request: Request, env: SecCronEnv, now = Date.now()): Promise<Response> {
  if (request.method !== "POST") return new Response("Not found", { status: 404 });
  if (!env.SEC_REFRESH_KEY || request.headers.get("x-sec-refresh-key") !== env.SEC_REFRESH_KEY) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const match = new URL(request.url).pathname.match(/^\/company-analysis\/([^/]+)$/);
  let rawTicker = "";
  try {
    rawTicker = decodeURIComponent(match?.[1] ?? "");
  } catch {
    return Response.json({ error: "Invalid ticker" }, { status: 400 });
  }
  const ticker = normalizeTrackedTicker(rawTicker);
  if (!ticker) return Response.json({ error: "Invalid ticker" }, { status: 400 });
  let trackedTickers: string[];
  try {
    trackedTickers = trackedTickersFor(env);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to read the SEC watchlist" }, { status: 503 });
  }
  if (!isTrackedTicker(ticker, trackedTickers)) return Response.json({ error: "Ticker is not tracked" }, { status: 403 });
  if (!env.COMPANY_ANALYSIS_WORKFLOW || !env.DB) {
    return Response.json({ error: "Company analysis is not configured" }, { status: 503 });
  }
  const trigger = await new D1CompanyAnalysisRepository(env.DB).findAnalysisTrigger(ticker);
  if (!trigger) {
    // Company analysis reasons over company memory, which SEC filing analysis produces. Without a
    // completed memory job there is nothing to analyse, and saying so beats a run that fails later.
    return Response.json({ error: "No completed company memory for this ticker yet" }, { status: 409 });
  }
  try {
    // A unique id per request, unlike the sweep's `company-<hash of triggerRef>`: that id already
    // exists for a ticker that has been analysed, which is exactly the case this route serves.
    const requestId = crypto.randomUUID();
    const instance = await env.COMPANY_ANALYSIS_WORKFLOW.create({
      id: `company-manual-${ticker}-${now}-${requestId}`,
      // trigger_ref is unique in D1: a manual regeneration must not collide with an old ready run.
      params: { ...trigger, triggerRef: `${trigger.triggerRef.slice(0, 170)}:manual:${now}:${requestId}` },
    });
    return Response.json({
      status: "queued", analysisJobId: instance.id, ticker,
      periodId: trigger.periodId, memoryVersion: trigger.memoryVersion,
    }, { status: 202 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to queue company analysis" }, { status: 503 });
  }
}

async function startWorkflow(binding: SecWorkflowBinding, ticker: string, requestedBy: SecWorkflowParams["requestedBy"], now: number, backfill: boolean) {
  const runKey = requestedBy === "manual" ? `${now}-${crypto.randomUUID()}` : Math.floor(now / (5 * 60_000));
  const id = `${requestedBy}-${ticker}-${runKey}`;
  return binding.create({ id, params: { ticker, requestedBy, backfill } });
}
