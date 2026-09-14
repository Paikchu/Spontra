import { WebSearchError, type ContentData, type ContentRequest, type SearchData, type SearchProvider, type SearchRequest } from "./types.ts";
import { normalizeContent, normalizeSearch, publicUrl } from "./validation.ts";
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WebSearchError("invalid_response");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new WebSearchError("invalid_response");
  return value;
}
/** Fixed endpoint, bounded body and deadline; never surface provider bodies or credentials in errors. */
export class TavilyProvider implements SearchProvider {
  readonly id = "tavily:v1";
  private readonly apiKey: string;
  private readonly fetcher: typeof fetch;
  constructor(apiKey: string, fetcher: typeof fetch = fetch) {
    this.apiKey = apiKey;
    this.fetcher = fetcher;
  }
  private async post(operation: "search" | "extract", body: unknown): Promise<Record<string, unknown>> {
    if (!this.apiKey?.trim()) throw new WebSearchError("not_configured");
    try {
      const response = await this.fetcher(`https://api.tavily.com/${operation}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new WebSearchError("provider_error", response.status === 429 || response.status >= 500);
      }
      if (!response.body) throw new WebSearchError("invalid_response");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 4 * 1024 * 1024) {
            await reader.cancel();
            throw new WebSearchError("invalid_response");
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const buffer = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
      return object(JSON.parse(new TextDecoder().decode(buffer)));
    } catch (error) {
      if (error instanceof WebSearchError) throw error;
      throw new WebSearchError("provider_error", true);
    }
  }
  async search(input: SearchRequest): Promise<SearchData> {
    const r = normalizeSearch(input);
    const body = await this.post("search", { query: r.query, max_results: r.maxResults,
      search_depth: r.depth, topic: r.topic, include_domains: r.includeDomains,
      exclude_domains: r.excludeDomains, start_date: r.startDate, end_date: r.endDate,
      include_answer: false, include_raw_content: false, auto_parameters: false });
    if (!Array.isArray(body.results)) throw new WebSearchError("invalid_response");
    const seen = new Set<string>();
    const results: SearchData["results"] = [];
    for (const value of body.results) {
      const hit = object(value);
      let url: string;
      try { url = publicUrl(string(hit.url)); } catch { continue; }
      if (seen.has(url)) continue;
      seen.add(url);
      results.push({ url, title: string(hit.title), snippet: string(hit.content),
        score: typeof hit.score === "number" && Number.isFinite(hit.score) ? hit.score : null,
        publishedAt: typeof hit.published_date === "string" ? hit.published_date : null });
    }
    if (body.results.length && !results.length) throw new WebSearchError("invalid_response");
    return { kind: "search", results: results.slice(0, r.maxResults) };
  }
  async fetchContent(input: ContentRequest): Promise<ContentData> {
    const r = normalizeContent(input);
    const body = await this.post("extract", { urls: [r.url], extract_depth: r.depth, format: "markdown" });
    if (!Array.isArray(body.results) || !body.results.length) throw new WebSearchError("provider_error", true);
    const result = body.results.map(object).find(item => item.url === r.url);
    if (!result) throw new WebSearchError("invalid_response");
    const text = string(result.raw_content);
    if (!text.trim()) throw new WebSearchError("invalid_response");
    return { kind: "content", url: r.url, text, format: "markdown", completeness: "unverified" };
  }
}
