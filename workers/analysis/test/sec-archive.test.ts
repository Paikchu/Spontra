import { test } from "node:test";
import assert from "node:assert/strict";
import { exhibitType } from "../src/sec-archive/archive.ts";
import { prepareSecFiling, SEC_ARCHIVE_MISSING } from "../src/sec/pipeline.ts";
import type { ArchivedFiling } from "../src/sec-archive/index.ts";
import { isEdgarUrl, WebSearchService } from "../src/web-search/service.ts";
import { WebSearchError } from "../src/web-search/types.ts";
import type { SecFiling } from "../src/sec/sec.ts";
import { SUBSCRIPTIONS, TASKS, validateRegistry } from "../src/pipeline/registry.ts";

const filing: SecFiling = {
  ticker: "ORCL", cik: "0001341439", cikNumber: 1341439, companyName: "Oracle", form: "8-K", filingDate: "2026-09-10", reportDate: "2026-09-09",
  accessionNumber: "0001193125-26-265848", primaryDocument: "d1.htm", description: "", items: "2.02,9.01",
  documentUrl: "https://www.sec.gov/Archives/edgar/data/1341439/000119312526265848/d1.htm", indexUrl: "https://www.sec.gov/Archives/edgar/data/1341439/000119312526265848/0001193125-26-265848-index.htm",
};
const paragraph = (text: string) => `<p>${text} ${"Revenue grew in the quarter as cloud infrastructure demand continued. ".repeat(6)}</p>`;
const archived: ArchivedFiling = {
  ticker: "ORCL", accession: filing.accessionNumber, form: "8-K", filedAt: "2026-09-10", reportDate: "2026-09-09",
  documents: [
    { url: filing.documentUrl, filename: "d1.htm", role: "primary", type: "8-K", html: `<html><body><h1>Item 2.02 Results of Operations</h1>${paragraph("Oracle announced its fiscal first quarter results.")}</body></html>` },
    { url: "https://www.sec.gov/Archives/edgar/data/1341439/000119312526265848/orcl-ex99_1.htm", filename: "orcl-ex99_1.htm", role: "exhibit", type: "EX-99.1", html: `<html><body><h1>Oracle Announces Fiscal 2027 First Quarter Financial Results</h1>${paragraph("Total quarterly revenues were up 12% year over year.")}</body></html>` },
  ],
};

test("a filing is prepared from the archive alone: the body first, exhibits after it, spans offset into one text", async () => {
  const prepared = await prepareSecFiling(filing, archived);
  assert.deepEqual(prepared.sourceMaterials.map(m => [m.type, m.filename, m.status]), [["8-K", "d1.htm", "read"], ["EX-99.1", "orcl-ex99_1.htm", "read"]]);
  assert.ok(prepared.blocks.some(b => b.source === "body"), "body blocks");
  const exhibit = prepared.blocks.find(b => b.source === "exhibit");
  assert.equal(exhibit?.exhibitType, "EX-99.1");
  assert.match(prepared.document.text.slice(exhibit!.start, exhibit!.end), /Total quarterly revenues/, "an exhibit block's span points into the combined document");
  assert.match(prepared.document.text, /fiscal first quarter results[\s\S]*Total quarterly revenues/);
});

test("a filing the archive does not hold is SEC_ARCHIVE_MISSING, never downloaded", async () => {
  await assert.rejects(prepareSecFiling(filing, null), new RegExp(SEC_ARCHIVE_MISSING));
  await assert.rejects(prepareSecFiling(filing, { ...archived, accession: "0001193125-26-000001" }), new RegExp(SEC_ARCHIVE_MISSING));
});

test("an exhibit's type is read from its file name", () => {
  assert.equal(exhibitType("orcl-ex99_1.htm"), "EX-99.1");
  assert.equal(exhibitType("ex991.htm"), "EX-99.1");
  assert.equal(exhibitType("a4q25erfex992supplement.htm"), "EX-99.2");
  assert.equal(exhibitType("exhibit99-1.htm"), "EX-99.1");
  assert.equal(exhibitType("ex-99.htm"), "EX-99");
  assert.equal(exhibitType("coreweave4q25earningspress.htm"), "EX-99");
});

test("the web search refuses EDGAR pages: SEC documents come from the archive", async () => {
  assert.ok(isEdgarUrl("https://www.sec.gov/Archives/edgar/data/1/0001-26-000001/a.htm"));
  assert.ok(!isEdgarUrl("https://investor.oracle.com/q1.pdf"));
  let fetched = 0;
  const service = new WebSearchService({ id: "test", search: async () => { throw new Error("unused"); }, fetchContent: async () => { fetched++; throw new Error("unused"); } } as never, {} as never);
  await assert.rejects(service.fetchContent({ url: "https://www.sec.gov/Archives/edgar/data/1/0001-26-000001/a.htm" }, { scope: "test" }), (e: unknown) => e instanceof WebSearchError && e.code === "archive_only");
  assert.equal(fetched, 0);
});

test("the SEC report follows the archive: it starts on filing.archived, and current reports collection skips are archived first", () => {
  assert.deepEqual(validateRegistry(), []);
  const discovered = SUBSCRIPTIONS["filing.discovered"]!;
  assert.ok(!discovered.some(s => s.task === "sec-report"), "the report no longer starts from a bare discovery");
  const archive = discovered.find(s => s.task === "archive")!;
  assert.equal(archive.when!({ type: "filing.discovered", ticker: "ORCL", detail: { form: "8-K", items: "5.02" } }), true);
  assert.equal(archive.when!({ type: "filing.discovered", ticker: "ORCL", detail: { form: "8-K", items: "2.02,9.01" } }), false, "an earnings release is collected, not archived twice");
  assert.equal(archive.when!({ type: "filing.discovered", ticker: "ORCL", detail: { form: "10-Q" } }), false);
  const report = SUBSCRIPTIONS["filing.archived"]!.find(s => s.task === "sec-report")!;
  assert.equal(report.when!({ type: "filing.archived", ticker: "ORCL", detail: { form: "8-K" } }), true);
  assert.equal(report.when!({ type: "filing.archived", ticker: "ORCL", detail: { form: "4" } }), false);
  assert.ok(TASKS.archive.emits.includes("filing.archived"));
});
