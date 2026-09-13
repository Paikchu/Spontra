import assert from "node:assert/strict";
import test from "node:test";

import { encodePageCursor } from "../../workers/pipeline/src/sec/config.ts";
import { getPublicFilingPage } from "../../workers/pipeline/src/sec/public-api.ts";
import { AnalysisRequestError } from "../../workers/pipeline/src/read-api/contract-support/errors.ts";

test("maps migrated filings to the public contract without generation", async () => {
  const fakeRepository = {
    async countPublicFilings() { return 1; },
    async listPublicFilings() {
      return {
        nextCursor: null,
        filings: [{
          ticker: "MSFT", cik: "0000789019", cikNumber: 789019, companyName: "MSFT", form: "10-Q",
          filingDate: "2026-07-30", reportDate: "2026-06-30", accessionNumber: "0001-26-000001",
          primaryDocument: "msft.htm", description: "Quarterly report", items: "", documentUrl: "https://sec.test/doc", indexUrl: "https://sec.test/index",
          summary: { ticker: "MSFT", form: "10-Q", filingDate: "2026-07-30", accessionNumber: "0001-26-000001", headline: "Revenue grew", bullets: [], analystView: "", source: "deepseek", generatedAt: "2026-08-01T00:00:00Z" },
          analysis: null,
        }],
      };
    },
    async getLatestAnalysisJobStatus() { return null; },
  };
  const page = await getPublicFilingPage(fakeRepository as never, "msft", null, "20");
  assert.equal(page.ticker, "MSFT");
  assert.equal(page.filings[0].analysisStatus, "not_collected");
  assert.equal(page.filings[0].edgarUrl, "https://sec.test/index");
});

test("rejects malformed public ticker paths instead of rewriting them", async () => {
  // The rejection now carries the machine code the HTTP contract publishes, so the router maps it
  // to 400 INVALID_TICKER without matching on prose.
  await assert.rejects(
    () => getPublicFilingPage({} as never, "MS/FT", null, "20"),
    (error: unknown) => error instanceof AnalysisRequestError && error.code === "INVALID_TICKER",
  );
  await assert.rejects(
    () => getPublicFilingPage({} as never, "MSFT", "not-a-cursor!", "20"),
    (error: unknown) => error instanceof AnalysisRequestError && error.code === "INVALID_CURSOR",
  );
});

test("always pages durable grouping rather than a stale per-file cache window", async () => {
  const cached = Array.from({ length: 40 }, (_, index) => ({
    ticker: "MSFT", cik: "0000789019", cikNumber: 789019, companyName: "Microsoft", form: "8-K",
    filingDate: `2026-${String(12 - Math.floor(index / 4)).padStart(2, "0")}-${String(28 - (index % 4)).padStart(2, "0")}`,
    reportDate: "", accessionNumber: `0001-26-${String(1000 - index).padStart(6, "0")}`,
    primaryDocument: "msft.htm", description: "Current report", items: "",
    documentUrl: "https://sec.test/doc", indexUrl: "https://sec.test/index",
  }));
  const summaryReads: string[] = [];
  const listed: (string | null)[] = [];
  const fakeRepository = {
    async getCache() { return { payload: { ticker: "MSFT", company: null, filings: cached, fetchedAt: "2026-12-28T00:00:00Z", status: "ready" }, fetchedAt: "2026-12-28T00:00:00Z" }; },
    async getSummary(_ticker: string, accessionNumber: string) { summaryReads.push(accessionNumber); return null; },
    async countPublicFilings() { return 137; },
    async listPublicFilings(_ticker: string, cursor: string | null) { listed.push(cursor); return { filings: [], nextCursor: cursor ? null : encodePageCursor({ filingDate: "2026-08-28", accessionNumber: "0001-26-000980" }) }; },
    async getLatestAnalysisJobStatus() { return null; },
  };

  const first = await getPublicFilingPage(fakeRepository as never, "msft", null, "20");
  assert.equal(first.filings.length, 0);
  assert.equal(first.total, 137);
  // Cached individual filings must not bypass durable grouping, even on the first page.
  assert.equal(summaryReads.length, 0);
  assert.deepEqual(listed, [null]);
  listed.length = 0;

  // The window ends exactly at this page, so D1 answers it and the cursor chain carries on past 40.
  summaryReads.length = 0;
  const second = await getPublicFilingPage(fakeRepository as never, "msft", first.nextCursor, "20");
  assert.equal(summaryReads.length, 0);
  assert.deepEqual(listed, [first.nextCursor]);
  assert.equal(second.total, null);

  listed.length = 0;
  const deepCursor = encodePageCursor({ filingDate: "2020-01-01", accessionNumber: "0000-00-000000" });
  const deep = await getPublicFilingPage(fakeRepository as never, "msft", deepCursor, "20");
  // Older than everything cached, so the cache costs nothing and D1 answers instead.
  assert.equal(summaryReads.length, 0);
  assert.deepEqual(listed, [deepCursor]);
  assert.equal(deep.total, null);
});
