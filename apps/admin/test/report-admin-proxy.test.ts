import { test } from "node:test";
import assert from "node:assert/strict";
import { handleReportAdminProxy } from "../worker/report-admin-proxy.ts";

/** Every write the admin UI sends reaches the pipeline; anything else is refused before it leaves the admin Worker. */
test("the admin proxy passes the mind map switches through", async () => {
  const seen: string[] = [];
  const env = { EARNING_REPORT_PIPELINE: { fetch: async (url: URL | string) => { seen.push(new URL(String(url)).pathname); return Response.json({ ok: true }); } } };
  for (const path of ["business-map/tree", "business-map/companies/MSFT/tree"]) {
    const request = new Request(`https://admin.example/api/admin/${path}`, { method: "POST", body: "{}", headers: { cookie: "spontra_report_admin=report-admin.v1.1.x", origin: "https://admin.example" } });
    assert.equal((await handleReportAdminProxy(request, path.split("/"), env)).status, 200, path);
  }
  assert.deepEqual(seen, ["/admin/business-map/tree", "/admin/business-map/companies/MSFT/tree"]);
});

test("the admin proxy refuses routes the admin does not use", async () => {
  const env = { EARNING_REPORT_PIPELINE: { fetch: async () => Response.json({ ok: true }) } };
  for (const path of ["business-map/companies/MSFT/tree/extra", "business-map/pipeline", "pipeline/events"]) {
    const request = new Request(`https://admin.example/api/admin/${path}`, { method: "POST", body: "{}", headers: { cookie: "spontra_report_admin=report-admin.v1.1.x", origin: "https://admin.example" } });
    assert.equal((await handleReportAdminProxy(request, path.split("/"), env)).status, 404, path);
  }
});
