import { readMapDerived } from '../financial-data/derived.ts';
import type { CapitalResponse } from '../../../../shared/analysis-contract/capital-structure.ts';
import {readCompletePublicationForTicker} from '../financial-data/publication.ts';
import { readBusinessExplainerResponse } from "../business-explainer/workflow.ts";
import { readGuidanceResponse } from "../guidance/workflow.ts";
import { readFindingsResponse } from "../findings/read.ts";
import { readNarrativeResponse } from "../narrative/read.ts";
import { readOperatingMetricsResponse } from "../operating-metrics/read.ts";
import { readPlannedFiguresResponse } from "../figures/workflow.ts";
import { readEventsResponse } from "../events/read.ts";
import { parseFundamentalApiQuery } from "../fundamentals/fundamentals-api.ts";
import { getSecFundamentals } from "../fundamentals/sec-fundamentals.ts";
import { getPublicFiling, getPublicFilingPage } from "../sec/public-api.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { findSecurity } from "../catalog/security-directory.ts";
import { AnalysisRequestError, type AnalysisErrorCode } from "./contract-support/errors.ts";
import { dataResponse, errorResponse } from "./http.ts";

/**
 * The analysis backend's read surface, served only to the business map over the `MapReads`
 * named entrypoint. A named entrypoint is unreachable from the public internet, so the binding is
 * the credential and nothing here parses one.
 *
 * Strictly read-only. Nothing reachable from here calls a model, fetches from SEC or Yahoo,
 * creates a Workflow, enqueues a refresh, or writes business data — including transitively, which
 * is why the fundamentals refresh that used to be triggered by a read now lives on the scheduled
 * sweep instead (`workers/pipeline/fundamentals-sweep.ts`).
 */
export type AnalysisReadEnv = {
  /** The analysis database. Absent in a partially configured environment, which answers 503. */
  DB?: D1Database;
};

/** A read request carries a ticker, a cursor and two small numbers. Anything longer is not one. */
const MAX_REQUEST_URL_LENGTH = 2_048;
const MAX_QUERY_PARAMETERS = 8;

type RouteMatch =
  | { kind: "filings"; ticker: string }
  | { kind: "filing"; ticker: string; accession: string }
  | { kind: "business-flow"; ticker: string }
  | { kind: "capital"; ticker: string }
  | { kind: "business-explainer"; ticker: string }
  | { kind: "guidance"; ticker: string }
  | { kind: "findings"; ticker: string }
  | { kind: "business-narrative"; ticker: string }
  | { kind: "operating-metrics"; ticker: string }
  | { kind: "business-figures"; ticker: string }
  | { kind: "events"; ticker: string }
  | { kind: "fundamentals"; ticker: string };


/** Serves one map read. */
export async function handleMapRead(request: Request, env: AnalysisReadEnv): Promise<Response> {
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

  if (!env.DB) {
    return errorResponse("STORAGE_UNAVAILABLE", "The analysis store is not available on this deployment.");
  }

  try {
    return await handleRoute(request, env.DB, route);
  } catch (error) {
    return errorResponse(...describeFailure(error));
  }
}

async function handleRoute(request: Request, database: D1Database, route: RouteMatch): Promise<Response> {
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
    case "business-flow": {
      const payload=await readCompletePublicationForTicker(database,route.ticker);
      // Older quarters are assembled on the schedule; until then the published pair stands alone.
      if(payload.flow)payload.reports=(await readMapDerived(database,payload.flow))?.reports??payload.flow;
      return dataResponse(request,payload,payload.status==="ready"?"cacheable":"no-store");
    }
    case "capital": {
      // Assembled on the schedule from the projections each filing received at ingestion; a read never parses.
      const publication = await readCompletePublicationForTicker(database, route.ticker);
      const capital = publication.flow ? (await readMapDerived(database, publication.flow))?.capital ?? null : null;
      const payload: CapitalResponse = { schemaVersion: "capital-response.v1", status: capital ? "ready" : "unavailable", capital };
      return dataResponse(request, payload, capital ? "cacheable" : "no-store");
    }
    case "business-explainer": {
      const payload = await readBusinessExplainerResponse(database, route.ticker);
      return dataResponse(request, payload, payload.status === "ready" ? "cacheable" : "no-store");
    }
    case "guidance": {
      const payload = await readGuidanceResponse(database, route.ticker);
      return dataResponse(request, payload, payload.status === "ready" ? "cacheable" : "no-store");
    }
    case "findings": {
      const payload = await readFindingsResponse(database, route.ticker);
      return dataResponse(request, payload, payload.status === "ready" ? "cacheable" : "no-store");
    }
    case "business-narrative": {
      const payload = await readNarrativeResponse(database, route.ticker);
      return dataResponse(request, payload, payload.status === "ready" ? "cacheable" : "no-store");
    }
    case "operating-metrics": {
      const payload = await readOperatingMetricsResponse(database, route.ticker);
      return dataResponse(request, payload, payload.status === "ready" ? "cacheable" : "no-store");
    }
    case "business-figures": {
      const payload = await readPlannedFiguresResponse(database, route.ticker);
      return dataResponse(request, payload, payload.status === "ready" ? "cacheable" : "no-store");
    }
    case "events": {
      const payload = await readEventsResponse(database, route.ticker);
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

function matchRoute(pathname: string): RouteMatch | null {
  const company = /^\/api\/v1\/companies\/([^/]+)\/(filings|fundamentals|business-flow|capital|business-explainer|guidance|findings|business-narrative|operating-metrics|business-figures|events)(?:\/([^/]+))?\/?$/.exec(pathname);
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
  if(resource === "business-flow") return {kind:"business-flow",ticker};
  if (resource === "capital") return { kind: "capital", ticker };
  if (resource === "business-explainer") return { kind: "business-explainer", ticker };
  if (resource === "guidance") return { kind: "guidance", ticker };
  if (resource === "findings") return { kind: "findings", ticker };
  if (resource === "business-narrative") return { kind: "business-narrative", ticker };
  if (resource === "operating-metrics") return { kind: "operating-metrics", ticker };
  if (resource === "business-figures") return { kind: "business-figures", ticker };
  if (resource === "events") return { kind: "events", ticker };
  return { kind: "fundamentals", ticker };
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
