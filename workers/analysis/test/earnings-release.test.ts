import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readStatementTableFacts } from "../src/financial-data/statement-table.ts";
import type { DocumentSource } from "../src/financial-data/parser.ts";
import { extractRevenueHistory } from "../src/financial-data/revenue-parser.ts";
import { mergeHistory } from "../../../shared/analysis-runtime/financial-data/history.ts";

// Earnings-release exhibits (8-K Exhibit 99.1) are plain HTML: their statements of operations are read from the tables.
// Each fixture keeps the text before the statement and the statement table of the named release.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/releases/${name}`, import.meta.url), "utf8");
const source = (cik: string, accession: string, filedAt: string): DocumentSource => ({ url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll("-", "")}/ex99.htm`, accession, filedAt, cik, industry: "standard" });
const millions = (n: number) => n * 1e6;
const quarters = (name: string, src: DocumentSource) => extractRevenueHistory(fixture(name), src, "8-K").quarters.map(q => [q.periodStart, q.periodEnd, Number(q.revenue)]).sort((a, b) => String(a[1]).localeCompare(String(b[1])));

test("CoreWeave's fourth quarter is read from its release, past the non-GAAP paragraph before the statement", () => {
  assert.deepEqual(quarters("crwv-q4-2025.htm", source("0001769628", "0001769628-26-000094", "2026-02-26")), [
    ["2024-10-01", "2024-12-31", millions(747)],
    ["2025-10-01", "2025-12-31", millions(1_572)],
  ]);
});

test("a title with a scale but no currency is USD when the statement prints its amounts in $", () => {
  const html = fixture("crwv-q4-2025.htm"), src = source("0001769628", "0001769628-26-000094", "2026-02-26");
  assert.ok(readStatementTableFacts(html, src).every(f => f.currency === "USD"));
  assert.deepEqual(readStatementTableFacts(html.replace(/<td>\$<\/td>/g, "<td></td>"), src), []);
  assert.deepEqual(readStatementTableFacts(html.replace("CONSOLIDATED STATEMENTS OF OPERATIONS", "NON-GAAP CONSOLIDATED STATEMENTS OF OPERATIONS"), src), []);
});

test("a duration heading narrower than its year columns still dates both columns", () => {
  assert.deepEqual(quarters("amzn-q1-2026.htm", source("0001018724", "0001018724-26-000011", "2026-04-29")), [
    ["2025-01-01", "2025-03-31", millions(155_667)],
    ["2026-01-01", "2026-03-31", millions(181_519)],
  ]);
});

test("a 52/53-week calendar runs each quarter 13 weeks back from its printed end", () => {
  assert.deepEqual(quarters("nvda-q4-fy2026.htm", source("0001045810", "0001045810-26-000019", "2026-02-25")), [
    ["2024-10-28", "2025-01-26", millions(39_331)],
    ["2025-10-27", "2026-01-25", millions(68_127)],
  ]);
  assert.deepEqual(quarters("aapl-q4-fy2025.htm", source("0000320193", "0000320193-25-000077", "2025-10-30")), [
    ["2024-06-30", "2024-09-28", millions(94_930)],
    ["2025-06-29", "2025-09-27", millions(102_466)],
  ]);
});

test("\"Income Statements\" and \"Quarter Ended\" headings are read; year-to-date columns are not quarters", () => {
  assert.deepEqual(quarters("msft-q4-fy2026.htm", source("0000789019", "0001193125-26-310000", "2026-07-29")), [
    ["2025-04-01", "2025-06-30", millions(76_441)],
    ["2026-04-01", "2026-06-30", millions(90_007)],
  ]);
  assert.deepEqual(quarters("googl-q2-2026.htm", source("0001652044", "0001652044-26-000060", "2026-07-22")), [
    ["2025-04-01", "2025-06-30", millions(96_428)],
    ["2026-04-01", "2026-06-30", millions(119_796)],
  ]);
});

test("a later earnings release does not replace the quarter its periodic report filed", () => {
  const release = extractRevenueHistory(fixture("nvda-q4-fy2026.htm"), source("0001045810", "0001045810-26-000019", "2026-02-25"), "8-K").quarters;
  const prior = release.find(q => q.periodEnd === "2025-01-26")!;
  const tenK = { ...prior, segments: [{ id: "compute", name: "Compute & Networking", value: String(millions(35_580)) }, { id: "graphics", name: "Graphics", value: String(millions(3_751)) }], source: { ...prior.source, accession: "0001045810-25-000023", filedAt: "2025-02-26", form: "10-K" } };
  const merged = mergeHistory("NVDA", [tenK], release, "2026-02-25").quarters;
  assert.equal(merged.find(q => q.periodEnd === "2025-01-26")?.source.form, "10-K");
  assert.equal(merged.find(q => q.periodEnd === "2026-01-25")?.source.form, "8-K");
});
