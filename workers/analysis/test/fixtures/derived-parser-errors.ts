import assert from "node:assert/strict";
import { mock, test } from "node:test";
import * as parser from "../../src/financial-data/parser.ts";
import { auditDb } from "./audit-data.ts";

let calls = 0;
mock.module(new URL("../../src/financial-data/parser.ts", import.meta.url).href, { namedExports: { ...parser, extractDisclosedQuarters: () => { calls++; throw new Error("injected parser failure"); } } });
const { deriveCompany, REPORT_QUARTERS_VERSION } = await import("../../src/financial-data/derived.ts");
const html = "<html><p>Unsupported layout</p></html>";
const record = { ticker: "ACME", documentId: "filing", rawKey: "financial-disclosures/filing", sourceBytes: Buffer.byteLength(html), contentSha256: "hash", source: { ticker: "ACME", form: "10-Q", accessionNumber: "0000000001-26-000001", filedAt: "2026-05-01", reportDate: "2026-03-31", documentUrl: "https://www.sec.gov/Archives/edgar/data/1/filing.htm" } };

test("A22: a parser exception cannot be cached as an empty supported result", async () => {
  const fixture = auditDb({ audits: [record] });
  const env = { DB: fixture.db, SEC_FILINGS: { get: async () => ({ text: async () => html }) } } as never;
  // A21 separately changes the task's terminal behavior. Here either result must never cache the failed parse.
  await deriveCompany(env, "ACME").catch(error => { assert.match(error.message, /injected parser failure/); });
  assert.equal(calls, 1);
  assert.equal(fixture.writes.filter(w => String(w.binds[0]).startsWith("sec:report-quarters:")).length, 0);
  await deriveCompany(env, "ACME").catch(error => { assert.match(error.message, /injected parser failure/); });
  assert.equal(calls, 2, "identical input must be parsed again after failure");
});

test("A22: cached empty results written by the swallowing parser are invalidated", async () => {
  const fixture = auditDb({ audits: [record], quarters: [{ documentId: record.documentId, contentSha256: "hash", version: `report-quarters.v2:${parser.SEC_FLOW_PARSER_VERSION}`, industry: "standard", labels: "unneeded", quarters: [] }] });
  const before = calls;
  await deriveCompany({ DB: fixture.db, SEC_FILINGS: { get: async () => ({ text: async () => html }) } } as never, "ACME").catch(error => { assert.match(error.message, /injected parser failure/); });
  assert.equal(calls, before + 1);
  assert.notEqual(REPORT_QUARTERS_VERSION, `report-quarters.v2:${parser.SEC_FLOW_PARSER_VERSION}`);
});
