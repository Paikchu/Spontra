import assert from "node:assert/strict";
import { test } from "node:test";
import type { EventsPublication } from "../../../shared/analysis-contract/events.ts";
import { refreshCompanyEvents, type EventsSweepEnv } from "../src/events/workflow.ts";
import { parseSecArchiveDocumentUrl, secArchiveDocumentUrl, secArchiveRoot } from "../../../shared/analysis-runtime/sec-sources.ts";

const now = new Date("2026-10-30T10:00:00.000Z");
const accession = "0001193125-26-438090";
const directory = "000119312526438090";
const root = `https://www.sec.gov/Archives/edgar/data/1067983/${directory}`;
const documentUrl = `${root}/report.htm`;

// No database is opened: SELECTs read fixtures and batch only captures the proposed publication.
function harness(publication: EventsPublication | null = null) {
  let published: EventsPublication | null = null;
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => {
      if (sql.includes("FROM sec_filing_summaries")) return null;
      assert.ok(sql.includes("FROM sec_cache"), sql);
      const key = values[0];
      const payload = key === "events:v1:BRK.B" ? publication
        : key === "sec:filings:BRK.B" ? { company: { cik: "0001067983" }, filings: [] }
        : key === `exhibits:v1:BRK.B:${accession}` ? [] : null;
      return payload === null ? null : { payload: JSON.stringify(payload), fetchedAt: now.toISOString() };
    },
    // The filings list indexed from the same submissions read: none known yet.
    all: async () => { assert.ok(sql.includes("FROM sec_filings"), sql); return { results: [] }; },
    run: async () => { throw new Error("Unexpected database write"); },
    sql, values,
  });
  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: ReturnType<typeof statement>[]) => {
      if (statements[0].sql.includes("INSERT INTO sec_filings")) return [];
      assert.equal(statements[0].values[0], "events:v1:BRK.B");
      published = JSON.parse(String(statements[0].values[1]));
      return [];
    },
  } as unknown as D1Database;
  const env: EventsSweepEnv = { DB: db, SEC_USER_AGENT: "test", SEC_DATA_TICKERS: "", SEC_AI_TICKERS: "", SEC_AI_ENABLED: "false" };
  return { env, publication: () => { assert.ok(published); return published; } };
}

async function fromSubmissions(primaryDocument: string) {
  const h = harness();
  const reads: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    reads.push(String(input));
    assert.equal(String(input), "https://data.sec.gov/submissions/CIK0001067983.json");
    return Response.json({ filings: { recent: {
      accessionNumber: [accession], form: ["8-K"], filingDate: ["2026-10-29"], reportDate: ["2026-10-29"],
      primaryDocument: [primaryDocument], primaryDocDescription: ["Results of Operations"], items: ["2.02,9.01"],
    } } });
  }) as typeof fetch;
  await refreshCompanyEvents(h.env, "BRK.B", fetcher, now, { forceList: true });
  assert.equal(reads.length, 1);
  return h.publication();
}

test("AD-1: a bare primaryDocument produces one accession directory", async () => {
  const publication = await fromSubmissions("report.htm");
  assert.equal(publication.events[0].documentUrl, documentUrl);
  assert.equal(publication.events[0].edgarUrl, `${root}/${accession}-index.html`);
});

test("AD-1: primaryDocument already prefixed with the accession directory is not appended twice", async () => {
  const publication = await fromSubmissions(`${directory}/report.htm`);
  assert.equal(publication.events[0].documentUrl, documentUrl);
});

test("AD-1: a cached publication round-trips documentUrl unchanged over repeated refreshes", async () => {
  let publication = await fromSubmissions("report.htm");
  const noFetch = (async () => { throw new Error("Cached publication must not fetch"); }) as typeof fetch;
  for (let i = 0; i < 3; i++) {
    const h = harness(publication);
    const result = await refreshCompanyEvents(h.env, "BRK.B", noFetch, now);
    assert.equal(result.exhibitReads, 0);
    publication = h.publication();
    assert.equal(publication.events[0].documentUrl, documentUrl);
    assert.equal(publication.events[0].edgarUrl, `${root}/${accession}-index.html`);
  }
});

test("archive URL parsing preserves document subdirectories, encoding and suffixes", () => {
  for (const primaryDocument of ["report.htm", "xslF345X06/ownership.xml", "attachments/results%20Q3.htm?download=1#results"]) {
    const url = `${root}/${primaryDocument}`;
    const parsed = parseSecArchiveDocumentUrl(url);
    assert.deepEqual(parsed, { archiveRoot: root, primaryDocument });
    assert.equal(secArchiveDocumentUrl(parsed.archiveRoot, parsed.primaryDocument), url);
    assert.equal(secArchiveDocumentUrl(root, `${directory}/${primaryDocument}`), url);
  }
});

test("migrated filename builders retain their previous URL bytes", () => {
  assert.equal(secArchiveRoot(Number("0001067983"), accession), root);
  const filenames = ["report.htm", `${accession}-index.htm`, `${accession}-index.html`, `${accession}.txt`,
    encodeURIComponent("results Q3.htm"), encodeURIComponent("folder/results.htm"), ""];
  for (const filename of filenames) assert.equal(secArchiveDocumentUrl(root, filename), `${root}/${filename}`);
});
