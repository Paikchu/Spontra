import assert from "node:assert/strict";
import test from "node:test";
import { authenticateAdmin, createAdminSession } from "../../workers/pipeline/src/admin/auth.ts";
import { getAdminReport, handleReportAdminRequest, listAdminReports } from "../../workers/pipeline/src/admin/reports.ts";
import { handleReportAdminProxy } from "../../apps/admin/worker/report-admin-proxy.ts";
import type { SecCronEnv, SecWorkflowParams } from "../../workers/pipeline/src/core.ts";
import { createAnalysisDatabase } from "./helpers/analysis-backend.ts";
import { FIXTURE_TICKER, VERIFIED_ACCESSION, VERIFIED_PERIOD_ID, VERIFIED_REPORT_VERSION, seedAnalysisFixtures, EVENT_ACCESSION } from "./helpers/analysis-fixtures.ts";
import { createSecPipelineOperations, type SecPipelineEnv } from "../../workers/pipeline/src/operations.ts";

const secret = "test-admin-credential-only-for-tests";
const now = Date.parse("2026-10-02T01:00:00Z");
async function fixture() {
  const database = await createAnalysisDatabase(); await seedAnalysisFixtures(database);
  const workflows: Array<{ id: string; params: SecWorkflowParams }> = [];
  const d1 = { prepare(sql: string) { return { bind(...args: unknown[]) {
    const statement = database.prepare(sql).bind(...args);
    return { first: statement.first.bind(statement), all: statement.all.bind(statement), async run() {
      const result = await statement.run() as { changes: number }; return { success: true, meta: { changes: Number(result.changes) } };
    } };
  } }; } };
  const env: SecCronEnv = { DB: d1 as unknown as D1Database, SEC_REFRESH_KEY: secret, SEC_TRACKED_TICKERS: FIXTURE_TICKER,
    SEC_ANALYSIS_WORKFLOW: { async create(options) { workflows.push(options); return { id: options.id }; } } };
  const token = await createAdminSession(secret, now);
  const request = (path: string, options: RequestInit = {}) => new Request(`https://pipeline.test/admin/${path}`, { ...options,
    headers: { authorization: `Bearer ${token}`, ...options.headers } });
  return { database, env, workflows, request };
}

test("admin authentication fails closed and rejects forged, expired and public read credentials", async () => {
  const token = await createAdminSession(secret, now);
  const request = (value: string) => new Request("https://pipeline.test/admin/reports", { headers: { authorization: `Bearer ${value}` } });
  assert.equal(await authenticateAdmin(request(token), secret, now), true);
  assert.equal(await authenticateAdmin(request(token + "0"), secret, now), false);
  assert.equal(await authenticateAdmin(request(token), "different-key", now), false);
  assert.equal(await authenticateAdmin(request(token), undefined, now), false);
  assert.equal(await authenticateAdmin(request(token), secret, now + 8 * 3600_000), false);
  assert.equal(await authenticateAdmin(request("read-consumer.public-read-secret"), secret, now), false);
  const f = await fixture();
  const anonymous = await handleReportAdminRequest(new Request("https://pipeline.test/admin/reports"), f.env, now);
  assert.equal(anonymous.status, 401); assert.equal(f.workflows.length, 0); f.database.close();
});

test("list queries real schema, filters company names and distinguishes failures from empty data", async () => {
  const f = await fixture();
  const page = await listAdminReports(f.env, new URL("https://pipeline.test/admin/reports"), now);
  assert.equal(page.reports.length, 6);
  assert.equal(page.reports.find(item => item.accessionNumber === VERIFIED_ACCESSION)?.status, "unreviewed");
  assert.equal(page.reports.find(item => item.ticker === "AMZN")?.canRegenerate, false);
  assert.equal(page.reports.filter(item => item.status === "failed").length, 2, "expired queued jobs are failures");
  const filtered = await listAdminReports(f.env, new URL("https://pipeline.test/admin/reports?search=msft&status=unreviewed"), now);
  assert.equal(filtered.reports.length, 3);
  assert.equal((await handleReportAdminRequest(f.request("reports?cursor=bad"), f.env, now)).status, 400);
  f.database.close();
});

test("review is persisted for an exact version and a new publication needs its own review", async () => {
  const f = await fixture(); const path = `reports/${FIXTURE_TICKER}/${VERIFIED_ACCESSION}`;
  const response = await handleReportAdminRequest(f.request(`${path}/review`, { method: "POST", body: JSON.stringify({ version: VERIFIED_REPORT_VERSION }) }), f.env, now);
  assert.equal(response.status, 200);
  assert.ok((await getAdminReport(f.env, FIXTURE_TICKER, VERIFIED_ACCESSION))?.reviewedAt);
  const row = f.database.raw.prepare("SELECT payload FROM sec_published_reports WHERE report_version = ?").get(VERIFIED_REPORT_VERSION) as { payload: string };
  const report = JSON.parse(row.payload); report.reportVersion = "sec-analysis.v2:new-version";
  f.database.raw.prepare("INSERT INTO sec_published_reports (ticker, period_id, report_version, payload, verification_status, generated_at) VALUES (?, ?, ?, ?, 'verified', ?)")
    .run(FIXTURE_TICKER, VERIFIED_PERIOD_ID, report.reportVersion, JSON.stringify(report), "2026-10-02T02:00:00Z");
  const detail = await getAdminReport(f.env, FIXTURE_TICKER, VERIFIED_ACCESSION);
  assert.equal(detail?.reviewedAt, null); assert.equal(detail?.versions.length, 2);
  assert.ok((await getAdminReport(f.env, FIXTURE_TICKER, VERIFIED_ACCESSION, VERIFIED_REPORT_VERSION))?.reviewedAt);
  assert.equal((await handleReportAdminRequest(f.request(`${path}/review`, { method: "POST", body: JSON.stringify({ version: "invented" }) }), f.env, now)).status, 409);
  assert.equal((await listAdminReports(f.env, new URL("https://pipeline.test/admin/reports"), now)).reports.find(item => item.accessionNumber === VERIFIED_ACCESSION)?.status, "unreviewed");
  f.database.close();
});

test("regeneration targets only the selected filing, queues a durable job, and coalesces repeat requests", async () => {
  const f = await fixture(); const path = `reports/${FIXTURE_TICKER}/${VERIFIED_ACCESSION}/regenerate`;
  const id = crypto.randomUUID();
  const send = (key: string) => handleReportAdminRequest(f.request(path, { method: "POST", headers: { "idempotency-key": key } }), f.env, now);
  assert.equal((await send(id)).status, 202);
  assert.deepEqual(f.workflows[0]?.params, { ticker: FIXTURE_TICKER, requestedBy: "manual", accessionNumber: VERIFIED_ACCESSION, regenerateReport: true });
  assert.equal((await send(id)).status, 202); assert.equal((await send(crypto.randomUUID())).status, 409); assert.equal(f.workflows.length, 1);
  assert.equal((await listAdminReports(f.env, new URL("https://pipeline.test/admin/reports?status=processing"), now)).reports[0]?.accessionNumber, VERIFIED_ACCESSION);
  assert.equal((await getAdminReport(f.env, FIXTURE_TICKER, VERIFIED_ACCESSION))?.jobs[0]?.status, "queued");
  assert.equal(f.database.raw.prepare("SELECT count(*) AS count FROM sec_published_reports").get()?.count, 2, "old publications were not removed");
  assert.equal((await handleReportAdminRequest(f.request("reports/AMZN/0000000002-26-000001/regenerate", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() } }), f.env, now)).status, 403);
  f.database.close();
});

test("concurrent regeneration clicks launch a single workflow", async () => {
  const f = await fixture(); const path = `reports/${FIXTURE_TICKER}/${VERIFIED_ACCESSION}/regenerate`;
  const responses = await Promise.all([1, 2].map(() => handleReportAdminRequest(f.request(path, { method: "POST", headers: { "idempotency-key": crypto.randomUUID() } }), f.env, now)));
  assert.deepEqual(responses.map(item => item.status).sort(), [202, 409]); assert.equal(f.workflows.length, 1); f.database.close();
});

test("a rejected Workflow dispatch is reported as a failed job, not successful generation", async () => {
  const f = await fixture(); f.env.SEC_ANALYSIS_WORKFLOW = { async create() { throw new Error("provider detail must not leak"); } };
  const result = await handleReportAdminRequest(f.request(`reports/${FIXTURE_TICKER}/${VERIFIED_ACCESSION}/regenerate`, { method: "POST", headers: { "idempotency-key": crypto.randomUUID() } }), f.env, now);
  assert.equal(result.status, 503); assert.doesNotMatch(await result.text(), /provider detail/);
  assert.equal((await getAdminReport(f.env, FIXTURE_TICKER, VERIFIED_ACCESSION))?.jobs[0]?.errorCode, "workflow_dispatch_failed"); f.database.close();
});

test("proxy login hides the credential and session token, requires same origin and uses an HttpOnly cookie", async () => {
  const f = await fixture();
  const env = { EARNING_REPORT_PIPELINE: { fetch: async (input: RequestInfo | URL, options?: RequestInit) => handleReportAdminRequest(new Request(input, options), f.env, now) } };
  const url = "https://web.test/api/admin/session";
  assert.equal((await handleReportAdminProxy(new Request(url, { method: "POST", headers: { origin: "https://evil.test" }, body: JSON.stringify({ key: secret }) }), ["session"], env)).status, 403);
  const login = await handleReportAdminProxy(new Request(url, { method: "POST", headers: { origin: "https://web.test" }, body: JSON.stringify({ key: secret }) }), ["session"], env);
  assert.equal(login.status, 200); assert.deepEqual(await login.json(), { status: "signed_in" });
  const cookie = login.headers.get("set-cookie")!;
  assert.match(cookie, /HttpOnly; SameSite=Strict; Max-Age=28800; Secure/); assert.doesNotMatch(cookie, new RegExp(secret));
  const result = await handleReportAdminProxy(new Request("https://web.test/api/admin/reports", { headers: { cookie: cookie.split(";")[0]! } }), ["reports"], env);
  assert.equal(result.status, 200); assert.equal(result.headers.get("cache-control"), "private, no-store");
  assert.equal(result.headers.get("access-control-allow-origin"), null);
  const logout = await handleReportAdminProxy(new Request(url, { method: "DELETE", headers: { origin: "https://web.test" } }), ["session"], env);
  assert.match(logout.headers.get("set-cookie")!, /Max-Age=0/); f.database.close();
});

test("login rejects bad keys and respects the distributed login limiter", async () => {
  const f = await fixture(); const request = (key: string) => new Request("https://pipeline.test/admin/session", { method: "POST", headers: { "x-sec-refresh-key": key } });
  assert.equal((await handleReportAdminRequest(request("wrong"), f.env, now)).status, 401);
  assert.equal((await handleReportAdminRequest(request(secret), { ...f.env, REPORT_ADMIN_RATE_LIMIT: { async limit() { return { success: false }; } } }, now)).status, 429);
  f.database.close();
});

test("pagination is bounded and stable across companies and identical filing dates", async () => {
  const f = await fixture();
  for (let index = 0; index < 48; index++) {
    const accession = `0000000088-26-${String(index).padStart(6, "0")}`;
    f.database.raw.prepare(`INSERT INTO sec_filings (filing_id,ticker,accession_number,cik,form,filing_date,report_date,document_url,index_url,parser_version,ingest_status)
      VALUES (?, 'MSFT', ?, '0000000088','10-Q','2026-09-30','2026-06-30','https://sec.test/report','https://sec.test/index','v1','indexed')`).run(accession,accession);
  }
  const first = await listAdminReports(f.env, new URL("https://pipeline.test/admin/reports"), now);
  assert.equal(first.reports.length, 40); assert.ok(first.nextCursor);
  const second = await listAdminReports(f.env, new URL(`https://pipeline.test/admin/reports?cursor=${encodeURIComponent(first.nextCursor!)}`), now);
  assert.equal(second.reports.length, 14); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.reports,...second.reports].map(row => `${row.ticker}:${row.accessionNumber}`)).size, 54);
  f.database.close();
});

test("compact event regeneration preserves old summaries and supports per-version review", async () => {
  const f = await fixture();
  const ops = createSecPipelineOperations({ ...f.env, SEC_FILINGS: { async get() { return null; }, async put() { return {}; } }, SEC_USER_AGENT: "tests@example.com" } as SecPipelineEnv);
  const old = (await getAdminReport(f.env, FIXTURE_TICKER, EVENT_ACCESSION))!.filing.summary!;
  const updated = { ...old, generatedAt: "2026-10-02T01:00:00.000Z", headline: "New event analysis" };
  await ops.publishEvent(updated);
  const detail = await getAdminReport(f.env, FIXTURE_TICKER, EVENT_ACCESSION);
  assert.equal(detail?.versions.length, 2);
  assert.equal((await getAdminReport(f.env, FIXTURE_TICKER, EVENT_ACCESSION, old.generatedAt))?.filing.summary?.headline, old.headline);
  const response = await handleReportAdminRequest(f.request(`reports/${FIXTURE_TICKER}/${EVENT_ACCESSION}/review`, { method: "POST", body: JSON.stringify({ version: old.generatedAt }) }), f.env, now);
  assert.equal(response.status, 200);
  assert.ok((await getAdminReport(f.env, FIXTURE_TICKER, EVENT_ACCESSION, old.generatedAt))?.reviewedAt);
  assert.equal((await getAdminReport(f.env, FIXTURE_TICKER, EVENT_ACCESSION))?.reviewedAt, null);
  f.database.close();
});

test("loading a historical source strips its old report from the next publication identity", async () => {
  const f = await fixture();
  const ops = createSecPipelineOperations({ ...f.env, SEC_FILINGS: { async get() { return null; }, async put() { return {}; } }, SEC_USER_AGENT: "tests@example.com" } as SecPipelineEnv);
  const source = await ops.loadFiling!(FIXTURE_TICKER, VERIFIED_ACCESSION);
  assert.ok(source); assert.equal(source.accessionNumber, VERIFIED_ACCESSION);
  assert.equal("analysis" in source, false); assert.equal("summary" in source, false); f.database.close();
});
