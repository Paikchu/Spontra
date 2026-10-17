import { test } from "node:test";
import assert from "node:assert/strict";
import { runHistoryStep } from "../src/financial-data/history.ts";
import type { SecReader } from "../src/financial-data/provider.ts";

// JPMorgan files ~2,000 prospectuses a month, so EDGAR's `recent` block covers under a year; its older periodic
// reports are listed only in the submission pages named under `filings.files`.
const CIK = "0000019617";
const columns = (rows: Array<[string, string, string, string?]>) => ({
  form: rows.map(r => r[0]), filingDate: rows.map(r => r[1]), accessionNumber: rows.map(r => r[2]),
  primaryDocument: rows.map(() => "doc.htm"), reportDate: rows.map(() => ""), items: rows.map(r => r[3] ?? ""),
});

function cacheDb() {
  const rows = new Map<string, { payload: string; fetchedAt: string }>();
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...values: unknown[]) => statement(sql, values),
    first: async () => /SELECT payload/.test(sql) ? rows.get(String(args[0])) ?? null : null,
    run: async () => { if (/INSERT INTO sec_cache/.test(sql)) rows.set(String(args[0]), { payload: String(args[1]), fetchedAt: String(args[2]) }); return { success: true }; },
  });
  return { rows, db: { prepare: (sql: string) => statement(sql) } as unknown as D1Database };
}

test("the history listing continues into EDGAR's older submission pages until the lookback", async () => {
  const read: string[] = [];
  const responses: Record<string, unknown> = {
    [`https://data.sec.gov/submissions/CIK${CIK}.json`]: { cik: CIK, sic: "6021", filings: {
      recent: columns([["424B2", "2026-10-15", "0001213900-26-000001"], ["10-Q", "2026-08-06", "0001628280-26-054343"], ["424B2", "2025-10-16", "0001213900-25-000001"]]),
      files: [
        { name: `CIK${CIK}-submissions-001.json`, filingFrom: "2025-01-10", filingTo: "2025-10-14" },
        { name: `CIK${CIK}-submissions-002.json`, filingFrom: "2023-01-01", filingTo: "2025-01-08" },
        { name: `CIK${CIK}-submissions-003.json`, filingFrom: "2019-01-01", filingTo: "2022-12-30" },
      ],
    } },
    [`https://data.sec.gov/submissions/CIK${CIK}-submissions-001.json`]: columns([["10-K", "2025-02-14", "0000019617-25-000270"], ["8-K", "2025-01-15", "0000019617-25-000040", "2.02,9.01"], ["424B2", "2025-01-10", "0001213900-25-000002"]]),
    [`https://data.sec.gov/submissions/CIK${CIK}-submissions-002.json`]: columns([["10-Q", "2024-11-01", "0000019617-24-000600"], ["10-Q", "2023-08-03", "0000019617-23-000500"], ["10-Q", "2023-05-03", "0000019617-23-000400"]]),
  };
  const reader: SecReader = { async read(url) {
    read.push(url);
    if (url in responses) return new Response(JSON.stringify(responses[url]));
    throw new Error("unavailable");
  } };
  const { rows, db } = cacheDb();
  await runHistoryStep(db, reader, { ticker: "JPM", cik: CIK }, new Date("2026-10-16T00:00:00Z"), 0);
  const cursor = JSON.parse(rows.get(`sec:revenue-history-cursor:v1:${CIK}`)!.payload) as { documents: Array<{ accession: string; form: string }> };
  // Listed through the second page; the 2023-05 10-Q is past the lookback, and the third page is never read.
  assert.deepEqual(cursor.documents.map(d => [d.form, d.accession]), [
    ["10-Q", "0001628280-26-054343"], ["10-K", "0000019617-25-000270"], ["8-K", "0000019617-25-000040"],
    ["10-Q", "0000019617-24-000600"], ["10-Q", "0000019617-23-000500"],
  ]);
  assert.ok(!read.some(url => url.endsWith("-submissions-003.json")));
});
