import assert from "node:assert/strict";
import test from "node:test";
import type { PublicBusinessFlow } from "../../../shared/analysis-contract/business-flow.ts";
import type { StoredAudit } from "../src/financial-data/disclosure-audit.ts";
import { reportCandidates } from "../src/financial-data/derived.ts";

const folder = "https://www.sec.gov/Archives/edgar/data/1513845/";
const audit = (n: number, filedAt: string, file: string): StoredAudit => ({
  documentId: `doc-${n}`, ticker: "NBIS", contentSha256: `sha-${n}`, sourceBytes: 1000, rawKey: `financial-disclosures/x/${n}/source.html`, inventoryKey: `i-${n}`,
  source: { ticker: "NBIS", accessionNumber: `0001104659-26-${String(n).padStart(6, "0")}`, documentUrl: `${folder}${n}/${file}`, form: "6-K", reportDate: filedAt, filedAt },
} as unknown as StoredAudit);
const flow = { ticker: "NBIS", quarters: [{ periodEnd: "2026-06-30", sources: [{ url: `${folder}1/nbis-20260812xex99d2.htm` }] }] } as unknown as PublicBusinessFlow;

test("a foreign issuer's earnings exhibit stays a candidate behind many newer notices", () => {
  // Thirty notices filed after the earnings release: a fixed filing cap used to cut the release off.
  const notices = Array.from({ length: 30 }, (_, i) => audit(100 + i, `2026-09-${String(1 + (i % 28)).padStart(2, "0")}`, `notice-${i}.htm`));
  const release = audit(1, "2026-08-12", "nbis-20260812xex99d2.htm");
  const candidates = reportCandidates([...notices, release], flow);
  assert.equal(candidates.length, 31);
  assert.equal(candidates.at(-1)!.documentId, "doc-1");
});
