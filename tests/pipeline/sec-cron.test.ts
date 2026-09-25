import assert from "node:assert/strict";
import test from "node:test";

import {
  handleCompanyAnalysisRequest,
  handleSecAnalysisRequest,
  runCompanyAnalysisSweep,
  runSecRefresh,
  type SecCronEnv,
  type SecWorkflowBinding,
} from "../../workers/pipeline/src/core.ts";

/** A fake D1 whose only job here is to answer `listBackfillCandidates`'s query. */
function companyAnalysisDb(candidates: Array<Record<string, unknown>>) {
  return {
    prepare() {
      return {
        bind() {
          return { async all() { return { results: candidates }; } };
        },
      };
    },
  } as unknown as D1Database;
}

const env: SecCronEnv = {
  SEC_TRACKED_TICKERS: "MSFT,NOK",
  SEC_REFRESH_KEY: "refresh-key",
  SEC_ANALYSIS_WORKFLOW: workflowBinding(),
};

function workflowBinding(started: string[] = []): SecWorkflowBinding {
  return {
    async create(options) {
      started.push(options.params.ticker);
      return { id: options.id };
    },
  };
}

test("reads its own whitelist and starts one independent workflow per ticker", async () => {
  const started: string[] = [];
  const result = await runSecRefresh({ ...env, SEC_ANALYSIS_WORKFLOW: workflowBinding(started) }, 1_786_000_000_000);

  assert.deepEqual(result, { started: ["MSFT", "NOK"], failed: [] });
  assert.deepEqual(started, ["MSFT", "NOK"]);
});

test("scheduled sweeps coalesce active analyses instead of filling the queue", async () => {
  const started: string[] = [];
  const DB = { prepare(sql: string) {
    assert.match(sql, /sec_analysis_jobs.*status IN \('running', 'queued'\)/);
    return { bind(ticker: string) { return { first: async () => ticker === "MSFT" ? { job_id: "active" } : null }; } };
  } } as unknown as D1Database;
  const result = await runSecRefresh({ ...env, DB, SEC_ANALYSIS_WORKFLOW: workflowBinding(started) });
  assert.deepEqual(result, { started: ["NOK"], failed: [], skipped: ["MSFT"] });
  assert.deepEqual(started, ["NOK"]);
  assert.deepEqual(await runSecRefresh({ ...env, DB, SEC_TRACKED_TICKERS: "MSFT" }), { started: [], failed: [], skipped: ["MSFT"] });
});

test("starts one idempotent company analysis workflow for each backfill candidate", async () => {
  const started: Array<{ id: string; ticker: string; triggerRef: string }> = [];
  const result = await runCompanyAnalysisSweep({
    ...env,
    DB: companyAnalysisDb([{
      ticker: "MSFT",
      memoryJobId: "memory-job-1",
      memoryVersion: 4,
      periodId: "MSFT:2026-06-30:quarter",
      reportDate: "2026-06-30",
      triggerRef: "memory-job-1:4",
    }]),
    COMPANY_ANALYSIS_WORKFLOW: {
      async create(options) {
        started.push({ id: options.id, ticker: options.params.ticker, triggerRef: options.params.triggerRef });
        return { id: options.id };
      },
    },
  });

  assert.deepEqual(result, { candidates: 1, started: ["MSFT"], failed: [] });
  assert.equal(started[0]?.ticker, "MSFT");
  assert.equal(started[0]?.triggerRef, "memory-job-1:4");
  assert.match(started[0]?.id ?? "", /^company-/);
});

test("paces historical business-report upgrades to two companies per Cron tick", async () => {
  const started: string[] = [];
  const tickers = ["MSFT", "NOK", "AMZN"];
  const candidates = tickers.map((ticker) => ({
    ticker, memoryJobId: `memory-${ticker}`, memoryVersion: 1,
    periodId: `${ticker}:2026-06-30:quarter`, reportDate: "2026-06-30",
    triggerRef: `memory-${ticker}:1`,
  }));
  const result = await runCompanyAnalysisSweep({
    ...env, SEC_TRACKED_TICKERS: tickers.join(","), DB: companyAnalysisDb(candidates),
    COMPANY_ANALYSIS_WORKFLOW: workflowBinding(started),
  });
  assert.deepEqual(result.started, ["MSFT", "NOK"]);
  assert.equal(result.candidates, 2);
});

test("repeated force backfills share the recovery id until that attempt actually ends", async () => {
  const ids: string[] = [];
  const triggerRefs: string[] = [];
  const analysisIds: Array<string | undefined> = [];
  const sweepEnv = {
    ...env,
    DB: companyAnalysisDb([{
      ticker: "MSFT",
      analysisId: "company:MSFT:existing",
      memoryJobId: "memory-job-1",
      memoryVersion: 4,
      periodId: "MSFT:2026-06-30:quarter",
      reportDate: "2026-06-30",
      triggerRef: "memory-job-1:4",
    }]),
    COMPANY_ANALYSIS_WORKFLOW: {
      async create(options) {
        ids.push(options.id);
        triggerRefs.push(options.params.triggerRef);
        analysisIds.push(options.params.analysisId);
        return { id: options.id };
      },
    },
  } as SecCronEnv;

  await runCompanyAnalysisSweep(sweepEnv, { forceIncomplete: true });
  await runCompanyAnalysisSweep(sweepEnv, { forceIncomplete: true });

  assert.equal(new Set(ids).size, 1);
  assert.deepEqual(triggerRefs, ["memory-job-1:4", "memory-job-1:4"]);
  assert.deepEqual(analysisIds, ["company:MSFT:existing", "company:MSFT:existing"]);
});

test("continues starting remaining workflows after one failure", async () => {
  const started: string[] = [];
  const binding: SecWorkflowBinding = {
    async create(options) {
      if (options.params.ticker === "MSFT") throw new Error("workflow unavailable");
      started.push(options.params.ticker);
      return { id: options.id };
    },
  };
  assert.deepEqual(await runSecRefresh({ ...env, SEC_ANALYSIS_WORKFLOW: binding }, 1_786_000_000_000), { started: ["NOK"], failed: ["MSFT"] });
  assert.deepEqual(started, ["NOK"]);
});

test("accepts authenticated manual jobs without running analysis in the request", async () => {
  const started: string[] = [];
  const response = await handleSecAnalysisRequest(
    new Request("https://worker.example/jobs/MSFT", { method: "POST", headers: { "x-sec-refresh-key": "refresh-key" } }),
    { ...env, SEC_ANALYSIS_WORKFLOW: workflowBinding(started) },
    1_786_000_000_000,
  );

  assert.equal(response.status, 202);
  assert.deepEqual(started, ["MSFT"]);
  assert.equal((await response.json() as { status: string }).status, "queued");
  assert.equal((await handleSecAnalysisRequest(new Request("https://worker.example/jobs/MSFT", { method: "POST" }), env, 1_786_000_000_000)).status, 401);
});

test("creates a distinct workflow for each manual force refresh", async () => {
  const ids: string[] = [];
  const binding: SecWorkflowBinding = {
    async create(options) {
      ids.push(options.id);
      return { id: options.id };
    },
  };
  const request = () => new Request("https://worker.example/jobs/MSFT", {
    method: "POST",
    headers: { "x-sec-refresh-key": "refresh-key" },
  });

  await handleSecAnalysisRequest(request(), { ...env, SEC_ANALYSIS_WORKFLOW: binding }, 1_786_000_000_000);
  await handleSecAnalysisRequest(request(), { ...env, SEC_ANALYSIS_WORKFLOW: binding }, 1_786_000_000_000);

  assert.equal(new Set(ids).size, 2);
});

test("fails the refresh when no workflow could be started at all", async () => {
  const binding: SecWorkflowBinding = {
    async create() {
      throw new Error("workflow unavailable");
    },
  };

  await assert.rejects(
    runSecRefresh({ ...env, SEC_ANALYSIS_WORKFLOW: binding }, 1_786_000_000_000),
    /started no workflows \(watchlist: 2, failed: 2\)/,
  );
});

/** A fake D1 answering `findAnalysisTrigger`, which reads one row rather than a result set. */
function memoryTriggerDb(row: Record<string, unknown> | null) {
  return {
    prepare() {
      return { bind() { return { async first() { return row; } }; } };
    },
  } as unknown as D1Database;
}

const memoryRow = { memoryJobId: "memory-job-9", periodId: "MSFT:2026-06-30:quarterly", reportDate: "2026-06-30", memoryVersion: 4 };

/**
 * The outlook workflow's only manual entry. The Cron sweep skips a company that already published
 * for the current memory version, so without this a prompt or model change cannot be looked at
 * until a filing advances memory.
 */
test("starts one company analysis on demand, with the trigger the sweep would have built", async () => {
  const started: Array<{ id: string; params: Record<string, unknown> }> = [];
  const response = await handleCompanyAnalysisRequest(
    new Request("https://worker.example/company-analysis/MSFT", { method: "POST", headers: { "x-sec-refresh-key": "refresh-key" } }),
    {
      ...env,
      DB: memoryTriggerDb(memoryRow),
      COMPANY_ANALYSIS_WORKFLOW: { async create(options) { started.push({ id: options.id, params: options.params as Record<string, unknown> }); return { id: options.id }; } },
    },
    1_786_000_000_000,
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    status: "queued", analysisJobId: started[0]!.id, ticker: "MSFT",
    periodId: memoryRow.periodId, memoryVersion: memoryRow.memoryVersion,
  });
  // A manual revision must have a fresh trigger_ref; the prior published row is immutable.
  assert.match(String(started[0]!.params.triggerRef), /^memory-job-9:4:manual:/);
  assert.equal(started[0]!.params.ticker, "MSFT");
  // A manual run is a fresh attempt, never a retry, so it must not spend the recovery budget.
  assert.equal("recoveryAttempt" in started[0]!.params, false);
  assert.equal("analysisId" in started[0]!.params, false);
});

test("a manual company analysis gets its own workflow id, because the sweep's already exists", async () => {
  const ids: string[] = [];
  const workflow = { async create(options: { id: string }) { ids.push(options.id); return { id: options.id }; } };
  for (let index = 0; index < 2; index += 1) {
    await handleCompanyAnalysisRequest(
      new Request("https://worker.example/company-analysis/MSFT", { method: "POST", headers: { "x-sec-refresh-key": "refresh-key" } }),
      { ...env, DB: memoryTriggerDb(memoryRow), COMPANY_ANALYSIS_WORKFLOW: workflow },
      1_786_000_000_000,
    );
  }
  assert.equal(new Set(ids).size, 2);
  assert.ok(ids.every((id) => id.startsWith("company-manual-MSFT-")));
});

test("company analysis on demand refuses what it cannot start", async () => {
  const workflow = { async create(options: { id: string }) { return { id: options.id }; } };
  const full = { ...env, DB: memoryTriggerDb(memoryRow), COMPANY_ANALYSIS_WORKFLOW: workflow };
  const post = (url: string, headers: Record<string, string> = { "x-sec-refresh-key": "refresh-key" }) =>
    new Request(url, { method: "POST", headers });

  assert.equal((await handleCompanyAnalysisRequest(post("https://worker.example/company-analysis/MSFT", {}), full)).status, 401);
  assert.equal((await handleCompanyAnalysisRequest(new Request("https://worker.example/company-analysis/MSFT"), full)).status, 404);
  // Not on this Worker's own whitelist. The Web service never gets a say in that.
  assert.equal((await handleCompanyAnalysisRequest(post("https://worker.example/company-analysis/TSLA"), full)).status, 403);
  // Company analysis reasons over memory that filing analysis produces; without it there is nothing.
  assert.equal((await handleCompanyAnalysisRequest(post("https://worker.example/company-analysis/MSFT"), { ...full, DB: memoryTriggerDb(null) })).status, 409);
  assert.equal((await handleCompanyAnalysisRequest(post("https://worker.example/company-analysis/MSFT"), { ...env, DB: memoryTriggerDb(memoryRow) })).status, 503);
});
