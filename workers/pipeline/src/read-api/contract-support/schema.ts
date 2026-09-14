import { FUNDAMENTAL_METRIC_CATALOG, FUNDAMENTAL_METRIC_CATALOG_VERSION } from "../../fundamentals/fundamental-metrics.ts";
import { COMPANY_ANALYSIS_SCHEMA_VERSION } from "../../company-analysis/contracts.ts";
import { FUNDAMENTALS_API_SCHEMA_VERSION } from "../../../../../shared/analysis-contract/fundamentals.ts";
import { COMPANY_ANALYSIS_MAX_BLOCKS_PER_HIGHLIGHT, COMPANY_ANALYSIS_MAX_HIGHLIGHTS, COMPANY_ANALYSIS_MIN_HIGHLIGHTS } from "../../../../../shared/analysis-contract/company-analysis.ts";
import type { JsonSchema } from "./json-schema.ts";
import { ANALYSIS_API_SCHEMA_VERSION } from "./versions.ts";
import { ANALYSIS_ERROR_STATUS } from "./errors.ts";
import { ANALYSIS_FILING_PAGE_MAX_LIMIT } from "../../../../../shared/analysis-contract/filings.ts";

/**
 * The machine-readable half of the public contract. TypeScript types prove nothing about what
 * actually goes over the wire — §4.3 is explicit about that — so these schemas are what the tests
 * validate real responses against, and what `openapi.ts` embeds in the published document.
 *
 * They are deliberately *closed* (`additionalProperties: false`) on every envelope this service
 * owns, so a field added by accident fails a test instead of quietly becoming part of the
 * contract. The one place they stay open is the generated report payload, whose interior is
 * produced by the analysis pipeline and versioned by `reportVersion` rather than by this document.
 */

const TICKER_PATTERN = "^[A-Z][A-Z0-9.-]{0,9}$";
const DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";

const nullableString: JsonSchema = { type: ["string", "null"] };

/**
 * The forms a judgment may take beyond its prose. Deliberately narrower than the full block
 * vocabulary — see COMPANY_ANALYSIS_BLOCK_TYPES for why `metrics` and `evidence` are absent — and
 * spelled out on the wire so a consumer can switch on `type` without reading the renderer.
 *
 * A chart names series; it never carries points. Those come from the fundamentals resource.
 */
const companyAnalysisBlock: JsonSchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "id", "text"],
      properties: {
        type: { const: "prose" },
        id: { type: "string" },
        title: { type: "string" },
        text: { type: "string" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "id", "tone", "text"],
      properties: {
        type: { const: "callout" },
        id: { type: "string" },
        tone: { enum: ["neutral", "positive", "negative", "caution"] },
        title: { type: "string" },
        text: { type: "string" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "id", "points"],
      properties: {
        type: { const: "key_points" },
        id: { type: "string" },
        title: { type: "string" },
        points: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["label", "detail", "importance"],
            properties: {
              label: { type: "string" },
              detail: { type: "string" },
              importance: { enum: ["high", "medium", "low"] },
            },
          },
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "id", "title", "series"],
      properties: {
        type: { const: "chart" },
        id: { type: "string" },
        title: { type: "string" },
        caption: { type: "string" },
        periodCount: { type: "integer" },
        series: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["metricKey"],
            properties: {
              metricKey: { enum: Object.keys(FUNDAMENTAL_METRIC_CATALOG) },
              mark: { enum: ["bar", "line"] },
              transform: { enum: ["value", "qoq_growth", "yoy_growth", "qoq_change", "yoy_change"] },
            },
          },
        },
      },
    },
  ],
};

const analysisRunSummary: JsonSchema = {
  title: "AnalysisRunSummary",
  description:
    "The latest known execution, reported separately from the published result. `none` means the "
    + "backend looked and found no history; `unknown` means history could not be read.",
  type: "object",
  additionalProperties: false,
  required: ["state", "updatedAt", "errorCode"],
  properties: {
    state: { enum: ["none", "queued", "running", "failed", "succeeded", "unknown"] },
    updatedAt: nullableString,
    errorCode: nullableString,
  },
};

const filingCompany: JsonSchema = {
  title: "FilingCompany",
  type: ["object", "null"],
  additionalProperties: false,
  required: ["ticker", "name", "cik"],
  properties: { ticker: { type: "string" }, name: { type: "string" }, cik: { type: "string" } },
};

const publishedReport: JsonSchema = {
  title: "PublishedSecReport",
  description:
    "The structured filing report. Its interior is owned by the analysis pipeline and identified "
    + "by `reportVersion`; this contract pins the fields consumers read facts from rather than the "
    + "whole tree, so a pipeline revision does not break the wire contract.",
  type: ["object", "null"],
  required: ["ticker", "periodId", "reportVersion", "headline", "keyMetrics", "changes", "dataQuality"],
  properties: {
    ticker: { type: "string" },
    periodId: { type: "string" },
    reportVersion: { type: "string" },
    headline: { type: "string" },
    reader: { type: "object", required: ["version", "changes", "sections", "watch", "limitations"], properties: {
      version: { const: "sec-reader.v1" }, changes: { type: "array", minItems: 1 }, sections: { type: "array", minItems: 3, maxItems: 8 },
      watch: { type: "array", minItems: 1 }, limitations: { type: "array" },
    } },
    financialLens: { type: "object", required: ["missingMetrics", "limitations"] },
    marketSnapshot: { type: "object", required: ["status", "asOf", "source", "sourceUrl", "limitations"], properties: { status: { enum: ["available", "unavailable"] } } },
    editorialReview: { type: "object", required: ["status", "reviewedAt"], properties: { status: { const: "passed" }, reviewedAt: { type: "string" } } },
    keyMetrics: {
      type: "array",
      items: {
        type: "object",
        required: ["metricKey", "currentValue", "status", "evidenceIds"],
        properties: {
          metricKey: { type: "string" },
          currentValue: { type: "string" },
          qoq: { type: "string" },
          yoy: { type: "string" },
          status: { enum: ["verified", "derived", "not_comparable", "not_disclosed"] },
          evidenceIds: { type: "array", items: { type: "string" } },
        },
      },
    },
    changes: {
      type: "object",
      required: ["qoq", "yoy", "guidance", "risks"],
      properties: {
        qoq: { type: "array" },
        yoy: { type: "array" },
        guidance: { type: "array" },
        risks: { type: "array" },
      },
    },
    dataQuality: {
      type: "object",
      required: ["coverage", "verificationStatus", "warnings"],
      properties: {
        coverage: { type: "number", minimum: 0, maximum: 1 },
        verificationStatus: { enum: ["verified", "partial", "failed"] },
        warnings: { type: "array", items: { type: "string" } },
        analysisStatus: { enum: ["complete", "partial"] },
        unresolvedQuestions: { type: "array", items: { type: "string" } },
        failedNodeIds: { type: "array", items: { type: "string" } },
        stopReason: { type: ["string", "null"] },
        managerCoverageScore: { type: "number" },
      },
    },
  },
};

const earningsGroup: JsonSchema = {
  type: "object", additionalProperties: false,
  required: ["id", "periodEnd", "earningsDate", "canonicalAccession", "inputKey", "sources"],
  properties: {
    id: { type: "string" }, periodEnd: { type: "string", pattern: DATE_PATTERN },
    earningsDate: { type: "string", pattern: DATE_PATTERN }, canonicalAccession: { type: "string" }, inputKey: { type: "string" },
    sources: { type: "array", minItems: 1, items: { type: "object", required: ["ticker", "accessionNumber", "form", "filingDate", "reportDate", "documentUrl", "indexUrl"],
      properties: { ticker: { type: "string" }, accessionNumber: { type: "string" }, form: { type: "string" }, filingDate: { type: "string" }, reportDate: { type: "string" }, documentUrl: { type: "string" }, indexUrl: { type: "string" } } } },
  },
};

const filingSummary: JsonSchema = {
  title: "SecFilingSummary",
  description:
    "The narrative summary. Event filings (8-K/6-K) legitimately carry only this and no structured "
    + "report, which is why `analysis` is nullable independently of `summary`.",
  type: ["object", "null"],
  required: ["ticker", "form", "filingDate", "accessionNumber", "headline", "bullets", "analystView", "source", "generatedAt"],
  properties: {
    earningsGroup,
    ticker: { type: "string" },
    form: { type: "string" },
    filingDate: { type: "string" },
    accessionNumber: { type: "string" },
    headline: { type: "string" },
    bullets: { type: "array" },
    analystView: { type: "string" },
    eventCategory: { enum: ["earnings_update", "guidance", "m&a", "executive", "legal", "other"] },
    report: { type: "string" },
    version: { type: "integer" },
    nodes: { type: "array" },
    plan: { type: "object" },
    managerReview: { type: "object" },
    repairRounds: { type: "integer" },
    source: { type: "string" },
    generatedAt: { type: "string" },
    error: { type: "string" },
  },
};

const publicSecFiling: JsonSchema = {
  title: "PublicSecFiling",
  type: "object",
  additionalProperties: false,
  required: [
    "accessionNumber", "ticker", "companyName", "form", "filingDate", "reportDate", "description",
    "summary", "analysis", "analysisStatus", "reportVersion", "edgarUrl", "documentUrl",
    "provenance", "periodId", "analysisSchemaVersion", "contentRevision", "analysisRun",
  ],
  properties: {
    fiscalPeriod: { type: ["object", "null"], required: ["fiscalYear", "fiscalPeriod", "periodEnd", "source", "sourceAccession", "sourceUrl"], properties: {
      fiscalYear: { type: "integer" }, fiscalPeriod: { enum: ["FY", "Q1", "Q2", "Q3", "Q4", "H1", "H2", "M9"] },
      periodEnd: { type: "string", pattern: DATE_PATTERN }, source: { enum: ["sec_dei", "ai_source_review"] }, sourceAccession: { type: "string" }, sourceUrl: { type: "string" },
    } },
    earningsGroup,
    accessionNumber: { type: "string" },
    ticker: { type: "string", pattern: TICKER_PATTERN },
    companyName: { type: "string" },
    form: { type: "string" },
    filingDate: { type: "string" },
    reportDate: { type: "string" },
    description: { type: "string" },
    summary: { $ref: "#/$defs/SecFilingSummary" },
    analysis: { $ref: "#/$defs/PublishedSecReport" },
    analysisStatus: {
      description: "Describes the published result only. A failed run shows up in `analysisRun`.",
      enum: ["complete", "partial", "processing", "not_collected"],
    },
    reportVersion: nullableString,
    edgarUrl: { type: "string" },
    documentUrl: { type: "string" },
    provenance: { const: "sec_edgar" },
    periodId: nullableString,
    analysisSchemaVersion: nullableString,
    contentRevision: nullableString,
    analysisRun: { $ref: "#/$defs/AnalysisRunSummary" },
  },
};

const sharedDefs: Record<string, JsonSchema> = {
  AnalysisRunSummary: analysisRunSummary,
  FilingCompany: filingCompany,
  PublishedSecReport: publishedReport,
  SecFilingSummary: filingSummary,
  PublicSecFiling: publicSecFiling,
};

export const FILING_PAGE_SCHEMA: JsonSchema = {
  title: "FilingPage",
  type: "object",
  additionalProperties: false,
  required: ["apiSchemaVersion", "ticker", "company", "filings", "nextCursor", "total", "checkedAt"],
  properties: {
    apiSchemaVersion: { const: ANALYSIS_API_SCHEMA_VERSION },
    ticker: { type: "string", pattern: TICKER_PATTERN },
    company: { $ref: "#/$defs/FilingCompany" },
    filings: { type: "array", maxItems: ANALYSIS_FILING_PAGE_MAX_LIMIT, items: { $ref: "#/$defs/PublicSecFiling" } },
    nextCursor: nullableString,
    total: { type: ["integer", "null"], minimum: 0 },
    checkedAt: nullableString,
  },
  $defs: sharedDefs,
};

export const FILING_DETAIL_SCHEMA: JsonSchema = {
  title: "FilingDetail",
  type: "object",
  additionalProperties: false,
  required: ["apiSchemaVersion", "ticker", "company", "filing"],
  properties: {
    apiSchemaVersion: { const: ANALYSIS_API_SCHEMA_VERSION },
    ticker: { type: "string", pattern: TICKER_PATTERN },
    company: { $ref: "#/$defs/FilingCompany" },
    filing: { $ref: "#/$defs/PublicSecFiling" },
  },
  $defs: sharedDefs,
};

export const COMPANY_ANALYSIS_SCHEMA: JsonSchema = {
  title: "CompanyAnalysis",
  type: "object",
  additionalProperties: false,
  required: [
    "apiSchemaVersion", "schemaVersion", "ticker", "status", "analysisId", "period", "generatedAt",
    "coverageStatus", "overview", "latestRun", "versions",
  ],
  properties: {
    apiSchemaVersion: { const: ANALYSIS_API_SCHEMA_VERSION },
    schemaVersion: { const: COMPANY_ANALYSIS_SCHEMA_VERSION },
    ticker: { type: "string", pattern: TICKER_PATTERN },
    status: {
      description:
        "Published-result state, unchanged from the pre-backend contract. `updating` means a "
        + "newer run is in flight and the previous published result is what you are reading.",
      enum: ["ready", "updating", "insufficient_data", "unavailable"],
    },
    analysisId: nullableString,
    period: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["periodId", "periodEnd", "label"],
      properties: {
        periodId: { type: "string" },
        periodEnd: { type: "string", pattern: DATE_PATTERN },
        label: { type: "string" },
      },
    },
    generatedAt: nullableString,
    coverageStatus: { type: ["string", "null"], enum: ["complete", "partial", null] },
    overview: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["label", "headline", "introduction", "highlights"],
      properties: {
        label: { type: "string" },
        headline: { type: "string" },
        introduction: { type: "string" },
        highlights: {
          type: "array",
          minItems: COMPANY_ANALYSIS_MIN_HIGHLIGHTS,
          maxItems: COMPANY_ANALYSIS_MAX_HIGHLIGHTS,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["ordinal", "title", "body", "evidenceRefs"],
            properties: {
              ordinal: { type: "string", pattern: "^\\d{2}$" },
              title: { type: "string" },
              body: { type: "string" },
              evidenceRefs: { type: "array", items: { type: "string" } },
              blocks: {
                type: "array",
                maxItems: COMPANY_ANALYSIS_MAX_BLOCKS_PER_HIGHLIGHT,
                items: { $ref: "#/$defs/CompanyAnalysisBlock" },
              },
            },
          },
        },
      },
    },
    latestRun: { $ref: "#/$defs/AnalysisRunSummary" },
    versions: {
      description: "API schema, content revision and internal pipeline versions, kept apart.",
      type: "object",
      additionalProperties: false,
      required: ["apiSchema", "payloadSchema", "contentRevision", "model", "prompt"],
      properties: {
        apiSchema: { const: ANALYSIS_API_SCHEMA_VERSION },
        payloadSchema: { const: COMPANY_ANALYSIS_SCHEMA_VERSION },
        contentRevision: nullableString,
        model: nullableString,
        prompt: nullableString,
      },
    },
  },
  $defs: { AnalysisRunSummary: analysisRunSummary, CompanyAnalysisBlock: companyAnalysisBlock },
};

export const FUNDAMENTALS_SCHEMA: JsonSchema = {
  title: "Fundamentals",
  type: "object",
  additionalProperties: false,
  required: [
    "apiSchemaVersion", "schemaVersion", "catalogVersion", "source", "ticker", "status",
    "dataVersion", "fetchedAt", "stale", "partial", "qualityStatus", "issueCount",
    "requestedPeriodCount", "periods", "series", "refresh",
  ],
  properties: {
    apiSchemaVersion: { const: ANALYSIS_API_SCHEMA_VERSION },
    schemaVersion: { const: FUNDAMENTALS_API_SCHEMA_VERSION },
    catalogVersion: { const: FUNDAMENTAL_METRIC_CATALOG_VERSION },
    source: {
      description: "Actual provenance. Public fundamentals are sourced from SEC XBRL filings.",
      const: "sec_xbrl",
    },
    ticker: { type: "string", pattern: TICKER_PATTERN },
    status: { enum: ["ready", "pending"] },
    dataVersion: nullableString,
    fetchedAt: nullableString,
    stale: { type: "boolean" },
    partial: { type: "boolean" },
    qualityStatus: { type: ["string", "null"], enum: ["complete", "partial", null] },
    issueCount: { type: "integer", minimum: 0 },
    requestedPeriodCount: { type: "integer", minimum: 2, maximum: 12 },
    periods: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["periodType", "periodEnd", "currency"],
        properties: {
          periodType: { const: "3M" },
          periodEnd: { type: "string", pattern: DATE_PATTERN },
          currency: { type: "string" },
        },
      },
    },
    series: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "metricKey", "label", "shortLabel", "category", "unitFamily", "unit", "currency",
          "basis", "displaySign", "defaultMark", "allowedTransforms", "available", "points",
        ],
        properties: {
          metricKey: { enum: Object.keys(FUNDAMENTAL_METRIC_CATALOG) },
          label: { type: "string" },
          shortLabel: { type: "string" },
          category: { type: "string" },
          unitFamily: { enum: ["currency", "percent", "per_share", "shares", "multiple"] },
          unit: { type: "string" },
          currency: { type: "string" },
          basis: { enum: ["reported", "derived"] },
          displaySign: { enum: ["as_reported", "outflow_magnitude"] },
          defaultMark: { enum: ["bar", "line"] },
          allowedTransforms: { type: "array", items: { type: "string" } },
          available: { type: "boolean" },
          points: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["periodEnd", "valueDecimal", "revision"],
              properties: {
                periodEnd: { type: "string", pattern: DATE_PATTERN },
                valueDecimal: nullableString,
                revision: { type: ["integer", "null"] },
                sourceAccession: { type: "string" },
                sourceFiledAt: { type: "string", pattern: DATE_PATTERN },
                derivationFormula: { type: "string" },
              },
            },
          },
        },
      },
    },
    refresh: {
      type: "object",
      additionalProperties: false,
      required: ["recommended", "scheduled", "mode"],
      properties: {
        recommended: { type: "boolean" },
        scheduled: {
          description: "Always false. Reads never enqueue work; kept for wire compatibility.",
          const: false,
        },
        mode: { const: "backend_scheduled" },
      },
    },
  },
};

export const ERROR_SCHEMA: JsonSchema = {
  title: "AnalysisError",
  type: "object",
  additionalProperties: false,
  required: ["apiSchemaVersion", "error", "code"],
  properties: {
    apiSchemaVersion: { const: ANALYSIS_API_SCHEMA_VERSION },
    error: { type: "string" },
    code: { enum: Object.keys(ANALYSIS_ERROR_STATUS) },
  },
};

export const ANALYSIS_API_SCHEMAS = {
  FilingPage: FILING_PAGE_SCHEMA,
  FilingDetail: FILING_DETAIL_SCHEMA,
  CompanyAnalysis: COMPANY_ANALYSIS_SCHEMA,
  Fundamentals: FUNDAMENTALS_SCHEMA,
  AnalysisError: ERROR_SCHEMA,
} as const;

export type AnalysisApiSchemaName = keyof typeof ANALYSIS_API_SCHEMAS;
