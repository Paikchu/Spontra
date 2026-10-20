import { test } from "node:test";
import assert from "node:assert/strict";
import { handleReportAdminProxy } from "../worker/report-admin-proxy.ts";

/** Every write the admin UI sends reaches Spontra Analysis; anything else is refused before it leaves the admin Worker. */
test("the admin proxy passes the feature switches through", async () => {
  const seen: string[] = [];
  const env = { SPONTRA_ANALYSIS: { fetch: async (url: URL | string) => { seen.push(new URL(String(url)).pathname); return Response.json({ ok: true }); } } };
  for (const path of ["business-map/features/tree", "business-map/companies/MSFT/features/findings", "business-map/companies/MSFT/presentation", "business-map/companies/MSFT"]) {
    const request = new Request(`https://admin.example/api/admin/${path}`, { method: "POST", body: "{}", headers: { cookie: "spontra_report_admin=report-admin.v1.1.x", origin: "https://admin.example" } });
    assert.equal((await handleReportAdminProxy(request, path.split("/"), env)).status, 200, path);
  }
  assert.deepEqual(seen, ["/admin/business-map/features/tree", "/admin/business-map/companies/MSFT/features/findings", "/admin/business-map/companies/MSFT/presentation", "/admin/business-map/companies/MSFT"]);
});

test("the admin proxy refuses routes the admin does not use", async () => {
  const env = { SPONTRA_ANALYSIS: { fetch: async () => Response.json({ ok: true }) } };
  for (const path of ["business-map/companies/MSFT/features/unknown", "business-map/pipeline", "pipeline/events"]) {
    const request = new Request(`https://admin.example/api/admin/${path}`, { method: "POST", body: "{}", headers: { cookie: "spontra_report_admin=report-admin.v1.1.x", origin: "https://admin.example" } });
    assert.equal((await handleReportAdminProxy(request, path.split("/"), env)).status, 404, path);
  }
});

test("the admin proxy passes the business-tag reads and writes through", async () => {
  const env = { SPONTRA_ANALYSIS: { fetch: async () => Response.json({ ok: true }) } };
  const headers = { cookie: "spontra_report_admin=report-admin.v1.1.x", origin: "https://admin.example" };
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
