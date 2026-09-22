import assert from "node:assert/strict";
import test from "node:test";
import { identifyReaderMarketSnapshot, normalizeReaderReport } from "../../workers/pipeline/src/sec/reader.ts";
import { summarizePreparedSecFiling } from "../../workers/pipeline/src/sec/pipeline.ts";
import { applyEditorialPatch } from "../../workers/pipeline/src/sec/editorial.ts";
import { buildSecAnalysisBrief } from "../../workers/pipeline/src/sec/analysis.ts";
import { createSecPipelineOperations, type SecPipelineEnv } from "../../workers/pipeline/src/operations.ts";
import { readerFixture, readerFilingFixture, readerNodes } from "../fixtures/sec-reader-fixture.ts";
import type { SecReaderContentBlock } from "../../shared/analysis-runtime/sec-reader-schema.ts";
import type { SecNodePlan } from "../../workers/pipeline/src/sec/sec.ts";

const plan: SecNodePlan = { nodes: [{ id: "demand", title: "需求", question: "回款", sectionIds: ["s"], materiality: "high", historySeriesIds: [], memoryIds: [], acceptanceCriteria: [] }], outlineSections: 1 };
const options = { nodes: readerNodes, plan, currentEvidence: new Set(["ev:demand"]), priorEvidence: new Set(["xbrl:prior"]), chartKeys: new Set<string>() };
const snapshot = () => readerFilingFixture().analysis!.marketSnapshot!;
const makeBrief = () => buildSecAnalysisBrief({ ticker: "DEMO", filingId: "demo-quarter", periodId: "DEMO:2026-06-30:quarter", periodScope: "quarter", reportDate: "2026-06-30", history: { registryVersion: "sec-canonical-series.v1", series: [] }, memorySummary: "", memoryItems: [] });
function v2() {
  const legacy = readerFixture();
  return { ...legacy, version: "sec-reader.v2" as const, sections: legacy.sections.map((section) => ({ ...section,
    content: section.paragraphs.map((markdown, index): SecReaderContentBlock => ({ type: "markdown", blockId: `${section.id}-prose-${index + 1}`, markdown, evidenceIds: section.evidenceIds })),
  })) };
}

test("market identity is bound to ticker, source and exact frozen snapshot, not an arbitrary market prefix", async () => {
  const current = await identifyReaderMarketSnapshot("DEMO", snapshot());
  assert.match(current!.evidenceId!, /^market:DEMO:[a-f0-9]{64}$/);
  assert.equal((await identifyReaderMarketSnapshot("DEMO", { ...snapshot(), evidenceId: "market:forged" }))!.evidenceId, current!.evidenceId);
  assert.notEqual((await identifyReaderMarketSnapshot("DEMO", { ...snapshot(), price: 121 }))!.evidenceId, current!.evidenceId);
  assert.notEqual((await identifyReaderMarketSnapshot("DEMO", { ...snapshot(), asOf: "2026-08-15T12:00:00Z" }))!.evidenceId, current!.evidenceId);
  assert.notEqual((await identifyReaderMarketSnapshot("OTHER", snapshot()))!.evidenceId, current!.evidenceId);
  const allowed = { ...options, currentEvidence: new Set([...options.currentEvidence, current!.evidenceId!]) };
  const reader = v2(); reader.sections[1].content[0].evidenceIds = [current!.evidenceId!];
  assert.doesNotThrow(() => normalizeReaderReport(reader, allowed));
  for (const bad of ["market:forged", (await identifyReaderMarketSnapshot("DEMO", { ...snapshot(), price: 121 }))!.evidenceId!]) {
    reader.sections[1].content[0].evidenceIds = [bad];
    assert.throws(() => normalizeReaderReport(reader, allowed), /lacks grounded evidence/);
  }
  reader.sections[0].content[0].evidenceIds = ["ev:invented"];
  assert.throws(() => normalizeReaderReport(reader, allowed), /lacks grounded evidence/);
});

test("missing price, unavailable snapshot or invalid source cannot manufacture a market citation", async () => {
  for (const invalid of [
    { ...snapshot(), status: "unavailable" as const },
    { ...snapshot(), price: undefined },
    { ...snapshot(), price: NaN },
    { ...snapshot(), sourceUrl: "https://user:password@example.com/quote" },
    { ...snapshot(), sourceUrl: "javascript:alert(1)" },
    { ...snapshot(), priceDate: "2026-02-30" },
  ]) assert.equal((await identifyReaderMarketSnapshot("DEMO", { ...invalid, evidenceId: "market:forged" }))!.evidenceId, undefined);
});

test("synthesis persists exactly the market source identity supplied to the model and independent auditor", async () => {
  const filing = readerFilingFixture(), brief = makeBrief(); brief.marketSnapshot = snapshot();
  let citedIdentity = "";
  const result = await summarizePreparedSecFiling({ filing, periodId: brief.periodId, periodScope: "quarter", blockIds: ["ev:demand"], outline: [] },
    { currentPeriodId: brief.periodId, qoqPeriodId: null, yoyPeriodId: null }, async (_stage, _system, raw) => {
      const payload = raw as { marketSnapshot: { evidenceId: string }; allowedEvidenceIds: string[] };
      citedIdentity = payload.marketSnapshot.evidenceId;
      assert.ok(payload.allowedEvidenceIds.includes(citedIdentity));
      const reader = v2(); reader.sections[1].content[0].evidenceIds = [citedIdentity];
      return { readerReport: reader, headline: "需求与回报", bullets: [{ label: "现金", detail: "观察现金兑现。" }], analystView: "估值需要结合持续盈利。", report: "", keyMetrics: [] };
    }, new Date("2026-08-14T12:00:00Z"), plan, readerNodes, brief);
  assert.equal(result.artifact.report.marketSnapshot!.evidenceId, citedIdentity);
  assert.equal(result.artifact.report.marketSnapshot!.price, 120);
  assert.equal(result.artifact.report.reader!.sections[1].content![0].evidenceIds[0], citedIdentity);
  assert.ok(!result.artifact.validEvidenceIds.includes(citedIdentity), "market source must not enter the SEC financial ledger");
  const env = { DEEPSEEK_API_KEY: "synthetic-test-key", SEC_FILINGS: { async get() { return null; }, async put() {} } } as unknown as SecPipelineEnv;
  const operations = createSecPipelineOperations(env, async (_url, init) => {
    const payload = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    assert.equal(payload.marketSnapshot.evidenceId, citedIdentity);
    assert.equal(payload.marketSnapshot.price, 120);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ verdict: "revise", issues: [{ id: "price", category: "fact", severity: "major", quote: "120美元", evidenceIds: [citedIdentity], detail: "核对冻结报价日期。", acceptance: "保留报价日期。" }] }) } }] });
  });
  const audit = await operations.auditReport!({ key: "filings/DEMO/demo-quarter", filing }, readerNodes, brief, result, 0);
  assert.equal(audit.findings![0].category, "fact");
  assert.deepEqual(audit.findings![0].evidenceIds, [citedIdentity]);
});

test("a section patch can repair malformed string blocks and invalid citations without inventing evidence", async () => {
  const market = await identifyReaderMarketSnapshot("DEMO", snapshot());
  const allowed = { ...options, currentEvidence: new Set([...options.currentEvidence, market!.evidenceId!]) };
  const malformed = JSON.parse(JSON.stringify(v2()));
  malformed.sections[1].content[0] = "示例收盘价为120美元，仍需结合持续盈利。";
  assert.throws(() => normalizeReaderReport(malformed, allowed), /expected object/);
  const fixedSection = structuredClone(v2().sections[1]);
  fixedSection.content[0] = { type: "markdown", blockId: "s6-price-anchor", markdown: malformed.sections[1].content[0], evidenceIds: [market!.evidenceId!] };
  const patch = applyEditorialPatch({ readerReport: malformed }, { replaceSections: [{ sectionId: fixedSection.id, section: fixedSection }] });
  assert.doesNotThrow(() => normalizeReaderReport(patch.readerReport, allowed));
  const wrong = structuredClone(fixedSection); wrong.content[0].evidenceIds = [];
  assert.throws(() => normalizeReaderReport(applyEditorialPatch({ readerReport: malformed }, { replaceSections: [{ sectionId: wrong.id, section: wrong }] }).readerReport, allowed), /lacks grounded evidence/);
});


test("section validation names its stable ID and every actual failed structural requirement", () => {
  const draft = v2();
  const invalid = { ...draft, sections: draft.sections.map((section, index) => index === 1 ? {
    ...section, id: "price-and-valuation", title: "", content: [], takeaway: "", role: "unknown", evidenceIds: ["ev:invented"], nodeIds: ["unfinished-node"],
  } : section) };
  assert.throws(() => normalizeReaderReport(invalid, options), (error: unknown) => {
    assert.ok(error instanceof Error);
    for (const expected of ["price-and-valuation (#2)", "title缺失", "markdown正文块数为0", "takeaway缺失", "role无效", "section.evidenceIds", "section.nodeIds"]) assert.ok(error.message.includes(expected), expected);
    return true;
  });
});
