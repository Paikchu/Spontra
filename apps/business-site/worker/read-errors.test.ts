import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicBusinessFlow } from "../../../shared/analysis-contract/business-flow.ts";
const TICKER = "ACME";
const flow: PublicBusinessFlow = { schemaVersion: "business-flow.v1", ticker: TICKER, fetchedAt: null, quarters: [["2026-01-01", "2026-03-31"], ["2026-04-01", "2026-06-30"]].map(([start, end]) => {
  const amount = (value: number) => ({ value: String(value), basis: "reported" as const, definition: "", comparabilityKey: "same", sourceIds: ["s1"], lineage: [{ accession: "s1", url: "https://www.sec.gov/report", concept: "Revenue", contextId: "c1", periodStart: start!, periodEnd: end!, dimensions: {}, parserVersion: "test" }] });
  return { id: end!, label: end!, periodStart: start!, periodEnd: end!, periodType: "3M" as const, currency: "USD", scale: 1, incomeModel: "standard" as const, basisLabel: "reported", reportedAt: null,
    figures: { revenue: amount(100), cost: amount(40), gross: amount(60), operatingExpenses: amount(20), operating: amount(40), other: amount(0), pretax: amount(40), tax: amount(10), net: amount(30) },
    segmentsComplete: true, segments: [{ id: "total", name: "Total", revenue: amount(100), description: "", products: [], customers: null, monetization: null, disclosure: "", sourceIds: ["s1"] }], sources: [{ id: "s1", title: "10-Q", url: "https://www.sec.gov/report", publishedAt: null }] };
}) };
import { handle, type SiteEnv } from "./index.ts";

const env: SiteEnv = { ASSETS: { fetch: async () => new Response() }, PUBLIC_READ_LIMIT: { limit: async () => ({ success: true }) } };
const url = (route: string) => new Request(`https://example.test/api/business/v1/${route}`);
const refused = (status = 429) => new Response(null, { status, headers: { "retry-after": "120" } });

test("A03: ancillary read failures are explicit and never cache an incomplete ready flow", async () => {
  for (const module of ["business-explainer", "guidance", "business-tree"]) {
    const writes: Promise<unknown>[] = [];
    const cache = { match: async () => undefined, put: async () => { assert.fail("failed company read must not be cached"); } } as unknown as Cache;
    const upstream: typeof fetch = async input => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/business-flow")) return Response.json({ schemaVersion: "complete-business-flow.v1", status: "ready", flow });
      if (path.endsWith(`/${module}`)) return refused();
      return Response.json({ status: "unavailable" });
    };
    const response = await handle(url(`companies/${TICKER}`), env, { waitUntil: p => { writes.push(p); } }, upstream, cache);
    await Promise.all(writes);
    assert.equal(response.status, 429, module);
    assert.equal(response.headers.get("retry-after"), "120");
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  const response = await handle(url(`companies/${TICKER}`), env, { waitUntil() {} }, async input => Response.json(String(input).includes("business-flow") ? { schemaVersion: "complete-business-flow.v1", status: "ready", flow } : { status: "unavailable" }));
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { status: string }).status, "ready");
  assert.equal(response.headers.get("cache-control"), "public, max-age=14400");
});

test("A04: fundamentals and findings index retain upstream errors and retry headers", async () => {
  for (const route of ["findings", "companies/ACME/fundamentals"]) {
    for (const status of [429, 500]) {
      const response = await handle(url(route), env, { waitUntil() { assert.fail("cannot cache a failed read"); } }, async () => refused(status));
      assert.equal(response.status, status === 429 ? 429 : 503, route);
      assert.equal(response.headers.get("cache-control"), "no-store");
      if (status === 429) assert.equal(response.headers.get("retry-after"), "120");
    }
    const response = await handle(url(route), env, { waitUntil() {} }, async () => Response.json({ status: "unavailable" }));
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { status: string }).status, "unavailable");
  }
});
