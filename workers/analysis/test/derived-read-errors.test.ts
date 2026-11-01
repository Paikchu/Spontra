import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveCompany } from "../src/financial-data/derived.ts";
import { auditDb } from "./fixtures/audit-data.ts";

const html = "<html><p>Unsupported layout</p></html>";
const record = { ticker: "ACME", documentId: "filing", rawKey: "financial-disclosures/filing", sourceBytes: Buffer.byteLength(html), contentSha256: "hash", source: { ticker: "ACME", form: "10-Q", accessionNumber: "0000000001-26-000001", filedAt: "2026-05-01", reportDate: "2026-03-31", documentUrl: "https://www.sec.gov/Archives/edgar/data/1/filing.htm" } };

test("A21: archived filing read failures cannot complete a derived snapshot", async () => {
  for (const get of [
    async () => { throw new Error("R2 read unavailable"); },
    async () => null,
    async () => ({ text: async () => "truncated" }),
  ]) {
    const fixture = auditDb({ audits: [record] });
    await assert.rejects(deriveCompany({ DB: fixture.db, SEC_FILINGS: { get } } as never, "ACME"), /R2 read unavailable|archived filing.*(missing|size)/i);
    assert.equal(fixture.writes.length, 0, "no success snapshot or filing cache may be written");
  }
});

test("A21: an unsupported layout is a successful empty parse, distinct from a read failure", async () => {
  const fixture = auditDb({ audits: [record] });
  const result = await deriveCompany({ DB: fixture.db, SEC_FILINGS: { get: async () => ({ text: async () => html }) } } as never, "ACME");
  assert.equal(result.pending, 0);
  assert.ok(fixture.writes.some(w => String(w.binds[0]).startsWith("sec:report-quarters:")));
});
