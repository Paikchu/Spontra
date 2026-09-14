import { WebSearchError, type CachePolicy, type ContentData, type ContentRequest, type Retrieval,
  type RetrievalData, type SearchData, type SearchProvider, type SearchRequest } from "./types.ts";
import type { SearchStore, StoredResult } from "./store.ts";
import { digest, normalizeContent, normalizeSearch } from "./validation.ts";
const MINUTE = 60_000;
export class WebSearchService {
  private readonly provider: SearchProvider;
  private readonly store: SearchStore;
  private readonly now: () => number;
  constructor(provider: SearchProvider, store: SearchStore, now: () => number = Date.now) {
    this.provider = provider; this.store = store; this.now = now;
  }
  search(request: SearchRequest, policy: CachePolicy): Promise<Retrieval<SearchData>> {
    const normalized = normalizeSearch(request);
    return this.retrieve("search", normalized, policy, () => this.provider.search(normalized));
  }
  fetchContent(request: ContentRequest, policy: CachePolicy): Promise<Retrieval<ContentData>> {
    const normalized = normalizeContent(request);
    return this.retrieve("content", normalized, policy, () => this.provider.fetchContent(normalized));
  }
  private async retrieve<T extends RetrievalData>(kind: T["kind"], request: unknown, policy: CachePolicy,
    fetchData: () => Promise<T>): Promise<Retrieval<T>> {
    if (!policy || typeof policy.scope !== "string" || !policy.scope.trim() || policy.scope.length > 256)
      throw new WebSearchError("invalid_request");
    const maxAge = policy.maxAgeMs ?? (kind === "search" ? 60 * MINUTE : 24 * 60 * MINUTE);
    if (!Number.isFinite(maxAge) || maxAge < 0 || maxAge > 30 * 24 * 60 * MINUTE)
      throw new WebSearchError("invalid_request");
    const key = await digest({ version: 1, provider: this.provider.id, scope: policy.scope, kind, request });
    const wrap = (stored: StoredResult, cache: "hit" | "miss"): Retrieval<T> => ({
      data: stored.data as T, provider: this.provider.id, fetchedAt: new Date(stored.fetchedAt).toISOString(),
      expiresAt: new Date(stored.expiresAt).toISOString(), cacheKey: key, cache,
    });
    const usable = (stored: StoredResult | null): stored is StoredResult => maxAge > 0 && !!stored &&
      stored.data.kind === kind && stored.expiresAt > this.now() && stored.fetchedAt <= this.now() &&
      this.now() - stored.fetchedAt <= maxAge;
    const prior = await this.store.read(key);
    if (!policy.refresh && usable(prior)) return wrap(prior, "hit");
    const owner = crypto.randomUUID();
    if (!await this.store.claim(key, owner, this.now(), this.now() + 2 * MINUTE))
      throw new WebSearchError("busy", true); // Caller retries via its Workflow, no unbounded polling.
    try {
      // Another owner may have completed between our initial read and claim.
      const current = await this.store.read(key);
      if (usable(current) && (!policy.refresh || current.fetchedAt > (prior?.fetchedAt ?? -1)))
        return wrap(current, "hit");
      const data = await fetchData();
      const fetchedAt = this.now();
      // Empty searches expire quickly; extraction failures throw and never overwrite old evidence.
      const ttl = data.kind === "search" && !data.results.length ? Math.min(maxAge, 5 * MINUTE) : maxAge;
      const stored = { data, fetchedAt, expiresAt: fetchedAt + ttl };
      if (!await this.store.publish(key, owner, this.now, stored)) throw new WebSearchError("lease_lost", true);
      return wrap(stored, "miss");
    } finally {
      await this.store.release(key, owner);
    }
  }
}
