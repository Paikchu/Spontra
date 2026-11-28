import { handlePublicResearchAdminRequest } from "./domains/public-research/admin.ts";
import { refreshValuationQuotes } from "./domains/valuation/quotes.ts";
import { handleAiModelsAdminRequest } from "./api/admin/ai-models.ts";
import { companyPolicyEnvironment } from "./domains/financials/data/company-policy.ts";
import { handleTranscriptAdminRequest } from "./api/admin/transcripts.ts";
import { handleBusinessMapAdminRequest } from "./api/admin/business-map.ts";
import { handleAiRunsAdminRequest } from "./api/admin/ai-runs.ts";
import { handleLibraryAdminRequest } from "./api/admin/library.ts";
import { authenticateAdmin } from "./api/admin/auth.ts";
import { handleAdminGatewayRequest, serveAdminSpa } from "./api/admin/gateway.ts";
import { handleMaterialAcceptance } from "./api/admin/material-acceptance.ts";
import { handlePipelineAdminRequest } from "./api/admin/pipeline.ts";
import { handle as handlePublicSiteRequest, isPublicSitePath } from "./api/public/gateway.ts";
import { flushOutbox } from "./pipeline/outbox.ts";
import { handlePipelineQueue, pipelineEntry } from "./pipeline/consumer.ts";
import { handleSecAnalysisRequest } from "./core.ts";
import { runSecDiscovery } from "./pipeline/discovery.ts";
import { handleBusinessFlowRefresh } from "./domains/filing-analysis/sec/business-flow-refresh.ts";
import { handleFundamentalsRefreshRequest } from "./domains/financials/fundamentals-refresh.ts";
import type { AnalysisEnv } from "./operations.ts";
import { handleReportAdminRequest } from "./api/admin/reports.ts";
import { handleFinancialAdminRequest } from "./api/admin/financials.ts";

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

async function dispatchBackendAdmin(request: Request, env: AnalysisEnv): Promise<Response> {
  const path = new URL(request.url).pathname;
  // The admin's whitelist and AI switch override the deployment's company lists for everything below.
  env = await companyPolicyEnvironment(env);
  if (path.startsWith("/admin/material-acceptance/")) {
    if (!await authenticateAdmin(request, env.REPORT_ADMIN_PASSWORD)) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const url = new URL(request.url);
    url.pathname = path.replace("/admin/material-acceptance/", "/acceptance/");
    return handleMaterialAcceptance(new Request(url, request), env);
  }
  if (path === "/admin/public-research" || path.startsWith("/admin/public-research/")) return handlePublicResearchAdminRequest(request, env);
  if (path.startsWith("/admin/business-map/")) return handleBusinessMapAdminRequest(request, env);
  if (path === "/admin/ai/models" || path.startsWith("/admin/ai/models/") || path === "/admin/ai/endpoints" || path.startsWith("/admin/ai/endpoints/")) return handleAiModelsAdminRequest(request, env);
  if (path.startsWith("/admin/ai/")) return handleAiRunsAdminRequest(request, env);
  if (path === "/admin/library" || path.startsWith("/admin/library/")) return handleLibraryAdminRequest(request, env);
  if (path === "/admin/pipeline" || path.startsWith("/admin/pipeline/")) return handlePipelineAdminRequest(request, env);
  if (path === "/admin/financials" || path.startsWith("/admin/financials/")) return handleFinancialAdminRequest(request, env);
  if (path === "/admin/transcripts" || path.startsWith("/admin/transcripts/")) return handleTranscriptAdminRequest(request, env);
  return handleReportAdminRequest(request, env);
}

const isHtmlNavigation = (request: Request) =>
  (request.method === "GET" || request.method === "HEAD")
  && !request.headers.has("authorization")
  && (request.headers.get("sec-fetch-mode") === "navigate" || (request.headers.get("accept") ?? "").includes("text/html"));

const worker = {
  async fetch(request: Request, env: AnalysisEnv, ctx?: ExecutionContext) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/health") return healthResponse();
    if (path === "/ready") return readyResponse(env);

    // 1. Public headless iOS read API (`/api/business/v1/*`), signed report preview, and static assets.
    if (isPublicSitePath(path)) {
      const siteCtx = { waitUntil: (promise: Promise<unknown>) => { ctx?.waitUntil(promise); } };
      const cache = typeof caches === "undefined" ? undefined : (caches as CacheStorage & { default: Cache }).default;
      return handlePublicSiteRequest(request, env, siteCtx, undefined, cache);
    }

    // 2. Browser Admin API (`/api/admin/*`, guarded by Cloudflare Access when configured).
    if (path.startsWith("/api/admin/")) {
      return handleAdminGatewayRequest(request, env, dispatchBackendAdmin);
    }

    // 3. Retired or unknown `/api/*` routes must never fall through to control handlers below.
    if (path === "/api" || path.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }

    // 4. Browser Admin SPA pages (`/admin*`, or `/` on dedicated admin hostnames).
    if (isHtmlNavigation(request) && (path === "/admin" || path.startsWith("/admin/") || (path === "/" && /^(?:admin\.|spontra-admin)/.test(url.hostname)))) {
      return serveAdminSpa(request, env);
    }

    // 5. Direct backend `/admin/*` API calls (signed Bearer session or `/admin/session`).
    if (path === "/admin" || path.startsWith("/admin/")) {
      return dispatchBackendAdmin(request, env);
    }

    // 6. Control and refresh routes.
    if (path.startsWith("/sec-financials/refresh/")) {
      return handleBusinessFlowRefresh(request, await companyPolicyEnvironment(env));
    }
    if (path.startsWith("/fundamentals/refresh/")) {
      return handleFundamentalsRefreshRequest(request, await companyPolicyEnvironment(env));
    }
    if (request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }
    return handleSecAnalysisRequest(request, await companyPolicyEnvironment(env));
  },

  /**
   * The schedule discovers new SEC filings and refreshes reference closes independently of valuation research. Everything a
   * filing leads to runs on the events and tasks queues. A failed discovery fails the invocation, which is what
   * Cloudflare's error notification watches. The admin's scheduled-analysis switch is applied inside discovery.
   */
  async scheduled(_controller: ScheduledController, env: AnalysisEnv) {
    env = await companyPolicyEnvironment(env);
    await pipelineEntry(env);
    try {
      console.log(JSON.stringify({ event: "sec-discovery", ...await runSecDiscovery(env) }));

    } finally {
      try { console.log(JSON.stringify({ event: "valuation-quotes", ...await refreshValuationQuotes(env) })); }
      catch (error) { console.error(JSON.stringify({ event: "valuation-quotes", error: error instanceof Error ? error.message : String(error) })); }
      // Filings just discovered go out now rather than at the next invocation.
      await flushOutbox(env).catch((error:unknown)=>console.error(JSON.stringify({event:"pipeline-outbox",error:error instanceof Error?error.message:String(error)})));
    }
  },

  /** The events, tasks and dead-letter queues of the event-driven pipeline. */
  async queue(batch: MessageBatch<unknown>, env: AnalysisEnv) {
    await handlePipelineQueue(batch, await companyPolicyEnvironment(env));
  },
} satisfies ExportedHandler<AnalysisEnv>;

export default worker;
