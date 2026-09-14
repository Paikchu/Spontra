/** Server-only module. No paid search endpoint is exposed to browsers. */
export * from "./types.ts";
export * from "./store.ts";
export * from "./service.ts";
export * from "./tavily.ts";

import type { D1Like } from "../sec/d1-support.ts";
import { D1R2SearchStore, type SearchBucket } from "./store.ts";
import { WebSearchService } from "./service.ts";
import { TavilyProvider } from "./tavily.ts";
import type { SearchProvider } from "./types.ts";

export function createWebSearch(options: {
  database: D1Like;
  bucket: SearchBucket;
  provider: SearchProvider;
}): WebSearchService {
  return new WebSearchService(options.provider, new D1R2SearchStore(options.database, options.bucket));
}

/** Call from the owning Worker with its existing DB/SEC_FILINGS bindings and a server-side secret. */
export function createTavilyWebSearch(database: D1Database, bucket: R2Bucket, apiKey: string): WebSearchService {
  return createWebSearch({ database, bucket, provider: new TavilyProvider(apiKey) });
}
