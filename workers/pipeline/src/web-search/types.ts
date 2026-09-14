/** Public server-side contracts. Providers must return evidence, never generated answers. */
export interface SearchRequest {
  query: string;
  maxResults?: number;
  depth?: "basic" | "advanced";
  topic?: "general" | "news";
  includeDomains?: string[];
  excludeDomains?: string[];
  startDate?: string;
  endDate?: string;
}
export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  publishedAt: string | null;
  score: number | null;
}
export interface SearchData { kind: "search"; results: SearchHit[] }
export interface ContentRequest { url: string; depth?: "basic" | "advanced" }
export interface ContentData {
  kind: "content";
  url: string;
  text: string;
  format: "markdown";
  /** Extraction success does not prove transcript completeness or presence of Q&A. */
  completeness: "unverified";
}
export type RetrievalData = SearchData | ContentData;
export interface SearchProvider {
  /** Include adapter version; changing parsing or provider options must invalidate old cache keys. */
  id: string;
  search(request: SearchRequest): Promise<SearchData>;
  fetchContent(request: ContentRequest): Promise<ContentData>;
}
export interface Retrieval<T extends RetrievalData> {
  data: T;
  provider: string;
  fetchedAt: string;
  expiresAt: string;
  cache: "hit" | "miss";
  cacheKey: string;
}
export interface CachePolicy {
  /** Trusted caller chooses a tenant/permission scope. No implicit cross-user sharing. */
  scope: string;
  maxAgeMs?: number;
  /** Bypass stored values, but still merge simultaneous refreshes via the lease. */
  refresh?: boolean;
}
export class WebSearchError extends Error {
  readonly code: "invalid_request" | "not_configured" | "provider_error" | "invalid_response" | "busy" | "lease_lost";
  readonly retryable: boolean;
  constructor(code: WebSearchError["code"], retryable = false) {
    super(`Web search: ${code}`);
    this.name = "WebSearchError";
    this.code = code;
    this.retryable = retryable;
  }
}
