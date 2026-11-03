import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { DeepSeekWebProvider } from "../src/web-search/deepseek.ts";
import { nativeSearches, nativeSearchSchema, type NativeSearch } from "../src/web-search/native.ts";
import { runAgentLoop, sequential, type Recipe } from "../src/agent-loop.ts";
import { defineTool } from "../src/tools/registry.ts";
import type { AgentBlock, AgentMessage, AgentReply } from "../src/tool-loop.ts";
import { aiUsageFromMetrics } from "../src/ai-runs/usage.ts";

const native: AgentBlock[] = [
  { type: "thinking", thinking: "research", signature: "sig" },
  { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "company product" } },
  { type: "web_search_tool_result", tool_use_id: "s1", content: [
    { type: "web_search_result", title: "Product", url: "https://example.com/product", page_age: "2026-10-01", encrypted_content: "opaque" },
    { type: "web_search_result", title: "SEC", url: "https://www.sec.gov/Archives/x", page_age: null },
  ] },
  { type: "text", text: "A lead", citations: [{ type: "web_search_result_location", url: "https://example.com/product", cited_text: "Product description." }] },
];

test("native search keeps thinking and server blocks intact; file reads and source registration continue in the same loop", async () => {
  type State = { batches: NativeSearch[]; read: boolean; done: boolean };
  const state: State = { batches: [], read: false, done: false };
  const tool = defineTool<State>();
  const recipe: Recipe<null, State, State> = {
    id: "research", budget: { turns: 5, wallMs: 1000 }, system: () => "Research", open: () => state,
    tools: () => [
      tool({ name: "sources", nativeSearch: { remaining: s => 1 - s.batches.length }, description: "Register sources", parameters: nativeSearchSchema,
        execute: (batch, ctx) => { ctx.state.batches.push(batch); return "h1: Product; read the source before citing"; }, observe: (_a, v) => v }),
      tool({ name: "read_file", description: "Read archived file", parameters: z.object({}), execute: (_a, ctx) => { ctx.state.read = true; return "Archived filing passage [e1]"; }, observe: (_a, v) => v }),
      tool({ name: "finish", description: "Finish", parameters: z.object({}), execute: (_a, ctx) => { ctx.state.done = true; return "done"; }, observe: (_a, v) => v }),
    ], policy: { allow: ["sources", "read_file", "finish"] }, settled: s => s.done, settle: s => s, nudge: "Read and finish",
  };
  const replies: AgentReply[] = [
    { stopReason: "end_turn", content: native },
    { stopReason: "tool_use", content: [{ type: "tool_use", id: "f1", name: "read_file", input: {} }] },
    { stopReason: "tool_use", content: [{ type: "tool_use", id: "f2", name: "finish", input: {} }] },
  ];
  const messages: AgentMessage[] = [{ role: "user", content: "go" }];
  let turns = 0;
  const outcome = await runAgentLoop(recipe, null, state, messages, async (_stage, _system, tools, history) => {
    assert.equal(tools.some(t => t.name === "web_search"), turns === 0, "the search budget removes the native tool after one search");
    assert.equal(tools.some(t => t.name === "sources"), false, "source indexing is not exposed as another model tool");
    if (turns > 0) assert.deepEqual(history[1], { role: "assistant", content: native });
    turns++;
    return replies.shift()!;
  }, { reserve: async () => true, record: () => {}, execute: (_t, calls, run) => sequential(calls, run), signal: new AbortController().signal, now: () => 0 });
  assert.equal(outcome.reason, "finished");
  assert.equal(state.read, true);
  assert.deepEqual(state.batches[0]!.hits, [{ title: "Product", url: "https://example.com/product", snippet: "Product description.", publishedAt: "2026-10-01", score: null }]);
  assert.match(JSON.stringify(messages), /Archived filing passage \[e1\]/);
  assert.equal(nativeSearches([{ type: "web_search_tool_result", tool_use_id: "s", content: { error_code: "unavailable" } }])[0]!.error !== null, true);
});

test("scheduled search and fallback fetch use raw APIs with no model request, and refuse SEC sources", async () => {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const records: unknown[] = [];
  const provider = new DeepSeekWebProvider({ apiKey: "test", record: async row => { records.push(row); }, fetcher: async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(String(url).endsWith("/search") ? { results: [
      { title: "Product", url: "https://example.com/product", snippet: "Original snippet", date: null, rerank_score: 2 },
      { title: "SEC", url: "https://www.sec.gov/Archives/x", snippet: "excluded", date: null, rerank_score: 3 },
    ] } : { title: "Product", content: "Original full text" }));
  } });
  const result = await provider.search({ query: "product details", maxResults: 5 });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]!.snippet, "Original snippet");
  assert.equal((await provider.fetchContent({ url: result.results[0]!.url })).text, "Original full text");
  await assert.rejects(provider.fetchContent({ url: "https://www.sec.gov/Archives/x" }), /archive_only/);
  assert.deepEqual(requests.map(r => r.url), ["https://api.deepseek.com/v1/tools/search", "https://api.deepseek.com/v1/tools/fetch"]);
  assert.ok(requests.every(r => !("model" in r.body) && !("messages" in r.body)));
  assert.equal(records.length, 2);
});

test("native search usage belongs to its main agent model call", () => {
  const row = aiUsageFromMetrics({ stage: "valuation-research-t1", model: "deepseek-v4-pro", usage: { input_tokens: 100, output_tokens: 40, server_tool_use: { web_search_requests: 2 } } }, { at: "2026-11-03T00:00:00Z", durationMs: 10, provider: "deepseek", kind: "valuation-research" });
  assert.equal(row.searchCalls, 2);
  assert.equal(row.kind, "valuation-research");
  assert.equal(row.model, "deepseek-v4-pro");
  assert.equal(row.inputTokens, 100);
});
