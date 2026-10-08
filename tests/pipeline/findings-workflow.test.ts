import assert from "node:assert/strict";
import test from "node:test";
import { completeOrclFixture } from "../fixtures/complete-orcl-flow.ts";
import { D1SecRepository } from "../../workers/pipeline/src/sec/d1.ts";
import { businessFlowCacheKey } from "../../workers/pipeline/src/sec/business-flow-cache.ts";
import { executeFindingsWorkflow, runFindingsSweep } from "../../workers/pipeline/src/findings/workflow.ts";
import { findingsCacheKey } from "../../workers/pipeline/src/findings/read.ts";
import { FINDINGS_SYSTEM, pairByEvidence, type FindingsModel } from "../../workers/pipeline/src/findings/writer.ts";
import type { LedgerRow } from "../../workers/pipeline/src/findings/ledger.ts";
import { handleAnalysisReadRequest } from "../../workers/pipeline/src/read-api/router.ts";
import type { SecPipelineEnv } from "../../workers/pipeline/src/operations.ts";
import type { FindingsResponse } from "../../shared/analysis-contract/findings.ts";
import { createAnalysisDatabase, readEnv, readRequest } from "./helpers/analysis-backend.ts";

const step = { do: <T>(_name: string, callback: () => Promise<T>) => callback() };
const number = (value: string) => value.match(/-?\d+(?:\.\d+)?/)![0];

/** A model that writes from the ledger: one sound finding, one with a number the ledger does not hold, repaired when asked. */
function model(calls: Array<{ stage: string; system: string; payload: { ledger: LedgerRow[]; sources: Array<{ id: string }>; rejected?: unknown[] } }>): FindingsModel {
  return async (stage, system, payload) => {
    const p = payload as (typeof calls)[number]["payload"];
    calls.push({ stage, system, payload: p });
    const revenue = p.ledger.find(r => "metric" in r.ref && r.ref.metric === "revenue" && r.span === "quarter" && r.qoq)!;
    const sound = {
      id: "revenue-step", kind: "strength", severity: 2, title: "收入环比继续增长",
      judgment: { text: `本季收入 ${number(revenue.value)} 亿美元，环比 ${number(revenue.qoq!)}%。`, sourceIds: [p.sources[0].id] },
      evidence: [{ ref: revenue.ref, periodEnd: revenue.periodEnd, span: "quarter", compare: "qoq" }],
      anchors: { view: "profit", nodeIds: [], metrics: ["revenue"] }, lens: { type: "trend", refs: [revenue.ref], span: "quarter", rate: "qoq" },
      watch: { ref: revenue.ref, condition: "下季收入是否继续环比增长", horizon: "next_quarter", compare: "qoq" },
    };
    const invented = { ...sound, id: "margin-guess", kind: "risk", title: "利润率承压", judgment: { text: "本季营业利润率只有 9%，远低于同行。", sourceIds: [p.sources[0].id] } };
    if (stage === "findings-repair") {
      assert.ok(system.startsWith(FINDINGS_SYSTEM));
      assert.deepEqual(p.rejected?.map(r => (r as { id: string }).id), ["margin-guess", "junk"]);
      return { findings: [{ ...invented, judgment: { text: `利润率的判断留待下季；本季收入 ${number(revenue.value)} 亿美元。`, sourceIds: [p.sources[0].id] } }] };
    }
    return { findings: [sound, invented, { id: "junk" }] };
  };
}

test("the sweep starts one run per unseen report; the run writes from the ledger, repairs what fails, and publishes only what verifies", async () => {
  const db = await createAnalysisDatabase();
  try {
    const repository = new D1SecRepository(db);
    await repository.setCache(businessFlowCacheKey("ORCL"), completeOrclFixture, "2026-10-01");
    const created: Array<{ id: string; params: { ticker: string; fingerprint: string } }> = [];
    const env = { DB: db, SEC_AI_TICKERS: "ORCL,NET", SEC_AI_ENABLED: "true", FINDINGS_ENABLED: "true", SEC_FILINGS: { async get() { return null; }, async put() {} },
      FINDINGS_WORKFLOW: { async create(options: { id: string; params: { ticker: string; fingerprint: string } }) { created.push(options); return {}; } } } as unknown as SecPipelineEnv;
    assert.deepEqual((await runFindingsSweep({ ...env, FINDINGS_ENABLED: "false" }, Date.parse("2026-10-09T00:00:00Z"))).started, [], "off unless enabled");
    const first = await runFindingsSweep(env, Date.parse("2026-10-09T00:00:00Z"));
    assert.deepEqual(first.started, ["ORCL"]);
    assert.match(created[0]!.id, /^findings-ORCL-[0-9a-f]{16}-\d+$/);

    const calls: Parameters<typeof model>[0] = [];
    const outcome = await executeFindingsWorkflow(created[0]!.params, step, env, { model: model(calls) });
    assert.equal(outcome.status, "ready");
    assert.deepEqual(calls.map(c => c.stage), ["findings-write", "findings-repair"]);
    assert.ok(calls[0].payload.ledger.length > 10 && calls[0].payload.ledger.some(r => "nodeId" in r.ref), "the ledger carries statement lines and businesses");
    assert.ok(calls[0].system === FINDINGS_SYSTEM);
    const stored = (await repository.getCache<{ model: string; fingerprint: string; findings: Array<{ id: string }> }>(findingsCacheKey("ORCL")))!.payload;
    assert.equal(stored.fingerprint, created[0]!.params.fingerprint);
    assert.deepEqual(stored.findings.map(f => f.id), ["revenue-step", "margin-guess"]);

    const response = await handleAnalysisReadRequest(readRequest("/api/v1/companies/ORCL/findings"), readEnv(db));
    const body = await response.json() as FindingsResponse;
    assert.equal(body.findings?.model, "deepseek-flash");
    assert.equal(body.findings?.findings.length, 2);

    const second = await runFindingsSweep(env, Date.parse("2026-10-09T00:00:00Z"));
    assert.deepEqual(second.started, [], "the same report is not written twice");
    assert.deepEqual(await executeFindingsWorkflow({ ticker: "ORCL", fingerprint: "stale" }, step, env, { model: model([]) }), { status: "superseded" });
  } finally { db.close(); }
});

test("a strength and a risk resting on the same figure are paired; findings with nothing in common stay apart", () => {
  const base = { severity: 2 as const, title: "t", judgment: { text: "x", sourceIds: ["s"] }, anchors: { view: "profit" as const, nodeIds: [], metrics: [] }, lens: { type: "ladder" as const } };
  const ev = (ref: object) => ({ ref: ref as never, periodEnd: "2026-05-31", span: "quarter" as const });
  const paired = pairByEvidence([
    { ...base, id: "cloud", kind: "strength", evidence: [ev({ nodeId: "cloud" }), ev({ capital: "capex" })] },
    { ...base, id: "margin", kind: "risk", evidence: [ev({ metric: "operating" })] },
    { ...base, id: "capex", kind: "risk", evidence: [ev({ capital: "capex" }), ev({ capital: "freeCashFlow" })] },
  ]);
  assert.deepEqual(paired.map(f => [f.id, f.pairWith ?? null]), [["cloud", "capex"], ["margin", null], ["capex", "cloud"]]);
});

test("a run whose findings all fail verification publishes nothing and leaves the stored set alone", async () => {
  const db = await createAnalysisDatabase();
  try {
    const repository = new D1SecRepository(db);
    await repository.setCache(businessFlowCacheKey("ORCL"), completeOrclFixture, "2026-10-01");
    const env = { DB: db, SEC_AI_TICKERS: "ORCL", SEC_AI_ENABLED: "true", FINDINGS_ENABLED: "true", SEC_FILINGS: { async get() { return null; }, async put() {} },
      FINDINGS_WORKFLOW: { async create() { return {}; } } } as unknown as SecPipelineEnv;
    const created: Array<{ params: { ticker: string; fingerprint: string } }> = [];
    (env.FINDINGS_WORKFLOW as { create(o: { params: { ticker: string; fingerprint: string } }): Promise<unknown> }).create = async o => { created.push(o); return {}; };
    await runFindingsSweep(env);
    const outcome = await executeFindingsWorkflow(created[0]!.params, step, env, { model: async () => ({ findings: [{ id: "x", kind: "risk", severity: 1, title: "凭空的数字", judgment: { text: "收入 999 亿美元。", sourceIds: ["nowhere"] }, evidence: [], anchors: { view: "profit", nodeIds: [], metrics: [] }, lens: { type: "ladder" } }] }) });
    assert.equal(outcome.status, "empty");
    assert.equal((await handleAnalysisReadRequest(readRequest("/api/v1/companies/ORCL/findings"), readEnv(db)).then(r => r.json()) as FindingsResponse).findings?.model, "authored");
  } finally { db.close(); }
});
