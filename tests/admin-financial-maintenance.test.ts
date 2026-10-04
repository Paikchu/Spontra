import assert from "node:assert/strict";
import test from "node:test";
import { handleAdminRequest, type AdminEnv } from "../apps/admin/worker/index.ts";
import { completeRequestId, displayFinancialValue, normalizeCompanyTicker, pendingRequestId, safeEvidenceUrl } from "../apps/admin/src/financial-maintenance-state.ts";

const origin = "https://admin.test";
const assets = { fetch: async () => new Response("shell") };
const token = "report-admin.v1.test-session";

test("financial routes keep existing admin session permission and origin boundary", async () => {
  const calls: Request[] = [];
  const env: AdminEnv = { ASSETS: assets, EARNING_REPORT_PIPELINE: { fetch: async (input, init) => {
    calls.push(new Request(input, init)); return Response.json({ task: { id: "test" } });
  } } };
  const request = (path: string, options?: RequestInit) => new Request(origin + "/api/admin/financials/" + path, options);
  assert.equal((await handleAdminRequest(request("companies"), env)).status, 401);
  assert.equal(calls.length, 0);
  const docId = "a".repeat(64);
  for (const path of ["companies", "companies/ORCL", `companies/ORCL/documents/${docId}?offset=50&limit=50&concept=Revenue`, `companies/ORCL/documents/${docId}/statements`, "tasks/test-task"]) {
    const response = await handleAdminRequest(request(path, { headers: { cookie: `spontra_report_admin=${token}` } }), env);
    assert.equal(response.status, 200);
    assert.equal(calls.at(-1)!.headers.get("authorization"), `Bearer ${token}`);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
  assert.equal(new URL(calls[2].url).searchParams.get("offset"), "50");
  const before = calls.length;
  const body = JSON.stringify({ action: "extract", requestId: "f40c8e29-0f15-4f87-a84d-a62bd6d21a4d" });
  for (const badOrigin of [undefined, "https://other.test"]) {
    assert.equal((await handleAdminRequest(request("companies/ORCL/actions", { method: "POST", body, headers: { cookie: `spontra_report_admin=${token}`, ...(badOrigin ? { origin: badOrigin } : {}) } }), env)).status, 403);
  }
  assert.equal(calls.length, before);
  const response = await handleAdminRequest(request("companies/ORCL/actions", { method: "POST", body, headers: { origin, cookie: `spontra_report_admin=${token}`, "idempotency-key": "stable-request" } }), env);
  assert.equal(response.status, 200);
  assert.equal(calls.at(-1)!.headers.get("idempotency-key"), "stable-request");
  assert.equal(await calls.at(-1)!.text(), body);
  assert.equal((await handleAdminRequest(request("tasks/test-task/cancel", { method: "POST", body: "{}", headers: { origin, cookie: `spontra_report_admin=${token}` } }), env)).status, 200);
});

test("financial proxy rejects unrelated, traversal and mutation-shaped GET paths before backend access", async () => {
  let calls = 0;
  const env: AdminEnv = { ASSETS: assets, EARNING_REPORT_PIPELINE: { fetch: async () => { calls++; return Response.json({}); } } };
  for (const path of ["companies/ORCL/actions", "companies/ORCL/documents/not-a-hash", "companies/ORCL/arbitrary/endpoint", "tasks/test/cancel", "companies/ORCL%2F..%2Fsession"]) {
    assert.equal((await handleAdminRequest(new Request(`${origin}/api/admin/financials/${path}`, { headers: { cookie: `spontra_report_admin=${token}` } }), env)).status, 404);
  }
  assert.equal(calls, 0);
});

test("ambiguous submissions reuse their UUID across refresh; confirmed operations release it", () => {
  const values = new Map<string, string>();
  const store = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const first = "10000000-0000-4000-8000-000000000001";
  const second = "10000000-0000-4000-8000-000000000002";
  const key = "TEST:extract:";
  assert.equal(pendingRequestId(key, store, () => first), first);
  assert.equal(pendingRequestId(key, store, () => second), first);
  assert.deepEqual([...values.values()], [first]);
  completeRequestId(key, store);
  assert.equal(pendingRequestId(key, store, () => second), second);
  completeRequestId(key, store);
});

test("missing facts remain missing, zero remains zero, and decimal precision survives formatting", () => {
  assert.equal(displayFinancialValue(null), "未提取");
  assert.equal(displayFinancialValue("0"), "0");
  assert.equal(displayFinancialValue("12345678901234567890.00100"), "12,345,678,901,234,567,890.00100");
  assert.equal(displayFinancialValue("-1000.10"), "-1,000.10");
  assert.equal(normalizeCompanyTicker(" brk.b "), "BRK.B");
  assert.equal(normalizeCompanyTicker("ORCL/../../session"), "");
  assert.equal(safeEvidenceUrl("javascript:alert(1)"), null);
  assert.equal(safeEvidenceUrl("https://secret@example.test"), null);
  assert.equal(safeEvidenceUrl("https://www.sec.gov/Archives/example.htm"), "https://www.sec.gov/Archives/example.htm");
});
