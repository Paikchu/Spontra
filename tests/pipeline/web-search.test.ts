import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { SqliteD1Database } from "./helpers/sqlite-d1.ts";
import { D1R2SearchStore, TavilyProvider, WebSearchService, WebSearchError, type SearchProvider } from "../../workers/pipeline/src/web-search/index.ts";
function setup() {
  const db = new SqliteD1Database();
  db.raw.exec(readFileSync(new URL("../../workers/pipeline/migrations/0011_web_search_cache.sql", import.meta.url), "utf8"));
  const objects = new Map<string, string>();
  const store = new D1R2SearchStore(db, {
    async get(key) { const value = objects.get(key); return value ? { async json<T>() { return JSON.parse(value) as T; } } : null; },
    async put(key, value) { objects.set(key, value); },
  });
  let calls = 0;
  const provider: SearchProvider = {
    id: "test:v1",
    async search() { calls++; return { kind: "search", results: [{ url: "https://example.com/ir", title: "IR", snippet: "evidence", score: null, publishedAt: null }] }; },
    async fetchContent({ url }) { calls++; return { kind: "content", url, text: "Prepared remarks", format: "markdown", completeness: "unverified" }; },
  };
  return { db, store, provider, calls: () => calls };
}
const policy = { scope: "public:licensed" };
test("shared instances reuse evidence; changed scope, filters, provider or age causes fresh retrieval", async t => {
  const s = setup(); t.after(() => s.db.close());
  let now = 100000;
  const a = new WebSearchService(s.provider, s.store, () => now);
  const b = new WebSearchService(s.provider, s.store, () => now);
  assert.equal((await a.search({ query: "MSFT transcript", includeDomains: ["b.com", "a.com"] }, policy)).cache, "miss");
  assert.equal((await b.search({ query: "MSFT transcript", includeDomains: ["a.com", "b.com", "a.com"] }, policy)).cache, "hit");
  assert.equal(s.calls(), 1);
  await b.search({ query: "MSFT transcript" }, policy);
  await b.search({ query: "MSFT transcript" }, { scope: "tenant:2" });
  await b.search({ query: "MSFT transcript", depth: "advanced" }, policy);
  now += 2000;
  await b.search({ query: "MSFT transcript" }, { ...policy, maxAgeMs: 1000 });
  await new WebSearchService({ ...s.provider, id: "other:v1" }, s.store, () => now).search({ query: "MSFT transcript" }, policy);
  assert.equal(s.calls(), 6);
});
test("concurrent requests report busy and reuse completed result", async t => {
  const s = setup(); t.after(() => s.db.close());
  let finish!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const original = s.provider.search;
  s.provider.search = async r => { entered(); await gate; return original(r); };
  const a = new WebSearchService(s.provider, s.store);
  const first = a.search({ query: "test" }, policy);
  await started;
  await assert.rejects(new WebSearchService(s.provider, s.store).search({ query: "test" }, policy), { code: "busy" });
  finish(); await first;
  assert.equal((await a.search({ query: "test" }, policy)).cache, "hit");
  assert.equal(s.calls(), 1);
});
test("failed refresh preserves old data, expired values are not silently served", async t => {
  const s = setup(); t.after(() => s.db.close());
  let now = 1000;
  const service = new WebSearchService(s.provider, s.store, () => now);
  await service.search({ query: "test" }, policy);
  s.provider.search = async () => { throw new WebSearchError("provider_error", true); };
  await assert.rejects(service.search({ query: "test" }, { ...policy, refresh: true }));
  assert.equal((await service.search({ query: "test" }, policy)).cache, "hit");
  now += 3600001;
  await assert.rejects(service.search({ query: "test" }, policy), { code: "provider_error" });
});
test("expired lease owner cannot publish over its successor", async t => {
  const s = setup(); t.after(() => s.db.close());
  assert.equal(await s.store.claim("key", "old", 0, 10), true);
  assert.equal(await s.store.claim("key", "new", 11, 30), true);
  const value = { data: { kind: "search" as const, results: [] }, fetchedAt: 12, expiresAt: 100 };
  assert.equal(await s.store.publish("key", "new", () => 12, value), true);
  assert.equal(await s.store.publish("key", "old", () => 13, { ...value, fetchedAt: 1 }), false);
  await s.store.release("key", "old");
  assert.equal((await s.store.read("key"))?.fetchedAt, 12);
});
test("empty results have short TTL and extraction never asserts completeness", async t => {
  const s = setup(); t.after(() => s.db.close());
  s.provider.search = async () => ({ kind: "search", results: [] });
  const service = new WebSearchService(s.provider, s.store, () => 1000);
  const empty = await service.search({ query: "new call" }, policy);
  assert.equal(Date.parse(empty.expiresAt) - Date.parse(empty.fetchedAt), 300000);
  const content = await service.fetchContent({ url: "https://example.com/call#qa" }, policy);
  assert.equal(content.data.completeness, "unverified");
  assert.equal((await service.fetchContent({ url: "https://example.com/call" }, policy)).cache, "hit");
});
test("Tavily sends bounded explicit options, validates evidence and sanitizes errors", async () => {
  const provider = new TavilyProvider("test-secret", async (url, init) => {
    assert.equal(url, "https://api.tavily.com/search");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.include_answer, false);
    assert.equal(body.auto_parameters, false);
    return Response.json({ results: [{ title: "IR", url: "https://example.com", content: "source", score: 0.9 }] });
  });
  assert.equal((await provider.search({ query: "test" })).results.length, 1);
  const failure = new TavilyProvider("test-secret", async () => new Response("test-secret", { status: 429 }));
  await assert.rejects(failure.search({ query: "test" }), error => error instanceof WebSearchError && error.retryable && !error.message.includes("test-secret"));
  await assert.rejects(new TavilyProvider("").search({ query: "test" }), { code: "not_configured" });
  await assert.rejects(provider.fetchContent({ url: "https://127.0.0.1/" }), { code: "invalid_request" });
  await assert.rejects(provider.search({ query: "test", startDate: "2026-02-30" }), { code: "invalid_request" });
  await assert.rejects(new TavilyProvider("x", async () => Response.json({ answer: "not evidence" })).search({ query: "test" }), { code: "invalid_response" });
});
test("Tavily extracts original text, rejects missing/empty content and oversized bodies", async () => {
  const url = "https://example.com/call";
  const provider = new TavilyProvider("key", async (endpoint, init) => {
    assert.equal(endpoint, "https://api.tavily.com/extract");
    assert.deepEqual(JSON.parse(String(init?.body)), { urls: [url], extract_depth: "advanced", format: "markdown" });
    return Response.json({ results: [{ url, raw_content: "Operator: Welcome\nQ&A" }] });
  });
  const result = await provider.fetchContent({ url, depth: "advanced" });
  assert.equal(result.text, "Operator: Welcome\nQ&A");
  assert.equal(result.completeness, "unverified");
  await assert.rejects(new TavilyProvider("key", async () => Response.json({ results: [], failed_results: [{ url }] })).fetchContent({ url }), { code: "provider_error" });
  await assert.rejects(new TavilyProvider("key", async () => Response.json({ results: [{ url, raw_content: " " }] })).fetchContent({ url }), { code: "invalid_response" });
  await assert.rejects(new TavilyProvider("key", async () => new Response("x".repeat(4 * 1024 * 1024 + 1))).search({ query: "test" }), { code: "invalid_response" });
});
test("R2 failure does not publish an unavailable pointer; expiry is checked after upload", async t => {
  const s = setup(); t.after(() => s.db.close());
  const broken = new D1R2SearchStore(s.db, { async get() { return null; }, async put() { throw new Error("storage unavailable"); } });
  await broken.claim("key", "owner", 0, 10);
  const value = { data: { kind: "search" as const, results: [] }, fetchedAt: 1, expiresAt: 100 };
  await assert.rejects(broken.publish("key", "owner", () => 1, value));
  assert.equal(await broken.read("key"), null);
  let now = 1;
  const slow = new D1R2SearchStore(s.db, { async get() { return null; }, async put() { now = 11; } });
  assert.equal(await slow.publish("key", "owner", () => now, value), false);
});
test("refresh and zero max-age force retrieval and filters preserve fiscal/time intent", async t => {
  const s = setup(); t.after(() => s.db.close());
  const service = new WebSearchService(s.provider, s.store);
  await service.search({ query: "company transcript" }, policy);
  await service.search({ query: "company transcript" }, { ...policy, refresh: true });
  await service.search({ query: "company transcript" }, { ...policy, maxAgeMs: 0 });
  await service.search({ query: "company transcript", startDate: "2026-01-01" }, policy);
  await service.search({ query: "company transcript", startDate: "2025-01-01" }, policy);
  assert.equal(s.calls(), 5);
});
