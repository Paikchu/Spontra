import { test } from "node:test";
import assert from "node:assert/strict";
import { featureDisplayed, hiddenTickers, readFeatureSettings, writeFeatureSetting } from "../src/admin/feature-settings.ts";
import { readBusinessTreeResponse } from "../src/business-tree/workflow.ts";
import { readGuidanceResponse } from "../src/guidance/workflow.ts";
import { readBusinessExplainerResponse } from "../src/business-explainer/workflow.ts";
import { readFindingsResponse } from "../src/findings/read.ts";

type Row = { ticker: string; feature: string; generate: number | null; display: number | null; updated_at: string };

/** A D1 stand-in holding only the feature settings; every other read is empty. */
function fakeDb(rows: Row[], migrated = true) {
  const writes: Array<{ sql: string; binds: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { binds = values; return statement; },
        async first() {
          if (sql.includes("business_feature_settings")) {
            if (!migrated) throw new Error("no such table: business_feature_settings");
            const [ticker, feature] = binds as [string, string];
            return rows.find(r => r.ticker === ticker && r.feature === feature) ?? null;
          }
          return null;
        },
        async all() {
          if (sql.includes("business_feature_settings")) {
            if (!migrated) throw new Error("no such table: business_feature_settings");
            if (sql.includes("display = 0")) return { results: rows.filter(r => r.feature === binds[0] && r.display === 0) };
            return { results: rows };
          }
          return { results: [] };
        },
        async run() { writes.push({ sql, binds }); return { meta: { changes: 1 } }; },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { db, writes };
}

test("a feature's display switch hides a company's publication from readers and nothing else", async () => {
  const { db } = fakeDb([
    { ticker: "ORCL", feature: "findings", generate: 1, display: 0, updated_at: "2026-10-17T00:00:00Z" },
    { ticker: "ORCL", feature: "tree", generate: 0, display: 1, updated_at: "2026-10-17T00:00:00Z" },
    { ticker: "NET", feature: "reports", generate: null, display: 0, updated_at: "2026-10-17T00:00:00Z" },
  ]);
  assert.equal(await featureDisplayed(db, "ORCL", "findings"), false);
  assert.equal(await featureDisplayed(db, "ORCL", "tree"), true);
  assert.equal(await featureDisplayed(db, "ORCL", "explainer"), true);
  assert.equal(await featureDisplayed(db, "NET", "reports"), false);
  assert.deepEqual([...await hiddenTickers(db, "findings")], ["ORCL"]);
  assert.deepEqual([...await hiddenTickers(db, "explainer")], []);
  // The public reads answer `hidden` without touching what is stored; the admin's reads are not gated.
  assert.equal((await readFindingsResponse(db, "ORCL", { public: true })).status, "hidden");
  assert.equal((await readGuidanceResponse(db, "NET", { public: true })).status, "hidden");
  assert.equal((await readGuidanceResponse(db, "ORCL", { public: true })).status, "preparing");
  assert.equal((await readBusinessExplainerResponse(db, "ORCL", { public: true })).status, "preparing");
  assert.equal((await readBusinessTreeResponse(db, "ORCL", { public: true })).status, "preparing");
  assert.equal((await readFindingsResponse(db, "ORCL")).status, "ready", "the authored ORCL set serves the admin");
});

test("before the table exists everything shows, and a write changes only the bits it names", async () => {
  const unmigrated = fakeDb([], false);
  assert.equal(await featureDisplayed(unmigrated.db, "ORCL", "findings"), true);
  assert.deepEqual([...await hiddenTickers(unmigrated.db, "findings")], []);
  assert.equal((await readFeatureSettings(unmigrated.db)).size, 0);
  const { db, writes } = fakeDb([]);
  await writeFeatureSetting(db, "ORCL", "reports", { display: false }, "2026-10-17T00:00:00Z");
  assert.deepEqual(writes[0]!.binds, ["ORCL", "reports", null, 0, "2026-10-17T00:00:00Z"]);
  assert.match(writes[0]!.sql, /COALESCE\(excluded\.generate, business_feature_settings\.generate\)/);
  await writeFeatureSetting(db, "*", "tree", { generate: true }, "2026-10-17T00:00:00Z");
  assert.deepEqual(writes[1]!.binds, ["*", "tree", 1, null, "2026-10-17T00:00:00Z"]);
});

test("stored switches read back per company with the global rows apart", async () => {
  const { db } = fakeDb([
    { ticker: "*", feature: "tree", generate: 0, display: null, updated_at: "2026-10-17T00:00:00Z" },
    { ticker: "ORCL", feature: "explainer", generate: 1, display: 0, updated_at: "2026-10-17T00:00:00Z" },
    { ticker: "ORCL", feature: "bogus", generate: 1, display: 0, updated_at: "2026-10-17T00:00:00Z" },
  ]);
  const settings = await readFeatureSettings(db);
  assert.deepEqual(settings.get("*"), { tree: { generate: false, display: true } });
  assert.deepEqual(settings.get("ORCL"), { explainer: { generate: true, display: false } });
});
