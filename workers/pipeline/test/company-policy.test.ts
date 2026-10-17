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

test("the admin's feature switches override each feature's default list per company, removals included, and applying it twice changes nothing", async () => {
  const base = { SEC_DATA_TICKERS: "ORCL,GOOGL,NET", SEC_AI_TICKERS: "ORCL,NET", SEC_AI_ENABLED: "true", BUSINESS_TREE_TICKERS: "AMZN" };
  const env = await companyPolicyEnvironment({ ...base, DB: fakeDb([{ ticker: "AMZN", enabled: 1 }], [
    { ticker: "GOOGL", feature: "reports", generate: 1 }, { ticker: "NET", feature: "reports", generate: 0 },
    { ticker: "GOOGL", feature: "findings", generate: 1 }, { ticker: "ORCL", feature: "explainer", generate: 0 }, { ticker: "NET", feature: "tree", generate: 0 },
  ]) });
  assert.deepEqual(featureTickersFor(env, "reports"), ["GOOGL", "ORCL"]);
  assert.deepEqual(trackedTickersFor(env), ["GOOGL", "ORCL"]);
  assert.deepEqual(featureTickersFor(env, "findings"), ["GOOGL", "NET", "ORCL"]);
  assert.deepEqual(featureTickersFor(env, "explainer"), ["NET"]);
  assert.deepEqual(featureTickersFor(env, "tree"), ["AMZN", "ORCL"]);
  assert.deepEqual(env.SEC_DATA_TICKERS!.split(",").sort(), ["AMZN", "GOOGL", "NET", "ORCL"]);
  const again = await companyPolicyEnvironment(env);
  assert.deepEqual(featureTickersFor(again, "reports"), ["GOOGL", "ORCL"]);
  assert.deepEqual(featureTickersFor(again, "tree"), ["AMZN", "ORCL"]);
  // Before the table exists the deployment defaults stand.
  const unmigrated = await companyPolicyEnvironment({ ...base, DB: fakeDb([], null) });
  assert.deepEqual(trackedTickersFor(unmigrated), ["NET", "ORCL"]);
  assert.deepEqual(featureTickersFor(unmigrated, "tree"), ["AMZN", "NET", "ORCL"]);
});

test("a feature's global switch empties its list without touching the others", async () => {
  const base = { SEC_DATA_TICKERS: "ORCL,NET", SEC_AI_TICKERS: "ORCL,NET", SEC_AI_ENABLED: "true" };
  const env = await companyPolicyEnvironment({ ...base, DB: fakeDb([], [{ ticker: "*", feature: "tree", generate: 0 }, { ticker: "*", feature: "findings", generate: 0 }]) });
  assert.deepEqual(featureTickersFor(env, "tree"), []);
  assert.deepEqual(featureTickersFor(env, "findings"), []);
  assert.equal(featureEnabled(env, "findings"), false);
  assert.deepEqual(featureTickersFor(env, "reports"), ["NET", "ORCL"]);
  assert.equal(env.BUSINESS_TREE_ENABLED, "false");
  const paused = await companyPolicyEnvironment({ ...base, SEC_AI_ENABLED: "false", DB: fakeDb([], [{ ticker: "*", feature: "reports", generate: 1 }]) });
  assert.deepEqual(featureTickersFor(paused, "reports"), ["NET", "ORCL"]);
  assert.deepEqual(featureTickersFor(paused, "findings"), []);
});

test("a feature switched on in the admin starts that feature's tasks, and the event graph stays acyclic", () => {
  const tasks = (feature: string) => SUBSCRIPTIONS["feature.settings"]?.filter(s => !s.when || s.when({ type: "feature.settings", ticker: "ORCL", detail: { feature: feature as Feature } })).map(s => s.task);
  assert.deepEqual(tasks("reports"), ["sec-report"]);
  assert.deepEqual(tasks("findings"), ["findings", "company-analysis"]);
  assert.deepEqual(tasks("explainer"), ["explainer"]);
  assert.deepEqual(tasks("tree"), ["tree"]);
  assert.deepEqual(validateRegistry(), []);
});

test("company names drop their listing's share-class wording", async () => {
  const { companyName } = await import("../src/catalog/security-directory.ts");
  assert.equal(companyName("GOOGL"), "Alphabet Inc.");
  assert.equal(companyName("NET"), "Cloudflare, Inc.");
  assert.equal(companyName("BRK.B"), "Berkshire Hathaway Inc.");
  assert.equal(companyName("JPM"), "JP Morgan Chase & Co.");
  assert.equal(companyName("ORCL"), "Oracle Corporation");
  assert.equal(companyName("TSM"), "Taiwan Semiconductor Manufacturing Company Ltd.");
  assert.equal(companyName("ZZZZZZ"), null);
});
