import { companyRequest } from "./company-request";
import { MAP_RESOURCES, type MapResource, type MapRevisions } from "@/shared/analysis-contract/revisions";
import type { Locale } from "@/shared/analysis-runtime/locale";

/** The locale is captured when a read starts, so a language switch cannot change a pending request's URL. */
export function companyPath(ticker: string, locale: Locale, resource = "", rev?: string): string {
  const query = new URLSearchParams();
  if (locale !== "en") query.set("lang", locale);
  if (rev) query.set("rev", rev);
  const search = query.toString();
  return `/api/business/v1/companies/${encodeURIComponent(ticker)}${resource}${search ? `?${search}` : ""}`;
}

/** The revision of each resource the page reads; null when the answer is unavailable. */
export async function fetchRevisions(ticker: string, signal: AbortSignal): Promise<MapRevisions | null> {
  const response = await fetch(`/api/business/v1/companies/${encodeURIComponent(ticker)}/revision`, { signal, cache: "no-store" });
  if (!response.ok) return null;
  const body = await response.json() as { revisions?: MapRevisions };
  return body.revisions && typeof body.revisions === "object" ? body.revisions : null;
}

type OpeningBundle = { revisions: MapRevisions | null; resources: Partial<Record<MapResource, { status: number; body: unknown; retryAfter?: string | null; exhausted?: boolean }>> };

export type OpeningRequests = {
  signal: AbortSignal;
  abort: () => void;
  revisions: Promise<MapRevisions | null>;
  response: (resource: MapResource) => Promise<Response>;
};

export type CompanyOpening = { start: () => OpeningRequests };

/** Observe failures now; the route module may not attach its consumer until after the request has settled. */
function observed<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => {});
  return promise;
}

/** An inert, route-owned handle. Starting it overlaps every opening request with the lazy route's download. */
export function createCompanyOpening(ticker: string, locale: Locale): CompanyOpening {
  let current: OpeningRequests | null = null;
  return {
    start() {
      if (current && !current.signal.aborted) return current;
      const controller = new AbortController();
      const { signal } = controller;
      const bundle = observed(companyRequest(companyPath(ticker, locale, "/opening"), signal).then(async response => {
        if (!response.ok) return { revisions: null, resources: Object.fromEntries(MAP_RESOURCES.map(resource => [resource, { status: response.status, body: null, exhausted: true }])) } as OpeningBundle;
        return await response.json() as OpeningBundle;
      }));
      const revisions = observed(bundle.then(body => body.revisions));
      const responses = new Map<MapResource, Promise<Response>>(MAP_RESOURCES.map(resource => [resource, observed(bundle.then(body => {
        signal.throwIfAborted();
        const part = body.resources[resource];
        return Response.json(part?.body ?? null, { status: part?.status ?? 503, headers: { ...(part?.retryAfter ? { "retry-after": part.retryAfter } : {}), ...(part?.exhausted ? { "x-retry-exhausted": "true" } : {}) } });
      }))]));
      current = {
        signal,
        abort: () => controller.abort(),
        revisions,
        response: resource => responses.get(resource)!,
      };
      return current;
    },
  };
}
