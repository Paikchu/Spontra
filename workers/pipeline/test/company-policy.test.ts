import { test } from "node:test";
import assert from "node:assert/strict";
import { companyPolicyEnvironment } from "../src/financial-data/company-policy.ts";
import { trackedTickersFor } from "../src/core.ts";
import { validateRegistry, SUBSCRIPTIONS } from "../src/pipeline/registry.ts";

const fakeDb = (data: Array<{ ticker: string; enabled: number }>, ai: Array<{ ticker: string; enabled: number }> | null) => ({
  prepare: (sql: string) => ({ bind() { return this; }, all: async () => {
    if (sql.includes("financial_ai_settings")) { if (!ai) throw new Error("no such table: financial_ai_settings"); return { results: ai }; }
    return { results: data };
  } }),
}) as unknown as D1Database;

test("the admin's AI switch overrides SEC_AI_TICKERS per company, removals included, and applying it twice changes nothing", async () => {
  const base = { SEC_DATA_TICKERS: "ORCL,GOOGL,NET", SEC_AI_TICKERS: "ORCL,NET", SEC_AI_ENABLED: "true" };
  const env = await companyPolicyEnvironment({ ...base, DB: fakeDb([{ ticker: "AMZN", enabled: 1 }], [{ ticker: "GOOGL", enabled: 1 }, { ticker: "NET", enabled: 0 }]) });
  assert.deepEqual(trackedTickersFor(env), ["GOOGL", "ORCL"]);
  assert.deepEqual(env.SEC_DATA_TICKERS!.split(",").sort(), ["AMZN", "GOOGL", "NET", "ORCL"]);
  const again = await companyPolicyEnvironment(env);
  assert.deepEqual(trackedTickersFor(again), ["GOOGL", "ORCL"]);
  // Before the AI table exists the deployment default stands.
  const unmigrated = await companyPolicyEnvironment({ ...base, DB: fakeDb([], null) });
  assert.deepEqual(trackedTickersFor(unmigrated), ["NET", "ORCL"]);
});

test("switching a company on starts its SEC reports and business explanations, and the event graph stays acyclic", () => {
  assert.deepEqual(SUBSCRIPTIONS["ai.enabled"]?.map(s => s.task), ["sec-report", "explainer"]);
  assert.deepEqual(validateRegistry(), []);
});
