import assert from "node:assert/strict";
import { test } from "node:test";
import { assessStatements } from "../../../shared/analysis-runtime/statement-analysis.ts";
import { executeCheckupWorkflow } from "../src/checkup/workflow.ts";
import type { AnalysisEnv } from "../src/operations.ts";
import type { AgentAct } from "../src/tool-loop.ts";
import type { WorkflowStepLike } from "../src/workflow-core.ts";
import { data, PERIOD } from "./fixtures/stage-data.ts";
import { resolvedFor } from "./fixtures/company-settings.ts";

const assessment = assessStatements(data, PERIOD);
const metricId = assessment.flags[0]!.metricId;
const firstTurn = `checkup-${metricId}-t1`;
const params = { ticker: "TEST", fingerprint: "budget-test" };

// Only budget bindings are recorded in memory. Input/publication stages are already
// durable, so no database or network operation runs in this workflow fixture.
function harness(cap: number, options: { beforeStage?: (name: string) => void; retryFirstTurn?: boolean } = {}) {
  const reservations: string[] = [];
  const units = new Map<string, number>();
  const completed = new Map<string, unknown>([
    ["checkup-input", { data, assessment, metrics: [metricId], documents: [], fingerprint: params.fingerprint }],
    ["checkup-empty", undefined],
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
      options.beforeStage?.(name);
      let value: T;
      try { value = await callback(); }
      catch (error) {
        if (!options.retryFirstTurn || name !== firstTurn) throw error;
        value = await callback();
      }
      completed.set(name, structuredClone(value));
      return value;
    },
  };
  return { reservations, units, run: (act: AgentAct) => executeCheckupWorkflow(params, step, env, { act }) };
}

test("checkup reserves against the UTC day when its model stage actually executes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-02T23:59:59Z") });
  const h = harness(1, { beforeStage(name) {
    if (name === firstTurn) t.mock.timers.tick(1_000);
  } });
  let calls = 0;
  const result = await h.run(async () => {
    calls++;
    return { content: [], stopReason: "end_turn" };
  });
  assert.equal(result.status, "empty");
  assert.equal(calls, 1, "the current day's cap stops the second model call");
  assert.deepEqual(h.reservations, ["2026-11-03", "2026-11-03"]);
  assert.deepEqual([...h.units], [["2026-11-03", 1]]);
});

test("replaying completed checkup model stages does not reserve again even at the daily cap", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-02T12:00:00Z") });
  const h = harness(2);
  let calls = 0;
  const act: AgentAct = async () => {
    calls++;
    return { content: [], stopReason: "end_turn" };
  };
  const first = await h.run(act);
  assert.equal(calls, 2);
  assert.equal(h.reservations.length, 2);
  const replay = await h.run(act);
  assert.equal(h.reservations.length, 2, "completed model stages reuse their reservations");
  assert.equal(calls, 2);
  assert.deepEqual(replay, first);
});

test("each real checkup model-stage retry reserves on its own execution day", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-02T23:59:59Z") });
  const h = harness(2, { retryFirstTurn: true });
  let calls = 0;
  const result = await h.run(async () => {
    if (++calls === 1) {
      t.mock.timers.tick(1_000);
      throw new Error("model transport failed");
    }
    return { content: [], stopReason: "end_turn" };
  });
  assert.equal(result.status, "empty");
  assert.equal(calls, 3);
  assert.deepEqual(h.reservations, ["2026-11-02", "2026-11-03", "2026-11-03"]);
  assert.deepEqual([...h.units], [["2026-11-02", 1], ["2026-11-03", 2]]);
});

test("a completed budget-denied stage remains denied on replay the next day", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-02T23:59:59Z") });
  const h = harness(1);
  h.units.set("2026-11-02", 1);
  const act: AgentAct = async () => { assert.fail("an exhausted budget must not call the model"); };
  const first = await h.run(act);
  assert.equal(first.status, "empty");
  assert.equal(h.reservations.length, 1);
  t.mock.timers.tick(1_000);
  const replay = await h.run(act);
  assert.deepEqual(h.reservations, ["2026-11-02"]);
  assert.deepEqual(replay, first);
});
