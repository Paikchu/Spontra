import {
  analysisErrorBody,
  analysisErrorStatus,
  type AnalysisErrorCode,
} from "./contract-support/errors.ts";

/**
 * Response construction for the read API. One place decides status, cache policy and validators,
 * so a handler cannot accidentally publish a different policy from the one the contract documents.
 */

/** How long a data-bearing response may be reused. Deliberately short. */
export const READ_CACHE_MAX_AGE_SECONDS = 30;

export type ReadCachePolicy = "cacheable" | "no-store";

export function errorResponse(code: AnalysisErrorCode, message: string, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(analysisErrorBody(code, message)), {
    status: analysisErrorStatus(code),
    headers: {
      "content-type": "application/json; charset=utf-8",
      // An error is never a cacheable artefact. Caching a transient 503 as though it were report
      // content is exactly how an outage outlives itself.
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

/**
 * Builds a data response, with a validator derived from the **entire** serialized body.
 *
 * Deriving the ETag from the whole body rather than from a data version matters here: these
 * payloads carry run-state metadata that changes while the underlying report does not, and an
 * ETag that ignored it would let a client hold "a newer run is queued" long after the run
 * finished.
 *
 * Every response is `private`: the business map decides what it caches and for how long, so no
 * shared cache between the two Workers may hold a copy.
 */
export async function dataResponse(
  request: Request,
  payload: unknown,
  policy: ReadCachePolicy = "cacheable",
): Promise<Response> {
  const body = JSON.stringify(payload);
  const etag = `W/"${await sha256Hex(body)}"`;
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": policy === "cacheable"
      ? `private, max-age=${READ_CACHE_MAX_AGE_SECONDS}, must-revalidate`
      : "no-store",
    etag,
    vary: "Authorization",
  };
  // The caller has already been authenticated and authorised by the time this runs — a 304 is a
  // statement about a resource the caller is allowed to read, so it cannot come first.
  if (matchesEtag(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, { status: 200, headers });
}

function matchesEtag(header: string | null, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header.split(",").map((candidate) => candidate.trim()).some((candidate) =>
    candidate === etag || candidate === etag.replace(/^W\//, ""));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
