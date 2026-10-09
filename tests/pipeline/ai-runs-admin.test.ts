import assert from "node:assert/strict";
import test from "node:test";
import { completeOrclFixture } from "../fixtures/complete-orcl-flow.ts";
import type { AiCompanies, AiCompanyDetail, AiRunStarted, AiVersionDetail } from "../../shared/analysis-contract/ai-runs-admin.ts";
import { createAdminSession } from "../../workers/pipeline/src/admin/auth.ts";
import { handleAiRunsAdminRequest } from "../../workers/pipeline/src/admin/ai-runs.ts";
import { AiRunStore } from "../../workers/pipeline/src/ai-runs/store.ts";
import { trackRun, trackSteps } from "../../workers/pipeline/src/ai-runs/tracking.ts";
import { executeFindingsWorkflow, runFindingsSweep } from "../../workers/pipeline/src/findings/workflow.ts";
import type { FindingsModel } from "../../workers/pipeline/src/findings/writer.ts";
import type { LedgerRow } from "../../workers/pipeline/src/findings/ledger.ts";
import { handleReportAdminProxy } from "../../apps/admin/worker/report-admin-proxy.ts";
import type { SecPipelineEnv } from "../../workers/pipeline/src/operations.ts";
import { businessFlowCacheKey } from "../../workers/pipeline/src/sec/business-flow-cache.ts";
import { D1SecRepository } from "../../workers/pipeline/src/sec/d1.ts";
import { createAnalysisDatabase } from "./helpers/analysis-backend.ts";

const SECRET = "test-admin-secret-with-enough-length";
const number = (value: string) => value.match(/-?\d+(?:\.\d+)?/)![0];
/** Writes one finding from the ledger; `title` varies so two runs publish different content. */
const model = (title: string): FindingsModel => async (_stage, _system, payload) => {
  const p = payload as { ledger: LedgerRow[]; sources: Array<{ id: string }> };
  const revenue = p.ledger.find(r => "metric" in r.ref && r.ref.metric === "revenue" && r.span === "quarter" && r.qoq)!;
  return { findings: [{
    id: "revenue-step", kind: "strength", severity: 2, title,
    judgment: { text: `本季收入 ${number(revenue.value)} 亿美元，环比 ${number(revenue.qoq!)}%。`, sourceIds: [p.sources[0]!.id] },
    evidence: [{ ref: revenue.ref, periodEnd: revenue.periodEnd, span: "quarter", compare: "qoq" }],
    anchors: { view: "profit", nodeIds: [], metrics: ["revenue"] }, lens: { type: "trend", refs: [revenue.ref], span: "quarter", rate: "qoq" },
  }] };
};

type Instance = { status: string; error?: unknown };
async function setup() {
  const db = await createAnalysisDatabase();
  await new D1SecRepository(db).setCache(businessFlowCacheKey("ORCL"), completeOrclFixture, "2026-10-01");
  const created: Array<{ id: string; params: { ticker: string; fingerprint: string } }> = [];
  const instances = new Map<string, Instance>();
  const env = {
    DB: db, SEC_AI_TICKERS: "ORCL", SEC_AI_ENABLED: "true", FINDINGS_ENABLED: "true", DEEPSEEK_API_KEY: "k", REPORT_ADMIN_PASSWORD: SECRET,
    SEC_FILINGS: { async get() { return null; }, async put() {} },
    FINDINGS_WORKFLOW: {
      async create(options: (typeof created)[number]) { if (instances.has(options.id)) throw new Error("instance already exists"); created.push(options); instances.set(options.id, { status: "queued" }); return {}; },
      async get(id: string) { const instance = instances.get(id); if (!instance) throw new Error("not found"); return { async status() { return instance; } }; },
    },
  } as unknown as SecPipelineEnv;
  const token = await createAdminSession(SECRET);
  const call = async <T>(path: string, init: RequestInit = {}, now = Date.now()) => {
    const response = await handleAiRunsAdminRequest(new Request(`https://pipeline.internal${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } }), env, now);
    return { status: response.status, body: await response.json() as T & { error?: string } };
  };
  /** Runs a created instance the way the Workflow class does: tracked steps and outcome. */
  const execute = async (index: number, title: string) => {
    const { id, params } = created[index]!;
    const run = { env, kind: "findings" as const, ticker: "ORCL", runId: id };
    const step = { do: <T>(_name: string, callback: (context?: { attempt: number }) => Promise<T>) => callback({ attempt: 1 }) };
    const result = await trackRun(run, () => executeFindingsWorkflow(params, trackSteps(step, run), env, { model: model(title) }));
    instances.set(id, { status: "complete" });
    return result;
  };
  return { db, env, created, instances, call, execute };
}

test("an operator reruns findings for one company without a new report, sees its steps, and reads every version", async () => {
  const { db, created, call, execute } = await setup();
  try {
    assert.equal((await handleAiRunsAdminRequest(new Request("https://pipeline.internal/admin/ai/companies"), {} as SecPipelineEnv)).status, 401);
    const requestId = crypto.randomUUID();
    const started = await call<AiRunStarted>("/admin/ai/companies/ORCL/findings/runs", { method: "POST", body: JSON.stringify({ requestId }) });
    assert.equal(started.status, 202);
    assert.equal(started.body.reused, false);
    const again = await call<AiRunStarted>("/admin/ai/companies/ORCL/findings/runs", { method: "POST", body: JSON.stringify({ requestId }) });
    assert.deepEqual(again.body, { runId: started.body.runId, reused: true }, "a retried click is the same run");
    const busy = await call("/admin/ai/companies/ORCL/findings/runs", { method: "POST", body: JSON.stringify({ requestId: crypto.randomUUID() }) });
    assert.equal(busy.status, 409, "one run per company and kind at a time");

    assert.equal((await execute(0, "收入环比继续增长")).status, "ready");
    let detail = (await call<AiCompanyDetail>("/admin/ai/companies/ORCL/findings")).body;
    assert.equal(detail.runs[0]!.status, "succeeded");
    assert.equal(detail.runs[0]!.trigger, "manual");
    assert.deepEqual(detail.runs[0]!.log.map(s => s.stage), ["findings-time", "findings-input", "findings-write", "findings-publish"]);
    assert.equal((detail.runs[0]!.result as { findings: number }).findings, 1);

    // The fingerprint is unchanged: the sweep leaves it, yet an operator can still rerun it.
    const sweep = await runFindingsSweep((await setupEnv(db)), Date.now());
    assert.deepEqual(sweep.started, [], "the sweep sees the manual publication as current");
    await call("/admin/ai/companies/ORCL/findings/runs", { method: "POST", body: JSON.stringify({ requestId: crypto.randomUUID() }) });
    assert.equal(created.length, 2);
    assert.equal(created[1]!.params.fingerprint, created[0]!.params.fingerprint);
    await execute(1, "收入环比增长延续");

    detail = (await call<AiCompanyDetail>("/admin/ai/companies/ORCL/findings")).body;
    assert.equal(detail.versions.length, 2);
    assert.equal(detail.versions[0]!.current, true);
    assert.equal(detail.state.current!.id, detail.versions[0]!.id);
    const old = (await call<AiVersionDetail>(`/admin/ai/companies/ORCL/findings/versions/${encodeURIComponent(detail.versions[1]!.id)}`)).body;
    assert.equal((old.publication as { findings: Array<{ title: string }> }).findings[0]!.title, "收入环比继续增长");
    const list = (await call<AiCompanies>("/admin/ai/companies")).body;
    assert.equal(list.companies[0]!.kinds.findings.latestRun!.status, "succeeded");
    assert.equal(list.companies[0]!.kinds.explainer.blocked !== null, true, "the explainer needs a search key and its workflow");
  } finally { db.close(); }
});

async function setupEnv(db: D1Database) {
  return { DB: db, SEC_AI_TICKERS: "ORCL", SEC_AI_ENABLED: "true", FINDINGS_ENABLED: "true", SEC_FILINGS: { async get() { return null; }, async put() {} },
    FINDINGS_WORKFLOW: { async create() { throw new Error("must not start"); } } } as unknown as SecPipelineEnv;
}

test("a run that died without recording its end is settled from the engine, which frees the company for a new run", async () => {
  const { db, call, instances, created } = await setup();
  try {
    const started = await call<AiRunStarted>("/admin/ai/companies/ORCL/findings/runs", { method: "POST", body: JSON.stringify({ requestId: crypto.randomUUID() }) });
    instances.set(started.body.runId, { status: "errored", error: { message: "model timed out" } });
    const later = Date.now() + 5 * 60_000;
    const detail = (await call<AiCompanyDetail>("/admin/ai/companies/ORCL/findings", {}, later)).body;
    assert.equal(detail.runs[0]!.status, "failed");
    assert.equal(detail.runs[0]!.error, "model timed out");
    assert.equal((await call("/admin/ai/companies/ORCL/findings/runs", { method: "POST", body: JSON.stringify({ requestId: crypto.randomUUID() }) }, later)).status, 202);
    assert.equal(created.length, 2);
    assert.equal((await call("/admin/ai/companies/NET/findings")).status, 404, "only AI-enabled companies");
  } finally { db.close(); }
});

test("run records keep the newest twenty and skip repeated steps", async () => {
  const db = await createAnalysisDatabase();
  try {
    const store = new AiRunStore(db);
    for (let i = 0; i < 23; i++) await store.start({ kind: "explainer", ticker: "ORCL", runId: `r${i}`, trigger: "schedule" }, new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString());
    const runs = await store.runs("explainer", "ORCL", 50);
    assert.equal(runs.length, 20);
    assert.equal(runs[0]!.runId, "r22");
    await store.step("explainer", "ORCL", "r22", "explainer-plan", "2026-10-02T00:00:00.000Z");
    await store.step("explainer", "ORCL", "r22", "explainer-plan", "2026-10-02T00:00:01.000Z");
    await store.step("explainer", "ORCL", "r22", "explainer-plan", "2026-10-02T00:00:02.000Z", 2);
    assert.deepEqual((await store.get("explainer", "ORCL", "r22"))!.log.map(s => s.attempt ?? 1), [1, 2]);
  } finally { db.close(); }
});

test("the admin proxy forwards only the AI routes it knows", async () => {
  const seen: string[] = [];
  const env = { EARNING_REPORT_PIPELINE: { async fetch(input: RequestInfo | URL) { seen.push(String(input)); return Response.json({ ok: true }); } } };
  const request = (path: string, method = "GET") => new Request(`https://admin.example/api/admin/${path}`, { method, headers: { cookie: "spontra_report_admin=t", origin: "https://admin.example" }, body: method === "POST" ? "{}" : undefined });
  const send = (path: string, method?: string) => handleReportAdminProxy(request(path, method), path.split("/").map(decodeURIComponent), env);
  assert.equal((await send("ai/companies")).status, 200);
  assert.equal((await send("ai/companies/ORCL/guidance")).status, 200);
  assert.equal((await send(`ai/companies/ORCL/findings/versions/${encodeURIComponent("2026-10-09T01:02:03.456Z")}`)).status, 200);
  assert.equal((await send("ai/companies/ORCL/explainer/runs", "POST")).status, 200);
  assert.equal((await send("ai/companies/ORCL/findings/runs")).status, 404, "starting a run is a POST");
  assert.equal((await send("ai/companies/ORCL/report")).status, 404);
  assert.ok(seen.at(-2)!.includes("/admin/ai/companies/ORCL/findings/versions/2026-10-09T01%3A02%3A03.456Z"));
});
