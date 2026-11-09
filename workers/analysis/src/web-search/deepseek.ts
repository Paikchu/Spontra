import { SEC_DOMAIN } from "../../../../shared/analysis-runtime/sec-sources.ts";
import { z } from "zod";
import { WebSearchError, type ContentData, type ContentRequest, type SearchData, type SearchProvider, type SearchRequest } from "./types.ts";
import { isEdgarUrl, normalizeContent, normalizeSearch, publicUrl } from "./validation.ts";

const searchResponse = z.object({ results: z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string(), date: z.string().nullable(), rerank_score: z.number() })) });
const pageResponse = z.object({ content: z.string().min(1) });
export type WebApiCall = { stage: "web-search" | "web-fetch"; durationMs: number; searchCalls: number; error?: string };

/** Raw Search/Fetch APIs for scheduled retrieval and page reads. No Messages API or model is involved. */
type WebApiOptions = { apiKey: string; signal?: AbortSignal; fetcher?: typeof fetch; record?: (call: WebApiCall) => Promise<void> };
export class DeepSeekWebProvider implements SearchProvider {
  readonly id = "deepseek-search-api:v1";
  private readonly options: WebApiOptions;
  constructor(options: WebApiOptions) { this.options = options; }

  private async request(kind: "search" | "fetch", body: object): Promise<unknown> {
    const started = Date.now();
    const timeout = AbortSignal.timeout(120_000);
    let error: string | undefined;
    try {
      const response = await (this.options.fetcher ?? fetch)(`https://api.deepseek.com/v1/tools/${kind}`, {
        method: "POST", headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body), signal: this.options.signal ? AbortSignal.any([timeout, this.options.signal]) : timeout,
      });
      if (!response.ok) {
        error = `http:${response.status}`;
        throw new WebSearchError("provider_error", response.status === 408 || response.status === 429 || response.status >= 500, response.status);
      }
      return await response.json();
    } catch (cause) {
      error ??= "transport";
      throw cause;
    } finally {
      await this.options.record?.({ stage: kind === "search" ? "web-search" : "web-fetch", durationMs: Date.now() - started, searchCalls: kind === "search" ? 1 : 0, ...(error ? { error } : {}) });
    }
  }

  async search(input: SearchRequest): Promise<SearchData> {
    const r = normalizeSearch(input);
    // Preserve restrictions in both the query and the returned set. Never ask the search service for SEC text.
    const domainTerms = r.includeDomains?.length ? r.includeDomains.map(d => `site:${d}`).join(" OR ") : "";
    const suffix = [domainTerms, `-site:${SEC_DOMAIN}`, r.startDate ? `after:${r.startDate}` : "", r.endDate ? `before:${r.endDate}` : ""].filter(Boolean).join(" ");
    const room = 128 - [...suffix].length - 1;
    if (room < 3) throw new WebSearchError("invalid_request");
    const query = `${[...r.query].slice(0, room).join("")} ${suffix}`;
    const data = searchResponse.parse(await this.request("search", { query, count: r.maxResults, need_content: false }));
    const results: SearchData["results"] = [];
    for (const h of data.results) {
      let url: string;
      try { url = publicUrl(h.url); } catch { continue; }
      const host = new URL(url).hostname;
      const matches = (domain: string) => host === domain || host.endsWith(`.${domain}`);
      if (isEdgarUrl(url) || r.includeDomains?.length && !r.includeDomains.some(matches) || r.excludeDomains?.some(matches)) continue;
      const publishedAt = h.date && Number.isFinite(Date.parse(h.date)) ? new Date(h.date).toISOString() : null;
      if (publishedAt && (r.startDate && publishedAt.slice(0, 10) < r.startDate || r.endDate && publishedAt.slice(0, 10) > r.endDate)) continue;
      if (!results.some(x => x.url === url)) results.push({ url, title: h.title, snippet: h.snippet, publishedAt, score: h.rerank_score });
    }
    return { kind: "search", results };
  }

  async fetchContent(input: ContentRequest): Promise<ContentData> {
    const r = normalizeContent(input);
    if (isEdgarUrl(r.url)) throw new WebSearchError("archive_only");
    const data = pageResponse.parse(await this.request("fetch", { url: r.url }));
    return { kind: "content", url: r.url, text: data.content, format: "markdown", completeness: "unverified" };
  }
}
