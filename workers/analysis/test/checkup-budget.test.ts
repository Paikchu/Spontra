import assert from "node:assert/strict";
import { test } from "node:test";
import { assessStatements } from "../../../shared/analysis-runtime/statement-analysis.ts";
import { checkupLoader, executeCheckupWorkflow } from "../src/checkup/workflow.ts";
import type { NoteSpec } from "../src/checkup/agent.ts";
import { scriptedRunner } from "./support/recipe-driver.ts";
import type { AnalysisEnv } from "../src/operations.ts";
import type { AgentAct } from "../src/tool-loop.ts";
import type { WorkflowStepLike } from "../src/workflow-core.ts";
import { data, PERIOD } from "./fixtures/stage-data.ts";
import { resolvedFor } from "./fixtures/company-settings.ts";

const assessment = assessStatements(data, PERIOD);
const metricId = assessment.flags[0]!.metricId;
const params = { ticker: "TEST", fingerprint: "budget-test" };

// Only budget bindings are recorded in memory. Input/publication stages are already
// durable, so no database or network operation runs in this workflow fixture.
function harness(cap: number) {
  const reservations: string[] = [];
  const units = new Map<string, number>();
  const completed = new Map<string, unknown>([
    ["checkup-input", { data, assessment, metrics: [metricId], documents: [], fingerprint: params.fingerprint }],
    ["checkup-empty", undefined],
    [`checkup-${metricId}-filings`, []],
  ]);
  const db = {
    prepare(sql: string) {
      assert.match(sql, /^INSERT INTO feature_budget /);
      return {
        bind(day: string, feature: string, limit: number) {
          assert.equal(feature, "checkup-turns");
          assert.equal(limit, cap);
          return { async first() {
            reservations.push(day);
            const used = units.get(day) ?? 0;
            if (used >= limit) return null;
            units.set(day, used + 1);
            return { units: used + 1 };
          } };
        },
      };
    },
  };
  const env: AnalysisEnv = {
    DB: db as unknown as D1Database,
    ...resolvedFor(["TEST"]), CHECKUP_DAILY_TURNS: String(cap),
  };
  const step: WorkflowStepLike = {
    async do<T>(name: string, callback: () => Promise<T>): Promise<T> {
      if (completed.has(name)) return structuredClone(completed.get(name)) as T;
      const value = await callback();
      completed.set(name, structuredClone(value));
      return value;
    },
  };
  return { reservations, units, run: (act: AgentAct) => executeCheckupWorkflow(params, step, env, { run: scriptedRunner((_kind, spec) => checkupLoader(spec as NoteSpec, env), act) }) };
}

test("each model call of a note reserves against the UTC day it is made, and the cap ends the note", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-02T23:59:59Z") });
  const h = harness(1);
  let calls = 0;
  const result = await h.run(async () => {
    calls++;
    t.mock.timers.tick(1_000);
    return { content: [], stopReason: "end_turn" };
  });
  assert.equal(result.status, "empty");
  const capped = harness(1);
  let once = 0;
  await capped.run(async () => { once++; return { content: [], stopReason: "end_turn" }; });
  assert.equal(once, 1, "within one day the cap stops the second model call");
  assert.equal(calls, 2, "the second call draws on the next day's allowance");
  assert.deepEqual(h.reservations, ["2026-11-02", "2026-11-03"]);
  assert.deepEqual([...h.units], [["2026-11-02", 1], ["2026-11-03", 1]]);
});

test("an exhausted allowance makes no model call", async () => {
  const h = harness(1);
  h.units.set(new Date().toISOString().slice(0, 10), 1);
  const result = await h.run(async () => { assert.fail("an exhausted budget must not call the model"); });
  assert.equal(result.status, "empty");
  assert.equal(h.reservations.length, 1);
});
