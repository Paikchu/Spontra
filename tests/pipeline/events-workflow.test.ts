import assert from "node:assert/strict";
import test from "node:test";
import { parseForm4, form4XmlUrl } from "../../workers/pipeline/src/events/form4.ts";
import { parseEventSubmissions, parseExhibitIndex, refreshCompanyEvents, runEventsSweep } from "../../workers/pipeline/src/events/workflow.ts";
import { eventsCacheKey } from "../../workers/pipeline/src/events/read.ts";
import { handleAnalysisReadRequest } from "../../workers/pipeline/src/read-api/router.ts";
import { D1SecRepository } from "../../workers/pipeline/src/sec/d1.ts";
import type { EventsResponse } from "../../shared/analysis-contract/events.ts";
import { createAnalysisDatabase, readEnv, readRequest } from "./helpers/analysis-backend.ts";

const FORM4 = `<?xml version="1.0"?>
<ownershipDocument>
  <schemaVersion>X0508</schemaVersion>
  <documentType>4</documentType>
  <periodOfReport>2026-09-15</periodOfReport>
  <aff10b5One>1</aff10b5One>
  <issuer><issuerCik>0001341439</issuerCik><issuerName>ORACLE CORP</issuerName><issuerTradingSymbol>ORCL</issuerTradingSymbol></issuer>
  <reportingOwner>
    <reportingOwnerId><rptOwnerCik>0001234567</rptOwnerCik><rptOwnerName>Doe Jane</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isDirector>0</isDirector><isOfficer>1</isOfficer><isTenPercentOwner>0</isTenPercentOwner><officerTitle>Chief Financial Officer</officerTitle></reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-09-15</value></transactionDate>
      <transactionCoding><transactionFormType>4</transactionFormType><transactionCode>M</transactionCode><equitySwap>0</equitySwap></transactionCoding>
      <transactionAmounts><transactionShares><value>20000</value></transactionShares><transactionPricePerShare><value>40.00</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode></transactionAmounts>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>220000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-09-15</value></transactionDate>
      <transactionCoding><transactionFormType>4</transactionFormType><transactionCode>S</transactionCode><equitySwap>0</equitySwap></transactionCoding>
      <transactionAmounts><transactionShares><value>12,000</value></transactionShares><transactionPricePerShare><value>150.10</value><footnoteId id="F1"/></transactionPricePerShare><transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>208000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-09-15</value></transactionDate>
      <transactionCoding><transactionFormType>4</transactionFormType><transactionCode>S</transactionCode><equitySwap>0</equitySwap></transactionCoding>
      <transactionAmounts><transactionShares><value>8000</value></transactionShares><transactionPricePerShare><value>151.00</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>200000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
  <derivativeTable>
    <derivativeTransaction>
      <securityTitle><value>Stock Option (right to buy)</value></securityTitle>
      <transactionDate><value>2026-09-15</value></transactionDate>
      <transactionCoding><transactionFormType>4</transactionFormType><transactionCode>M</transactionCode><equitySwap>0</equitySwap></transactionCoding>
      <transactionAmounts><transactionShares><value>20000</value></transactionShares><transactionPricePerShare><value>0</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>50000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature>
    </derivativeTransaction>
  </derivativeTable>
  <footnotes><footnote id="F1">The sales were effected pursuant to a Rule 10b5-1 trading plan adopted on June 20, 2026. Weighted average price; prices ranged from $149.80 to $150.40.</footnote></footnotes>
</ownershipDocument>`;

test("a Form 4 parses into the owner, the summed open-market sale, the exercise and the plan", () => {
  const t = parseForm4(FORM4)!;
  assert.equal(t.ownerCik, "1234567");
  assert.equal(t.ownerName, "Doe Jane");
  assert.equal(t.title, "Chief Financial Officer");
  assert.ok(t.isOfficer && !t.isDirector);
  assert.equal(t.rule10b51, true);
  assert.equal(t.planAdoptedOn, "2026-06-20");
  assert.equal(t.sold!.shares, 20_000);
  assert.equal(Math.round(t.sold!.proceeds), 12_000 * 150.1 + 8_000 * 151);
  assert.equal(t.sold!.averagePrice.toFixed(2), "150.46");
  assert.equal(t.exercised, 20_000);
  assert.equal(t.heldAfter, 200_000);
  assert.equal(t.lines.filter(l => l.derivative).length, 1);
  assert.equal(t.footnotes.length, 1);
  assert.equal(parseForm4("<html>not a form</html>"), null);
  assert.equal(form4XmlUrl("https://www.sec.gov/Archives/edgar/data/1341439/000134143926000123", "xslF345X05/wk-form4_1.xml"), "https://www.sec.gov/Archives/edgar/data/1341439/000134143926000123/wk-form4_1.xml");
});

const submissions = {
  filings: { recent: {
    accessionNumber: ["0001-26-000003", "0001-26-000002", "0001-26-000001", "0001-24-000001"],
    form: ["4", "8-K", "10-Q", "8-K"],
    filingDate: ["2026-09-17", "2026-09-10", "2026-09-11", "2024-01-05"],
    reportDate: ["2026-09-15", "2026-09-09", "2026-08-31", "2024-01-04"],
    primaryDocument: ["xslF345X05/wk-form4_1.xml", "orcl-8k.htm", "orcl-10q.htm", "old.htm"],
    primaryDocDescription: ["FORM 4", "8-K", "10-Q", "8-K"],
    items: ["", "2.02,9.01", "", "8.01"],
  } },
};

const INDEX_HTML = `<table class="tableFile"><tr><th>Seq</th><th>Description</th><th>Document</th><th>Type</th><th>Size</th></tr>
<tr><td scope="row">1</td><td scope="row">8-K</td><td scope="row"><a href="/Archives/edgar/data/1341439/000000012600000002/orcl-8k.htm">orcl-8k.htm</a></td><td scope="row">8-K</td><td>1</td></tr>
<tr><td scope="row">2</td><td scope="row">PRESS RELEASE</td><td scope="row"><a href="/Archives/edgar/data/1341439/000000012600000002/orcl-ex99_1.htm">orcl-ex99_1.htm</a></td><td scope="row">EX-99.1</td><td>2</td></tr>
<tr><td scope="row">3</td><td scope="row">XBRL</td><td scope="row"><a href="/x.xml">x.xml</a></td><td scope="row">EX-101.SCH</td><td>3</td></tr></table>`;

test("the submission list keeps 8-K and Form 4 inside the window; the index page yields the exhibits", () => {
  const now = new Date("2026-10-09T00:00:00Z");
  const raw = parseEventSubmissions(submissions, 1341439, now);
  assert.deepEqual(raw.map(f => f.form), ["4", "8-K"]);
  assert.equal(raw[1].items, "2.02,9.01");
  assert.equal(raw[0].archiveRoot, "https://www.sec.gov/Archives/edgar/data/1341439/000126000003");
  const exhibits = parseExhibitIndex(INDEX_HTML, "https://www.sec.gov/Archives/edgar/data/1341439/000000012600000002");
  assert.deepEqual(exhibits, [{ type: "EX-99.1", title: "PRESS RELEASE", url: "https://www.sec.gov/Archives/edgar/data/1341439/000000012600000002/orcl-ex99_1.htm" }]);
});

test("the sweep reads EDGAR once, fills Form 4 figures and exhibits, reuses the filing's summary, and the read API serves it", async () => {
  const database = await createAnalysisDatabase();
  const repository = new D1SecRepository(database as unknown as D1Database);
  const now = new Date("2026-10-09T00:00:00Z");
  await repository.setCache("sec:filings:ORCL", { ticker: "ORCL", company: { ticker: "ORCL", cik: "0001341439", name: "Oracle" }, filings: [], fetchedAt: now.toISOString(), status: "ready" }, now.toISOString());
  await database.prepare("INSERT INTO sec_filing_summaries (ticker, accession_number, payload, generated_at) VALUES (?, ?, ?, ?)").bind("ORCL", "0001-26-000002", JSON.stringify({
    ticker: "ORCL", form: "8-K", filingDate: "2026-09-10", accessionNumber: "0001-26-000002", headline: "Q1 云收入加速", bullets: [{ label: "云", detail: "+30%", importance: "high" }], analystView: "看 RPO", eventCategory: "earnings_update", source: "deepseek", generatedAt: "2026-09-10T12:00:00.000Z",
  }), "2026-09-10T12:00:00.000Z").run();
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("submissions/CIK0001341439.json")) return Response.json(submissions);
    if (url.endsWith("wk-form4_1.xml")) return new Response(FORM4, { headers: { "content-type": "application/xml" } });
    if (url.endsWith("-index.htm")) return new Response(INDEX_HTML, { headers: { "content-type": "text/html" } });
    return new Response("missing", { status: 404 });
  };
  const env = { DB: database as unknown as D1Database, SEC_USER_AGENT: "test", SEC_AI_TICKERS: "ORCL", SEC_AI_ENABLED: "true", SEC_DATA_TICKERS: "ORCL,MSFT" };
  const sweep = await runEventsSweep(env, fetcher, now);
  assert.deepEqual(sweep.refreshed, ["ORCL"]);
  assert.equal(sweep.insiderReads, 1);
  // MSFT has no discovered feed yet, so it is skipped rather than failed.
  assert.deepEqual(sweep.skipped, ["MSFT"]);
  const response = await handleAnalysisReadRequest(readRequest("/api/v1/companies/ORCL/events"), readEnv(database));
  assert.equal(response.status, 200);
  const body = await response.json() as EventsResponse;
  assert.equal(body.status, "ready");
  const events = body.events!.events;
  assert.deepEqual(events.map(e => [e.form, e.class]), [["4", "insider"], ["8-K", "earnings"]]);
  assert.equal(events[0].insider?.sold?.shares, 20_000);
  assert.equal(events[1].summary?.headline, "Q1 云收入加速");
  assert.deepEqual(events[1].exhibits.map(x => x.type), ["EX-99.1"]);
  assert.equal(events[1].edgarUrl, "https://www.sec.gov/Archives/edgar/data/1341439/000126000002/0001-26-000002-index.html");
  assert.equal(body.events!.pendingInsider, 0);
  // Within the refresh interval the list is not re-read, and already-read figures are reused without a request.
  const before = requests.length;
  assert.deepEqual((await runEventsSweep(env, fetcher, new Date(now.getTime() + 60_000))).skipped, ["ORCL", "MSFT"]);
  assert.equal(requests.length, before);
  const again = await refreshCompanyEvents(env, "ORCL", fetcher, new Date(now.getTime() + 60_000));
  assert.equal(again.insiderReads + again.exhibitReads, 0);
  assert.equal(requests.length, before);
  // A later tick re-reads the list; the stored publication still carries what was read.
  const later = await refreshCompanyEvents(env, "ORCL", fetcher, new Date(now.getTime() + 7 * 60 * 60_000));
  assert.equal(later.published, true);
  assert.equal(requests.filter(u => u.includes("submissions")).length, 2);
  const stored = await repository.getCache<{ events: Array<{ id: string }> }>(eventsCacheKey("ORCL"));
  assert.equal(stored?.payload.events.length, 2);
  // Nothing published reads as preparing, never as an empty list.
  assert.deepEqual(await (await handleAnalysisReadRequest(readRequest("/api/v1/companies/MSFT/events"), readEnv(database))).json(), { schemaVersion: "events-response.v1", status: "preparing", events: null });
});
