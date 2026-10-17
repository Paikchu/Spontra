import { featureShown, shownFilter, type FeatureDefaultsEnv } from "../admin/feature-settings.ts";
import { readMapDerived } from '../financial-data/derived.ts';
import type { CapitalResponse } from '../../../../shared/analysis-contract/capital-structure.ts';
import {readCompletePublicationForTicker} from '../financial-data/publication.ts';
import { readBusinessExplainerResponse } from "../business-explainer/workflow.ts";
import { readBusinessTreeResponse } from "../business-tree/workflow.ts";
import { readGuidanceResponse } from "../guidance/workflow.ts";
import { readFindingsResponse } from "../findings/read.ts";
import { readEventsResponse } from "../events/read.ts";
import { readPublicPassage } from "../filing-library/passage-read.ts";
import { parseFundamentalApiQuery } from "../fundamentals/fundamentals-api.ts";
import { getSecFundamentals } from "../fundamentals/sec-fundamentals.ts";
import { getPublicFiling, getPublicFilingPage } from "../sec/public-api.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { findSecurity } from "../catalog/security-directory.ts";
import { AnalysisRequestError, type AnalysisErrorCode } from "./contract-support/errors.ts";
import { dataResponse, errorResponse } from "./http.ts";
import { localize, type TranslatedResource } from "../../../../shared/analysis-runtime/translation.ts";
import { isLocale, type Locale } from "../../../../shared/analysis-runtime/locale.ts";
import { readTranslationTable } from "../translation/translate.ts";
import { readRevisions } from "../pipeline/revisions.ts";
import type { RevisionsResponse } from "../../../../shared/analysis-contract/revisions.ts";
import type { PublicSecFiling } from "../../../../shared/analysis-contract/filings.ts";
import type { Feature } from "../../../../shared/analysis-contract/business-features.ts";

/**
 * The analysis backend's read surface, served only to the business map over the `MapReads`
 * named entrypoint. A named entrypoint is unreachable from the public internet, so the binding is
 * the credential and nothing here parses one.
 *
 * Strictly read-only. Nothing reachable from here calls a model, fetches from SEC or Yahoo,
 * creates a Workflow, enqueues a refresh, or writes business data — including transitively, which
 * is why the fundamentals refresh that used to be triggered by a read now happens inside the company
 * analysis Workflow, when an analysis needs it.
 */
export type AnalysisReadEnv = FeatureDefaultsEnv & {
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
  | { kind: "business-tree"; ticker: string }
  | { kind: "guidance"; ticker: string }
  | { kind: "findings"; ticker: string }
  | { kind: "events"; ticker: string }
  | { kind: "passage"; ticker: string; passageId: string }
  | { kind: "fundamentals"; ticker: string }
  | { kind: "revisions"; ticker: string }
  | { kind: "findings-index" };


/** A filing as the reports feature's display switch leaves it for readers: the filing itself, none of the model's writing. */
function withoutSummary(filing: PublicSecFiling): PublicSecFiling {
  return { ...filing, summary: null, analysis: null, analysisStatus: "not_collected", reportVersion: null, periodId: null, analysisSchemaVersion: null, contentRevision: null };
}

/**
 * The companies that have published findings, for the home page: whichever companies the admin's AI switch has had on,
 * read from what is stored rather than from a list kept in the page.
 */
async function findingsIndex(request: Request, database: D1Database, env: FeatureDefaultsEnv): Promise<Response> {
  const [rows, shown] = await Promise.all([
    database.prepare("SELECT substr(cache_key, 13) ticker FROM sec_cache WHERE cache_key LIKE 'findings:v2:%' ORDER BY fetched_at DESC LIMIT 40").all<{ ticker: string }>(),
    shownFilter(database, env, "findings"),
  ]);
  // A company whose findings are switched off is left off the home page as well as its own.
  const tickers = rows.results.map(r => r.ticker).filter(t => /^[A-Z][A-Z0-9.-]{0,11}$/.test(t) && shown(t));
  return dataResponse(request, { schemaVersion: "findings-index.v1", tickers }, "cacheable");
}

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
    if (route.kind === "findings-index") return await findingsIndex(request, env.DB, env);
    return await handleRoute(request, env.DB, env, route);
  } catch (error) {
    return errorResponse(...describeFailure(error));
  }
}

async function handleRoute(request: Request, database: D1Database, env: FeatureDefaultsEnv, route: Exclude<RouteMatch, { kind: "findings-index" }>): Promise<Response> {
  // The admin's switch for one feature of this company: off hides what the feature wrote (docs/whitelist-feature-switches-design.md).
  const hidden = async (feature: Feature, ticker = route.ticker) => !await featureShown(database, env, ticker.trim().toUpperCase(), feature);
  const url = new URL(request.url);
  // `?locale=zh-CN` serves a resource with its translated prose applied; the structure, figures and ids are the English
  // publication's, and a string not yet translated stays English. Two lookups and a pure copy, never a model call.
  const requested = url.searchParams.get("locale");
  const locale: Locale | null = isLocale(requested) && requested !== "en" ? requested : null;
  const translated = async <T>(resource: TranslatedResource, value: T, scope = ""): Promise<T> =>
    locale && value ? localize(resource, value, await readTranslationTable(database, locale, resource, route.ticker.trim().toUpperCase(), scope)) : value;
  switch (route.kind) {
    // What changed since a reader loaded: one indexed read, never cached, so the answer is as current as the events routed.
    case "revisions": {
      const ticker = route.ticker.trim().toUpperCase();
      return dataResponse(request, { schemaVersion: "revisions.v1", ticker, revisions: await readRevisions(database, ticker) } satisfies RevisionsResponse, "no-store");
    }
    case "filings": {
      const page = await getPublicFilingPage(
        new D1SecRepository(database),
        route.ticker,
        url.searchParams.get("cursor"),
        url.searchParams.get("limit"),
      );
      // Report summaries hidden by the admin: the filings are still listed, as filings, without what the model wrote.
      const filings = await hidden("reports", page.ticker) ? page.filings.map(withoutSummary) : page.filings;
      return dataResponse(request, { ...page, filings: await translated("filings", filings) });
    }
    case "filing": {
      const detail = await getPublicFiling(new D1SecRepository(database), route.ticker, route.accession,
        url.searchParams.has("reportVersion") || url.searchParams.has("reportDate")
          ? { reportVersion: url.searchParams.get("reportVersion") ?? "", reportDate: url.searchParams.get("reportDate") ?? "" } : undefined);
      if (!detail) return errorResponse("FILING_NOT_FOUND", "SEC filing not found.");
      if (await hidden("reports", detail.ticker)) return dataResponse(request, { ...detail, filing: withoutSummary(detail.filing) }, "no-store");
      const report = await translated("filing", { summary: detail.filing.summary, analysis: detail.filing.analysis }, route.accession);
      return dataResponse(request, { ...detail, filing: { ...detail.filing, summary: report.summary, analysis: report.analysis } });
    }
    case "business-flow": {
      const payload=await readCompletePublicationForTicker(database,route.ticker);
      // Older quarters are assembled on the schedule; until then the published pair stands alone.
      if(payload.flow)payload.reports=(await readMapDerived(database,payload.flow))?.reports??payload.flow;
      if(payload.flow){const flow=await translated("flow",{flow:payload.flow,reports:payload.reports??null});payload.flow=flow.flow;payload.reports=flow.reports;}
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
      const payload = await readBusinessExplainerResponse(database, route.ticker, { hidden: await hidden("explainer") });
      payload.explainer = await translated("explainer", payload.explainer);
      return dataResponse(request, payload, payload.status === "ready" ? "cacheable" : "no-store");
    }
    case "business-tree": {
      const payload = await readBusinessTreeResponse(database, route.ticker, { hidden: await hidden("tree") });
      payload.tree = await translated("tree", payload.tree);
      return dataResponse(request, payload, payload.status === "ready" ? "cacheable" : "no-store");
    }
    case "guidance": {
      const payload = await readGuidanceResponse(database, route.ticker, { hidden: await hidden("reports") });
      payload.guidance = await translated("guidance", payload.guidance);
      return dataResponse(request, payload, payload.status === "ready" ? "cacheable" : "no-store");
    }
    case "findings": {
      const payload = await readFindingsResponse(database, route.ticker, { hidden: await hidden("findings") });
      payload.findings = await translated("findings", payload.findings);
      return dataResponse(request, payload, payload.status === "ready" ? "cacheable" : "no-store");
    }
    case "events": {
      const payload = await readEventsResponse(database, route.ticker);
      payload.events = await translated("events", payload.events);
      return dataResponse(request, payload, payload.status === "ready" ? "cacheable" : "no-store");
    }
    case "passage": {
      const payload = await readPublicPassage(database, route.ticker, route.passageId);
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
  if (/^\/api\/v1\/findings\/?$/.test(pathname)) return { kind: "findings-index" };
  const company = /^\/api\/v1\/companies\/([^/]+)\/(filings|fundamentals|business-flow|capital|business-explainer|business-tree|guidance|findings|events|passages|revisions)(?:\/([^/]+))?\/?$/.exec(pathname);
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
  if (resource === "passages") {
    if (tail === undefined) return null;
    const passageId = safeDecode(tail);
    return passageId === null ? null : { kind: "passage", ticker, passageId };
  }
  if (tail !== undefined) return null;
  if(resource === "business-flow") return {kind:"business-flow",ticker};
  if (resource === "capital") return { kind: "capital", ticker };
  if (resource === "business-explainer") return { kind: "business-explainer", ticker };
  if (resource === "business-tree") return { kind: "business-tree", ticker };
  if (resource === "guidance") return { kind: "guidance", ticker };
  if (resource === "findings") return { kind: "findings", ticker };
  if (resource === "events") return { kind: "events", ticker };
  if (resource === "revisions") return { kind: "revisions", ticker };
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
