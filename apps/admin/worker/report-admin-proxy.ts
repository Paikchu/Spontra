import { asServiceBinding, serviceFetcher } from "../../../lib/earning-report/web/service-binding.ts";

const COOKIE = "spontra_report_admin";
const MAX_BODY = 8192;
type ProxyEnv = Record<string, unknown>;
const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } });

function cookie(value: string, request: Request, clear = false): string {
  return `${COOKIE}=${value}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 8 * 3600}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}
export async function handleReportAdminProxy(request: Request, path: string[], env: ProxyEnv): Promise<Response> {
  if (!path.length || !/^(session|reports)$/.test(path[0]!) || path.length > 4) return json({ error: "Not found" }, 404);
  if (request.method !== "GET") {
    // Browsers must prove same-origin even before login; no public write proxy.
    if (request.headers.get("origin") !== new URL(request.url).origin) return json({ error: "请求来源无效。" }, 403);
  }
  if (path[0] === "session" && request.method === "DELETE") {
    const response = json({ status: "signed_out" }, 200);
    response.headers.set("set-cookie", cookie("", request, true));
    return response;
  }
  const login = path.length === 1 && path[0] === "session" && request.method === "POST";
  const token = request.headers.get("cookie")?.split(";").map(v => v.trim()).find(v => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!login && !token) return json({ error: "请登录财报管理后台。" }, 401);
  if (request.url.length > 2048 || Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return json({ error: "请求过大。" }, 413);
  try {
    const binding = asServiceBinding(env.EARNING_REPORT_PIPELINE);
    const origin = "https://earning-report-pipeline.internal";
    if (!binding) return json({ error: "财报服务尚未连接。" }, 503);
    const headers = new Headers({ accept: "application/json" });
    const ip = request.headers.get("cf-connecting-ip");
    if (ip) headers.set("cf-connecting-ip", ip);
    if (token) headers.set("authorization", `Bearer ${token}`);
    const idempotency = request.headers.get("idempotency-key");
    if (idempotency) headers.set("idempotency-key", idempotency);
    let body: string | undefined;
    if (request.method === "POST") {
      body = await request.text();
      if (new TextEncoder().encode(body).length > MAX_BODY) return json({ error: "请求过大。" }, 413);
      headers.set("content-type", "application/json");
    }
    if (login) {
      let key: unknown;
      try { key = (JSON.parse(body ?? "{}") as { key?: unknown }).key; } catch { return json({ error: "请输入管理密钥。" }, 400); }
      if (typeof key !== "string" || !key || key.length > 4096) return json({ error: "请输入管理密钥。" }, 400);
      headers.set("x-sec-refresh-key", key);
      body = undefined;
    }
    const target = new URL(`/admin/${path.map(encodeURIComponent).join("/")}`, origin);
    target.search = new URL(request.url).search;
    const result = await serviceFetcher(binding)(target, { method: request.method, headers, body, redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (login && result.status === 200) {
      const payload = await result.json() as { token?: string };
      if (!payload.token || !/^report-admin\.v1\.[a-f0-9.-]+$/.test(payload.token)) return json({ error: "登录服务暂时不可用。" }, 503);
      const response = json({ status: "signed_in" }, 200);
      response.headers.set("set-cookie", cookie(payload.token, request));
      return response;
    }
    if (![200, 202, 400, 401, 403, 404, 405, 409, 413, 429, 503].includes(result.status)) return json({ error: "财报服务暂时不可用。" }, 503);
    return new Response(result.body, { status: result.status, headers: { "content-type": "application/json", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  } catch { return json({ error: "财报服务暂时不可用，请稍后重试。" }, 503); }
}
