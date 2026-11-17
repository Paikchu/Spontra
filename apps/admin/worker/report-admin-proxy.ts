import { asServiceBinding, serviceFetcher } from "../../../packages/web/src/model/service-binding.ts";
import { FEATURES } from "../../../shared/analysis-contract/business-features.ts";

const MAX_BODY = 8192;
/** A company's valuation inputs carry management's cited targets with their sources, which run past the usual limit. */
const MAX_VALUATION_INPUTS_BODY = 65536;
const valuationInputs = /^companies\/[A-Z][A-Z0-9.-]{0,11}\/valuation-inputs$/;
type ProxyEnv = Record<string, unknown>;
const FEATURE = `(?:${FEATURES.join("|")})`;
const companyWrite = new RegExp(`^companies\\/[A-Z][A-Z0-9.-]{0,11}(?:\\/presentation|\\/stage|\\/features\\/${FEATURE})?$`);
const featureWrite = new RegExp(`^features\\/${FEATURE}$`);
const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } });

/** The binding to Spontra Analysis's AdminGateway entrypoint is the credential; the browser holds none. */
export async function handleReportAdminProxy(request: Request, path: string[], env: ProxyEnv): Promise<Response> {
  const checkpointRead = request.method === "GET" && path.length === 5 && /^public-research\/runs\/public-[a-f0-9]{40}\/checkpoints\/(?:research-demand|research-financing|synthesis|review|repair|review-repair)$/.test(path.join("/"));
  if (!path.length || !/^(financials|business-map|ai|library|reports|public-research)$/.test(path[0]!) || (!checkpointRead && path.length > (path[0] === "financials" || path[0] === "ai" || path[0] === "library" || path[0] === "reports" ? 6 : path[0] === "business-map" || path[0] === "reports" ? 5 : 4))) return json({ error: "Not found" }, 404);
  if (path[0] === "public-research") {
    const route = path.slice(1).join("/");
    const read = checkpointRead || (request.method === "GET" && /^(?:runs|reports|runs\/[A-Za-z0-9._:-]{1,128}|reports\/[A-Za-z0-9._:-]{1,128}|companies\/[A-Z][A-Z0-9.-]{0,11}\/context)$/.test(route));
    const write = request.method === "POST" && /^(?:runs|runs\/[A-Za-z0-9._:-]{1,128}\/stop|exposures(?:\/from-tag)?|reports\/[A-Za-z0-9._:-]{1,128}\/(?:review|publish|withdraw|restore|invalidate|revise|operator-complete))$/.test(route);
    if (!read && !write) return json({ error: "Not found" }, 404);
  }
  if (path[0] === "business-map") {
    const route = path.slice(1).join("/");
    const read = request.method === "GET" && (/^companies(?:\/[A-Z][A-Z0-9.-]{0,11}\/(?:charts|flow|usage|valuation-inputs))?$/.test(route) || route === "messages" || route === "issuers" || route === "directory");
    const write = request.method === "POST" && (route === "messages/read" || route === "scheduled-analysis" || route === "stage" || companyWrite.test(route) || featureWrite.test(route) || valuationInputs.test(route));
    if (!read && !write) return json({ error: "Not found" }, 404);
  }
  if (path[0] === "ai") {
    const route = path.slice(1).join("/");
    const read = request.method === "GET" && (route === "models" || route === "stage" || /^stage\/conversations\/[0-9a-f]{32}$/.test(route) || /^companies(?:\/[A-Z][A-Z0-9.-]{0,11}\/(?:findings|analyst|explainer|tree|valuation)(?:\/versions\/[0-9T:.Z-]{10,40})?)?$/.test(route) || /^companies\/[A-Z][A-Z0-9.-]{0,11}\/translations(?:\/artifact)?$/.test(route));
    const write = request.method === "POST" && (/^companies\/[A-Z][A-Z0-9.-]{0,11}\/(?:findings|analyst|explainer|tree|valuation)\/runs$/.test(route) || /^companies\/[A-Z][A-Z0-9.-]{0,11}\/translations(?:\/artifact)?$/.test(route) || /^models\/[a-z-]{2,40}$/.test(route) || route === "endpoints");
    if (!read && !write) return json({ error: "Not found" }, 404);
  }
  if (path[0] === "library") {
    const route = path.slice(1).join("/");
    const read = request.method === "GET" && /^(?:|companies\/[A-Z][A-Z0-9.-]{0,11}|materials\/[A-Z][A-Z0-9.-]{0,11}\/\d{10}-\d{2}-\d{6}(?:\/(?:index|markdown|tables(?:\/[^/]+)?))?|links(?:\/[A-Z][A-Z0-9.-]{0,11})?|tags(?:\/[A-Z][A-Z0-9.-]{0,11}|\/sectors\/[a-z_]{2,40})?)$/.test(route);
    const write = request.method === "POST" && /^(?:materials\/[A-Z][A-Z0-9.-]{0,11}\/\d{10}-\d{2}-\d{6}\/(?:prepare|prepare-pilot|reconcile-source)|links\/[A-Z][A-Z0-9.-]{0,11}\/[\p{L}\p{N}-]{1,60}|tags\/[A-Z][A-Z0-9.-]{0,11}\/(?:run|pair|tag\/t[a-f0-9]{24}))$/u.test(route);
    if (!read && !write) return json({ error: "Not found" }, 404);
  }
  if (path[0] === "reports") {
    const route = path.slice(1).join("/");
    const read = request.method === "GET" && (route === "" || /^[A-Z][A-Z0-9.-]{0,11}\/\d{10}-\d{2}-\d{6}\/(?:runs\/[A-Za-z0-9_-]{1,160}|shadow\/[A-Za-z0-9_-]{1,160}(?:\/checkpoint)?)$/.test(route));
    const write = request.method === "POST" && /^[A-Z][A-Z0-9.-]{0,11}\/\d{10}-\d{2}-\d{6}\/(?:regenerate|revise|recheck|shadow|shadow\/[A-Za-z0-9_-]{1,160}\/(?:promote|stop|resume|operator-complete))$/.test(route);
    if (!read && !write) return json({ error: "Not found" }, 404);
  }
  if (path[0] === "financials") {
    const route = path.slice(1).join("/");
    const read = request.method === "GET" && /^(companies(?:\/[A-Z][A-Z0-9.-]{0,11}(?:\/documents\/[a-f0-9]{64}(?:\/statements)?)?)?|tasks\/[A-Za-z0-9_-]{1,160})$/.test(route);
    const write = request.method === "POST" && /^(companies\/[A-Z][A-Z0-9.-]{0,11}\/actions|tasks\/[A-Za-z0-9_-]{1,160}\/cancel)$/.test(route);
    if (!read && !write) return json({ error: "Not found" }, 404);
  }
  if (request.method !== "GET") {
    // Browsers must prove same-origin; no cross-site write proxy.
    if (request.headers.get("origin") !== new URL(request.url).origin) return json({ error: "请求来源无效" }, 403);
  }
  const revision = path[0] === "public-research" && /^reports\/[A-Za-z0-9._:-]{1,128}\/revise$/.test(path.slice(1).join("/"));
  // A stopped industry's externally completed draft retains the full, audited original source excerpts.
  const operatorCompletion = path[0] === "public-research" && /^reports\/[A-Za-z0-9._:-]{1,128}\/operator-complete$/.test(path.slice(1).join("/"));
  const reconciliation=path[0] === "library" && /^materials\/[A-Z][A-Z0-9.-]{0,11}\/\d{10}-\d{2}-\d{6}\/reconcile-source$/.test(path.slice(1).join("/"));
  const filingOperator=path[0]==="reports"&&/^[A-Z][A-Z0-9.-]{0,11}\/\d{10}-\d{2}-\d{6}\/shadow\/[A-Za-z0-9_-]{1,160}\/operator-complete$/.test(path.slice(1).join("/"));
  const maxBody = operatorCompletion ? 262144 : revision || reconciliation || filingOperator ? 131072 : path[0] === "public-research" || (path[0] === "business-map" && valuationInputs.test(path.slice(1).join("/"))) ? MAX_VALUATION_INPUTS_BODY : MAX_BODY;
  if (request.url.length > 2048 || Number(request.headers.get("content-length") ?? 0) > maxBody) return json({ error: "请求过大" }, 413);
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
      if (new TextEncoder().encode(body).length > maxBody) return json({ error: "请求过大" }, 413);
      headers.set("content-type", "application/json");
    }
    const target = new URL(`/admin/${path.map(encodeURIComponent).join("/")}`, origin);
    target.search = new URL(request.url).search;
    const result = await serviceFetcher(binding)(target, { method: request.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    if (![200, 202, 400, 401, 403, 404, 405, 409, 413, 429, 503].includes(result.status)) return json({ error: "财报服务不可用" }, 503);
    return new Response(result.body, { status: result.status, headers: { "content-type": "application/json", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  } catch { return json({ error: "财报服务不可用" }, 503); }
}
