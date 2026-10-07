import { extractCapitalFlows, fetchFlexStatement, normalizeFlexStatement } from "../../lib/ibkr-flex.ts";
import { selectTradeQueryPeriod } from "../../lib/portfolio-snapshot.ts";

import { publishFlexSnapshot, readPortfolioSnapshot, recordSyncFailure, type PortfolioDatabase } from "./portfolio-store.ts";
import { matchesSecret, matchesPortfolioReadToken } from "./auth.ts";

export type IbkrSyncEnv = Pick<PortfolioSyncBindings, "IBKR_FLEX_QUERY_ID"> & {
  DB: PortfolioDatabase;
  IBKR_FLEX_TOKEN: string;
  PORTFOLIO_SYNC_KEY: string;
  PORTFOLIO_READ_TOKEN: string;
  PORTFOLIO_SITE_READ_TOKEN?: string;
};

export async function runIbkrFlexSync(env: IbkrSyncEnv, fetcher: typeof fetch = fetch, clock: () => Date = () => new Date()) {
  const startedAt = clock().toISOString();
  try {
    if (!env.IBKR_FLEX_TOKEN || !/^\d+$/.test(env.IBKR_FLEX_QUERY_ID)) {
      throw new Error("IBKR Flex worker environment is incomplete");
    }
    const previous = await readPortfolioSnapshot(env.DB);
    const queryPeriod = selectTradeQueryPeriod(previous?.tradeSync.lastSuccessfulTradeAt ?? null, startedAt);
    const csv = await fetchFlexStatement({ token: env.IBKR_FLEX_TOKEN, queryId: env.IBKR_FLEX_QUERY_ID, periodDays: 365, fetcher });
    const input = normalizeFlexStatement(csv, { generatedAt: startedAt, queryPeriod, queryId: env.IBKR_FLEX_QUERY_ID });
    input.capitalFlows = extractCapitalFlows(csv);
    const { status, snapshot } = await publishFlexSnapshot(env.DB, input, clock().toISOString());
    return { status, reportDate: snapshot.source?.reportDate ?? null, positions: snapshot.positions.length, trades: snapshot.trades.length };
  } catch (error) {
    await recordSyncFailure(env.DB, startedAt);
    throw error;
  }
}

// A protected manual trigger uses exactly the same pipeline as the Cron.
export async function handleIbkrSyncRequest(
  request: Request,
  env: IbkrSyncEnv,
  sync: () => ReturnType<typeof runIbkrFlexSync> = () => runIbkrFlexSync(env),
): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: { ...headers, allow: "POST" } });
  }
  const suppliedKey = request.headers.get("x-portfolio-sync-key");
  if (!matchesSecret(suppliedKey, env.PORTFOLIO_SYNC_KEY) || matchesPortfolioReadToken(suppliedKey, env)) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  }
  try {
    const result = await sync();
    console.log(JSON.stringify({ event: "ibkr-flex-sync", trigger: "manual", ...result }));
    return Response.json(result, { headers });
  } catch (error) {
    let reason = error instanceof Error ? error.message : "Unknown sync error";
    for (const secret of [env.IBKR_FLEX_TOKEN, env.PORTFOLIO_SYNC_KEY]) {
      if (secret) reason = reason.replaceAll(secret, "[redacted]");
    }
    reason = reason.replace(/https?:\/\/\S+/g, "[redacted-url]");
    console.error(JSON.stringify({ event: "ibkr-flex-sync-failed", trigger: "manual", reason: reason.slice(0, 300) }));
    return Response.json({ error: "Portfolio sync failed; previous data retained" }, { status: 502, headers });
  }
}
