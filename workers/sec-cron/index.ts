import { handleIbkrSyncRequest, runIbkrFlexSync, type IbkrSyncEnv } from "./ibkr-sync.ts";
import { handlePortfolioRead } from "./portfolio-api.ts";
import { IBKR_SYNC_CRON } from "../../shared/portfolio-contract.ts";

const worker = {
  async fetch(request: Request, env: IbkrSyncEnv) {
    const path = new URL(request.url).pathname;
    if (path === "/api/v1/portfolio") return handlePortfolioRead(request, env);
    if (path === "/internal/portfolio/sync") return handleIbkrSyncRequest(request, env);
    if (path === "/health") return Response.json({
      status: "ok", executor: "portfolio-data-sync", apiVersion: 1,
      portfolioConfigured: Boolean(env.DB && env.PORTFOLIO_READ_TOKEN && env.PORTFOLIO_SYNC_KEY && env.IBKR_FLEX_TOKEN),
    }, { headers: { "cache-control": "no-store" } });
    return Response.json({ error: "Endpoint retired" }, { status: 410 });
  },

  async scheduled(controller: ScheduledController, env: IbkrSyncEnv, context: ExecutionContext) {
    if (controller.cron !== IBKR_SYNC_CRON) return;
    context.waitUntil(runIbkrFlexSync(env).then(result => {
      console.log(JSON.stringify({ event: "ibkr-flex-sync", ...result }));
    }).catch(() => {
      // Provider exceptions may contain credentials. The persisted attempt marks the API delayed.
      console.error(JSON.stringify({ event: "ibkr-flex-sync-failed", trigger: "cron" }));
      throw new Error("Portfolio sync failed; previous data retained");
    }));
  },
} satisfies ExportedHandler<IbkrSyncEnv>;

export default worker;
