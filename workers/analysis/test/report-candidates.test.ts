import assert from "node:assert/strict";
import test from "node:test";
import type { PublicBusinessFlow } from "../../../shared/analysis-contract/business-flow.ts";
import type { StoredAudit } from "../src/financial-data/disclosure-audit.ts";
import { reportCandidates, supersedes } from "../src/financial-data/derived.ts";
import type { BusinessFlowQuarter } from "../../../shared/analysis-contract/business-flow.ts";

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

// Meta's third quarter of 2025: the 8-K of October 2026 prints it beside the new quarter as consolidated amounts only;
// its own 10-Q verified the Family of Apps / Reality Labs split for the same figures.
const quarter = (segments: string[], revenue: number, operating: number, single = false) => ({
  periodEnd: "2025-09-30", figures: { revenue: { value: String(revenue) }, operating: { value: String(operating) } },
  segments: segments.map(id => ({ id })), ...(single ? { segmentDisclosure: "single_reportable_segment" } : {}),
}) as unknown as BusinessFlowQuarter;

test("an older quarterly report's segment split takes a period over from an exhibit that printed the same figures whole", () => {
  const exhibit = quarter(["reported-company-total"], 51242e6, 20535e6), report = quarter(["meta:FamilyOfAppsMember", "meta:RealityLabsMember"], 51242e6, 20535e6);
  assert.equal(supersedes(report, exhibit), true);
  // The newer filing's split, or recast figures, or a single reportable segment stay as the newer filing presents them.
  assert.equal(supersedes(exhibit, report), false);
  assert.equal(supersedes(quarter(["meta:FamilyOfAppsMember", "meta:RealityLabsMember"], 51240e6, 20535e6), exhibit), false);
  assert.equal(supersedes(report, quarter(["reported-company-total"], 51242e6, 20535e6, true)), false);
});

test("a first quarter the exhibit derived from six months and the second quarter gives way within one printed unit", () => {
  // Meta's 8-K of July 2026 prints six months and the second quarter in millions; its first quarter of 2026 derives to
  // 56,310 and 22,872, where the 10-Q for March 31, 2026 reports 56,311 and 22,871.
  const derived = (q: BusinessFlowQuarter) => ({ ...q, figures: Object.fromEntries(Object.entries(q.figures).map(([k, f]) => [k, { ...f, basis: "derived" }])) }) as BusinessFlowQuarter;
  const exhibit = derived(quarter(["reported-company-total"], 56310e6, 22872e6)), report = quarter(["meta:FamilyOfAppsMember", "meta:RealityLabsMember"], 56311e6, 22871e6);
  assert.equal(supersedes(report, exhibit), true);
  assert.equal(supersedes(quarter(["meta:FamilyOfAppsMember", "meta:RealityLabsMember"], 56312e6, 22871e6), exhibit), false);
  // A figure the exhibit printed itself is not rounded twice, and must match.
  assert.equal(supersedes(report, quarter(["reported-company-total"], 56310e6, 22872e6)), false);
});
