import type {CompleteFlowPublication} from '../../../shared/analysis-contract/complete-business-flow.ts';
import type {CapitalResponse} from '../../../shared/analysis-contract/capital-structure.ts';
import type { BusinessExplainerResponse } from "../../../shared/analysis-contract/business-explainer.ts";
import type { GuidanceResponse } from "../../../shared/analysis-contract/guidance.ts";
import type { PublicCompanyAnalysisResponse } from "../../../shared/analysis-contract/company-analysis.ts";
import { AnalysisRequestError, type AnalysisErrorBody, type AnalysisErrorCode } from "./analysis-errors.ts";
import type { PublicFilingDetail, PublicFilingPage } from "../../../shared/analysis-contract/filings.ts";
import type { PublicFundamentalsResponse } from "../../../shared/analysis-contract/fundamentals.ts";

/**
 * The lightweight client every caller of the analysis backend uses — the Web Worker over its
 * Service Binding, and any other service over HTTPS. It is **server-only**: it carries a read
 * credential, so it must never be imported into a browser bundle or a client component.
 *
 * It speaks plain HTTP rather than an RPC surface on purpose. The Service Binding already carries
 * `fetch`, so the same request builder, the same handlers and the same response bodies serve both
 * transports; adding an RPC API would have forked the business logic across two shapes, which is
 * exactly what the refactor set out to avoid.
 */
export type AnalysisBackendClientOptions = {
  /**
   * Absolute origin for the backend. Over a Service Binding the hostname is ignored and only the
   * path is honoured, so any syntactically valid origin works there; over HTTPS it must be real.
   */
  origin: string;
  /** The read credential, `"<keyId>.<secret>"`. */
  token: string;
  /** The Service Binding's `fetch` when one is bound, otherwise the global `fetch`. */
  fetcher?: typeof fetch;
  /** Per-request timeout. A backend that hangs must not hang the page that called it. */
  timeoutMs?: number;
};

export type AnalysisBackendResponse<T> = {
  status: number;
  headers: Headers;
  body: T;
};

export const ANALYSIS_CLIENT_DEFAULT_TIMEOUT_MS = 8_000;

export class AnalysisBackendClient {
  private readonly origin: string;
  private readonly token: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: AnalysisBackendClientOptions) {
    this.origin = options.origin.replace(/\/+$/, "");
    this.token = options.token;
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? ANALYSIS_CLIENT_DEFAULT_TIMEOUT_MS;
  }

  listFilings(ticker: string, query: { cursor?: string | null; limit?: string | null } = {}) {
    const search = new URLSearchParams();
    if (query.cursor) search.set("cursor", query.cursor);
    if (query.limit) search.set("limit", query.limit);
    return this.request<PublicFilingPage>(`/api/v1/companies/${encode(ticker)}/filings`, search);
  }

  getFiling(ticker: string, accession: string, snapshot?: { reportDate: string; reportVersion: string }) {
    return this.request<PublicFilingDetail>(`/api/v1/companies/${encode(ticker)}/filings/${encode(accession)}`, snapshot ? new URLSearchParams(snapshot) : undefined);
  }

  getCompleteBusinessFlow(ticker:string){return this.request<CompleteFlowPublication>(`/api/v1/companies/${encode(ticker)}/business-flow`);}
  getCapital(ticker: string) { return this.request<CapitalResponse>(`/api/v1/companies/${encode(ticker)}/capital`); }
  getBusinessExplainer(ticker: string) { return this.request<BusinessExplainerResponse>(`/api/v1/companies/${encode(ticker)}/business-explainer`); }
  getGuidance(ticker: string) { return this.request<GuidanceResponse>(`/api/v1/companies/${encode(ticker)}/guidance`); }

  getCompanyAnalysis(ticker: string) {
    return this.request<PublicCompanyAnalysisResponse>(`/api/v1/companies/${encode(ticker)}/analysis`);
  }

  getFundamentals(ticker: string, query: { metrics?: string | null; periodCount?: string | null } = {}) {
    const search = new URLSearchParams();
    if (query.metrics !== null && query.metrics !== undefined) search.set("metrics", query.metrics);
    if (query.periodCount !== null && query.periodCount !== undefined) search.set("periodCount", query.periodCount);
    return this.request<PublicFundamentalsResponse>(`/api/v1/companies/${encode(ticker)}/fundamentals`, search);
  }

  /**
   * Returns the response rather than throwing on a non-2xx, because the callers are proxies that
   * have to reproduce the backend's status and body. Only transport-level failures throw, and they
   * throw an `AnalysisRequestError` carrying `BACKEND_UNAVAILABLE` — never the underlying error,
   * which can name internal hosts.
   */
  private async request<T>(path: string, search?: URLSearchParams): Promise<AnalysisBackendResponse<T | AnalysisErrorBody>> {
    const query = search && [...search.keys()].length ? `?${search}` : "";
    let response: Response;
    try {
      response = await this.fetcher(`${this.origin}${path}${query}`, {
        method: "GET",
        headers: { authorization: `Bearer ${this.token}`, accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new AnalysisRequestError("BACKEND_UNAVAILABLE", "The analysis backend is unreachable.");
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new AnalysisRequestError("BACKEND_UNAVAILABLE", "The analysis backend returned an unreadable response.");
    }
    return { status: response.status, headers: response.headers, body: body as T | AnalysisErrorBody };
  }
}

/** Narrows a client result to the error envelope. */
export function isAnalysisErrorBody(body: unknown): body is AnalysisErrorBody {
  return typeof body === "object" && body !== null && typeof (body as AnalysisErrorBody).code === "string"
    && typeof (body as AnalysisErrorBody).error === "string";
}

export function analysisErrorCodeOf(body: unknown): AnalysisErrorCode | null {
  return isAnalysisErrorBody(body) ? body.code : null;
}

function encode(value: string): string {
  return encodeURIComponent(value);
}
