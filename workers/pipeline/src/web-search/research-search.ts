import { modelFor, reasoningFor } from "../ai-config.ts";
import { aiUsageFromMetrics, recordAiUsage } from "../ai-runs/usage.ts";
import type { SecPipelineEnv } from "../operations.ts";
import { ClaudeWebProvider, createWebSearch } from "./index.ts";

/** Whether the research agents can search: Claude's web tools need only the model key. */
export function researchSearchConfigured(env: Pick<SecPipelineEnv, "DB" | "ANTHROPIC_API_KEY">): boolean {
  return !!env.DB && !!env.ANTHROPIC_API_KEY;
}

/** Cached Claude web search for the explainer, tree, guidance, analyst and company-analysis agents; results persist in D1 and R2. */
export function researchSearch(env: SecPipelineEnv) {
  if (!env.DB || !env.ANTHROPIC_API_KEY) throw new Error("research_search_not_configured");
  const provider = new ClaudeWebProvider({
    apiKey: env.ANTHROPIC_API_KEY, workspaceId: env.ANTHROPIC_WORKSPACE_ID, model: modelFor(env, "web"), effort: reasoningFor(env, "web"),
    // Every call, cache misses only, is a row in the cost ledger beside the model calls.
    record: call => recordAiUsage(env, aiUsageFromMetrics({ stage: call.stage, model: call.model, reasoning: call.reasoning, usage: call.usage, ...(call.error ? { error: call.error } : {}) },
      { at: new Date(Date.now() - call.durationMs).toISOString(), durationMs: call.durationMs, provider: "anthropic", kind: "web", searchCalls: call.searchCalls })),
  });
  return createWebSearch({ database: env.DB, provider, bucket: {
    async get(key) {
      const object = await env.SEC_FILINGS.get(key);
      return object ? { async json<T>() { return JSON.parse(await object.text()) as T; } } : null;
    },
    put: (key, value) => env.SEC_FILINGS.put(key, value),
  } });
}
