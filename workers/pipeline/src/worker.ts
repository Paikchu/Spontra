import {handleTranscriptAdminRequest} from './admin/transcripts.ts';
import {syncTranscript} from './transcripts/library.ts';
import {handleBusinessMapAdminRequest} from './admin/business-map.ts';
import {handleAiRunsAdminRequest} from './admin/ai-runs.ts';
import {runDataOnlySweep} from './financial-data/queue.ts';
import {runMapDerivationTick} from './financial-data/derived.ts';
import { handleCompanyAnalysisRequest, handleSecAnalysisRequest, runCompanyAnalysisSweep, runSecMemorySweep, runSecRefresh } from "./core.ts";
import { handleBusinessFlowRefresh, runBusinessFlowBootstrap } from "./sec/business-flow-refresh.ts";
import { handleFundamentalsRefreshRequest } from "./fundamentals.ts";
import { runFundamentalsStalenessSweep } from "./fundamentals-sweep.ts";
import type { SecPipelineEnv } from "./operations.ts";
import { runBusinessExplainerSweep } from "./business-explainer/workflow.ts";
import { runGuidanceSweep } from "./guidance/workflow.ts";
import { runFindingsSweep } from "./findings/workflow.ts";
import { runOperatingMetricsSweep } from "./operating-metrics/workflow.ts";
import { runFiguresSweep } from "./figures/workflow.ts";
import { runEventsSweep } from "./events/workflow.ts";
import { handleReportAdminRequest } from "./admin/reports.ts";
import { handleFinancialAdminRequest } from "./admin/financials.ts";
import { runFinancialMaintenanceTick } from "./admin/financial-maintenance-runner.ts";

/**
 * `JSON.stringify` renders an Error as `{}`, so a rejection reason has to be read off it before it
 * reaches the log. The old handler logged the raw settled results and every failure it did report
 * arrived as `"reason":{}` — the one line meant to explain a broken run explained nothing.
 */
function describeSettled(result: PromiseSettledResult<unknown>) {
  return result.status === "fulfilled"
    ? { status: result.status, value: result.value }
    : { status: result.status, reason: result.reason instanceof Error ? result.reason.message : String(result.reason) };
}

/**
 * Liveness only: is this Worker running. It deliberately reports no dependency state, so a probe
 * cannot be used to enumerate what is and is not configured. `/ready` answers that, for an
 * operator, and answers it without touching anything.
 */
function healthResponse(): Response {
  return Response.json({ status: "ok" }, { headers: { "cache-control": "no-store" } });
}

/**
 * Dependency readiness. A GET, and read-only in the strictest sense — it inspects bindings and
 * configuration presence, and issues no query, no fetch and no write. It reports booleans, never
 * a value: whether a secret is set, never any part of it.
 */
function readyResponse(env: SecPipelineEnv): Response {
  const checks = {
    analysisStore: Boolean(env.DB),
    watchlist: Boolean(env.SEC_TRACKED_TICKERS?.trim()),
    analysisWorkflow: Boolean(env.SEC_ANALYSIS_WORKFLOW),
    // Generation needs a model; reads never do, which is why this is not part of `ready`.
    modelConfigured: Boolean(env.DEEPSEEK_API_KEY),
  };
  // Readiness is about the map's read path. A missing model key leaves published data readable
  // and must not fail the probe.
  const ready = checks.analysisStore;
  return Response.json({ status: ready ? "ready" : "degraded", checks }, {
    status: ready ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}

const worker = {
  async fetch(request: Request, env: SecPipelineEnv) {
    const path = new URL(request.url).pathname;
    if (path === "/health") return healthResponse();
    if (path === "/ready") return readyResponse(env);
    if (path.startsWith("/admin/business-map/")) return handleBusinessMapAdminRequest(request, env);
    if (path.startsWith("/admin/ai/")) return handleAiRunsAdminRequest(request, env);
    if (path === "/admin/financials" || path.startsWith("/admin/financials/")) return handleFinancialAdminRequest(request, env);
    if (path === "/admin/transcripts" || path.startsWith("/admin/transcripts/")) return handleTranscriptAdminRequest(request, env);
    if (path === "/admin" || path.startsWith("/admin/")) return handleReportAdminRequest(request, env);
    // Reads are served only over the MapReads binding; the retired public read prefix must never
    // fall through to the control handlers below.
    if (path === "/api/v1" || path.startsWith("/api/v1/")) return new Response("Not found", { status: 404 });
    if (path.startsWith("/sec-financials/refresh/")) return handleBusinessFlowRefresh(request, env);
    if (path.startsWith("/fundamentals/refresh/")) return handleFundamentalsRefreshRequest(request, env);
    if (path.startsWith("/company-analysis/")) return handleCompanyAnalysisRequest(request, env);
    return handleSecAnalysisRequest(request, env);
  },

  async scheduled(_controller: ScheduledController, env: SecPipelineEnv) {
    if (_controller.cron === "*/2 * * * *") {
      console.log(JSON.stringify({ event: "transcript-library", ...await syncTranscript(env) }));
      const maintenance = await runFinancialMaintenanceTick(env);
      if (maintenance.processed) {
        console.log(JSON.stringify({event:"financial-maintenance",...maintenance}));
      }
      // Waiting for a model Workflow never mutates the data-only history cursor. Keep that
      // request's issuer/idempotency lock without starving ordinary deterministic collection.
      if (!maintenance.processed || maintenance.blocksDataSweep === false) {
        const result = env.DB ? await runDataOnlySweep({DB:env.DB,SEC_FILINGS:env.SEC_FILINGS,SEC_USER_AGENT:env.SEC_USER_AGENT,SEC_DATA_TICKERS:env.SEC_DATA_TICKERS,SEC_TRACKED_TICKERS:env.SEC_TRACKED_TICKERS,SEC_DATA_COLLECTION_ENABLED:env.SEC_DATA_COLLECTION_ENABLED}) : {enabled:false,published:false,reasons:[],modelCalls:0};
        console.log(JSON.stringify({event:"financial-data",...result}));
      }
      // Whatever collection did this tick, the map's prepared data catches up with the archive. It runs even while
      // maintenance holds the collection lock: it only reads what is already archived.
      if (env.DB && env.SEC_FILINGS) {
        const derived = await runMapDerivationTick({DB:env.DB,SEC_FILINGS:env.SEC_FILINGS,SEC_DATA_TICKERS:env.SEC_DATA_TICKERS,SEC_TRACKED_TICKERS:env.SEC_TRACKED_TICKERS}).catch((error:unknown)=>({error:error instanceof Error?error.message:String(error)}));
        console.log(JSON.stringify({event:"map-derivation",...derived}));
      }
      return;
    }
    const results = await Promise.allSettled([
      runSecRefresh(env),
      runSecMemorySweep(env),
      runCompanyAnalysisSweep(env),
      // Took over from the refresh a public read used to trigger. Bounded per tick; the Cron
      // schedule above it is unchanged.
      runFundamentalsStalenessSweep(env),
      runBusinessFlowBootstrap(env),
      runBusinessExplainerSweep(env),
      runGuidanceSweep(env),
      runFindingsSweep(env),
      // Deterministic: EDGAR's current reports and Form 4 filings for the map's event rail, no model.
      runEventsSweep(env),
      // Operating quantities from the newest unread filing, then the figure plan once its inputs moved.
      runOperatingMetricsSweep(env),
      runFiguresSweep(env),
    ]);
    const [analysis, memory, companyAnalysis, fundamentals, businessFlow, businessExplainer, guidance, findings, events, operatingMetrics, figures] = results.map(describeSettled);
    const payload = JSON.stringify({ event: "sec-workflows", analysis, memory, companyAnalysis, fundamentals, businessFlow, businessExplainer, guidance, findings, events, operatingMetrics, figures });
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (!rejected.length) {
      console.log(payload);
      return;
    }
    /**
     * `allSettled` never rejects, so a broken run used to finish as `outcome: ok` with nothing but
     * this one log line to show for it — the whole refresh sat dead for days behind that. The work
     * is awaited rather than handed to `waitUntil` so a rethrow lands on the invocation record,
     * which is the only part of a Cron run anything can alert on.
     */
    console.error(payload);
    throw new AggregateError(rejected.map((result) => result.reason), "SEC scheduled run failed");
  },
} satisfies ExportedHandler<SecPipelineEnv>;

export default worker;
