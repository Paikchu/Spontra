import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { PublicBusinessFlow } from "../../../shared/analysis-contract/business-flow.ts";
import { disclosureAuditPrefix, readStoredAudits, type StoredAudit } from "../src/financial-data/disclosure-audit.ts";
import { auditWindowStart, unarchivedSources } from "../src/financial-data/derived.ts";

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

const day = (n: number) => new Date(Date.UTC(2026, 9, 1) - n * 86400000).toISOString().slice(0, 10);
const accession = (n: number) => `0001104659-26-${String(n).padStart(6, "0")}`;
async function archive(db: D1Database, n: number, filedAt: string, archivedAt: string) {
  const payload = { documentId: `doc-${n}`, ticker: "FOO", rawKey: `financial-disclosures/x/${n}`, coverage: { tables: 3 },
    source: { ticker: "FOO", accessionNumber: accession(n), documentUrl: `https://www.sec.gov/Archives/edgar/data/1/${n}/a.htm`, form: "6-K", reportDate: filedAt, filedAt } };
  await db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?)").bind(disclosureAuditPrefix("FOO") + `doc-${n}`, JSON.stringify(payload), archivedAt).run();
}

test("a backfill archived after the newest filings does not push them out of the window", async () => {
  const db = database();
  // The newest 60 filings are archived first; a backfill then archives 250 older ones, 200 of them inside the window.
  for (let n = 0; n < 60; n++) await archive(db, n, day(n), `2026-10-14T00:00:${String(n % 60).padStart(2, "0")}Z`);
  for (let n = 60; n < 310; n++) await archive(db, n, day(n * 4), `2026-10-15T00:${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}Z`);
  const since = auditWindowStart("2026-09-30");
  const audits = await readStoredAudits(db, "FOO", since);
  const expected = Array.from({ length: 310 }, (_, n) => n < 60 ? day(n) : day(n * 4)).filter(d => d >= since).length;
  assert.equal(audits.length, expected);
  assert.ok(expected > 200, "more documents than any former row cap");
  assert.equal(audits[0]!.source.filedAt, day(0));
  assert.ok(audits.every((a, i) => i === 0 || audits[i - 1]!.source.filedAt >= a.source.filedAt));
  assert.ok(audits.every(a => a.source.filedAt >= since));
  assert.equal((audits[0] as StoredAudit & { coverage?: unknown }).coverage, undefined);
});

test("the window reaches three years behind the latest quarter", () => {
  assert.equal(auditWindowStart("2026-06-30"), "2023-06-30");
});

test("a cited filing missing from the archive read is reported", () => {
  const flow = { quarters: [{ sources: [{ id: accession(1) }, { id: accession(2) }, { id: "not-an-accession" }] }] } as unknown as PublicBusinessFlow;
  const audits = [{ source: { accessionNumber: accession(1) } }] as unknown as StoredAudit[];
  assert.deepEqual(unarchivedSources(flow, audits), [accession(2)]);
});
