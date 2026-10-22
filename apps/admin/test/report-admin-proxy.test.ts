import { test } from "node:test";
import assert from "node:assert/strict";
import { handleReportAdminProxy } from "../worker/report-admin-proxy.ts";

/** Every write the admin UI sends reaches Spontra Analysis; anything else is refused before it leaves the admin Worker. */
test("the admin proxy passes the feature switches through", async () => {
  const seen: string[] = [];
  const env = { SPONTRA_ANALYSIS: { fetch: async (url: URL | string) => { seen.push(new URL(String(url)).pathname); return Response.json({ ok: true }); } } };
  for (const path of ["business-map/features/tree", "business-map/companies/MSFT/features/findings", "business-map/companies/MSFT/presentation", "business-map/companies/MSFT"]) {
    const request = new Request(`https://admin.example/api/admin/${path}`, { method: "POST", body: "{}", headers: { origin: "https://admin.example" } });
    assert.equal((await handleReportAdminProxy(request, path.split("/"), env)).status, 200, path);
  }
  assert.deepEqual(seen, ["/admin/business-map/features/tree", "/admin/business-map/companies/MSFT/features/findings", "/admin/business-map/companies/MSFT/presentation", "/admin/business-map/companies/MSFT"]);
});

test("the admin proxy refuses routes the admin does not use", async () => {
  const env = { SPONTRA_ANALYSIS: { fetch: async () => Response.json({ ok: true }) } };
  for (const path of ["business-map/companies/MSFT/features/unknown", "business-map/pipeline", "pipeline/events"]) {
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

test("the admin proxy needs no credential and has no session route", async () => {
  const seen: Headers[] = [];
  const env = { SPONTRA_ANALYSIS: { fetch: async (_url: URL | string, init?: RequestInit) => { seen.push(new Headers(init?.headers)); return Response.json({ ok: true }); } } };
  assert.equal((await handleReportAdminProxy(new Request("https://admin.example/api/admin/business-map/companies"), ["business-map", "companies"], env)).status, 200);
  assert.equal(seen[0]!.get("authorization"), null);
  assert.equal((await handleReportAdminProxy(new Request("https://admin.example/api/admin/session", { method: "POST", body: "{}", headers: { origin: "https://admin.example" } }), ["session"], env)).status, 404);
});
