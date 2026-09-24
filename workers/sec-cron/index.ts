import { handleIbkrSyncRequest, runIbkrFlexSync, type IbkrSyncEnv } from "./ibkr-sync.ts";

const worker = {
  async fetch(request: Request, env: IbkrSyncEnv) {
    if (new URL(request.url).pathname === "/internal/portfolio/sync") {
      return handleIbkrSyncRequest(request, env);
    }
    if (new URL(request.url).pathname === "/health") {
      return Response.json({ status: "ok", executor: "portfolio-cron", portfolioConfigured: Boolean(env.PORTFOLIO_SERVICE && env.PORTFOLIO_SYNC_KEY && env.IBKR_FLEX_TOKEN) }, { headers: { "cache-control": "no-store" } });
    }
    return Response.json({ error: "Legacy SEC execution retired" }, { status: 410 });
  },

  async scheduled(controller: ScheduledController, env: IbkrSyncEnv, context: ExecutionContext) {
    if (controller.cron === "*/5 * * * *") {
      if (!env.PORTFOLIO_SERVICE || !env.PORTFOLIO_SYNC_KEY) throw new Error("Research holdings sync not configured");
      const response = await env.PORTFOLIO_SERVICE.fetch("https://investment-record.internal/api/internal/research/sync", {
        method: "POST", headers: { "x-portfolio-sync-key": env.PORTFOLIO_SYNC_KEY },
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`Research holdings sync HTTP ${response.status}`);
      return;
    }
    if (controller.cron === "15 * * * *") {
      context.waitUntil((async () => {
        if (!env.PORTFOLIO_SERVICE || !env.PORTFOLIO_SYNC_KEY) throw new Error("Earnings refresh binding or credential missing");
        const response = await env.PORTFOLIO_SERVICE.fetch("https://investment-record.internal/api/internal/earnings/refresh", {
          method: "POST", headers: { "x-portfolio-sync-key": env.PORTFOLIO_SYNC_KEY },
        });
        if (!response.ok) throw new Error(`Earnings refresh HTTP ${response.status}`);
        console.log(JSON.stringify({event: "earnings-calendar-refresh", result: await response.json()}));
      })());
      return;
    }
    if (controller.cron === "0 6 * * 2-6") {
      context.waitUntil(runIbkrFlexSync(env).then((result) => {
        console.log(JSON.stringify({ event: "ibkr-flex-sync", ...result }));
      }));
      return;
    }
    console.warn(JSON.stringify({ event: "unknown-cron", cron: controller.cron }));
  },
} satisfies ExportedHandler<IbkrSyncEnv>;

export default worker;
