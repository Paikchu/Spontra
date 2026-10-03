import assert from "node:assert/strict";
import test from "node:test";
import { handleAdminRequest, type AdminEnv } from "../apps/admin/worker/index.ts";
import { GET, POST } from "../app/api/admin/[...path]/route.ts";

const origin = "https://admin.example.com";
const assets = { fetch: async () => new Response("<html>admin</html>", { headers: { "content-type": "text/html" } }) };

test("admin shell and deep links carry private dashboard headers", async () => {
  for (const path of ["/", "/admin/reports"]) {
    const response = await handleAdminRequest(new Request(origin + path), { ASSETS: assets });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "<html>admin</html>");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
  }
});

test("admin API never falls through to the SPA or proxies unrelated APIs", async () => {
  let assetCalls = 0;
  const env: AdminEnv = { ASSETS: { fetch: async () => { assetCalls++; return new Response("shell"); } } };
  for (const path of ["/api/ledger", "/api/admin/unknown", "/api/admin/%ZZ"]) {
    assert.equal((await handleAdminRequest(new Request(origin + path), env)).status, 404);
  }
  assert.equal((await handleAdminRequest(new Request(origin + "/api/admin/reports", { method: "PUT" }), env)).status, 405);
  assert.equal(assetCalls, 0);
});

test("login uses the HTTP binding, hides credentials and rejects cross-origin writes", async () => {
  let calls = 0;
  const env: AdminEnv = { ASSETS: assets, EARNING_REPORT_PIPELINE: { fetch: async (input, init) => {
    calls++;
    const request = new Request(input, init);
    assert.equal(new URL(request.url).pathname, "/admin/session");
    assert.equal(request.headers.get("x-sec-refresh-key"), "test-secret");
    return Response.json({ token: "report-admin.v1.123.abc.def" });
  } } };
  const login = (requestOrigin: string) => new Request(origin + "/api/admin/session", {
    method: "POST", headers: { origin: requestOrigin }, body: JSON.stringify({ key: "test-secret" }),
  });
  assert.equal((await handleAdminRequest(login("https://other.example.com"), env)).status, 403);
  assert.equal(calls, 0);
  const response = await handleAdminRequest(login(origin), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "signed_in" });
  assert.match(response.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict;.*Secure/);
  assert.equal(calls, 1);
  assert.equal((await handleAdminRequest(login(origin), { ASSETS: assets })).status, 503);
});

test("old main API is retired rather than redirecting authenticated writes", async () => {
  for (const handler of [GET, POST]) {
    const response = handler();
    assert.equal(response.status, 410);
    assert.equal(response.headers.get("location"), null);
    assert.match(response.headers.get("set-cookie")!, /Max-Age=0/);
  }
});
