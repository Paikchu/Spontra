import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAnalyticsProxy } from "../worker/analytics-proxy.ts";

test("the analytics proxy reads the business site aggregate and drops the caller's address", async () => {
  const seen: Array<{ url: string; headers: Headers }> = [];
  const env = {
    SPONTRA_ANALYSIS: { fetch: async () => { throw new Error("analysis must stay unread"); } },
    BUSINESS_SITE: { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push({ url: request.url, headers: request.headers });
      return Response.json({ schemaVersion: "telemetry-summary.v1", sessions: 1 });
    } },
  };
  const response = await handleAnalyticsProxy(new Request("https://admin.example/api/admin/analytics?range=24h", {
    headers: { cookie: "session=1", "cf-connecting-ip": "203.0.113.8" },
  }), env);
  assert.equal(response.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, "https://business-map.internal/api/business/v1/telemetry?range=24h");
  assert.equal(seen[0]!.headers.get("cookie"), null);
  assert.equal(seen[0]!.headers.get("cf-connecting-ip"), null);
});

test("the analytics proxy refuses a bad range, a write, and a missing binding", async () => {
  const env = { BUSINESS_SITE: { fetch: async () => Response.json({ ok: true }) } };
  assert.equal((await handleAnalyticsProxy(new Request("https://admin.example/api/admin/analytics?range=year"), env)).status, 400);
  assert.equal((await handleAnalyticsProxy(new Request("https://admin.example/api/admin/analytics", { method: "POST" }), env)).status, 405);
  assert.equal((await handleAnalyticsProxy(new Request("https://admin.example/api/admin/analytics"), {})).status, 503);
  const body = await (await handleAnalyticsProxy(new Request("https://admin.example/api/admin/analytics"), {})).json() as { error: string };
  assert.equal(body.error, "统计服务未连接");
});
