import { financialPolicy, allowData, aiIsEnabled } from "../../../shared/analysis-runtime/financial-data/policy.ts";
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
  /** Resolves a persisted authenticated one-off request; not a general policy override. */
  maintenanceTaskId?: string;
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

export type SecCronEnv = {
  /** This Worker's own copy of the whitelist — nothing here asks another Worker for it. */
  SEC_TRACKED_TICKERS?: string;
  SEC_DATA_TICKERS?: string;
  SEC_DATA_COLLECTION_ENABLED?: string;
  SEC_AI_TICKERS?: string;
  SEC_AI_ENABLED?: string;
  SEC_REFRESH_KEY: string;
  /** Dedicated dashboard login and session-signing secret. */
  REPORT_ADMIN_PASSWORD?: string;
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
export function trackedTickersFor(env: Pick<SecCronEnv, "SEC_TRACKED_TICKERS" | "SEC_DATA_TICKERS" | "SEC_AI_TICKERS" | "SEC_AI_ENABLED">): string[] {
  if(!aiIsEnabled(env))return [];
  return parseTrackedTickers(env.SEC_AI_TICKERS??env.SEC_TRACKED_TICKERS);
}

/** The error a run raises when its company's feature is no longer switched on. */
export const NOT_TRACKED = "Ticker is not tracked";
export function assertTrackedTicker(env: Pick<SecCronEnv, "SEC_TRACKED_TICKERS" | "SEC_DATA_TICKERS" | "SEC_AI_TICKERS" | "SEC_AI_ENABLED">, ticker: string): void {
  if (!isTrackedTicker(ticker, trackedTickersFor(env))) throw new Error(NOT_TRACKED);
}

export function dataTickersFor(env:Pick<SecCronEnv,"SEC_TRACKED_TICKERS"|"SEC_DATA_TICKERS"|"SEC_AI_TICKERS"|"SEC_AI_ENABLED">):string[]{return [...financialPolicy({SEC_DATA_TICKERS:env.SEC_DATA_TICKERS,SEC_TRACKED_TICKERS:env.SEC_TRACKED_TICKERS,SEC_AI_ENABLED:"false"}).dataTickers].sort();}
export function assertDataTicker(env:Pick<SecCronEnv,"SEC_TRACKED_TICKERS"|"SEC_DATA_TICKERS"|"SEC_AI_TICKERS"|"SEC_AI_ENABLED">,ticker:string):void{if(!allowData(financialPolicy({SEC_DATA_TICKERS:env.SEC_DATA_TICKERS,SEC_TRACKED_TICKERS:env.SEC_TRACKED_TICKERS,SEC_AI_ENABLED:"false"}),ticker))throw new Error("Ticker is not data-enabled");}

export function requireDb(env: Pick<SecCronEnv, "DB">): D1Database {
  if (!env.DB) throw new Error("SEC pipeline D1 binding is not configured");
  return env.DB;
}

/**
 * One company's analysis recovery, run by the `company-analysis` task: settles executions whose Workflow ended without
 * saying so, then starts the analysis the company is missing (a new memory version, a failed run whose back-off has
 * passed, an older prompt version). Reports a run still in progress and when a failed run may next be retried.
 */
export async function recoverCompanyAnalysis(env: SecCronEnv, ticker: string, now = Date.now()): Promise<{ started: string | null; running: boolean; nextRecoveryAt: string | null }> {
  if (!env.COMPANY_ANALYSIS_WORKFLOW) return { started: null, running: false, nextRecoveryAt: null };
  const repository = new D1CompanyAnalysisRepository(requireDb(env));
  if (env.COMPANY_ANALYSIS_WORKFLOW.get) {
    for (const execution of await repository.listActiveExecutions([ticker], new Date(now - 60 * 60_000).toISOString())) {
      try {
        const state = (await (await env.COMPANY_ANALYSIS_WORKFLOW.get(execution.workflowInstanceId)).status()).status;
        if (["errored", "terminated", "complete"].includes(state)) await repository.markStoppedExecution(execution.analysisId, execution.workflowInstanceId, new Date(now).toISOString());
      } catch (error) {
        // An instance the platform says does not exist cannot be running; any other unknown state is not permission
        // to launch a duplicate running Agent.
        if (/not.?found|does not exist|no such instance/i.test(String(error))) await repository.markStoppedExecution(execution.analysisId, execution.workflowInstanceId, new Date(now).toISOString());
        else console.warn(JSON.stringify({ event: "company-analysis-status-unavailable", analysisId: execution.analysisId }));
      }
    }
  }
  const running = Boolean(await requireDb(env).prepare("SELECT 1 FROM company_analysis_runs WHERE ticker = ? AND status IN ('waiting_fundamentals', 'calculating', 'analyzing', 'validating') LIMIT 1").bind(ticker).first());
  if (running) return { started: null, running: true, nextRecoveryAt: null };
  const [candidate] = await repository.listBackfillCandidates([ticker], 1, false, now);
  if (candidate?.triggerRef) {
    // A terminal run version has exactly one recovery id, even across concurrent runs or an ambiguous create
    // response. The id changes only after that attempt actually ends.
    const id = candidate.analysisId
      ? `company-recovery-${await sha256(`${candidate.analysisId}:${candidate.expectedUpdatedAt}`)}`
      : `company-${hashString(candidate.triggerRef)}`;
    try { await env.COMPANY_ANALYSIS_WORKFLOW.create({ id, params: { ...candidate, ticker } }); }
    catch (error) { if (!/already exists|duplicate/i.test(String(error))) throw error; }
    return { started: id, running: true, nextRecoveryAt: null };
  }
  return { started: null, running: false, nextRecoveryAt: await repository.nextRecoveryAt(ticker) };
}

/** Starts report memory for the company's oldest pending (or abandoned) memory job, if there is one. */
export async function startCompanyMemory(env: SecCronEnv, ticker: string): Promise<{ started: string | null; leasedUntil: string | null }> {
  if (!env.SEC_MEMORY_WORKFLOW) return { started: null, leasedUntil: null };
  const ownerToken = `sweeper:${crypto.randomUUID()}`;
  const claim = await new D1SecRepository(requireDb(env)).claimMemoryJob(null, ownerToken, new Date(), undefined, [ticker]);
  if (claim) {
    await env.SEC_MEMORY_WORKFLOW.create({ id: `memory-${crypto.randomUUID()}`, params: { jobId: claim.jobId, ticker: claim.ticker, ownerToken } });
    return { started: claim.jobId, leasedUntil: null };
  }
  const leased = await requireDb(env).prepare("SELECT MAX(lease_until) AS until FROM sec_memory_jobs WHERE ticker = ? AND status = 'running'").bind(ticker).first<{ until: string | null }>();
  return { started: null, leasedUntil: leased?.until ?? null };
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
