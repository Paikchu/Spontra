import { test } from "node:test";
import assert from "node:assert/strict";
import { featureShown, shownFilter, writeFeatureSetting } from "../src/admin/feature-settings.ts";
import { readBusinessTreeResponse } from "../src/business-tree/workflow.ts";
import { readGuidanceResponse } from "../src/guidance/workflow.ts";
import { readBusinessExplainerResponse } from "../src/business-explainer/workflow.ts";
import { readFindingsResponse } from "../src/findings/read.ts";
import { handleMapRead } from "../src/read-api/router.ts";

type Row = { ticker: string; feature: string; generate: number | null; display?: number | null };

/** A D1 stand-in holding the feature settings and the given `sec_cache` rows; every other read is empty. */
function fakeDb(rows: Row[], migrated = true, cache: Record<string, unknown> = {}) {
  const writes: Array<{ sql: string; binds: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { binds = values; return statement; },
        async first() {
          const key = sql.includes("sec_cache") ? binds[0] as string : "";
          return key in cache ? { payload: JSON.stringify(cache[key]), fetchedAt: "2026-10-14T00:00:00Z" } : null;
        },
        async all() {
          if (!sql.includes("business_feature_settings")) return { results: [] };
          if (!migrated) throw new Error("no such table: business_feature_settings");
          if (!sql.includes("WHERE feature = ?")) return { results: rows };
          const [feature, ticker] = binds as [string, string | undefined];
          return { results: rows.map(r => ({ ...r, shown: r.display ?? r.generate })).filter(r => r.feature === feature && r.ticker !== "*" && r.shown !== null && (ticker === undefined || r.ticker === ticker)) };
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
    { ticker: "NET", feature: "explainer", generate: 0, display: 1 },
  ]);
  // A failed run stopped generation only: what was written stays shown.
  assert.equal(await featureShown(db, deployment, "NET", "explainer"), true, "stopped by a failure");
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
  assert.equal((await readFindingsResponse(db, "ORCL")).status, "preparing", "nothing stored yet");
  assert.equal((await readGuidanceResponse(db, "NET", { hidden: true })).status, "hidden");
  assert.equal((await readGuidanceResponse(db, "NET")).status, "preparing");
  assert.equal((await readBusinessExplainerResponse(db, "ORCL", { hidden: true })).status, "hidden");
  assert.equal((await readBusinessTreeResponse(db, "ORCL", { hidden: true })).status, "hidden");
  assert.equal((await readBusinessTreeResponse(db, "ORCL")).status, "preparing");
});

test("with reports switched off the events route still lists every filing, without the summaries the model wrote", async () => {
  const filing = { ticker: "CRWV", items: ["8.01"], class: "other", description: "8-K", exhibits: [], insider: null,
    edgarUrl: "https://www.sec.gov/Archives/edgar/data/1769628/0001-index.html", documentUrl: "https://www.sec.gov/Archives/edgar/data/1769628/0001.htm" };
  const summary = { headline: "Notes priced", bullets: [{ label: "Size", detail: "$1B", importance: "high" }], analystView: "Dilutive.", eventCategory: "other", generatedAt: "2026-09-23" };
  const publication = { schemaVersion: "events.v1", ticker: "CRWV", checkedAt: "2026-10-14T00:00:00Z", pendingInsider: 0, events: [
    { ...filing, id: "0001-26-000001", form: "8-K", filedAt: "2026-09-22", eventDate: "2026-09-17", summary },
  ] };
  const read = async (on: boolean) => {
    const { db } = fakeDb([{ ticker: "CRWV", feature: "reports", generate: on ? 1 : 0 }], true, { "events:v1:CRWV": publication });
    const response = await handleMapRead(new Request("https://analysis.internal/api/v1/companies/CRWV/events"), { DB: db, ...deployment });
    return (await response.json() as { status: string; events: { events: Array<{ id: string; summary: unknown }> } });
  };
  const shown = await read(true), hidden = await read(false);
  assert.equal(shown.events.events[0]!.summary && (shown.events.events[0]!.summary as { headline: string }).headline, "Notes priced");
  assert.equal(hidden.status, "ready");
  assert.deepEqual(hidden.events.events.map(e => [e.id, e.summary]), [["0001-26-000001", null]]);
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
