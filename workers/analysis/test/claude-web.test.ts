import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeWebProvider, type WebCallRecord } from "../src/web-search/claude.ts";
import { WebSearchError } from "../src/web-search/types.ts";

const message = (content: unknown[], usage: Record<string, unknown> = {}) => ({
  id: "msg_1", type: "message", role: "assistant", model: "deepseek-v4-pro", content, stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage },
});
function provider(body: unknown, status = 200) {
  const requests: Array<Record<string, unknown>> = [], records: WebCallRecord[] = [];
  const fetcher = (async (_: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const web = new ClaudeWebProvider({ apiKey: "sk-test", model: "deepseek-flash", effort: "low", fetcher, record: async call => { records.push(call); } });
  return { web, requests, records };
}

test("a search runs one web_search and keeps each result's cited passages as its snippet", async () => {
  const { web, requests, records } = provider(message([
    { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "Oracle OCI revenue" } },
    { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [
      { type: "web_search_result", url: "https://www.oracle.com/news/q1", title: "Oracle Q1", encrypted_content: "x", page_age: "September 9, 2026" },
      { type: "web_search_result", url: "https://old.example.com/a", title: "Old", encrypted_content: "x", page_age: "January 2, 2020" },
      { type: "web_search_result", url: "http://insecure.example.com/b", title: "Insecure", encrypted_content: "x", page_age: null },
    ] },
    { type: "text", text: "OCI revenue grew 55%.", citations: [{ type: "web_search_result_location", url: "https://www.oracle.com/news/q1", title: "Oracle Q1", encrypted_index: "i", cited_text: "Cloud infrastructure revenue was up 55%" }] },
  ], { server_tool_use: { web_search_requests: 1 } }));
  const result = await web.search({ query: "Oracle OCI revenue", maxResults: 5, startDate: "2026-01-01", excludeDomains: ["reddit.com"] });
  assert.deepEqual(result.results, [{ url: "https://www.oracle.com/news/q1", title: "Oracle Q1", snippet: "Cloud infrastructure revenue was up 55%", score: null, publishedAt: "2026-09-09" }]);
  const [request] = requests;
  assert.equal(request!.model, "deepseek-flash");
  assert.deepEqual(request!.output_config, { effort: "low" });
  assert.deepEqual(request!.tools, [{ type: "web_search_20250305", name: "web_search", max_uses: 1, blocked_domains: ["reddit.com"] }]);
  assert.deepEqual(request!.messages, [{ role: "user", content: "Oracle OCI revenue" }]);
  assert.equal(records[0]!.stage, "web-search");
  assert.equal(records[0]!.searchCalls, 1);
});

test("an allow list wins over a block list, since the API takes one", async () => {
  const { web, requests } = provider(message([{ type: "web_search_tool_result", tool_use_id: "s", content: [] }]));
  await web.search({ query: "q", includeDomains: ["sec.gov"], excludeDomains: ["reddit.com"] });
  assert.deepEqual((requests[0]!.tools as Array<Record<string, unknown>>)[0]!.allowed_domains, ["sec.gov"]);
  assert.equal((requests[0]!.tools as Array<Record<string, unknown>>)[0]!.blocked_domains, undefined);
});

test("a fetched page is the text the web_fetch tool returned", async () => {
  const { web, requests } = provider(message([
    { type: "server_tool_use", id: "srvtoolu_2", name: "web_fetch", input: { url: "https://investor.example.com/q3" } },
    { type: "web_fetch_tool_result", tool_use_id: "srvtoolu_2", content: { type: "web_fetch_result", url: "https://investor.example.com/q3", retrieved_at: "2026-10-17T00:00:00Z",
      content: { type: "document", title: "Q3", citations: null, source: { type: "text", media_type: "text/plain", data: "Third quarter revenue rose." } } } },
    { type: "text", text: "done" },
  ]));
  const page = await web.fetchContent({ url: "https://investor.example.com/q3", depth: "advanced" });
  assert.equal(page.text, "Third quarter revenue rose.");
  assert.equal((requests[0]!.tools as Array<Record<string, unknown>>)[0]!.max_content_tokens, 25_000);
  assert.deepEqual(requests[0]!.messages, [{ role: "user", content: "https://investor.example.com/q3" }]);
});

test("tool errors and HTTP errors become web search errors the callers already handle", async () => {
  const busy = provider(message([{ type: "web_fetch_tool_result", tool_use_id: "s", content: { type: "web_fetch_tool_result_error", error_code: "too_many_requests" } }]));
  await assert.rejects(busy.web.fetchContent({ url: "https://example.com/a" }), (e) => e instanceof WebSearchError && e.code === "provider_error" && e.retryable);
  const blocked = provider(message([{ type: "web_fetch_tool_result", tool_use_id: "s", content: { type: "web_fetch_tool_result_error", error_code: "url_not_accessible" } }]));
  await assert.rejects(blocked.web.fetchContent({ url: "https://example.com/a" }), (e) => e instanceof WebSearchError && !e.retryable);
  const unsearched = provider(message([{ type: "text", text: "I can't search." }]));
  await assert.rejects(unsearched.web.search({ query: "q" }), (e) => e instanceof WebSearchError && e.code === "provider_error");
  const denied = provider({ type: "error", error: { type: "invalid_request_error", message: "web search is not enabled" } }, 400);
  await assert.rejects(denied.web.search({ query: "q" }), (e) => e instanceof WebSearchError && e.httpStatus === 400 && !e.retryable);
  assert.equal(denied.records[0]!.error, "http:400");
});

test("web search goes to the configured Anthropic-format endpoint", async () => {
  const urls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify(message([{ type: "text", text: "done" }])), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const web = new ClaudeWebProvider({ apiKey: "sk-test", baseURL: "https://api.deepseek.com/anthropic", model: "deepseek-flash", effort: "low", fetcher });
  await web.search({ query: "Oracle OCI revenue" }).catch(() => null);
  assert.equal(urls[0], "https://api.deepseek.com/anthropic/v1/messages");
});
