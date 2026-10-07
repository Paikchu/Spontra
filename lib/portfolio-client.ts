import type { PortfolioApiResponseV1, PortfolioReadSnapshot, PortfolioSyncMetadata } from "../shared/portfolio-contract.ts";

export type PortfolioClientEnv = {
  PORTFOLIO_DATA_SERVICE?: { fetch: typeof fetch };
  PORTFOLIO_READ_TOKEN?: string;
};

export class PortfolioUnavailableError extends Error {
  constructor(public readonly reason: "uninitialized" | "unavailable" = "unavailable") {
    super(reason === "uninitialized" ? "持仓数据尚未完成首次同步。" : "持仓数据暂时无法读取，请稍后重试。");
  }
}

export async function fetchPortfolio(env: PortfolioClientEnv): Promise<PortfolioApiResponseV1> {
  if (!env.PORTFOLIO_DATA_SERVICE || !env.PORTFOLIO_READ_TOKEN) throw new PortfolioUnavailableError();
  try {
    const response = await env.PORTFOLIO_DATA_SERVICE.fetch("https://portfolio-data.internal/api/v1/portfolio", {
      headers: { authorization: `Bearer ${env.PORTFOLIO_READ_TOKEN}` },
      redirect: "manual", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new PortfolioUnavailableError(); }
    return await response.json() as PortfolioApiResponseV1;
  } catch {
    throw new PortfolioUnavailableError();
  }
}

export async function loadPortfolio(env?: PortfolioClientEnv): Promise<{ snapshot: PortfolioReadSnapshot; sync: PortfolioSyncMetadata }> {
  const runtime = env ?? (await import("cloudflare:workers")).env as PortfolioClientEnv;
  const { portfolio, ...sync } = await fetchPortfolio(runtime);
  if (!portfolio) throw new PortfolioUnavailableError("uninitialized");
  return { snapshot: portfolio, sync };
}
