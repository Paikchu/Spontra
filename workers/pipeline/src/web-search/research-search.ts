import type { SecPipelineEnv } from "../operations.ts";
import { createWebSearch, TavilyProvider } from "./index.ts";

/** Cached Tavily search for the explainer, guidance and company-analysis agents; results persist in D1 and R2. */
export function researchSearch(env: SecPipelineEnv) {
  if (!env.DB || !env.TAVILY_API_KEY) throw new Error("research_search_not_configured");
  return createWebSearch({ database: env.DB, provider: new TavilyProvider(env.TAVILY_API_KEY), bucket: {
    async get(key) {
      const object = await env.SEC_FILINGS.get(key);
      return object ? { async json<T>() { return JSON.parse(await object.text()) as T; } } : null;
    },
    put: (key, value) => env.SEC_FILINGS.put(key, value),
  } });
}
