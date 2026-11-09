import { test } from "node:test";
import assert from "node:assert/strict";
import { exhibitType } from "../src/sec-archive/archive.ts";
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

test("an exhibit's type is read from its file name", () => {
  assert.equal(exhibitType("orcl-ex99_1.htm"), "EX-99.1");
  assert.equal(exhibitType("ex991.htm"), "EX-99.1");
  assert.equal(exhibitType("a4q25erfex992supplement.htm"), "EX-99.2");
  assert.equal(exhibitType("exhibit99-1.htm"), "EX-99.1");
  assert.equal(exhibitType("ex-99.htm"), "EX-99");
  assert.equal(exhibitType("coreweave4q25earningspress.htm"), "EX-99");
});

test("the web search drops EDGAR hits from its results, cached ones included", async () => {
  const hit = (url: string) => ({ url, title: "t", snippet: "s", publishedAt: null, score: 1 });
  const stored = { kind: "search", results: [hit("https://www.sec.gov/Archives/edgar/data/1/0001-26-000001/a.htm"), hit("https://investor.oracle.com/q1")] };
  const store = { read: async () => ({ data: stored, fetchedAt: Date.now() - 1000, expiresAt: Date.now() + 60_000 }), claim: async () => true, publish: async () => undefined, release: async () => undefined };
  const service = new WebSearchService({ id: "test", search: async () => { throw new Error("unused: cached"); }, fetchContent: async () => { throw new Error("unused"); } } as never, store as never);
  const found = await service.search({ query: "oracle results" }, { scope: "test" });
  assert.deepEqual(found.data.results.map(r => r.url), ["https://investor.oracle.com/q1"]);
});

test("the web search refuses EDGAR pages: SEC documents come from the archive", async () => {
  assert.ok(isEdgarUrl("https://www.sec.gov/Archives/edgar/data/1/0001-26-000001/a.htm"));
  assert.ok(!isEdgarUrl("https://investor.oracle.com/q1.pdf"));
  assert.ok(isEdgarUrl("https://www.sec.gov./Archives/edgar/data/1/0001-26-000001/a.htm"), "a trailing DNS dot names the same host");
  assert.ok(isEdgarUrl("https://WWW.SEC.GOV/Archives/edgar/data/1/0001-26-000001/a.htm"));
  assert.ok(!isEdgarUrl("https://sec.gov.example.com/a.htm"));
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
  assert.equal(archive.when!({ type: "filing.discovered", ticker: "ORCL", detail: { form: "8-K", items: "2.02,9.01" } }), true, "a release collection also reads is archived once: stored documents are not downloaded again");
  assert.equal(archive.when!({ type: "filing.discovered", ticker: "ORCL", detail: { form: "10-Q" } }), true, "a periodic report collection may skip (same-day as its release) is archived by the task; a stored copy is read back");
  // Every current report and 40-F is archived by the task, amended or not; collection's own copies are read back, not downloaded again.
  assert.equal(archive.when!({ type: "filing.discovered", ticker: "ORCL", detail: { form: "8-K/A", items: "2.02,9.01" } }), true, "an amended earnings release is not collected");
  assert.equal(archive.when!({ type: "filing.discovered", ticker: "ORCL", detail: { form: "6-K/A" } }), true);
  assert.equal(archive.when!({ type: "filing.discovered", ticker: "ORCL", detail: { form: "40-F" } }), true);
  assert.equal(archive.when!({ type: "filing.discovered", ticker: "NBIS", detail: { form: "6-K" } }), true, "a 6-K collection's incremental window leaves out is still archived");
  assert.equal(archive.when!({ type: "filing.discovered", ticker: "ORCL", detail: { form: "4" } }), false);
  assert.equal(archive.when!({ type: "filing.discovered", ticker: "ORCL", detail: { form: "10-Q/A" } }), true, "a periodic amendment inside collection's incremental window is not collected");
  assert.equal(archive.when!({ type: "filing.discovered", ticker: "ORCL", detail: { form: "20-F" } }), true);
  assert.equal(archive.when!({ type: "filing.discovered", ticker: "ORCL", detail: { form: "424B5" } }), true, "the item analysis reads prospectus supplements; nothing else stores them");
  assert.equal(archive.when!({ type: "filing.discovered", ticker: "ORCL", detail: { form: "DEF 14A" } }), false);
  assert.deepEqual(SUBSCRIPTIONS["archive.requested"]!.map(s => s.task), ["archive"], "a baseline's current reports are archived without a filing.discovered");
  const report = SUBSCRIPTIONS["filing.archived"]!.find(s => s.task === "filing-analysis")!;
  assert.equal(report.when!({ type: "filing.archived", ticker: "ORCL", detail: { form: "8-K" } }), true);
  assert.equal(report.when!({ type: "filing.archived", ticker: "ORCL", detail: { form: "4" } }), false);
  assert.ok(TASKS.archive.emits.includes("filing.archived"));
  assert.ok(SUBSCRIPTIONS["archive.unsupported"]!.some(s => s.task === "filing-analysis" && s.when!({ type: "archive.unsupported", ticker: "ORCL", detail: { form: "10-Q" } })), "a filing the archive gave up on sends the report back to regroup");
  const guidance = SUBSCRIPTIONS["filing.archived"]!.find(s => s.task === "guidance")!;
  assert.equal(guidance.when!({ type: "filing.archived", ticker: "ORCL", detail: { form: "8-K" } }), true, "a release that waited for the archive restarts its guidance");
});
