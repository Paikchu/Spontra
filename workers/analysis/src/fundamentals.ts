import { FundamentalSyncService } from "./fundamentals/fundamental-sync.ts";
import { D1FundamentalsRepository, FundamentalSyncInProgressError, type FundamentalsD1Database } from "./fundamentals/fundamentals-d1.ts";
import { normalizeTrackedTicker } from "./sec/config.ts";
import { assertDataTicker, requireDb, type SecCronEnv } from "./core.ts";

export type FundamentalsSyncOutcome = {
  ticker: string;
  status: "synced" | "in-progress";
  qualityStatus?: string;
  observationCount?: number;
  fetchedAt?: string;
};

/**
 * The Yahoo sync used to run on the Web Worker: this Worker's cron POSTed
 * `/api/internal/fundamentals/refresh`, and the request handler kicked the fetch off in a
 * `waitUntil` before answering. That put outbound third-party fetching on the Worker that serves
 * public traffic, and it put the failure — a rate limit, a schema change at Yahoo — inside a
 * request the reader was still waiting on. Here it is an ordinary durable step: the Worker that
 * owns the schedule also does the fetching, and a failure is retried by the Workflow instead of
 * being swallowed by a request that already returned.
 */
export async function syncFundamentals(database: FundamentalsD1Database, ticker: string): Promise<FundamentalsSyncOutcome> {
  const service = new FundamentalSyncService(new D1FundamentalsRepository(database));
  try {
    const result = await service.syncTicker(ticker);
    return {
      ticker,
      status: "synced",
      qualityStatus: result.qualityStatus,
      observationCount: result.observationCount,
      fetchedAt: result.fetchedAt,
    };
  } catch (error) {
    // Another run already holds this ticker's lease. That is ordinary contention, not a failure,
    // and retrying the step would only take a number in the same queue.
    if (error instanceof FundamentalSyncInProgressError) return { ticker, status: "in-progress" };
    throw error;
  }
}

/**
 * The control-plane counterpart to `syncFundamentals`: the Web Worker's public fundamentals page
 * used to trigger this refresh by running it locally. That put the same outbound Yahoo fetch this
 * Worker's cron already does onto the Worker serving public traffic instead. Now Web only asks —
 * an upper Worker calling down is fine — and this Worker still owns the fetching and the write.
 */
export async function handleFundamentalsRefreshRequest(request: Request, env: SecCronEnv): Promise<Response> {
  if (request.method !== "POST") return new Response("Not found", { status: 404 });
  if (!env.SEC_REFRESH_KEY || request.headers.get("x-sec-refresh-key") !== env.SEC_REFRESH_KEY) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const match = new URL(request.url).pathname.match(/^\/fundamentals\/refresh\/([^/]+)$/);
  let rawTicker = "";
  try {
    rawTicker = decodeURIComponent(match?.[1] ?? "");
  } catch {
    return Response.json({ error: "Invalid ticker" }, { status: 400 });
  }
  const ticker = normalizeTrackedTicker(rawTicker);
  if (!ticker) return Response.json({ error: "Invalid ticker" }, { status: 400 });
  try {
    assertDataTicker(env, ticker);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Ticker is not tracked" }, { status: 403 });
  }
  try {
    const outcome = await syncFundamentals(requireDb(env), ticker);
    return Response.json(outcome, { status: 202 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to sync fundamentals" }, { status: 503 });
  }
}
