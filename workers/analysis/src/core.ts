import { featureTickersFor } from "./financial-data/company-policy.ts";
import type { Feature } from "../../../shared/analysis-contract/business-features.ts";
import { allowData, aiIsEnabled, dataTickers, normalizeTicker, tickerList } from "../../../shared/analysis-runtime/financial-data/policy.ts";
import { D1SecRepository } from "./sec/d1.ts";

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

export type SecCronEnv = {
  /** This Worker's own copy of the whitelist — nothing here asks another Worker for it. */
  SEC_DATA_TICKERS?: string;
  SEC_DATA_COLLECTION_ENABLED?: string;
  SEC_AI_TICKERS?: string;
  SEC_AI_ENABLED?: string;
  SEC_REFRESH_KEY: string;
  /** Dedicated dashboard login and session-signing secret. */
  REPORT_ADMIN_PASSWORD?: string;
  /** The same D1 database the Web Worker binds. Optional only so tests can build a partial env. */
  DB?: D1Database;
  SEC_MEMORY_WORKFLOW?: SecWorkflowBinding<SecMemoryWorkflowParams>;
};

/**
 * Reads this Worker's own copy of the whitelist. There is deliberately no other Worker to ask: a
 * second copy living on the Web Worker is exactly what let the two sides disagree silently — one
 * side would start analysis the other side then refused, and the jobs just failed on repeat. The
 * whitelist now has exactly one home, this one, and this Worker is also the one deciding whether to
 * start a run — so the two can no longer drift apart.
 */
export function trackedTickersFor(env: Pick<SecCronEnv, "SEC_AI_TICKERS" | "SEC_AI_ENABLED">): string[] {
  return aiIsEnabled(env) ? tickerList(env.SEC_AI_TICKERS) : [];
}

const tracked = (ticker: string, list: string[]) => { const normalized = normalizeTicker(ticker); return !!normalized && list.includes(normalized); };

/** The error a run raises when its company's feature is no longer switched on. */
export const NOT_TRACKED = "Ticker is not tracked";
export function assertTrackedTicker(env: Pick<SecCronEnv, "SEC_AI_TICKERS" | "SEC_AI_ENABLED">, ticker: string): void {
  if (!tracked(ticker, trackedTickersFor(env))) throw new Error(NOT_TRACKED);
}

/**
 * The same refusal for a run of another feature: the company analysis, memory, findings and analyst belong to the
 * findings switch and the explainer to its own, so a run is refused by the switch that scheduled it, not the reports list.
 */
export function assertFeatureTicker(env: Parameters<typeof featureTickersFor>[0], feature: Feature, ticker: string): void {
  if (!tracked(ticker, featureTickersFor(env, feature))) throw new Error(NOT_TRACKED);
}

/**
 * A scheduled report runs only while this company is still on the reports list. A manual run is not decided here:
 * an admin analysis carries its own grant, and a manual request for a company that has left the list still fails as before.
 */
export function scheduledAnalysisAllowed(env: Pick<SecCronEnv, "SEC_AI_TICKERS" | "SEC_AI_ENABLED">, params: { ticker: string; requestedBy: string }): boolean {
  if (params.requestedBy === "manual") return true;
  return tracked(params.ticker, trackedTickersFor(env));
}

export function dataTickersFor(env:Pick<SecCronEnv,"SEC_DATA_TICKERS">):string[]{return [...dataTickers(env)].sort();}
export function assertDataTicker(env:Pick<SecCronEnv,"SEC_DATA_TICKERS">,ticker:string):void{if(!allowData(dataTickers(env),ticker))throw new Error("Ticker is not data-enabled");}

export function requireDb(env: Pick<SecCronEnv, "DB">): D1Database {
  if (!env.DB) throw new Error("SEC pipeline D1 binding is not configured");
  return env.DB;
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
  const ticker = normalizeTicker(rawTicker);
  if (!ticker) return Response.json({ error: "Invalid ticker" }, { status: 400 });
  let trackedTickers: string[];
  try {
    trackedTickers = trackedTickersFor(env);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to read the SEC watchlist" }, { status: 503 });
  }
  if (!tracked(ticker, trackedTickers)) return Response.json({ error: "Ticker is not tracked" }, { status: 403 });
  try {
    const { startFilingRuns } = await import("./filing-analysis/start.ts");
    const result = await startFilingRuns(env as never, ticker, { requestedBy: "manual" });
    return Response.json({ status: "queued", ticker, mode, ...result }, { status: 202 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to queue analysis" }, { status: 503 });
  }
}
