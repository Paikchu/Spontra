import { test } from "node:test";
import assert from "node:assert/strict";
import { MAP_RESOURCES } from "../../../shared/analysis-contract/revisions.ts";
import { createCompanyOpening } from "../src/company-opening.ts";
import { companyRequest, retryDelay, observeRateLimit } from "../src/company-request.ts";
import { loadOpening } from "../src/live-company.ts";
import { handle, type SiteEnv } from "../worker/index.ts";

const bundle = () => ({ revisions: { company: "2026-10-30T00:00:00Z" }, resources: Object.fromEntries(MAP_RESOURCES.map(resource => [resource, { status: 200, body: { status: "preparing" } }])) });
test("one locale-specific opening request is shared by every module and restarts after cleanup", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const urls: string[] = [];
  globalThis.fetch = async input => { urls.push(String(input)); return Response.json(bundle()); };
  const opening = createCompanyOpening("ACME", "zh-CN");
  assert.equal(urls.length, 0);
  const run = opening.start();
  assert.equal(opening.start(), run);
  for (const resource of MAP_RESOURCES) assert.equal((await run.response(resource)).status, 200);
  assert.deepEqual(urls, ["/api/business/v1/companies/ACME/opening?lang=zh-CN"]);
  assert.deepEqual(await run.revisions, bundle().revisions);
  run.abort(); const next = opening.start(); assert.notEqual(next, run);
  run.abort(); assert.equal(next.signal.aborted, false); next.abort();
});
test("a failed module does not discard successful modules", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const body = bundle();
  body.resources.capital = { status: 503, body: { status: "unavailable" } };
  globalThis.fetch = async () => Response.json(body);
  const run = createCompanyOpening("ACME", "en").start();
  const result = await loadOpening("ACME", run, () => {}, "");
  assert.deepEqual(result.errors, ["capital"]);
  assert.equal(result.failed, false);
  assert.equal(result.data.publication?.status, "preparing");
  run.abort();
});
test("abort rejects all pending module reads", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let finish!: (response: Response) => void;
  globalThis.fetch = async () => new Promise(resolve => { finish = resolve; });
  const run = createCompanyOpening("ACME", "en").start(); run.abort(); finish(Response.json(bundle()));
  await assert.rejects(run.response("company"), { name: "AbortError" });
});
test("429 waits Retry-After and retries exactly once, with an observable notice", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let calls = 0; const states: boolean[] = [];
  const unsubscribe = observeRateLimit(value => states.push(value)); t.after(unsubscribe);
  globalThis.fetch = async () => { calls++; return new Response(null, { status: 429, headers: { "retry-after": "0.02" } }); };
  const start = Date.now();
  assert.equal((await companyRequest("/test", new AbortController().signal)).status, 429);
  assert(Date.now() - start >= 18); assert.equal(calls, 2); assert.deepEqual(states, [false, true, false]);
  assert.equal(retryDelay("2"), 2000);
  assert.equal(retryDelay("Wed, 21 Oct 2026 07:28:00 GMT", Date.parse("2026-10-21T07:27:58Z")), 2000);
  assert.equal(retryDelay(null), 60_000);
});
test("leaving cancels a scheduled retry", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let calls = 0; globalThis.fetch = async () => { calls++; return new Response(null, { status: 429, headers: { "retry-after": "60" } }); };
  const controller = new AbortController(); const request = companyRequest("/test", controller.signal);
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(request, { name: "AbortError" }); assert.equal(calls, 1);
});
const env: SiteEnv = { ASSETS: { fetch: async () => new Response() }, PUBLIC_READ_LIMIT: { limit: async () => ({ success: true }) } };
test("worker bundles modules, preserves a failure, and caches successful reads for four hours", async () => {
  const stored = new Map<string, Response>(); const writes: Promise<unknown>[] = [];
  const cache = { match: async (key: Request) => stored.get(key.url)?.clone(), put: async (key: Request, value: Response) => { stored.set(key.url, value); } } as Cache;
  const upstream: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/revisions")) return Response.json({ schemaVersion: "revisions.v1", revisions: { filings: "2026-10-30T00:00:00Z" } });
    if (path.endsWith("/capital")) return new Response(null, { status: 503 });
    if (path.endsWith("/filings")) return Response.json({ ticker: "ACME", filings: [] });
    if (path.endsWith("/business-flow")) return Response.json({ schemaVersion: "complete-business-flow.v1", status: "preparing", flow: null });
    return Response.json({ status: "preparing" });
  };
  const response = await handle(new Request("https://example.test/api/business/v1/companies/ACME/opening?lang=zh-CN"), env, { waitUntil: p => { writes.push(p); } }, upstream, cache);
  const body = await response.json() as { resources: Record<string, { status: number }> };
  assert.equal(body.resources.capital.status, 503); assert.equal(body.resources.company.status, 200); assert.equal(body.resources.filings.status, 200);
  await Promise.all(writes);
  assert.equal(stored.size, 1);
  const [key, cached] = [...stored][0]; assert(key.includes("lang=zh-CN")); assert(key.includes("rev="));
  assert.equal(cached.headers.get("cache-control"), "public, max-age=14400");
  assert.equal(response.headers.get("cache-control"), "no-store");
});
