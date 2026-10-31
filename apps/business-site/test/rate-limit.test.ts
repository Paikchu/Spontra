import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handle, type SiteEnv } from "../worker/index.ts";
const ctx = { waitUntil: (_: Promise<unknown>) => {} };
const upstream: typeof fetch = async () => Response.json({});
const env: SiteEnv = { ASSETS: { fetch: async () => new Response() }, PUBLIC_READ_LIMIT: { limit: async () => ({ success: false }) } };
test("public read budget is 300 per minute, independent of the stage budget", () => {
  const source = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"name": "PUBLIC_READ_LIMIT"[^]*?"limit": 300,\s*"period": 60/);
  assert.match(source, /"name": "AGENT_LIMIT"[^]*?"limit": 30,\s*"period": 60/);
});
test("every public read rejection includes Retry-After and cannot be cached", async () => {
  for (const route of ["home", "findings", "companies/ACME", "companies/ACME/opening", "companies/ACME/events", "companies/ACME/revision"]) {
    const response = await handle(new Request(`https://example.test/api/business/v1/${route}`), env, ctx, upstream);
    assert.equal(response.status, 429, route);
    assert.equal(response.headers.get("retry-after"), "60", route);
    assert.equal(response.headers.get("cache-control"), "no-store", route);
  }
});
test("stage's own limiter and upstream refusals also supply Retry-After", async () => {
  const request = new Request("https://example.test/agents/identity", { method: "POST", headers: { origin: "https://example.test" } });
  const stage = { fetch: async () => new Response(null, { status: 429, headers: { "retry-after": "12" } }) };
  const blocked = await handle(request, { ...env, SPONTRA_STAGE: stage, AGENT_LIMIT: { limit: async () => ({ success: false }) } }, ctx);
  assert.equal(blocked.headers.get("retry-after"), "60");
  const forwarded = await handle(request, { ...env, SPONTRA_STAGE: stage }, ctx);
  assert.equal(forwarded.headers.get("retry-after"), "12");
});
