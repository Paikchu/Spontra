import { ANALYSIS_API_SCHEMAS } from "./schema.ts";
import { ANALYSIS_ERROR_STATUS } from "./errors.ts";
import { ANALYSIS_API_SCHEMA_VERSION, ANALYSIS_READ_SCOPES } from "./versions.ts";
import { ANALYSIS_FILING_PAGE_DEFAULT_LIMIT, ANALYSIS_FILING_PAGE_MAX_LIMIT } from "../../../../../shared/analysis-contract/filings.ts";
import {
  FUNDAMENTALS_DEFAULT_PERIOD_COUNT,
  FUNDAMENTALS_MAX_PERIOD_COUNT,
  FUNDAMENTALS_MIN_PERIOD_COUNT,
} from "../../../../../shared/analysis-contract/fundamentals.ts";

/**
 * The published HTTP contract, built from the same schema objects the tests validate responses
 * against — so the document cannot describe a shape the service does not actually return.
 * Served at `GET /api/v1/openapi.json`.
 */
export function buildAnalysisOpenApiDocument(serverUrl = "https://<analysis-backend-host>"): Record<string, unknown> {
  const errorResponse = (code: keyof typeof ANALYSIS_ERROR_STATUS, description: string) => ({
    description: `${description} (\`code: "${code}"\`)`,
    content: { "application/json": { schema: { $ref: "#/components/schemas/AnalysisError" } } },
  });

  const commonResponses = {
    "400": errorResponse("INVALID_TICKER", "Malformed ticker, accession, cursor, limit, metric list or period count"),
    "401": errorResponse("UNAUTHORIZED", "Missing, malformed, unknown or revoked read credential"),
    "403": errorResponse("FORBIDDEN_SCOPE", "Valid credential without the scope this resource requires"),
    "429": errorResponse("RATE_LIMITED", "Per-credential rate limit exceeded"),
    "503": errorResponse("STORAGE_UNAVAILABLE", "Storage or read-auth configuration unavailable; never returned as an empty success"),
  };

  const tickerParameter = {
    name: "ticker",
    in: "path",
    required: true,
    description: "Uppercase symbol. Untracked companies are readable when results already exist.",
    schema: { type: "string", pattern: "^[A-Z][A-Z0-9.-]{0,9}$" },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "Financial Analysis Backend — read API",
      version: ANALYSIS_API_SCHEMA_VERSION,
      description:
        "Strictly read-only queries over published financial-analysis results. No endpoint here "
        + "ingests data, calls a model, starts a Workflow, enqueues a refresh, or writes business "
        + "data. The same handlers serve internal Service Binding calls and external HTTPS calls; "
        + "only the transport differs.",
    },
    servers: [{ url: serverUrl }],
    security: [{ readCredential: ANALYSIS_READ_SCOPES }],
    components: {
      securitySchemes: {
        readCredential: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "<keyId>.<secret>",
          description:
            "A read credential. Read credentials never authorise refresh, backfill or any other "
            + "control operation — those use a separate administrative secret.",
        },
      },
      schemas: ANALYSIS_API_SCHEMAS,
    },
    paths: {
      "/api/v1/companies/{ticker}/filings": {
        get: {
          summary: "List a company's SEC filings, newest first",
          description:
            "Keyset pagination. `nextCursor` is opaque; pass it back verbatim. `total` is counted "
            + "on the first page only and is null on later pages.",
          security: [{ readCredential: ["filings:read"] }],
          parameters: [
            tickerParameter,
            {
              name: "cursor",
              in: "query",
              required: false,
              description: "Opaque cursor from a previous page's `nextCursor`.",
              schema: { type: "string" },
            },
            {
              name: "limit",
              in: "query",
              required: false,
              schema: {
                type: "integer",
                minimum: 1,
                maximum: ANALYSIS_FILING_PAGE_MAX_LIMIT,
                default: ANALYSIS_FILING_PAGE_DEFAULT_LIMIT,
              },
            },
          ],
          responses: {
            "200": {
              description:
                "A page of filings. A company with no collected filings returns 200 with an empty "
                + "`filings` array — absence of data, not an error.",
              headers: {
                etag: { description: "Covers the whole body, status metadata included.", schema: { type: "string" } },
                "cache-control": { schema: { type: "string" } },
              },
              content: { "application/json": { schema: { $ref: "#/components/schemas/FilingPage" } } },
            },
            "304": { description: "Revalidated. Only returned after the credential has been authenticated and authorised." },
            ...commonResponses,
          },
        },
      },
      "/api/v1/companies/{ticker}/filings/{accession}": {
        get: {
          summary: "One filing, with its summary and structured report when one exists",
          description:
            "Event filings (8-K/6-K) legitimately carry only a narrative summary; `analysis` is "
            + "null for those and `analysisStatus` reports the published-result state.",
          security: [{ readCredential: ["filings:read"] }],
          parameters: [
            tickerParameter,
            {
              name: "accession",
              in: "path",
              required: true,
              schema: { type: "string", pattern: "^[0-9-]{10,25}$" },
            },
          ],
          responses: {
            "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/FilingDetail" } } }, description: "The filing." },
            "404": errorResponse("FILING_NOT_FOUND", "No such filing for this company"),
            ...commonResponses,
          },
        },
      },
      "/api/v1/companies/{ticker}/analysis": {
        get: {
          summary: "The company's latest published cross-period analysis",
          description:
            "`status` describes the published result; `latestRun` describes the newest execution. "
            + "A failed run never hides a previously published result, and never reports as "
            + "\"never collected\"./index.ts",
          security: [{ readCredential: ["analysis:read"] }],
          parameters: [tickerParameter],
          responses: {
            "200": {
              description: "The published analysis, or a documented absence response with `status: \"unavailable\"`.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/CompanyAnalysis" } } },
            },
            ...commonResponses,
          },
        },
      },
      "/api/v1/companies/{ticker}/fundamentals": {
        get: {
          summary: "Quarterly fundamentals series",
          description: "Sourced from SEC XBRL filings (`source: \"sec_xbrl\"`); refreshed by SEC discovery.",
          security: [{ readCredential: ["fundamentals:read"] }],
          parameters: [
            tickerParameter,
            {
              name: "metrics",
              in: "query",
              required: false,
              description: "Comma-separated metric keys. Omit for every metric with data.",
              schema: { type: "string" },
            },
            {
              name: "periodCount",
              in: "query",
              required: false,
              schema: {
                type: "integer",
                minimum: FUNDAMENTALS_MIN_PERIOD_COUNT,
                maximum: FUNDAMENTALS_MAX_PERIOD_COUNT,
                default: FUNDAMENTALS_DEFAULT_PERIOD_COUNT,
              },
            },
          ],
          responses: {
            "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Fundamentals" } } }, description: "The series." },
            "404": errorResponse("FUNDAMENTALS_NOT_AVAILABLE", "Fundamentals are not collected for this ticker"),
            ...commonResponses,
          },
        },
      },
      "/api/v1/openapi.json": {
        get: {
          summary: "This document",
          security: [],
          responses: { "200": { description: "The OpenAPI document.", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
    },
  };
}
