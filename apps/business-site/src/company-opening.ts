import { companyRequest } from "./company-request";
import { PRIMARY_MAP_RESOURCES, STREAM_MAP_RESOURCES, type MapResource, type MapRevisions } from "@/shared/analysis-contract/revisions";
import type { Locale } from "@/shared/analysis-runtime/locale";

/** A fresh URL namespace avoids copies cached before layer display choices were carried to the page. */
export const COMPANY_READ_SCHEMA = "artifact-i18n-v2-layers";

/** The locale is captured when a read starts, so a language switch cannot change a pending request's URL. */
export function companyPath(ticker: string, locale: Locale, resource = "", rev?: string, cfg?: string | null): string {
  const query = new URLSearchParams({ schema: COMPANY_READ_SCHEMA });
  if (locale !== "en") query.set("lang", locale);
  if (rev) query.set("rev", rev);
  if (cfg) query.set("cfg", cfg);
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

type OpeningPartPayload = { status: number; body: unknown; retryAfter?: string | null; exhausted?: boolean };
type OpeningBundle = { revisions: MapRevisions | null; config?: string | null; resources: Partial<Record<MapResource, OpeningPartPayload>> };

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

function bundleResponse(part: OpeningPartPayload | undefined): Response {
  return Response.json(part?.body ?? null, {
    status: part?.status ?? 503,
    headers: {
      ...(part?.retryAfter ? { "retry-after": part.retryAfter } : {}),
      ...(part?.exhausted ? { "x-retry-exhausted": "true" } : {}),
    },
  });
}

function needsStreamEagerly(): boolean {
  if (typeof location === "undefined") return false;
  const params = new URLSearchParams(location.search);
  return ["finding", "check", "report", "event"].some(key => params.has(key));
}

/**
 * An inert, route-owned handle. Starting it overlaps the primary opening read with the lazy route's download:
 * 1. Primary resources (`company`, `capital`, `findings`, `fundamentals`, `valuation`) load at high priority without waiting for slow filings/events.
 * 2. Secondary stream resources (`events`, `filings`) load individually with their exact `(rev, cfg)` cache keys once primary settles (or eagerly in parallel for deep links).
 */
export function createCompanyOpening(ticker: string, locale: Locale): CompanyOpening {
  let current: OpeningRequests | null = null;
  return {
    start() {
      if (current && !current.signal.aborted) return current;
      const controller = new AbortController();
      const { signal } = controller;
      const primaryUrl = `${companyPath(ticker, locale, "/opening")}&scope=primary`;
      const primaryBundle = observed(companyRequest(primaryUrl, signal, undefined, "high").then(async response => {
        if (!response.ok) return { revisions: null, config: null, resources: Object.fromEntries(PRIMARY_MAP_RESOURCES.map(resource => [resource, { status: response.status, body: null, exhausted: true }])) } as OpeningBundle;
        return await response.json() as OpeningBundle;
      }));
      const revisions = observed(primaryBundle.then(body => body.revisions));
      const responses = new Map<MapResource, Promise<Response>>();
      for (const resource of PRIMARY_MAP_RESOURCES) {
        responses.set(resource, observed(primaryBundle.then(body => {
          signal.throwIfAborted();
          return bundleResponse(body.resources[resource]);
        })));
      }
      if (needsStreamEagerly()) {
        // Deep links targeting a specific filing, event or finding fetch the stream in parallel without waiting a round trip.
        const streamUrl = `${companyPath(ticker, locale, "/opening")}&scope=stream`;
        const streamBundle = observed(companyRequest(streamUrl, signal, undefined, "high").then(async response => {
          if (!response.ok) return { revisions: null, resources: Object.fromEntries(STREAM_MAP_RESOURCES.map(resource => [resource, { status: response.status, body: null, exhausted: true }])) } as OpeningBundle;
          return await response.json() as OpeningBundle;
        }));
        for (const resource of STREAM_MAP_RESOURCES) {
          responses.set(resource, observed(streamBundle.then(body => {
            signal.throwIfAborted();
            return bundleResponse(body.resources[resource]);
          })));
        }
      } else {
        // Standard visits keep bandwidth free for first paint, then fetch versioned, individually cacheable stream endpoints.
        for (const resource of STREAM_MAP_RESOURCES) {
          responses.set(resource, observed(primaryBundle.then(body => {
            signal.throwIfAborted();
            const url = companyPath(ticker, locale, `/${resource}`, body.revisions?.[resource], body.config);
            return companyRequest(url, signal, undefined, "low");
          })));
        }
      }
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
