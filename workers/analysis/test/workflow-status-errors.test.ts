import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnalysisEnv } from "../src/operations.ts";
import { driveWorkflow, type WorkflowBindingLike } from "../src/pipeline/workflow-task.ts";
import { auditDb } from "./fixtures/audit-data.ts";

const key = "sec-report:ACME";
const cacheKey = `pipeline:workflow:${key}`;
const pollMs = 30_000;
const mustNotStart = async (): Promise<never> => { throw new Error("must keep following the existing instance"); };

for (const failingCall of ["get", "status"] as const) {
  for (const fingerprint of [undefined, "input-v1"]) {
    test(`AC-3: ${failingCall} outage preserves a two-hour-old run ${fingerprint ? "with" : "without"} a fingerprint through recovery`, async () => {
      const started = { instanceId: "existing-run", startedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(), fingerprint };
      const fixture = auditDb({ cache: { [cacheKey]: started } });
      const env = { DB: fixture.db } as AnalysisEnv;
      const outage = new Error("Workflow status service unavailable");
      let unavailable = true;
      let status = "running";
      const workflows: WorkflowBindingLike = {
        create: mustNotStart,
        async get(id) {
          assert.equal(id, started.instanceId);
          if (unavailable && failingCall === "get") throw outage;
          return { async status() {
            if (unavailable && failingCall === "status") throw outage;
            return { status };
          } };
        },
      };
      const options = { pollMs, deadLetter: { task: "sec-report" as const, ticker: "ACME", causeId: "cause-1" } };

      // Repeated outages must neither delete tracking nor record failures, disable features, or dead-letter work.
      for (let poll = 0; poll < 2; poll++) {
        const outcome = await driveWorkflow(env, key, workflows, mustNotStart, options);
        assert.deepEqual(fixture.writes, [], "a status read exception must not mutate workflow or feature state");
        assert.deepEqual(outcome, { status: "later", afterMs: pollMs, detail: {
          instanceId: started.instanceId, workflow: "status-unavailable", error: outage.message,
        } });
      }

      unavailable = false;
      assert.deepEqual(await driveWorkflow(env, key, workflows, mustNotStart, options), {
        status: "later", afterMs: pollMs, detail: { instanceId: started.instanceId, workflow: "running" },
      });
      assert.deepEqual(fixture.writes, []);

      status = "complete";
      assert.deepEqual(await driveWorkflow(env, key, workflows, mustNotStart, options), {
        status: "done", detail: { instanceId: started.instanceId, workflow: "complete" },
      });
      assert.deepEqual(fixture.writes, [{ sql: "DELETE FROM sec_cache WHERE cache_key = ?", binds: [cacheKey] }]);
    });
  }
}

test("AC-3: an actual unknown status retains the one-hour abandonment policy", async () => {
  for (const ageMinutes of [30, 120]) {
    const started = { instanceId: "missing-run", startedAt: new Date(Date.now() - ageMinutes * 60_000).toISOString() };
    const fixture = auditDb({ cache: { [cacheKey]: started } });
    const workflows: WorkflowBindingLike = {
      create: mustNotStart,
      async get() { return { async status() { return { status: "unknown" }; } }; },
    };
    const outcome = driveWorkflow({ DB: fixture.db } as AnalysisEnv, key, workflows, mustNotStart, { pollMs });
    if (ageMinutes < 60) {
      assert.deepEqual(await outcome, { status: "later", afterMs: pollMs, detail: { instanceId: started.instanceId, workflow: "unknown" } });
      assert.deepEqual(fixture.writes, []);
    } else {
      await assert.rejects(outcome, /Workflow missing-run unknown/);
      assert.deepEqual(fixture.writes, [{ sql: "DELETE FROM sec_cache WHERE cache_key = ?", binds: [cacheKey] }]);
    }
  }
});
