import { handleReportAdminProxy } from "./report-admin-proxy.ts";

export type AdminEnv = {
  ASSETS: { fetch: typeof fetch };
  EARNING_REPORT_PIPELINE?: { fetch: typeof fetch };
};

export async function handleAdminRequest(request: Request, env: AdminEnv): Promise<Response> {
  const url = new URL(request.url);
  let response: Response;
  if (url.pathname.startsWith("/api/admin/")) {
    if (!["GET", "POST", "DELETE"].includes(request.method)) {
      response = new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST, DELETE" } });
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
  return secured;
}

const worker = { fetch: handleAdminRequest };
export default worker;
