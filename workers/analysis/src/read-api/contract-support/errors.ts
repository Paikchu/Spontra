import { ANALYSIS_ERROR_STATUS, type AnalysisErrorCode, type AnalysisErrorBody, ANALYSIS_API_SCHEMA_VERSION } from "../../../../../shared/analysis-contract/common.ts";
export { ANALYSIS_ERROR_STATUS, type AnalysisErrorCode, type AnalysisErrorBody } from "../../../../../shared/analysis-contract/common.ts";

/**
 * Every error the backend can return, and the single HTTP status each one maps to. The mapping
 * lives in one table so the router cannot drift from the published contract, and so a consumer can
 * branch on `code` without pattern-matching prose. No code here carries a prompt, a credential, a
 * stack, or a provider response — §4.4 requires the error surface to stay that small.
 */

export function analysisErrorStatus(code: AnalysisErrorCode): number {
  return ANALYSIS_ERROR_STATUS[code];
}

export function analysisErrorBody(code: AnalysisErrorCode, message: string): AnalysisErrorBody {
  return { apiSchemaVersion: ANALYSIS_API_SCHEMA_VERSION, error: message, code };
}

/** Thrown by query services; the router is the only thing that turns one into a response. */
export class AnalysisRequestError extends Error {
  readonly code: AnalysisErrorCode;

  constructor(code: AnalysisErrorCode, message: string) {
    super(message);
    this.name = "AnalysisRequestError";
    this.code = code;
  }
}
