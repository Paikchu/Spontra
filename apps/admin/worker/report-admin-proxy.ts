import { asServiceBinding, serviceFetcher } from "../../../packages/web/src/model/service-binding.ts";

const MAX_BODY = 8192;
type ProxyEnv = Record<string, unknown>;
const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } });

/** The binding to Spontra Analysis's AdminGateway entrypoint is the credential; the browser holds none. */
export async function handleReportAdminProxy(request: Request, path: string[], env: ProxyEnv): Promise<Response> {
  if (!path.length || !/^(financials|business-map|ai|library)$/.test(path[0]!) || path.length > (path[0] === "financials" || path[0] === "ai" || path[0] === "library" ? 6 : path[0] === "business-map" ? 5 : 4)) return json({ error: "Not found" }, 404);
  if (path[0] === "business-map") {
    const route = path.slice(1).join("/");
    const read = request.method === "GET" && (/^companies(?:\/[A-Z][A-Z0-9.-]{0,9}\/charts)?$/.test(route) || route === "messages");
    const write = request.method === "POST" && (route === "messages/read" || /^companies\/[A-Z][A-Z0-9.-]{0,9}(?:\/presentation|\/features\/(?:reports|findings|explainer|tree))?$/.test(route) || /^features\/(?:reports|findings|explainer|tree)$/.test(route));
    if (!read && !write) return json({ error: "Not found" }, 404);
  }
  if (path[0] === "ai") {
    const route = path.slice(1).join("/");
    const read = request.method === "GET" && (route === "models" || route === "stage" || /^stage\/conversations\/[0-9a-f]{32}$/.test(route) || /^companies(?:\/[A-Z][A-Z0-9.-]{0,9}\/(?:findings|analyst|checkup|explainer|tree)(?:\/versions\/[0-9T:.Z-]{10,40})?)?$/.test(route) || /^companies\/[A-Z][A-Z0-9.-]{0,9}\/translations$/.test(route));
    const write = request.method === "POST" && (/^companies\/[A-Z][A-Z0-9.-]{0,9}\/(?:findings|analyst|checkup|explainer|tree)\/runs$/.test(route) || /^models\/[a-z-]{2,40}$/.test(route));
    if (!read && !write) return json({ error: "Not found" }, 404);
  }
  if (path[0] === "library") {
    const route = path.slice(1).join("/");
    const read = request.method === "GET" && /^(?:|find|facts|search|links(?:\/[A-Z][A-Z0-9.-]{0,9})?|tags(?:\/[A-Z][A-Z0-9.-]{0,9}|\/sectors\/[a-z_]{2,40})?|wiki\/[A-Z][A-Z0-9.-]{0,9}|companies\/[A-Z][A-Z0-9.-]{0,9}|documents\/[a-f0-9]{64}(?:\/sections\/s[a-f0-9]{28})?)$/.test(route);
    const write = request.method === "POST" && /^(?:documents\/[a-f0-9]{64}\/rerun|links\/[A-Z][A-Z0-9.-]{0,9}\/[\p{L}\p{N}-]{1,60}|tags\/[A-Z][A-Z0-9.-]{0,9}\/(?:run|pair|tag\/t[a-f0-9]{24}))$/u.test(route);
    if (!read && !write) return json({ error: "Not found" }, 404);
  }
  if (path[0] === "financials") {
    const route = path.slice(1).join("/");
    const read = request.method === "GET" && /^(companies(?:\/[A-Z][A-Z0-9.-]{0,9}(?:\/documents\/[a-f0-9]{64}(?:\/statements)?)?)?|tasks\/[A-Za-z0-9_-]{1,160})$/.test(route);
    const write = request.method === "POST" && /^(companies\/[A-Z][A-Z0-9.-]{0,9}\/actions|tasks\/[A-Za-z0-9_-]{1,160}\/cancel)$/.test(route);
    if (!read && !write) return json({ error: "Not found" }, 404);
  }
  if (request.method !== "GET") {
    // Browsers must prove same-origin; no cross-site write proxy.
    if (request.headers.get("origin") !== new URL(request.url).origin) return json({ error: "请求来源无效" }, 403);
  }
  if (request.url.length > 2048 || Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return json({ error: "请求过大" }, 413);
  try {
    const binding = asServiceBinding(env.SPONTRA_ANALYSIS);
    const origin = "https://spontra-analysis.internal";
    if (!binding) return json({ error: "财报服务未连接" }, 503);
    const headers = new Headers({ accept: "application/json" });
    const ip = request.headers.get("cf-connecting-ip");
    if (ip) headers.set("cf-connecting-ip", ip);
    const idempotency = request.headers.get("idempotency-key");
    if (idempotency) headers.set("idempotency-key", idempotency);
    let body: string | undefined;
    if (request.method === "POST") {
      body = await request.text();
      if (new TextEncoder().encode(body).length > MAX_BODY) return json({ error: "请求过大" }, 413);
      headers.set("content-type", "application/json");
    }
    const target = new URL(`/admin/${path.map(encodeURIComponent).join("/")}`, origin);
    target.search = new URL(request.url).search;
    const result = await serviceFetcher(binding)(target, { method: request.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    if (![200, 202, 400, 401, 403, 404, 405, 409, 413, 429, 503].includes(result.status)) return json({ error: "财报服务不可用" }, 503);
    return new Response(result.body, { status: result.status, headers: { "content-type": "application/json", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  } catch { return json({ error: "财报服务不可用" }, 503); }
}
