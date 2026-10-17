import { test } from "node:test";
import assert from "node:assert/strict";
import { aiUsageFromMetrics, aiUsageKind, recordAiUsage } from "../src/ai-runs/usage.ts";

test("the ledger kind is the feature at the front of the stage name", () => {
  assert.equal(aiUsageKind("findings-write"), "findings");
  assert.equal(aiUsageKind("lens-capex-1"), "lens");
  assert.equal(aiUsageKind("business-tree-2-3"), "tree");
  assert.equal(aiUsageKind("business-tree-review-b1"), "tree");
  assert.equal(aiUsageKind("business-explainer-write-0"), "explainer");
  assert.equal(aiUsageKind("business-react-2"), "business");
  assert.equal(aiUsageKind("guidance-extract"), "guidance");
  assert.equal(aiUsageKind("manager-review:2"), "manager");
  assert.equal(aiUsageKind("synthesis"), "synthesis");
});

test("a row reads the provider usage and the call outcome from the request metrics", () => {
  const call = { at: "2026-10-14T08:00:00.000Z", durationMs: 1234.6, provider: "deepseek", ticker: "MSFT", runId: "run-1" };
  const ok = aiUsageFromMetrics({
    stage: "lens-capex-1", model: "deepseek-flash", reasoning: "medium",
    usage: { prompt_tokens: 1200, completion_tokens: 300, prompt_cache_hit_tokens: 1000, completion_tokens_details: { reasoning_tokens: 120 } },
  }, call);
  assert.deepEqual(ok, {
    at: call.at, ticker: "MSFT", kind: "lens", runId: "run-1", stage: "lens-capex-1", provider: "deepseek", model: "deepseek-flash", reasoning: "medium",
    inputTokens: 1200, cachedTokens: 1000, outputTokens: 300, reasoningTokens: 120, durationMs: 1235, outcome: "ok", searchCalls: 0,
  });
  assert.equal(aiUsageFromMetrics({ stage: "x", usage: { prompt_tokens: 5, prompt_tokens_details: { cached_tokens: 2 } } }, call).cachedTokens, 2);
  const timeout = aiUsageFromMetrics({ stage: "findings-write", model: "m", error: "model-timeout:first-response" }, { ...call, ticker: undefined });
  assert.equal(timeout.outcome, "timeout"); assert.equal(timeout.ticker, null); assert.equal(timeout.inputTokens, 0); assert.equal(timeout.reasoningTokens, null);
  assert.equal(aiUsageFromMetrics({ stage: "findings-write", error: "http:429" }, call).outcome, "error");
  assert.equal(aiUsageFromMetrics({ stage: "node:revenue" }, { ...call, kind: "sec-analysis" }).kind, "sec-analysis");
});

test("recording is a no-op without a database and swallows a failed write", async () => {
  const row = aiUsageFromMetrics({ stage: "findings-write", model: "m" }, { at: "2026-10-14T08:00:00.000Z", durationMs: 1, provider: "deepseek" });
  await recordAiUsage({}, row);
  const bound: unknown[][] = [];
  const failing = { prepare: () => ({ bind: (...values: unknown[]) => { bound.push(values); return { run: () => Promise.reject(new Error("no such table: ai_usage")) }; } }) } as unknown as D1Database;
  await recordAiUsage({ DB: failing }, row);
  assert.equal(bound.length, 1);
  assert.equal(bound[0]!.length, 15);
  assert.equal(bound[0]![4], "findings-write");
});
