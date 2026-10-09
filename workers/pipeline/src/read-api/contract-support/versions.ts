
export { ANALYSIS_API_SCHEMA_VERSION } from "../../../../../shared/analysis-contract/common.ts";

/**
 * Splits a `reportVersion` into the analysis schema it was produced under and the content hash
 * identifying that exact report. Anything that does not carry the compound form is reported as an
 * unknown schema with the whole value as the revision, rather than guessed at.
 */
export function splitReportVersion(reportVersion: string | null): {
  analysisSchemaVersion: string | null;
  contentRevision: string | null;
} {
  if (!reportVersion) return { analysisSchemaVersion: null, contentRevision: null };
  const separator = reportVersion.lastIndexOf(":");
  if (separator <= 0 || separator === reportVersion.length - 1) {
    return { analysisSchemaVersion: null, contentRevision: reportVersion };
  }
  return {
    analysisSchemaVersion: reportVersion.slice(0, separator),
    contentRevision: reportVersion.slice(separator + 1),
  };
}
