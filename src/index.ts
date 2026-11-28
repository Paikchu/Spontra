import { WorkerEntrypoint } from "cloudflare:workers";
import * as cloudflareWorkers from "cloudflare:workers";
import { installPiTracer, type PiTracer } from "./ai/pi/tracing.ts";
import { handleMapRead } from "./api/public/router.ts";
import { readHomeDigest } from "./api/public/home-digest.ts";
import { isLocale } from "./lib/locale.ts";
import type { AnalysisEnv } from "./operations.ts";
import worker from "./worker.ts";
import { createAdminSession } from "./api/admin/auth.ts";

/**
 * The request, queue and Cron handler lives in `./worker.ts` so it can be imported, and therefore tested, without
 * `cloudflare:workers`. The entrypoints and Durable Objects that need that module live here; this is the file
 * Wrangler points `main` at. Every model run is a `TaskRunner` (durable-runs/), one Durable Object per run.
 */
export { TaskRunner } from "./ai/durable-runs/runner.ts";

/**
 * The public business map reads over a Service Binding to this named entrypoint. A named entrypoint
 * is unreachable from the public internet, so the binding is the credential: no key to issue, store
 * or rotate for that consumer. Only the read API is exposed here; control routes stay on the default
 * entrypoint behind SEC_REFRESH_KEY.
 */
export class MapReads extends WorkerEntrypoint<AnalysisEnv> {
  fetch(request: Request) {
    return handleMapRead(request, this.env);
  }

  /** Aggregated homepage read. The public route is `GET /api/v1/home`; this method is the same query. */
  homeDigest(locale?: string | null) {
    if (!this.env.DB) return Promise.reject(new Error("The analysis store is not available on this deployment."));
    const lang = isLocale(locale) && locale !== "en" ? locale : null;
    return readHomeDigest(this.env.DB, lang);
  }
}

installPiTracer((cloudflareWorkers as unknown as { tracing?: PiTracer }).tracing);

/**
 * The admin site reaches the admin routes over its Service Binding to this named entrypoint. As with MapReads, the
 * binding is the credential: each request carries a fresh admin session, so the admin site asks for no password.
 * The default entrypoint's `/admin/*` still requires a signed session.
 */
export class AdminGateway extends WorkerEntrypoint<AnalysisEnv> {
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/admin/") || path === "/admin/session") return Response.json({ error: "Not found" }, { status: 404 });
    if (!this.env.REPORT_ADMIN_PASSWORD) return Response.json({ error: "管理后台尚未配置。" }, { status: 503 });
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${await createAdminSession(this.env.REPORT_ADMIN_PASSWORD)}`);
    return worker.fetch(new Request(request, { headers }), this.env, this.ctx);
  }
}

export default worker;
