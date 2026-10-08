import assert from "node:assert/strict";
import test from "node:test";

import {
  ANALYSIS_API_SCHEMAS,
  assertSupportedSchema,
  buildAnalysisOpenApiDocument,
  validateJsonSchema,
  type JsonSchema,
} from "../../workers/pipeline/src/read-api/contract-support/index.ts";
import { ANALYSIS_ERROR_STATUS, analysisErrorBody } from "../../workers/pipeline/src/read-api/contract-support/errors.ts";
import { ANALYSIS_API_SCHEMA_VERSION, splitReportVersion } from "../../workers/pipeline/src/read-api/contract-support/versions.ts";

/**
 * The contract tests. A TypeScript interface proves nothing about what crosses the wire, so these
 * exercise the published JSON Schemas directly; `tests/analysis-read-api.test.ts` then validates
 * real handler responses against the very same objects.
 */

test("every published schema uses only keywords the validator enforces", () => {
  for (const [name, schema] of Object.entries(ANALYSIS_API_SCHEMAS)) {
    assert.doesNotThrow(() => assertSupportedSchema(schema), `${name} uses an unsupported keyword`);
  }
});

test("the validator rejects the mistakes it exists to catch", () => {
  const schema: JsonSchema = {
    type: "object",
    additionalProperties: false,
    required: ["id", "count", "tags"],
    properties: {
      id: { type: "string", pattern: "^[a-z]+$" },
      count: { type: "integer", minimum: 0 },
      tags: { type: "array", items: { type: "string" }, maxItems: 2 },
      nullable: { type: ["string", "null"] },
    },
  };
  assert.deepEqual(validateJsonSchema(schema, { id: "ok", count: 1, tags: ["a"], nullable: null }), []);
  const errors = validateJsonSchema(schema, { id: "NOPE", count: -1, tags: ["a", "b", "c"], extra: true });
  const paths = errors.map((error) => error.path).sort();
  assert.deepEqual(paths, ["$.count", "$.extra", "$.id", "$.tags"]);
});

test("a missing required property is reported rather than passed over", () => {
  const errors = validateJsonSchema(ANALYSIS_API_SCHEMAS.AnalysisError, { error: "x", code: "UNAUTHORIZED" });
  assert.deepEqual(errors.map((error) => error.path), ["$.apiSchemaVersion"]);
});

test("the error envelope validates and every code has exactly one status", () => {
  for (const code of Object.keys(ANALYSIS_ERROR_STATUS) as Array<keyof typeof ANALYSIS_ERROR_STATUS>) {
    const body = analysisErrorBody(code, "message");
    assert.deepEqual(validateJsonSchema(ANALYSIS_API_SCHEMAS.AnalysisError, body), [], code);
    assert.equal(typeof ANALYSIS_ERROR_STATUS[code], "number");
  }
  // The mapping the brief asks for, pinned so a future edit cannot quietly move one.
  assert.equal(ANALYSIS_ERROR_STATUS.INVALID_TICKER, 400);
  assert.equal(ANALYSIS_ERROR_STATUS.UNAUTHORIZED, 401);
  assert.equal(ANALYSIS_ERROR_STATUS.FORBIDDEN_SCOPE, 403);
  assert.equal(ANALYSIS_ERROR_STATUS.FILING_NOT_FOUND, 404);
  assert.equal(ANALYSIS_ERROR_STATUS.RATE_LIMITED, 429);
  assert.equal(ANALYSIS_ERROR_STATUS.STORAGE_UNAVAILABLE, 503);
});

test("the OpenAPI document describes the resources it actually serves, and embeds the same schemas", () => {
  const document = buildAnalysisOpenApiDocument("https://backend.test") as {
    openapi: string;
    info: { version: string };
    components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
    paths: Record<string, { get?: { security?: Array<Record<string, string[]>> } }>;
  };
  assert.equal(document.openapi, "3.1.0");
  assert.equal(document.info.version, ANALYSIS_API_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(document.paths).sort(), [
    "/api/v1/companies/{ticker}/analysis",
    "/api/v1/companies/{ticker}/business-explainer",
    "/api/v1/companies/{ticker}/business-flow",
    "/api/v1/companies/{ticker}/capital",
    "/api/v1/companies/{ticker}/filings",
    "/api/v1/companies/{ticker}/filings/{accession}",
    "/api/v1/companies/{ticker}/fundamentals",
    "/api/v1/companies/{ticker}/guidance",
    "/api/v1/openapi.json",
  ]);
  // Embedded by reference, not copied — so the document cannot describe a shape the tests do not check.
  assert.equal(document.components.schemas.FilingPage, ANALYSIS_API_SCHEMAS.FilingPage);
  assert.ok(document.components.securitySchemes.readCredential);
  assert.deepEqual(
    document.paths["/api/v1/companies/{ticker}/fundamentals"]?.get?.security,
    [{ readCredential: ["fundamentals:read"] }],
  );
  // The contract document itself is the one unauthenticated resource.
  assert.deepEqual(document.paths["/api/v1/openapi.json"]?.get?.security, []);
});

test("the document serialises — a consumer reads JSON, not a live object graph", () => {
  const serialised = JSON.parse(JSON.stringify(buildAnalysisOpenApiDocument())) as { paths: Record<string, unknown> };
  assert.equal(Object.keys(serialised.paths).length, 9);
});

/**
 * §4.3 asks for API schema version, content revision and internal pipeline versions to stay
 * distinguishable. `reportVersion` predates that and packs two of them together, so it is split
 * rather than reinterpreted — and anything that is not in the compound form is reported as an
 * unknown schema instead of being guessed at.
 */
test("reportVersion splits into an analysis schema and a content revision", () => {
  assert.deepEqual(splitReportVersion("sec-analysis.v2:abc123"), {
    analysisSchemaVersion: "sec-analysis.v2",
    contentRevision: "abc123",
  });
  assert.deepEqual(splitReportVersion("v1"), { analysisSchemaVersion: null, contentRevision: "v1" });
  assert.deepEqual(splitReportVersion(null), { analysisSchemaVersion: null, contentRevision: null });
  assert.deepEqual(splitReportVersion("trailing:"), { analysisSchemaVersion: null, contentRevision: "trailing:" });
});
