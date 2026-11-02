import { test } from "node:test";
import assert from "node:assert/strict";
import { handle, type SiteEnv } from "../worker/index.ts";

const env: SiteEnv = { ASSETS: { fetch: async () => new Response() }, PUBLIC_READ_LIMIT: { limit: async () => ({ success: true }) } };
const base = "https://example.test/api/business/v1/companies/ACME";
const itemId = "0000000001-26-000001";
const routes = [
  { path: "/insiders", schemaVersion: "insiders-response.v1", name: "insiders", body: { schemaVersion: "insiders.v1", ticker: "ACME", source: "ledger", newDays: 7, asOf: "2026-11-01", persons: [] } },
  { path: "/insiders/123/transactions", schemaVersion: "insider-transactions-response.v1", name: "transactions", body: { schemaVersion: "insider-transactions.v1", ticker: "ACME", personKey: "123", source: "ledger", items: [], nextCursor: null } },
  { path: `/items/${itemId}`, schemaVersion: "item-analysis-response.v1", name: "analysis", body: { schemaVersion: "item-analysis.v1", ticker: "ACME", itemId, finding: { lens: { type: "document" } } } },
];

for (const route of routes) {
  test(`${route.path} uses a private 30-second lifetime and bypasses edge cache reads and writes`, async () => {
    let matches = 0, puts = 0, reads = 0;
    const pending: Promise<unknown>[] = [];
    const cache = {
      match: async () => { matches++; return Response.json({ stale: true }); },
      put: async () => { puts++; },
    } as unknown as Cache;
    const upstream: typeof fetch = async () => {
      reads++;
      return Response.json({ schemaVersion: route.schemaVersion, status: "ready", [route.name]: route.body });
    };
    for (let i = 0; i < 2; i++) {
      const response = await handle(new Request(base + route.path), env, { waitUntil: p => { pending.push(p); } }, upstream, cache);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "private, max-age=30");
      const body = await response.json() as Record<string, unknown>;
      assert.equal(body.status, "ready");
      assert.deepEqual(body[route.name], route.body);
    }
    await Promise.all(pending);
    assert.equal(reads, 2);
    assert.equal(matches, 0);
    assert.equal(puts, 0);
  });
}

test("a revisioned events route still reads and writes the edge cache with a public four-hour lifetime", async () => {
  const stored = new Map<string, Response>();
  const pending: Promise<unknown>[] = [];
  let matches = 0, puts = 0, reads = 0;
  const cache = {
    match: async (key: Request) => { matches++; return stored.get(key.url)?.clone(); },
    put: async (key: Request, response: Response) => { puts++; stored.set(key.url, response); },
  } as Cache;
  const upstream: typeof fetch = async () => {
    reads++;
    return Response.json({ schemaVersion: "events-response.v1", status: "ready", events: { schemaVersion: "events.v1", ticker: "ACME", checkedAt: "2026-11-01", events: [], pendingInsider: 0 } });
  };
  const url = base + "/events?rev=2026-11-01T00%3A00%3A00Z";
  const first = await handle(new Request(url), env, { waitUntil: p => { pending.push(p); } }, upstream, cache);
  await Promise.all(pending);
  const second = await handle(new Request(url), env, { waitUntil: p => { pending.push(p); } }, upstream, cache);
  for (const response of [first, second]) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "public, max-age=14400");
  }
  assert.deepEqual(await second.json(), await first.json());
  assert.deepEqual([...stored.keys()], [url]);
  assert.equal(matches, 2);
  assert.equal(puts, 1);
  assert.equal(reads, 1);
});

test("the home digest is held at the edge for half a minute and revalidated by the browser with its ETag", async () => {
  const digest = { schemaVersion: "home-digest.v1", status: "ready", generatedAt: "2026-11-02T00:00:00.000Z", coverage: { count: 0, lastUpdatedAt: null }, companies: [], popular: [] };
  const stored = new Map<string, Response>();
  const pending: Promise<unknown>[] = [];
  const cache = {
    match: async (key: Request) => stored.get(key.url)?.clone(),
    put: async (key: Request, response: Response) => { stored.set(key.url, response); },
  } as unknown as Cache;
  let reads = 0;
  const upstream: typeof fetch = async () => { reads++; return Response.json(digest); };
  const home = "https://example.test/api/business/v1/home";
  const first = await handle(new Request(home), env, { waitUntil: p => { pending.push(p); } }, upstream, cache);
  await Promise.all(pending);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-cache");
  const etag = first.headers.get("etag");
  assert.match(etag ?? "", /^W\/"[0-9a-f]{32}"$/);
  assert.equal(stored.get(home)?.headers.get("cache-control"), "public, max-age=30");
  const again = await handle(new Request(home, { headers: { "if-none-match": etag! } }), env, { waitUntil() {} }, upstream, cache);
  assert.equal(again.status, 304);
  assert.equal(again.headers.get("etag"), etag);
  assert.equal(again.headers.get("cache-control"), "no-cache");
  const other = await handle(new Request(home, { headers: { "if-none-match": 'W/"stale"' } }), env, { waitUntil() {} }, upstream, cache);
  assert.equal(other.status, 200);
  assert.equal(other.headers.get("cache-control"), "no-cache");
  assert.deepEqual(await other.json(), digest);
  assert.equal(reads, 1);
});
