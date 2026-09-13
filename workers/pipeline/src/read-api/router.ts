import { getPublicCompanyAnalysis } from "../company-analysis/api.ts";
import { D1CompanyAnalysisRepository } from "../company-analysis/repository.ts";
import { parseFundamentalApiQuery } from "../fundamentals/fundamentals-api.ts";
import { getSecFundamentals } from "../fundamentals/sec-fundamentals.ts";
import { getPublicFiling, getPublicFilingPage } from "../sec/public-api.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { findSecurity } from "../catalog/security-directory.ts";
import { AnalysisRequestError, type AnalysisErrorCode } from "./contract-support/errors.ts";
import { buildAnalysisOpenApiDocument } from "./contract-support/openapi.ts";
import type { AnalysisReadScope } from "./contract-support/versions.ts";
import { authenticateReadRequest, hasScope, type AnalysisReadIdentity } from "./auth.ts";
import { dataResponse, errorResponse } from "./http.ts";

/**
 * The analysis backend's read surface.
 *
 * Strictly read-only. Nothing reachable from here calls a model, fetches from SEC or Yahoo,
 * creates a Workflow, enqueues a refresh, or writes business data — including transitively, which
 * is why the fundamentals refresh that used to be triggered by a read now lives on the scheduled
 * sweep instead (`workers/pipeline/fundamentals-sweep.ts`).
 *
 * These handlers are the *only* implementation. A request over the Web Worker's Service Binding
 * and a request from an unrelated service over HTTPS arrive here identically and are answered
 * identically; the transport is not consulted, and neither is any caller-supplied claim about who
 * the caller is. Only the `Authorization` header decides.
 */
export type RateLimiterLike = { limit(options: { key: string }): Promise<{ success: boolean }> };

export type AnalysisReadEnv = {
  /** The analysis database. Absent in a partially configured environment, which answers 503. */
  DB?: D1Database;
  /** Read credentials. Absent means no reader is authorised — the surface fails closed. */
  ANALYSIS_READ_KEYS?: string;
  /** Independent read credentials; existing encrypted keys need not be replaced to add a consumer. */
  ANALYSIS_ADDITIONAL_READ_KEYS?: string;
  /**
   * Cloudflare's rate-limit binding, keyed per credential. Optional so a local `wrangler dev`
   * without it still serves; its absence is reported by `/ready` rather than silently substituted
   * with an in-isolate counter, which would not be a distributed limit at all.
   */
  ANALYSIS_READ_RATE_LIMIT?: RateLimiterLike;
};

export const ANALYSIS_READ_PREFIX = "/api/v1/";
/** A read request carries a ticker, a cursor and two small numbers. Anything longer is not one. */
const MAX_REQUEST_URL_LENGTH = 2_048;
const MAX_QUERY_PARAMETERS = 8;

type RouteMatch =
  | { kind: "filings"; ticker: string }
  | { kind: "filing"; ticker: string; accession: string }
  | { kind: "analysis"; ticker: string }
  | { kind: "fundamentals"; ticker: string }
  | { kind: "openapi" };

const SCOPE_BY_ROUTE: Record<Exclude<RouteMatch["kind"], "openapi">, AnalysisReadScope> = {
  filings: "filings:read",
  filing: "filings:read",
  analysis: "analysis:read",
  fundamentals: "fundamentals:read",
};

/** True when this request belongs to the read API, so the caller never falls through to a writer. */
export function isAnalysisReadPath(pathname: string): boolean {
  return pathname === "/api/v1" || pathname.startsWith(ANALYSIS_READ_PREFIX);
}

export async function handleAnalysisReadRequest(request: Request, env: AnalysisReadEnv): Promise<Response> {
  // Method is checked before anything else: this router owns the whole `/api/v1` prefix precisely
  // so a POST cannot slip past it into a control handler further down the entry point.
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse("METHOD_NOT_ALLOWED", "This resource is read-only.", { allow: "GET, HEAD" });
  }
  if (request.url.length > MAX_REQUEST_URL_LENGTH) {
    return errorResponse("REQUEST_TOO_LARGE", "The request URL is too long.");
  }

  const url = new URL(request.url);
  if ([...url.searchParams.keys()].length > MAX_QUERY_PARAMETERS) {
    return errorResponse("REQUEST_TOO_LARGE", "Too many query parameters.");
  }

  const route = matchRoute(url.pathname);
  if (!route) return errorResponse("ROUTE_NOT_FOUND", "No such resource.");

  // The contract document is the one thing a consumer needs before it has a credential.
  if (route.kind === "openapi") {
    return dataResponse(request, buildAnalysisOpenApiDocument(url.origin));
  }

  let auth = await authenticateReadRequest(request, env.ANALYSIS_READ_KEYS);
  if (!auth.ok && env.ANALYSIS_ADDITIONAL_READ_KEYS?.trim()) {
    auth = await authenticateReadRequest(request, env.ANALYSIS_ADDITIONAL_READ_KEYS);
  }
  if (!auth.ok) {
    return auth.reason === "not_configured"
      ? errorResponse("READ_AUTH_NOT_CONFIGURED", "Read credentials are not configured on this deployment.")
      : errorResponse("UNAUTHORIZED", "A valid read credential is required.", { "www-authenticate": "Bearer" });
  }
  if (!hasScope(auth.identity, SCOPE_BY_ROUTE[route.kind])) {
    return errorResponse("FORBIDDEN_SCOPE", `This credential lacks the ${SCOPE_BY_ROUTE[route.kind]} scope.`);
  }
  if (!await withinRateLimit(env, auth.identity)) {
    return errorResponse("RATE_LIMITED", "Too many requests for this credential.");
  }
  if (!env.DB) {
    return errorResponse("STORAGE_UNAVAILABLE", "The analysis store is not available on this deployment.");
  }

  try {
    return await handleRoute(request, env.DB, route);
  } catch (error) {
    return errorResponse(...describeFailure(error));
  }
}

async function handleRoute(request: Request, database: D1Database, route: Exclude<RouteMatch, { kind: "openapi" }>): Promise<Response> {
  const url = new URL(request.url);
  switch (route.kind) {
    case "filings": {
      const page = await getPublicFilingPage(
        new D1SecRepository(database),
        route.ticker,
        url.searchParams.get("cursor"),
        url.searchParams.get("limit"),
      );
      return dataResponse(request, page);
    }
    case "filing": {
      const detail = await getPublicFiling(new D1SecRepository(database), route.ticker, route.accession,
        url.searchParams.has("reportVersion") || url.searchParams.has("reportDate")
          ? { reportVersion: url.searchParams.get("reportVersion") ?? "", reportDate: url.searchParams.get("reportDate") ?? "" } : undefined);
      if (!detail) return errorResponse("FILING_NOT_FOUND", "SEC filing not found.");
      return dataResponse(request, detail);
    }
    case "analysis": {
      const payload = await getPublicCompanyAnalysis(new D1CompanyAnalysisRepository(database), route.ticker);
      // A published result is a durable artefact and may be reused briefly. Everything else here
      // is execution state, which must not be cached as though it were report content.
      return dataResponse(request, payload, payload.status === "ready" ? "cacheable" : "no-store");
    }
    case "fundamentals": {
      const query = parseFundamentalApiQuery(route.ticker, url.searchParams);
      const payload = await getSecFundamentals(database, query);
      // Preserved from the pre-backend behaviour: a ticker the directory does not know as a stock
      // has no fundamentals to collect, and says so, rather than reporting an empty pending set.
      if (payload.status === "pending" && findSecurity(query.ticker)?.type !== "stock") {
        return errorResponse("FUNDAMENTALS_NOT_AVAILABLE", "Fundamentals are unavailable for this ticker.");
      }
      return dataResponse(request, payload, payload.status === "ready" ? "cacheable" : "no-store");
    }
  }
}

/**
 * A limiter that is bound is enforced; one that is not is reported by `/ready` and does not
 * pretend. Cloudflare's binding shares counters across isolates and Workers on the same
 * `namespace_id`, which an in-memory counter cannot do — so there is no fallback here on purpose.
 */
async function withinRateLimit(env: AnalysisReadEnv, identity: AnalysisReadIdentity): Promise<boolean> {
  if (!env.ANALYSIS_READ_RATE_LIMIT) return true;
  try {
    const { success } = await env.ANALYSIS_READ_RATE_LIMIT.limit({ key: identity.keyId });
    return success;
  } catch {
    // A limiter that errors must not take the read surface down with it.
    return true;
  }
}

function matchRoute(pathname: string): RouteMatch | null {
  if (pathname === "/api/v1/openapi.json") return { kind: "openapi" };
  const company = /^\/api\/v1\/companies\/([^/]+)\/(filings|analysis|fundamentals)(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!company) return null;
  const ticker = safeDecode(company[1]!);
  const resource = company[2]!;
  const tail = company[3];
  if (ticker === null) return null;
  if (resource === "filings") {
    if (tail === undefined) return { kind: "filings", ticker };
    const accession = safeDecode(tail);
    return accession === null ? null : { kind: "filing", ticker, accession };
  }
  if (tail !== undefined) return null;
  return resource === "analysis" ? { kind: "analysis", ticker } : { kind: "fundamentals", ticker };
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Query failures are translated, never forwarded. A validation error carries the code it declared;
 * anything else is a storage or runtime failure and becomes a 503 with no detail attached — a D1
 * message can name internal identifiers and has no place in a response body.
 */
function describeFailure(error: unknown): [AnalysisErrorCode, string] {
  if (error instanceof AnalysisRequestError) return [error.code, error.message];
  return ["STORAGE_UNAVAILABLE", "The analysis store is temporarily unavailable."];
}
