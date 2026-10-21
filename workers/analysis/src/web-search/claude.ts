import Anthropic from "@anthropic-ai/sdk";
import { extractText } from "unpdf";
import { WebSearchError, type ContentData, type ContentRequest, type SearchData, type SearchProvider, type SearchRequest } from "./types.ts";
import { normalizeContent, normalizeSearch, publicUrl } from "./validation.ts";

/** One provider call as the cost ledger records it. */
export type WebCallRecord = { stage: "web-search" | "web-fetch"; model: string; reasoning: string; usage: unknown; error?: string; durationMs: number; searchCalls: number };
export type ClaudeWebOptions = {
  apiKey: string; model: string; effort: Anthropic.OutputConfig["effort"];
  /** The Anthropic-format endpoint; the SDK's default when unset. */
  baseURL?: string;
  fetcher?: typeof fetch; record?: (call: WebCallRecord) => Promise<void>;
};

const SEARCH_SYSTEM = "You relay one web search. Call web_search exactly once with the user's query as given. Then, for each result that bears on the query, quote the passage from it that does, citing it. Quote only text from the results; add nothing else.";
const FETCH_SYSTEM = "Call web_fetch exactly once on the URL the user gives. Then reply with the single word: done.";
/** Server-side tool failures the provider may clear on a later try. */
const TRANSIENT = new Set(["too_many_requests", "unavailable"]);

/** `page_age` is free text such as "April 30, 2025"; its calendar date, whatever the runtime's time zone. */
const dateOf = (pageAge: string | null | undefined): string | null => {
  if (!pageAge) return null;
  const iso = /^\d{4}-\d{2}-\d{2}/.exec(pageAge);
  if (iso) return iso[0];
  const date = new Date(pageAge);
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

/**
 * Search and page reading through the Messages API's server tools (`web_search`, `web_fetch`): evidence only, never a
 * generated answer. A result's snippet is the passages the model cites from it, which the API quotes verbatim; a page is the text
 * the fetch returned, a PDF's text extracted here.
 */
export class ClaudeWebProvider implements SearchProvider {
  readonly id = "claude-web:v1";
  private readonly client: Anthropic;
  private readonly options: ClaudeWebOptions;
  constructor(options: ClaudeWebOptions) {
    this.options = options;
    const fetcher = options.fetcher ?? fetch;
    this.client = new Anthropic({ apiKey: options.apiKey, baseURL: options.baseURL, maxRetries: 2, timeout: 120_000, fetch: (input, init) => fetcher(input, init) });
  }

  private async call(stage: WebCallRecord["stage"], params: Omit<Anthropic.MessageCreateParamsNonStreaming, "model" | "output_config">): Promise<Anthropic.Message> {
    if (!this.options.apiKey?.trim()) throw new WebSearchError("not_configured");
    const started = Date.now();
    const record = (usage: unknown, error?: string) => this.options.record?.({
      stage, model: this.options.model, reasoning: String(this.options.effort), usage, error, durationMs: Date.now() - started,
      searchCalls: (usage as { server_tool_use?: { web_search_requests?: number } } | undefined)?.server_tool_use?.web_search_requests ?? 0,
    }).catch(() => {});
    try {
      const message = await this.client.messages.create({ ...params, model: this.options.model, output_config: { effort: this.options.effort } });
      await record(message.usage);
      return message;
    } catch (error) {
      await record(undefined, error instanceof Anthropic.APIError && error.status ? `http:${error.status}` : "transport");
      if (error instanceof Anthropic.APIError && error.status) throw new WebSearchError("provider_error", error.status === 429 || error.status >= 500, error.status);
      throw new WebSearchError("provider_error", true);
    }
  }

  async search(input: SearchRequest): Promise<SearchData> {
    const r = normalizeSearch(input);
    // The API takes one domain list; an allow list already excludes everything else.
    const domains = r.includeDomains?.length ? { allowed_domains: r.includeDomains } : r.excludeDomains?.length ? { blocked_domains: r.excludeDomains } : {};
    const message = await this.call("web-search", {
      max_tokens: 4096, system: SEARCH_SYSTEM,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1, ...domains }],
      messages: [{ role: "user", content: r.query }],
    });
    const block = message.content.find((b): b is Anthropic.WebSearchToolResultBlock => b.type === "web_search_tool_result");
    if (!block) throw new WebSearchError("provider_error", true);
    if (!Array.isArray(block.content)) throw new WebSearchError("provider_error", TRANSIENT.has(block.content.error_code));
    const quotes = new Map<string, string[]>();
    for (const b of message.content) {
      if (b.type !== "text") continue;
      for (const c of b.citations ?? []) {
        if (c.type !== "web_search_result_location" || !c.cited_text.trim()) continue;
        const list = quotes.get(c.url) ?? [];
        if (!list.includes(c.cited_text)) list.push(c.cited_text);
        quotes.set(c.url, list);
      }
    }
    const seen = new Set<string>();
    const results: SearchData["results"] = [];
    for (const hit of block.content) {
      let url: string;
      try { url = publicUrl(hit.url); } catch { continue; }
      if (seen.has(url)) continue;
      seen.add(url);
      const publishedAt = dateOf(hit.page_age);
      if (publishedAt && ((r.startDate && publishedAt < r.startDate) || (r.endDate && publishedAt > r.endDate))) continue;
      results.push({ url, title: hit.title, snippet: (quotes.get(hit.url) ?? quotes.get(url) ?? []).join(" … "), score: null, publishedAt });
    }
    return { kind: "search", results: results.slice(0, r.maxResults) };
  }

  async fetchContent(input: ContentRequest): Promise<ContentData> {
    const r = normalizeContent(input);
    const message = await this.call("web-fetch", {
      max_tokens: 1024, system: FETCH_SYSTEM,
      // Every fetched token is billed as input; the agents keep at most a 20,000-character excerpt of a page.
      tools: [{ type: "web_fetch_20250910", name: "web_fetch", max_uses: 1, max_content_tokens: r.depth === "advanced" ? 25_000 : 10_000 }],
      messages: [{ role: "user", content: r.url }],
    });
    const block = message.content.find((b): b is Anthropic.WebFetchToolResultBlock => b.type === "web_fetch_tool_result");
    if (!block) throw new WebSearchError("provider_error", true);
    if (block.content.type !== "web_fetch_result") throw new WebSearchError("provider_error", TRANSIENT.has(block.content.error_code));
    const source = block.content.content.source;
    let text: string;
    if (source.type === "text") text = source.data;
    else if (source.type === "base64" && source.media_type === "application/pdf") {
      try { text = (await extractText(Uint8Array.from(atob(source.data), c => c.charCodeAt(0)), { mergePages: true })).text; }
      catch { throw new WebSearchError("invalid_response"); }
    } else throw new WebSearchError("invalid_response");
    if (!text.trim()) throw new WebSearchError("invalid_response");
    return { kind: "content", url: r.url, text, format: "markdown", completeness: "unverified" };
  }
}
