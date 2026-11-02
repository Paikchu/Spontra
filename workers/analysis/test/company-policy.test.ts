import { test } from "node:test";
import assert from "node:assert/strict";
import { companyPolicyEnvironment, featureEnabled, featureTickersFor } from "../src/financial-data/company-policy.ts";
import type { Feature } from "../../../shared/analysis-contract/business-features.ts";
import { trackedTickersFor } from "../src/core.ts";
import { validateRegistry, SUBSCRIPTIONS } from "../src/pipeline/registry.ts";

const fakeDb = (data: Array<{ ticker: string; enabled: number }>, features: Array<{ ticker: string; feature: string; generate: number | null }> | null) => ({
  prepare: (sql: string) => ({ bind() { return this; }, all: async () => {
    if (sql.includes("business_feature_settings")) { if (!features) throw new Error("no such table: business_feature_settings"); return { results: features.filter(r => r.generate !== null) }; }
    return { results: data };
  } }),
}) as unknown as D1Database;

test("the admin's rows are the company lists: a deployment list is ignored, removals hold, and applying it twice changes nothing", async () => {
  // A list left on the deployed Worker (wrangler --keep-vars) must not switch anyone on.
  const base = { SEC_DATA_TICKERS: "ZZZ", SEC_AI_TICKERS: "ZZZ", SEC_AI_ENABLED: "true", BUSINESS_TREE_TICKERS: "ZZZ" };
  const env = await companyPolicyEnvironment({ ...base, DB: fakeDb([{ ticker: "AMZN", enabled: 1 }, { ticker: "ORCL", enabled: 1 }, { ticker: "NET", enabled: 0 }], [
    { ticker: "GOOGL", feature: "reports", generate: 1 }, { ticker: "ORCL", feature: "reports", generate: 1 }, { ticker: "NET", feature: "reports", generate: 0 },
    { ticker: "GOOGL", feature: "findings", generate: 1 }, { ticker: "ORCL", feature: "explainer", generate: 0 }, { ticker: "AMZN", feature: "tree", generate: 1 }, { ticker: "NET", feature: "tree", generate: null },
  ]) });
  assert.deepEqual(featureTickersFor(env, "reports"), ["GOOGL", "ORCL"]);
  assert.deepEqual(trackedTickersFor(env), ["GOOGL", "ORCL"]);
  assert.deepEqual(featureTickersFor(env, "findings"), ["GOOGL"]);
  assert.deepEqual(featureTickersFor(env, "explainer"), []);
  assert.deepEqual(featureTickersFor(env, "tree"), ["AMZN"]);
  assert.deepEqual(env.SEC_DATA_TICKERS!.split(",").sort(), ["AMZN", "ORCL"]);
  const again = await companyPolicyEnvironment(env);
  assert.deepEqual(featureTickersFor(again, "reports"), ["GOOGL", "ORCL"]);
  assert.deepEqual(again.SEC_DATA_TICKERS!.split(",").sort(), ["AMZN", "ORCL"]);
  await assert.rejects(companyPolicyEnvironment({ ...base, DB: fakeDb([], null) }), /no such table/);
  const unset = await companyPolicyEnvironment({ ...base, DB: fakeDb([], []) });
  assert.deepEqual(trackedTickersFor(unset), []);
  assert.deepEqual(featureTickersFor(unset, "tree"), []);
  assert.equal(unset.SEC_DATA_TICKERS, "");
});

test("a feature's global switch empties its list without touching the others", async () => {
  const on = (ticker: string, feature: string) => ({ ticker, feature, generate: 1 });
  const rows = ["ORCL", "NET"].flatMap(t => ["reports", "findings", "tree"].map(f => on(t, f)));
  const env = await companyPolicyEnvironment({ SEC_AI_ENABLED: "true", DB: fakeDb([], [...rows, { ticker: "*", feature: "tree", generate: 0 }, { ticker: "*", feature: "findings", generate: 0 }]) });
  assert.deepEqual(featureTickersFor(env, "tree"), []);
  assert.deepEqual(featureTickersFor(env, "findings"), []);
  assert.equal(featureEnabled(env, "findings"), false);
  assert.deepEqual(featureTickersFor(env, "reports"), ["NET", "ORCL"]);
  assert.equal(env.BUSINESS_TREE_ENABLED, "false");
  const paused = await companyPolicyEnvironment({ SEC_AI_ENABLED: "false", DB: fakeDb([], [...rows, { ticker: "*", feature: "reports", generate: 1 }]) });
  assert.deepEqual(featureTickersFor(paused, "reports"), ["NET", "ORCL"]);
  assert.deepEqual(featureTickersFor(paused, "findings"), []);
});

test("a feature switched on in the admin starts that feature's tasks, and the event graph stays acyclic", () => {
  const tasks = (feature: string) => SUBSCRIPTIONS["feature.settings"]?.filter(s => !s.when || s.when({ type: "feature.settings", ticker: "ORCL", detail: { feature: feature as Feature } })).map(s => s.task);
  assert.deepEqual(tasks("reports"), ["sec-report"]);
  assert.deepEqual(tasks("findings"), ["findings", "company-analysis", "items"]);
  assert.deepEqual(tasks("explainer"), ["explainer"]);
  assert.deepEqual(tasks("tree"), ["tree"]);
  assert.deepEqual(validateRegistry(), []);
});

test("A20: a generation settings query failure cannot restore deployment defaults", async () => {
  const db = { prepare(sql: string) {
    const statement = { bind() { return statement; }, async all() {
      if (sql.includes("business_feature_settings")) throw new Error("settings database unavailable");
      return { results: [] };
    } };
    return statement;
  } } as unknown as D1Database;
  await assert.rejects(companyPolicyEnvironment({ DB: db, SEC_AI_TICKERS: "ORCL", SEC_AI_ENABLED: "true" }), /settings database unavailable/);
});
