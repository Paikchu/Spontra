import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { readRevisions, REVISES, revisionStatements } from "../src/pipeline/revisions.ts";
import { EVENT_TYPES } from "../src/pipeline/registry.ts";
import { handleMapRead } from "../src/read-api/router.ts";

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

test("every event that revises a resource is a known event", () => {
  for (const type of Object.keys(REVISES)) assert.ok((EVENT_TYPES as readonly string[]).includes(type), type);
});

test("revisions keep the latest event per company and resource, and a redelivered older batch cannot move them back", async () => {
  const db = database();
  await db.batch(revisionStatements(db, [
    { type: "findings.published", ticker: "MSFT", at: "2026-10-16T01:00:00.000Z" },
    { type: "map.derived", ticker: "MSFT", at: "2026-10-16T02:00:00.000Z" },
    { type: "findings.published", ticker: "MSFT", at: "2026-10-16T00:30:00.000Z" },
    { type: "filing.archived", ticker: "MSFT", at: "2026-10-16T03:00:00.000Z" },
  ]));
  assert.deepEqual(await readRevisions(db, "MSFT"), { findings: "2026-10-16T01:00:00.000Z", company: "2026-10-16T02:00:00.000Z", capital: "2026-10-16T02:00:00.000Z" });
  await db.batch(revisionStatements(db, [{ type: "findings.published", ticker: "MSFT", at: "2026-10-15T00:00:00.000Z" }]));
  assert.equal((await readRevisions(db, "MSFT")).findings, "2026-10-16T01:00:00.000Z");
});

test("a global publication counts for every company; another company's does not", async () => {
  const db = database();
  await db.batch(revisionStatements(db, [
    { type: "findings.published", ticker: "MSFT", at: "2026-10-16T01:00:00.000Z" },
    { type: "peers.published", ticker: "*", at: "2026-10-16T04:00:00.000Z" },
    { type: "events.published", ticker: "ORCL", at: "2026-10-16T05:00:00.000Z" },
  ]));
  assert.deepEqual(await readRevisions(db, "MSFT"), { findings: "2026-10-16T04:00:00.000Z" });
  assert.deepEqual(await readRevisions(db, "ORCL"), { findings: "2026-10-16T04:00:00.000Z", events: "2026-10-16T05:00:00.000Z" });
});

test("the read API answers a company's revisions uncached", async () => {
  const db = database();
  await db.batch(revisionStatements(db, [{ type: "events.published", ticker: "MSFT", at: "2026-10-16T05:00:00.000Z" }]));
  const response = await handleMapRead(new Request("https://analysis.internal/api/v1/companies/MSFT/revisions"), { DB: db });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { schemaVersion: "revisions.v1", ticker: "MSFT", revisions: { events: "2026-10-16T05:00:00.000Z" } });
});
