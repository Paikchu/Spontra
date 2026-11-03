import { accessConfig, verifyAccess, type AccessEnv } from "./access.ts";
import { handleAnalyticsProxy } from "./analytics-proxy.ts";
import { handleReportAdminProxy } from "./report-admin-proxy.ts";

export type AdminEnv = {
  ASSETS: { fetch: typeof fetch };
  SPONTRA_ANALYSIS?: { fetch: typeof fetch };
  BUSINESS_SITE?: { fetch: typeof fetch };
} & AccessEnv;

const accessDenied = { unauthorized: { error: "需要登录", status: 401 }, unavailable: { error: "登录服务不可用", status: 503 } } as const;

/** `fetcher` reaches the Access team domain for its signing keys. */
export async function handleAdminRequest(request: Request, env: AdminEnv, fetcher: typeof fetch = (input, init) => fetch(input, init)): Promise<Response> {
  const url = new URL(request.url);
  const access = accessConfig(env);
  const verdict = access && url.pathname.startsWith("/api/admin/") ? await verifyAccess(request, access, fetcher) : "ok";
  let response: Response;
  if (verdict !== "ok") {
    const { error, status } = accessDenied[verdict];
    response = Response.json({ error }, { status });
  } else if (url.pathname === "/api/admin/analytics") {
    response = await handleAnalyticsProxy(request, env);
  } else if (url.pathname.startsWith("/api/admin/")) {
    if (!["GET", "POST"].includes(request.method)) {
      response = new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
    } else {
      let path: string[];
      try { path = url.pathname.slice("/api/admin/".length).split("/").map(decodeURIComponent); }
      catch { path = []; }
      response = await handleReportAdminProxy(request, path, env);
    }
  } else if (url.pathname.startsWith("/api/")) {
    response = new Response("Not found", { status: 404 });
  } else if (!["GET", "HEAD"].includes(request.method)) {
    response = new Response("Method not allowed", { status: 405 });
  } else {
    response = await env.ASSETS.fetch(request);
  }
  const secured = new Response(response.body, response);
  secured.headers.set("cache-control", "private, no-store");
  secured.headers.set("x-robots-tag", "noindex, nofollow");
  secured.headers.set("x-content-type-options", "nosniff");
  secured.headers.set("x-frame-options", "DENY");
  secured.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  if (!access && url.pathname.startsWith("/api/")) secured.headers.set("x-admin-auth", "unconfigured");
  return secured;
}

// The runtime passes (request, env, ctx); keep ctx out of the fetcher slot.
const worker = { fetch: (request: Request, env: AdminEnv) => handleAdminRequest(request, env) };
export default worker;
