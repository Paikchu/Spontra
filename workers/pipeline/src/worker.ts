import { handleCompanyAnalysisRequest, handleSecAnalysisRequest, runCompanyAnalysisSweep, runSecMemorySweep, runSecRefresh } from "./core.ts";
import { handleFundamentalsRefreshRequest } from "./fundamentals.ts";
import { runFundamentalsStalenessSweep } from "./fundamentals-sweep.ts";
import type { SecPipelineEnv } from "./operations.ts";
import { handleAnalysisReadRequest, isAnalysisReadPath } from "./read-api/router.ts";

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
    readCredentials: Boolean(env.ANALYSIS_READ_KEYS?.trim() || env.ANALYSIS_ADDITIONAL_READ_KEYS?.trim()),
    readRateLimiter: Boolean(env.ANALYSIS_READ_RATE_LIMIT),
    watchlist: Boolean(env.SEC_TRACKED_TICKERS?.trim()),
    analysisWorkflow: Boolean(env.SEC_ANALYSIS_WORKFLOW),
    // Generation needs a model; reads never do, which is why this is not part of `ready`.
    modelConfigured: Boolean(env.DEEPSEEK_API_KEY),
  };
  // Reads are the contract this service publishes, so readiness is about the read path. A missing
  // model key leaves published data perfectly readable and must not fail the probe.
  const ready = checks.analysisStore && checks.readCredentials;
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
    /**
     * The read API claims the whole `/api/v1` prefix and rejects every method but GET/HEAD itself,
     * so no request under it can fall through to the control handlers below — which is the only
     * thing standing between a read path and a workflow trigger if a route is ever mistyped.
     */
    if (isAnalysisReadPath(path)) return handleAnalysisReadRequest(request, env);
    if (path.startsWith("/fundamentals/refresh/")) return handleFundamentalsRefreshRequest(request, env);
    if (path.startsWith("/company-analysis/")) return handleCompanyAnalysisRequest(request, env);
    return handleSecAnalysisRequest(request, env);
  },

  async scheduled(_controller: ScheduledController, env: SecPipelineEnv) {
    const results = await Promise.allSettled([
      runSecRefresh(env),
      runSecMemorySweep(env),
      runCompanyAnalysisSweep(env),
      // Took over from the refresh a public read used to trigger. Bounded per tick; the Cron
      // schedule above it is unchanged.
      runFundamentalsStalenessSweep(env),
    ]);
    const [analysis, memory, companyAnalysis, fundamentals] = results.map(describeSettled);
    const payload = JSON.stringify({ event: "sec-workflows", analysis, memory, companyAnalysis, fundamentals });
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
