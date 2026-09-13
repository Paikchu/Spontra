#!/usr/bin/env node
/**
 * An independent HTTP consumer of the financial analysis backend.
 *
 * This file exists to prove a claim: another service can read published analysis results using
 * nothing but the documented HTTP API and a read credential — no Web Worker, no database, no shared
 * code from this repository. So it deliberately imports nothing from `lib/`, speaks plain `fetch`,
 * and validates what comes back against the backend's own published OpenAPI document rather than
 * against types it was compiled with.
 *
 * Usage:
 *
 *   ANALYSIS_API_URL="https://<analysis-backend-host>" \
 *   ANALYSIS_READ_TOKEN="<keyId>.<secret>" \
 *   node examples/analysis-backend-consumer.mjs MSFT
 *
 * The token is a *read* credential. It cannot start an analysis, a backfill or a refresh — those
 * need a separate administrative secret that is never given to a reader.
 */

const baseUrl = (process.env.ANALYSIS_API_URL ?? "").replace(/\/+$/, "");
const token = process.env.ANALYSIS_READ_TOKEN ?? "";
const ticker = (process.argv[2] ?? "MSFT").toUpperCase();

if (!baseUrl || !token) {
  console.error("Set ANALYSIS_API_URL and ANALYSIS_READ_TOKEN. See docs/analysis-backend.md.");
  process.exit(2);
}

async function read(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json();
  if (response.status === 401 || response.status === 403) {
    throw new Error(`Credential rejected (${response.status}): ${body.code}`);
  }
  if (response.status === 429) throw new Error("Rate limited; slow down and retry.");
  if (response.status >= 500) throw new Error(`Backend unavailable (${response.status}): ${body.code}`);
  return { status: response.status, body };
}

/** The contract document is public, so a consumer can discover the shape before authenticating. */
const contract = await (await fetch(`${baseUrl}/api/v1/openapi.json`)).json();
const schemas = contract.components.schemas;

const report = {
  ticker,
  apiVersion: contract.info.version,
  filings: null,
  latestFiling: null,
  companyAnalysis: null,
  fundamentals: null,
};

const filings = await read(`/api/v1/companies/${encodeURIComponent(ticker)}/filings?limit=5`);
assertShape(schemas.FilingPage, filings.body, "FilingPage");
report.filings = {
  count: filings.body.filings.length,
  total: filings.body.total,
  hasMore: filings.body.nextCursor !== null,
};

const newest = filings.body.filings[0];
if (newest) {
  const detail = await read(
    `/api/v1/companies/${encodeURIComponent(ticker)}/filings/${encodeURIComponent(newest.accessionNumber)}`,
  );
  assertShape(schemas.FilingDetail, detail.body, "FilingDetail");
  const filing = detail.body.filing;
  report.latestFiling = {
    accessionNumber: filing.accessionNumber,
    form: filing.form,
    reportingPeriod: { reportDate: filing.reportDate, periodId: filing.periodId },
    // Published result and latest run are two different questions.
    publishedResult: filing.analysisStatus,
    latestRun: filing.analysisRun.state,
    runError: filing.analysisRun.errorCode,
    // Version identifiers, each meaning one thing.
    apiSchemaVersion: detail.body.apiSchemaVersion,
    analysisSchemaVersion: filing.analysisSchemaVersion,
    contentRevision: filing.contentRevision,
    // Facts, not prose: metrics and the evidence backing them.
    keyMetrics: (filing.analysis?.keyMetrics ?? []).map((metric) => ({
      metricKey: metric.metricKey,
      value: metric.currentValue,
      status: metric.status,
      evidenceIds: metric.evidenceIds,
    })),
    quality: filing.analysis?.dataQuality
      ? { coverage: filing.analysis.dataQuality.coverage, verificationStatus: filing.analysis.dataQuality.verificationStatus }
      : null,
    provenance: filing.provenance,
    sourceDocument: filing.documentUrl,
  };
}

const analysis = await read(`/api/v1/companies/${encodeURIComponent(ticker)}/analysis`);
assertShape(schemas.CompanyAnalysis, analysis.body, "CompanyAnalysis");
report.companyAnalysis = {
  publishedResult: analysis.body.status,
  latestRun: analysis.body.latestRun.state,
  runError: analysis.body.latestRun.errorCode,
  generatedAt: analysis.body.generatedAt,
  contentRevision: analysis.body.versions.contentRevision,
  headline: analysis.body.overview?.headline ?? null,
  highlights: (analysis.body.overview?.highlights ?? []).map((highlight) => ({
    title: highlight.title,
    evidenceRefs: highlight.evidenceRefs,
  })),
};

const fundamentals = await read(`/api/v1/companies/${encodeURIComponent(ticker)}/fundamentals?periodCount=4`);
if (fundamentals.status === 404) {
  report.fundamentals = { available: false, reason: fundamentals.body.code };
} else {
  assertShape(schemas.Fundamentals, fundamentals.body, "Fundamentals");
  report.fundamentals = {
    available: true,
    // Real provenance: public fundamentals are sourced from SEC XBRL filings.
    source: fundamentals.body.source,
    status: fundamentals.body.status,
    stale: fundamentals.body.stale,
    fetchedAt: fundamentals.body.fetchedAt,
    periods: fundamentals.body.periods.map((period) => period.periodEnd),
  };
}

console.log(JSON.stringify(report, null, 2));

/**
 * A deliberately small structural check against the published schema: enough to catch a response
 * that has drifted from the contract, without pulling a validation library into an example.
 */
function assertShape(schema, value, label) {
  for (const key of schema.required ?? []) {
    if (!(key in value)) throw new Error(`${label} is missing the required field "${key}"`);
  }
  const version = schema.properties?.apiSchemaVersion?.const;
  if (version && value.apiSchemaVersion !== version) {
    throw new Error(`${label} reports API schema ${value.apiSchemaVersion}, expected ${version}`);
  }
}
