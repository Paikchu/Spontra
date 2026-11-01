import assert from "node:assert/strict";
import test from "node:test";
import { handleSecAnalysisRequest, type SecCronEnv, type SecWorkflowParams } from "../src/core.ts";

for (const mode of ["jobs", "backfill"] as const) {
  test(`${mode} requests preserve manual parameters and have unique IDs at the same timestamp`, async () => {
    const calls: { id: string; params: SecWorkflowParams }[] = [];
    const env: SecCronEnv = {
      SEC_REFRESH_KEY: "test-key",
      SEC_AI_ENABLED: "true",
      SEC_AI_TICKERS: "AAPL",
      SEC_ANALYSIS_WORKFLOW: {
        async create(options) {
          calls.push(options);
          return { id: options.id };
        },
      },
    };
    const now = Date.parse("2026-11-02T00:00:00Z");
    for (let i = 0; i < 2; i++) {
      const response = await handleSecAnalysisRequest(new Request(`https://analysis.test/${mode}/aapl`, {
        method: "POST",
        headers: { "x-sec-refresh-key": "test-key" },
      }), env, now);
      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), { status: "queued", jobId: calls[i].id, ticker: "AAPL", mode });
    }
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].id, calls[1].id);
    for (const call of calls) {
      assert.match(call.id, new RegExp(`^manual-AAPL-${now}-[0-9a-f-]{36}$`));
      assert.deepEqual(call.params, { ticker: "AAPL", requestedBy: "manual", backfill: mode === "backfill" });
    }
  });
}
