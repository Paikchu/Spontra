import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { RevenueHistoryQuarter } from "../../../shared/analysis-contract/revenue-history.ts";
import { readRevenueHistory, rereadHistoryFiling } from "../src/financial-data/history.ts";
import type { SecReader } from "../src/financial-data/provider.ts";

// The admin's "重新读取此报告": CoreWeave's Q4 2025 earnings 8-K, whose release prints Q4 2025 and Q4 2024.
const CIK = "0001769628", ACCESSION = "0001769628-26-000094", FOLDER = "https://www.sec.gov/Archives/edgar/data/1769628/000176962826000094/";
const release = readFileSync(new URL("./fixtures/releases/crwv-q4-2025.htm", import.meta.url), "utf8");
const millions = (n: number) => n * 1e6;
const submissions = {
  cik: CIK, sic: "7374",
  filings: { recent: {
    form: ["10-Q", "8-K"], filingDate: ["2026-05-08", "2026-02-26"], accessionNumber: ["0001769628-26-000222", ACCESSION],
    primaryDocument: ["crwv-20260331.htm", "coreweave4q25earningspress.htm"], reportDate: ["2026-03-31", "2026-02-26"], items: ["", "2.02,9.01"],
  } },
};

function cacheDb() {
  const rows = new Map<string, { payload: string; fetchedAt: string }>();
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...values: unknown[]) => statement(sql, values),
    first: async () => /SELECT payload/.test(sql) ? rows.get(String(args[0])) ?? null : null,
    run: async () => { if (/INSERT INTO sec_cache/.test(sql)) rows.set(String(args[0]), { payload: String(args[1]), fetchedAt: String(args[2]) }); return { success: true }; },
  });
  return { rows, db: { prepare: (sql: string) => statement(sql) } as unknown as D1Database };
}
const reader = (document: string): SecReader => ({
  submissions: async () => submissions,
  issuerDirectory: async () => ({ fields: [], data: [] }),
  async read(url) {
    if (url === `${FOLDER}coreweave4q25earningspress.htm`) return new Response(document);
    throw new Error("unavailable");
  },
});
const quarter = (start: string, end: string, revenue: number, accession: string, form: string): RevenueHistoryQuarter => {
  const url = `https://www.sec.gov/Archives/edgar/data/1769628/${accession.replaceAll("-", "")}/doc.htm`;
  return { periodStart: start, periodEnd: end, currency: "USD", scale: 1, revenue: String(millions(revenue)), basis: "reported",
    segments: [{ id: "total", name: "Total", value: String(millions(revenue)) }], source: { accession, url, filedAt: form === "8-K" ? "2026-02-26" : "2026-05-08", form } };
};
const seed = (rows: Map<string, { payload: string; fetchedAt: string }>, quarters: RevenueHistoryQuarter[]) =>
  rows.set(`sec:revenue-history:v1:${CIK}`, { payload: JSON.stringify({ schemaVersion: "revenue-history.v1", ticker: "CRWV", updatedAt: "2026-10-15T00:00:00Z", quarters }), fetchedAt: "2026-10-15T00:00:00Z" });
const now = new Date("2026-10-16T00:00:00Z");

test("re-reading one filing replaces the quarters it is the source of and leaves every other quarter", async () => {
  const { rows, db } = cacheDb();
  seed(rows, [quarter("2025-10-01", "2025-12-31", 1_000, ACCESSION, "8-K"), quarter("2026-01-01", "2026-03-31", 2_078, "0001769628-26-000222", "10-Q")]);
  const result = await rereadHistoryFiling(db, reader(release), { ticker: "CRWV", cik: CIK }, ACCESSION, now);
  assert.deepEqual([result.form, result.filedAt, result.replaced, result.quarters], ["8-K", "2026-02-26", ["2025-12-31"], ["2024-12-31", "2025-12-31"]]);
  const history = await readRevenueHistory(db, CIK, "CRWV");
  assert.deepEqual(history?.quarters.map(q => [q.periodEnd, Number(q.revenue), q.source.accession]), [
    ["2024-12-31", millions(747), ACCESSION],
    ["2025-12-31", millions(1_572), ACCESSION],
    ["2026-03-31", millions(2_078), "0001769628-26-000222"],
  ]);
});

test("a re-read that reads no quarter erases nothing, and a filing outside the history window is refused", async () => {
  const { rows, db } = cacheDb(), before = [quarter("2025-10-01", "2025-12-31", 1_572, ACCESSION, "8-K")];
  seed(rows, before);
  const result = await rereadHistoryFiling(db, reader("<html><body><p>Press release</p></body></html>"), { ticker: "CRWV", cik: CIK }, ACCESSION, now);
  assert.deepEqual([result.replaced, result.quarters], [[], []]);
  assert.ok(result.issues.length > 0);
  assert.deepEqual((await readRevenueHistory(db, CIK, "CRWV"))?.quarters.map(q => [q.periodEnd, Number(q.revenue)]), [["2025-12-31", millions(1_572)]]);
  await assert.rejects(rereadHistoryFiling(db, reader(release), { ticker: "CRWV", cik: CIK }, "0001769628-24-000001", now), /FILING_NOT_IN_HISTORY_WINDOW/);
});
