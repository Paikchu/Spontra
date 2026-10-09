export const ANALYSIS_API_SCHEMA_VERSION = "analysis-api.v1";

export const ANALYSIS_ERROR_STATUS = {
  INVALID_TICKER: 400,
  INVALID_CURSOR: 400,
  INVALID_METRICS: 400,
  INVALID_PERIOD_COUNT: 400,
  REQUEST_TOO_LARGE: 400,
  ROUTE_NOT_FOUND: 404,
  FILING_NOT_FOUND: 404,
  FUNDAMENTALS_NOT_AVAILABLE: 404,
  METHOD_NOT_ALLOWED: 405,
  STORAGE_UNAVAILABLE: 503,
} as const;

export type AnalysisErrorCode = keyof typeof ANALYSIS_ERROR_STATUS;

export type AnalysisErrorBody = {
  apiSchemaVersion: typeof ANALYSIS_API_SCHEMA_VERSION;
  error: string;
  code: AnalysisErrorCode;
};
