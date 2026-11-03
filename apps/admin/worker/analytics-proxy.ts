const RANGES = new Set(["24h", "7d", "4w"]);
const json = (body: unknown, status: number, extra?: HeadersInit) => Response.json(body, { status, headers: { "cache-control": "private, no-store", ...Object.fromEntries(new Headers(extra)) } });

export type AnalyticsEnv = { BUSINESS_SITE?: { fetch: typeof fetch } };

/** Reads the business site's aggregate. The admin holds no copy of the events and forwards no address or cookie. */
export async function handleAnalyticsProxy(request: Request, env: AnalyticsEnv): Promise<Response> {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, { allow: "GET" });
  const range = new URL(request.url).searchParams.get("range") ?? "7d";
  if (!RANGES.has(range)) return json({ error: "invalid" }, 400);
  const binding = env.BUSINESS_SITE;
  if (!binding || typeof binding.fetch !== "function") return json({ error: "统计服务未连接" }, 503);
  try {
    const result = await binding.fetch(new Request(`https://business-map.internal/api/business/v1/telemetry?range=${range}`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    }));
    return new Response(result.body, { status: result.status, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
  } catch {
    return json({ error: "统计服务未连接" }, 503);
  }
}
