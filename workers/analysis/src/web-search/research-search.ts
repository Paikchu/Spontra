import { aiUsageFromMetrics, recordAiUsage } from "../ai-runs/usage.ts";
import { type AnalysisEnv } from "../operations.ts";
import { DeepSeekWebProvider } from "./deepseek.ts";
import { DirectPageProvider, type MarkdownConverter } from "./page.ts";
import { WebSearchService } from "./service.ts";
import { D1R2SearchStore } from "./store.ts";

/** Whether the research agents can search: the web tools need only the model key. */
export function researchSearchConfigured(env: Pick<AnalysisEnv, "DB" | "DEEPSEEK_API_KEY">): boolean {
  return !!env.DB && !!env.DEEPSEEK_API_KEY;
}

/** Cached web search for the explainer, tree, guidance, analyst and company-analysis agents; results persist in D1 and R2. */
export function researchSearch(env: AnalysisEnv) {
  if (!env.DB || !env.DEEPSEEK_API_KEY) throw new Error("research_search_not_configured");
  const api = new DeepSeekWebProvider({
    apiKey: env.DEEPSEEK_API_KEY,
    record: call => recordAiUsage(env, aiUsageFromMetrics({ stage: call.stage, model: "search-fetch-api", ...(call.error ? { error: call.error } : {}) },
      { at: new Date(Date.now() - call.durationMs).toISOString(), durationMs: call.durationMs, provider: "deepseek", kind: "web", searchCalls: call.searchCalls })),
  });
  // Direct reads first; the raw Fetch API handles pages the Worker cannot read. Neither path calls a model.
  const markdown = typeof env.AI?.toMarkdown === "function" ? env.AI as MarkdownConverter : undefined;
  const provider = new DirectPageProvider(api, { markdown, record: read => console.log(JSON.stringify({ event: "web-page-read", ...read })) });
  return new WebSearchService(provider, new D1R2SearchStore(env.DB, {
    async get(key) {
      const object = await env.SEC_FILINGS.get(key);
      return object ? { async json<T>() { return JSON.parse(await object.text()) as T; } } : null;
    },
    put: (key, value) => env.SEC_FILINGS.put(key, value),
  }));
}
