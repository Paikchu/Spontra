import { handleStageAdminRequest } from "./admin/stage.ts";
import { handleAiModelsAdminRequest } from "./admin/ai-models.ts";
import { companyPolicyEnvironment } from "./financial-data/company-policy.ts";
import {handleTranscriptAdminRequest} from './admin/transcripts.ts';
import {handleBusinessMapAdminRequest} from './admin/business-map.ts';
import {handleAiRunsAdminRequest} from './admin/ai-runs.ts';
import {handleLibraryAdminRequest} from './admin/library.ts';
import {handlePipelineAdminRequest} from './admin/pipeline.ts';
import {flushOutbox} from './pipeline/outbox.ts';
import {handlePipelineQueue, pipelineEntry} from './pipeline/consumer.ts';
import { handleCompanyAnalysisRequest, handleSecAnalysisRequest } from "./core.ts";
import { runSecDiscovery } from "./pipeline/discovery.ts";
import { handleBusinessFlowRefresh } from "./sec/business-flow-refresh.ts";
import { handleFundamentalsRefreshRequest } from "./fundamentals.ts";
import type { AnalysisEnv } from "./operations.ts";
import { handleReportAdminRequest } from "./admin/reports.ts";
import { handleFinancialAdminRequest } from "./admin/financials.ts";

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
function readyResponse(env: AnalysisEnv): Response {
  const checks = {
    analysisStore: Boolean(env.DB),
    watchlist: Boolean(env.SEC_TRACKED_TICKERS?.trim()),
    analysisWorkflow: Boolean(env.SEC_ANALYSIS_WORKFLOW),
    // Generation needs a model; reads never do, which is why this is not part of `ready`.
    modelConfigured: Boolean(env.ANTHROPIC_API_KEY),
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
  async fetch(request: Request, env: AnalysisEnv) {
    const path = new URL(request.url).pathname;
    if (path === "/health") return healthResponse();
    if (path === "/ready") return readyResponse(env);
    // The admin's whitelist and AI switch override the deployment's company lists for everything below.
    env = await companyPolicyEnvironment(env);
    if (path.startsWith("/admin/business-map/")) return handleBusinessMapAdminRequest(request, env);
    if (path === "/admin/ai/models" || path.startsWith("/admin/ai/models/")) return handleAiModelsAdminRequest(request, env);
    if (path === "/admin/ai/stage" || path.startsWith("/admin/ai/stage/")) return handleStageAdminRequest(request, env);
    if (path.startsWith("/admin/ai/")) return handleAiRunsAdminRequest(request, env);
    if (path === "/admin/library" || path.startsWith("/admin/library/")) return handleLibraryAdminRequest(request, env);
    if (path === "/admin/pipeline" || path.startsWith("/admin/pipeline/")) return handlePipelineAdminRequest(request, env);
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

  /**
   * The only schedule: discover new SEC filings, because EDGAR pushes nothing (docs/analysis-events.md). Everything a
   * filing leads to runs on the events and tasks queues. A failed discovery fails the invocation, which is what
   * Cloudflare's error notification watches.
   */
  async scheduled(_controller: ScheduledController, env: AnalysisEnv) {
    env = await companyPolicyEnvironment(env);
    await pipelineEntry(env);
    try {
      console.log(JSON.stringify({ event: "sec-discovery", ...await runSecDiscovery(env) }));
    } finally {
      // Filings just discovered go out now rather than at the next invocation.
      await flushOutbox(env).catch((error:unknown)=>console.error(JSON.stringify({event:"pipeline-outbox",error:error instanceof Error?error.message:String(error)})));
    }
  },

  /** The events, tasks and dead-letter queues of the event-driven pipeline (docs/analysis-events.md). */
  async queue(batch: MessageBatch<unknown>, env: AnalysisEnv) {
    await handlePipelineQueue(batch, await companyPolicyEnvironment(env));
  },
} satisfies ExportedHandler<AnalysisEnv>;

export default worker;
