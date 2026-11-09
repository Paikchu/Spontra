import { test } from "node:test";
import assert from "node:assert/strict";
import { handleReportAdminProxy } from "../worker/report-admin-proxy.ts";

/** Every write the admin UI sends reaches Spontra Analysis; anything else is refused before it leaves the admin Worker. */
test("the admin proxy passes the feature switches through", async () => {
  const seen: string[] = [];
  const env = { SPONTRA_ANALYSIS: { fetch: async (url: URL | string) => { seen.push(new URL(String(url)).pathname); return Response.json({ ok: true }); } } };
  for (const path of ["business-map/features/tree", "business-map/companies/MSFT/features/findings", "business-map/features/valuation", "business-map/companies/MSFT/features/valuation", "business-map/companies/MSFT/presentation", "business-map/companies/MSFT", "business-map/scheduled-analysis"]) {
    const request = new Request(`https://admin.example/api/admin/${path}`, { method: "POST", body: "{}", headers: { origin: "https://admin.example" } });
    assert.equal((await handleReportAdminProxy(request, path.split("/"), env)).status, 200, path);
  }
  assert.deepEqual(seen, ["/admin/business-map/features/tree", "/admin/business-map/companies/MSFT/features/findings", "/admin/business-map/features/valuation", "/admin/business-map/companies/MSFT/features/valuation", "/admin/business-map/companies/MSFT/presentation", "/admin/business-map/companies/MSFT", "/admin/business-map/scheduled-analysis"]);
});

test("the admin proxy refuses routes the admin does not use", async () => {
  const env = { SPONTRA_ANALYSIS: { fetch: async () => Response.json({ ok: true }) } };
  for (const path of ["business-map/companies/MSFT/features/unknown", "business-map/features/unknown", "business-map/pipeline", "pipeline/events"]) {
    const request = new Request(`https://admin.example/api/admin/${path}`, { method: "POST", body: "{}", headers: { origin: "https://admin.example" } });
    assert.equal((await handleReportAdminProxy(request, path.split("/"), env)).status, 404, path);
  }
});

test("the admin proxy passes the business-tag reads and writes through", async () => {
  const env = { SPONTRA_ANALYSIS: { fetch: async () => Response.json({ ok: true }) } };
  const headers = { origin: "https://admin.example" };
  for (const path of ["library/tags", "library/tags/CRWV", "library/tags/BRK.B", "library/tags/sectors/cloud_infrastructure"]) {
    assert.equal((await handleReportAdminProxy(new Request(`https://admin.example/api/admin/${path}`, { headers }), path.split("/"), env)).status, 200, path);
  }
  for (const path of ["library/tags/CRWV/run", "library/tags/CRWV/pair", `library/tags/CRWV/tag/t${"a".repeat(24)}`]) {
    assert.equal((await handleReportAdminProxy(new Request(`https://admin.example/api/admin/${path}`, { method: "POST", body: "{}", headers }), path.split("/"), env)).status, 200, path);
  }
  for (const path of ["library/tags/CRWV/delete", "library/tags/sectors/Cloud"]) {
    assert.equal((await handleReportAdminProxy(new Request(`https://admin.example/api/admin/${path}`, { method: "POST", body: "{}", headers }), path.split("/"), env)).status, 404, path);
  }
});

test("the admin proxy passes the inbox read and its mark-read through", async () => {
  const seen: string[] = [];
  const env = { SPONTRA_ANALYSIS: { fetch: async (url: URL | string) => { seen.push(new URL(String(url)).pathname); return Response.json({ ok: true }); } } };
  const headers = { origin: "https://admin.example" };
  assert.equal((await handleReportAdminProxy(new Request("https://admin.example/api/admin/business-map/messages", { headers }), ["business-map", "messages"], env)).status, 200);
  assert.equal((await handleReportAdminProxy(new Request("https://admin.example/api/admin/business-map/messages/read", { method: "POST", body: "{}", headers }), ["business-map", "messages", "read"], env)).status, 200);
  assert.deepEqual(seen, ["/admin/business-map/messages", "/admin/business-map/messages/read"]);
});

test("the admin proxy passes the ticker field's issuer search through with its query", async () => {
  const seen: string[] = [];
  const env = { SPONTRA_ANALYSIS: { fetch: async (url: URL | string) => { const u = new URL(String(url)); seen.push(u.pathname + u.search); return Response.json({ issuers: [] }); } } };
  assert.equal((await handleReportAdminProxy(new Request("https://admin.example/api/admin/business-map/issuers?q=berkshire"), ["business-map", "issuers"], env)).status, 200);
  assert.equal((await handleReportAdminProxy(new Request("https://admin.example/api/admin/business-map/issuers/AAPL"), ["business-map", "issuers", "AAPL"], env)).status, 404);
  assert.deepEqual(seen, ["/admin/business-map/issuers?q=berkshire"]);
});

test("the admin proxy needs no credential and has no session route", async () => {
  const seen: Headers[] = [];
  const env = { SPONTRA_ANALYSIS: { fetch: async (_url: URL | string, init?: RequestInit) => { seen.push(new Headers(init?.headers)); return Response.json({ ok: true }); } } };
  assert.equal((await handleReportAdminProxy(new Request("https://admin.example/api/admin/business-map/companies"), ["business-map", "companies"], env)).status, 200);
  assert.equal(seen[0]!.get("authorization"), null);
  assert.equal((await handleReportAdminProxy(new Request("https://admin.example/api/admin/session", { method: "POST", body: "{}", headers: { origin: "https://admin.example" } }), ["session"], env)).status, 404);
});

test("the admin proxy lets one company's flow graph through, and nothing beside it", async () => {
  const seen: string[] = [];
  const env = { SPONTRA_ANALYSIS: { fetch: async (url: URL | string) => { seen.push(new URL(url).pathname); return Response.json({ ok: true }); } } };
  assert.equal((await handleReportAdminProxy(new Request("https://admin.example/api/admin/business-map/companies/TTMI/flow"), ["business-map", "companies", "TTMI", "flow"], env)).status, 200);
  assert.equal((await handleReportAdminProxy(new Request("https://admin.example/api/admin/business-map/companies/TTMI/flow", { method: "POST", body: "{}", headers: { origin: "https://admin.example" } }), ["business-map", "companies", "TTMI", "flow"], env)).status, 404);
  assert.deepEqual(seen, ["/admin/business-map/companies/TTMI/flow"]);
});

test("company token usage is a read-only company route", async () => {
  const seen: string[] = [];
  const env = { SPONTRA_ANALYSIS: { fetch: async (url: URL | string) => { seen.push(new URL(url).pathname); return Response.json({ ok: true }); } } };
  const path = ["business-map", "companies", "TEST", "usage"], url = "https://admin.example/api/admin/business-map/companies/TEST/usage";
  assert.equal((await handleReportAdminProxy(new Request(url), path, env)).status, 200);
  assert.equal((await handleReportAdminProxy(new Request(url, { method: "POST", body: "{}", headers: { origin: "https://admin.example" } }), path, env)).status, 404);
  assert.deepEqual(seen, ["/admin/business-map/companies/TEST/usage"]);
});

test("the admin proxy lets the valuation runs, versions and a manual run through, but not guidance", async () => {
  const seen: string[] = [];
  const env = { SPONTRA_ANALYSIS: { fetch: async (url: URL | string, init?: RequestInit) => { seen.push(`${init?.method ?? "GET"} ${new URL(String(url)).pathname}`); return Response.json({ ok: true }); } } };
  const headers = { origin: "https://admin.example" };
  for (const path of ["ai/companies/MSFT/valuation", "ai/companies/MSFT/valuation/versions/2026-11-01T12:00:00.000Z"]) {
    assert.equal((await handleReportAdminProxy(new Request(`https://admin.example/api/admin/${path}`), path.split("/"), env)).status, 200, path);
  }
  const run = "ai/companies/MSFT/valuation/runs";
  assert.equal((await handleReportAdminProxy(new Request(`https://admin.example/api/admin/${run}`, { method: "POST", body: "{}", headers }), run.split("/"), env)).status, 200, run);
  for (const path of ["ai/companies/MSFT/guidance", "ai/companies/MSFT/guidance/runs"]) {
    assert.equal((await handleReportAdminProxy(new Request(`https://admin.example/api/admin/${path}`, { method: "POST", body: "{}", headers }), path.split("/"), env)).status, 404, path);
    assert.equal((await handleReportAdminProxy(new Request(`https://admin.example/api/admin/${path}`), path.split("/"), env)).status, 404, path);
  }
  assert.deepEqual(seen, ["GET /admin/ai/companies/MSFT/valuation", "GET /admin/ai/companies/MSFT/valuation/versions/2026-11-01T12%3A00%3A00.000Z", "POST /admin/ai/companies/MSFT/valuation/runs"]);
});

test("the admin proxy reads and saves a company's valuation inputs, with room for cited targets but no more", async () => {
  const seen: string[] = [];
  const env = { SPONTRA_ANALYSIS: { fetch: async (url: URL | string, init?: RequestInit) => { seen.push(`${init?.method ?? "GET"} ${new URL(String(url)).pathname}`); return Response.json({ ok: true }); } } };
  const headers = { origin: "https://admin.example" };
  const path = ["business-map", "companies", "ACME", "valuation-inputs"];
  const url = "https://admin.example/api/admin/business-map/companies/ACME/valuation-inputs";
  assert.equal((await handleReportAdminProxy(new Request(url), path, env)).status, 200);
  assert.equal((await handleReportAdminProxy(new Request(url, { method: "POST", body: JSON.stringify({ peers: null, targets: { notes: "x".repeat(20_000) } }), headers }), path, env)).status, 200);
  assert.equal((await handleReportAdminProxy(new Request(url, { method: "POST", body: "x".repeat(70_000), headers }), path, env)).status, 413);
  assert.equal((await handleReportAdminProxy(new Request("https://admin.example/api/admin/business-map/messages/read", { method: "POST", body: "x".repeat(20_000), headers }), ["business-map", "messages", "read"], env)).status, 413);
  assert.equal((await handleReportAdminProxy(new Request(url, { method: "POST", body: "{}" }), path, env)).status, 403);
  assert.deepEqual(seen, ["GET /admin/business-map/companies/ACME/valuation-inputs", "POST /admin/business-map/companies/ACME/valuation-inputs"]);
});

test("the admin proxy passes a company's filing list and a filing's report regeneration through, and nothing else under reports", async () => {
  const seen: string[] = [];
  const env = { SPONTRA_ANALYSIS: { fetch: async (url: URL | string) => { const u = new URL(String(url)); seen.push(u.pathname + u.search); return Response.json({ ok: true }); } } };
  const headers = { origin: "https://admin.example" };
  assert.equal((await handleReportAdminProxy(new Request("https://admin.example/api/admin/reports?ticker=NET", { headers }), ["reports"], env)).status, 200);
  const regenerate = ["reports", "NET", "0001477333-26-000061", "regenerate"];
  assert.equal((await handleReportAdminProxy(new Request(`https://admin.example/api/admin/${regenerate.join("/")}`, { method: "POST", body: "{}", headers }), regenerate, env)).status, 200);
  for (const path of [["reports", "NET", "0001477333-26-000061", "review"], ["reports", "NET", "x", "regenerate"]]) {
    assert.equal((await handleReportAdminProxy(new Request(`https://admin.example/api/admin/${path.join("/")}`, { method: "POST", body: "{}", headers }), path, env)).status, 404, path.join("/"));
  }
  assert.deepEqual(seen, ["/admin/reports?ticker=NET", "/admin/reports/NET/0001477333-26-000061/regenerate"]);
});
