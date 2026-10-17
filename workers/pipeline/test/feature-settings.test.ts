import { test } from "node:test";
import assert from "node:assert/strict";
import { featureShown, shownFilter, writeFeatureSetting } from "../src/admin/feature-settings.ts";
import { readBusinessTreeResponse } from "../src/business-tree/workflow.ts";
import { readGuidanceResponse } from "../src/guidance/workflow.ts";
import { readBusinessExplainerResponse } from "../src/business-explainer/workflow.ts";
import { readFindingsResponse } from "../src/findings/read.ts";

type Row = { ticker: string; feature: string; generate: number | null };

/** A D1 stand-in holding only the feature settings; every other read is empty. */
function fakeDb(rows: Row[], migrated = true) {
  const writes: Array<{ sql: string; binds: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { binds = values; return statement; },
        async first() { return null; },
        async all() {
          if (!sql.includes("business_feature_settings")) return { results: [] };
          if (!migrated) throw new Error("no such table: business_feature_settings");
          if (!sql.includes("WHERE feature = ?")) return { results: rows };
          const [feature, ticker] = binds as [string, string | undefined];
          return { results: rows.filter(r => r.feature === feature && r.ticker !== "*" && r.generate !== null && (ticker === undefined || r.ticker === ticker)) };
        },
        async run() { writes.push({ sql, binds }); return { meta: { changes: 1 } }; },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { db, writes };
}

const deployment = { SEC_AI_TICKERS: "ORCL,NET", SEC_AI_ENABLED: "true", BUSINESS_TREE_TICKERS: "MSFT" };

test("readers see a feature exactly when its switch is on: the stored choice, else the deployment's default list", async () => {
  const { db } = fakeDb([
    { ticker: "ORCL", feature: "findings", generate: 0 },
    { ticker: "AAPL", feature: "reports", generate: 1 },
    { ticker: "*", feature: "tree", generate: 0 },
  ]);
  assert.equal(await featureShown(db, deployment, "ORCL", "findings"), false, "switched off");
  assert.equal(await featureShown(db, deployment, "ORCL", "reports"), true, "default list");
  assert.equal(await featureShown(db, deployment, "AAPL", "reports"), true, "switched on");
  assert.equal(await featureShown(db, deployment, "AAPL", "tree"), false, "never on: an old tree is not shown");
  // The global switch pauses generation only; what companies show follows their own switches.
  assert.equal(await featureShown(db, deployment, "MSFT", "tree"), true);
  const shown = await shownFilter(db, deployment, "findings");
  assert.deepEqual(["ORCL", "NET", "AAPL"].filter(shown), ["NET"]);
});

test("the readers answer hidden when the route says so and are untouched otherwise", async () => {
  const { db } = fakeDb([]);
  assert.equal((await readFindingsResponse(db, "ORCL", { hidden: true })).status, "hidden");
  assert.equal((await readFindingsResponse(db, "ORCL")).status, "ready", "the authored ORCL set serves the admin");
  assert.equal((await readGuidanceResponse(db, "NET", { hidden: true })).status, "hidden");
  assert.equal((await readGuidanceResponse(db, "NET")).status, "preparing");
  assert.equal((await readBusinessExplainerResponse(db, "ORCL", { hidden: true })).status, "hidden");
  assert.equal((await readBusinessTreeResponse(db, "ORCL", { hidden: true })).status, "hidden");
  assert.equal((await readBusinessTreeResponse(db, "ORCL")).status, "preparing");
});

test("before the table exists the defaults stand, and a switch writes both stored bits together", async () => {
  const unmigrated = fakeDb([], false);
  assert.equal(await featureShown(unmigrated.db, deployment, "ORCL", "findings"), true);
  assert.equal(await featureShown(unmigrated.db, deployment, "AAPL", "findings"), false);
  const { db, writes } = fakeDb([]);
  await writeFeatureSetting(db, "ORCL", "reports", false, "2026-10-17T00:00:00Z");
  assert.deepEqual(writes[0]!.binds, ["ORCL", "reports", 0, 0, "2026-10-17T00:00:00Z"]);
  await writeFeatureSetting(db, "*", "tree", true, "2026-10-17T00:00:00Z");
  assert.deepEqual(writes[1]!.binds, ["*", "tree", 1, null, "2026-10-17T00:00:00Z"]);
});
