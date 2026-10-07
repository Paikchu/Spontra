import { fetchPortfolio, type PortfolioClientEnv } from "../lib/portfolio-client.ts";
import { readCalendar, writeCalendar } from "../lib/earnings-store.ts";
import { refreshCalendar } from "../lib/earnings-live.ts";

export type PortfolioJobsEnv = PortfolioClientEnv & {
  DB: D1Database;
  EARNING_REPORT_PIPELINE: { fetch: typeof fetch };
  RESEARCH_SYNC_KEY?: string;
};

export async function syncResearchHoldings(env: PortfolioJobsEnv) {
  const { portfolio } = await fetchPortfolio(env);
  if (!portfolio) return { status: "uninitialized" };
  if (!env.RESEARCH_SYNC_KEY) throw new Error("Research sync credential missing");
  const tickers = [...new Set(portfolio.positions.map(position => position.symbol.toUpperCase()))]
    .filter(ticker => /^[A-Z0-9.^=-]{1,20}$/.test(ticker));
  const response = await env.EARNING_REPORT_PIPELINE.fetch("https://earning-report-pipeline.internal/research/universe", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env.RESEARCH_SYNC_KEY}` },
    body: JSON.stringify({ tickers, asOf: portfolio.generatedAt }), signal: AbortSignal.timeout(15_000),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`Research holdings sync HTTP ${response.status}`);
  return { status: "synced", tickers: tickers.length };
}

export async function refreshPortfolioEarnings(env: PortfolioJobsEnv, now = new Date()) {
  const previous = await readCalendar(env.DB);
  if (previous.lastAttemptAt && now.getTime() - Date.parse(previous.lastAttemptAt) < 5 * 60_000) return { status: "recently_checked" };
  const { portfolio } = await fetchPortfolio(env);
  if (!portfolio) return { status: "uninitialized" };
  const state = await refreshCalendar(previous, new Set(portfolio.positions.map(position => position.symbol)), now);
  await writeCalendar(env.DB, state);
  return { status: state.status, events: state.events.length };
}

export async function runPortfolioJob(cron: string, env: PortfolioJobsEnv) {
  if (cron === "*/5 * * * *") return syncResearchHoldings(env);
  if (cron === "15 * * * *") return refreshPortfolioEarnings(env);
  return { status: "unknown_cron" };
}
