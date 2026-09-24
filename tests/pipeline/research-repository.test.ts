import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { SqliteD1Database } from "./helpers/sqlite-d1.ts";
import { ResearchRepository, type ResearchEvent } from "../../workers/pipeline/src/research/repository.ts";
import { RESEARCH_REPORT_SCHEMA, type ResearchReport } from "../../shared/analysis-runtime/research-schema.ts";

const now = "2026-09-25T01:00:00.000Z";
const later = "2026-09-25T01:05:00.000Z";
const event: ResearchEvent = { id: "orcl-event", ticker: "ORCL", kind: "price", observedAt: now, sourceAt: now, payload: { changePercent: -5 } };
function setup() {
  const db = new SqliteD1Database();
  db.raw.exec(readFileSync(new URL("../../workers/pipeline/migrations/0012_autonomous_research.sql", import.meta.url), "utf8"));
  return { db, repo: new ResearchRepository(db) };
}
function report(): ResearchReport {
  return { version: "research.v1", id: "report-1", caseId: event.id, title: "Oracle 股价变动待核实", summary: "观察到价格变化，原因尚待查证。",
    tickers: ["ORCL"], generatedAt: now, asOf: now, trigger: "price",
    content: [{ blockId: "price", type: "markdown", markdown: "观察到价格变化。", evidenceIds: ["source1"] }],
    sources: [{ id: "source1", title: "行情", url: "https://example.com/quote", publishedAt: now, retrievedAt: now, kind: "market", excerpt: "fixture" }],
    hypotheses: [], followups: [{ question: "是否存在公告？", query: "Oracle investor relations announcement", dueAt: later }], limitations: ["原因未确认"] };
}

test("duplicate events retain one dispatch intent; expired owners cannot change a successor's claim", async t => {
  const { db, repo } = setup(); t.after(() => db.close());
  // D1 serializes batches. This local adapter uses a single SQLite connection.
  await repo.enqueue(event); await repo.enqueue(event);
  assert.equal((await repo.pending(now)).length, 1);
  assert.ok(await repo.claim(event.id, "old", now, later));
  assert.equal(await repo.claim(event.id, "competitor", now, later), null);
  assert.ok(await repo.claim(event.id, "new", later, "2026-09-25T01:10:00.000Z"));
  await repo.dispatched(event.id, "old", later);
  await repo.dispatchFailed(event.id, "old", later);
  assert.equal(db.raw.prepare("SELECT lease_owner FROM research_cases").get()?.lease_owner, "new");
  await repo.dispatched(event.id, "new", later);
  assert.equal(db.raw.prepare("SELECT status FROM research_cases").get()?.status, "running");
});

test("publication is idempotent and schedules persisted followups with the report", async t => {
  const { db, repo } = setup(); t.after(() => db.close());
  await repo.enqueue(event);
  await repo.publish(report()); await repo.publish(report());
  assert.equal((await repo.reports()).reports.length, 1);
  assert.equal((await repo.due(now)).length, 0);
  assert.equal((await repo.due(later)).length, 1);
  assert.equal(db.raw.prepare("SELECT status FROM research_cases").get()?.status, "published");
  await repo.finishWithoutReport(event.id, "failed", later);
  assert.equal(db.raw.prepare("SELECT status FROM research_cases").get()?.status, "published");
});

test("unresolvable citations and unbacked chart blocks cannot publish", async t => {
  const { db, repo } = setup(); t.after(() => db.close());
  await repo.enqueue(event);
  const invalid = report(); invalid.content[0].evidenceIds = ["invented"];
  await assert.rejects(repo.publish(invalid));
  assert.equal((await repo.reports()).reports.length, 0);
  const chart = report(); chart.content = [{ blockId: "made-up", type: "chart", metricKey: "revenue", mark: "line", title: "Revenue", caption: "Unsupported", evidenceIds: ["source1"] }];
  assert.equal(RESEARCH_REPORT_SCHEMA.safeParse(chart).success, false);
});

test("concurrent budget claims stay capped; a new UTC day gets a fresh budget", async t => {
  const { db, repo } = setup(); t.after(() => db.close());
  const reservations = await Promise.all(Array.from({ length: 8 }, () => repo.reserveBudget("2026-09-25", 3)));
  assert.equal(reservations.filter(Boolean).length, 3);
  assert.equal(await repo.reserveBudget("2026-09-26", 3), true);
});
