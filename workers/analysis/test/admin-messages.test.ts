import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { latestOutcomes, listMessages, markRead, messageStatements, recordFeatureFailure } from "../src/admin/messages.ts";
import { featureShown } from "../src/admin/feature-settings.ts";
import { companyPolicyEnvironment, featureTickersFor } from "../src/financial-data/company-policy.ts";
import type { EventMessage } from "../src/pipeline/messages.ts";

/** D1 over node:sqlite with every migration applied. */
function database(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(file, dir), "utf8").replace(/--> statement-breakpoint/g, ""));
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    run: async () => { sqlite.prepare(sql).run(...values as never[]); return { success: true }; },
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...values as never[]) as T[] }),
    first: async <T>() => (sqlite.prepare(sql).get(...values as never[]) ?? null) as T | null,
  });
  return { prepare: (sql: string) => statement(sql), batch: async (list: Array<{ run(): Promise<unknown> }>) => { for (const s of list) await s.run(); return []; } } as unknown as D1Database;
}
const event = (type: EventMessage["type"], ticker: string): EventMessage => ({ v: 1, kind: "event", id: crypto.randomUUID(), causeId: null, type, ticker, cik: null, task: null, detail: null, at: "" });
const deployment = { SEC_AI_TICKERS: "NET", SEC_AI_ENABLED: "true", SEC_DATA_TICKERS: "NET" };

test("publications fold into one unread success per company and feature; a read entry is followed by a new one", async () => {
  const db = database();
  await db.batch(messageStatements(db, [event("report.published", "NET"), event("guidance.published", "NET"), event("map.derived", "NET"), event("tree.published", "*")], "2026-10-20T14:00:00.000Z"));
  let inbox = await listMessages(db);
  assert.equal(inbox.unread, 1);
  assert.deepEqual(inbox.messages.map(m => [m.ticker, m.feature, m.outcome, m.count, m.detail]), [["NET", "reports", "succeeded", 2, "guidance.published"]]);
  await markRead(db, null, "2026-10-20T14:01:00.000Z");
  await db.batch(messageStatements(db, [event("report.published", "NET")], "2026-10-20T14:02:00.000Z"));
  inbox = await listMessages(db);
  assert.equal(inbox.unread, 1);
  assert.deepEqual(inbox.messages.map(m => [m.count, m.readAt]), [[1, null], [2, "2026-10-20T14:01:00.000Z"]]);
});

test("a failed run switches the feature off but keeps what was written shown; the findings go off with the reports", async () => {
  const db = database();
  await recordFeatureFailure(db, "NET", "reports", "sec-report: filing 0001 failed", "2026-10-20T14:00:00.000Z");
  const env = await companyPolicyEnvironment({ ...deployment, DB: db });
  assert.deepEqual(featureTickersFor(env, "reports"), []);
  assert.deepEqual(featureTickersFor(env, "findings"), []);
  assert.equal(await featureShown(db, deployment, "NET", "reports"), true);
  assert.deepEqual([...(await latestOutcomes(db)).entries()], [["reports:NET", { outcome: "failed", detail: "sec-report: filing 0001 failed", updatedAt: "2026-10-20T14:00:00.000Z" }]]);
  // A switch the admin had turned off stays hidden.
  await db.prepare("INSERT INTO business_feature_settings (ticker, feature, generate, display, updated_at) VALUES ('NET', 'tree', 0, 0, '')").run();
  await recordFeatureFailure(db, "NET", "tree", "late run", "2026-10-20T14:00:00.000Z");
  assert.equal(await featureShown(db, deployment, "NET", "tree"), false);
});
