import assert from "node:assert/strict";
import test from "node:test";
import { SEC_READER_REPORT_SCHEMA, SEC_READER_CONTENT_BLOCK_SCHEMA, SEC_READER_ASSET_SCHEMA, SEC_READER_JSON_SCHEMA, SEC_READER_MAX_SECTIONS, parseSecReaderReport } from "../../shared/analysis-runtime/sec-reader-schema.ts";
import type { SecReaderAsset, SecReaderContentBlock } from "../../shared/analysis-runtime/sec-reader-schema.ts";
import { normalizeReaderReport, normalizeReaderSummaryText, readerArticleText } from "../../workers/pipeline/src/sec/reader.ts";
import { applyEditorialPatch, assertReaderIntegrity } from "../../workers/pipeline/src/sec/editorial.ts";
import { validateJsonSchema, assertSupportedSchema } from "../../workers/pipeline/src/read-api/contract-support/json-schema.ts";
import { readerFixture, readerFilingFixture, readerNodes } from "../fixtures/sec-reader-fixture.ts";
import { normalizeSecSummary, type SecNodePlan } from "../../workers/pipeline/src/sec/sec.ts";
import { summarizePreparedSecFiling } from "../../workers/pipeline/src/sec/pipeline.ts";
import { buildSecAnalysisBrief } from "../../workers/pipeline/src/sec/analysis.ts";
import { FILING_DETAIL_SCHEMA } from "../../workers/pipeline/src/read-api/contract-support/schema.ts";

const plan: SecNodePlan = { nodes: [{ id: "demand", title: "需求", question: "资金支持", sectionIds: ["s"], historySeriesIds: [], memoryIds: [], acceptanceCriteria: [], materiality: "high" }], outlineSections: 1 };
const args = { nodes: readerNodes, plan, currentEvidence: new Set(["ev:demand"]), priorEvidence: new Set(["xbrl:prior"]), chartKeys: new Set(["capex"]), requireVisual: true };
function draftV2() {
  const fixture = readerFixture();
  return { ...fixture, version: "sec-reader.v2" as const, sections: fixture.sections.map((section, i) => ({ ...section,
    id: `topic-${i + 1}`,
    content: section.paragraphs.map((markdown, j): SecReaderContentBlock => ({ type: "markdown", blockId: `topic-${i + 1}-paragraph-${j + 1}`, markdown, evidenceIds: section.evidenceIds, groupId: `topic-${i + 1}-argument` })),
  })) };
}
const chart: SecReaderContentBlock = { type: "chart", blockId: "capital-comparison", evidenceIds: ["ev:demand"], groupId: "topic-1-argument", layout: "wrap", metricKey: "capex", mark: "bar", title: "资本开支规模", caption: "比较投入规模，不能证明回款改善。" };

test("v2 keeps author order and persistent IDs; legacy projection cannot override current text", () => {
  const input = draftV2(); input.sections[0].content.splice(1, 0, chart);
  input.sections[0].paragraphs = ["过期正文一", "过期正文二"];
  const reader = normalizeReaderReport(input, args);
  assert.equal(reader.version, "sec-reader.v2");
  assert.deepEqual(reader.sections[0].content?.map((b) => b.blockId), ["topic-1-paragraph-1", "capital-comparison", "topic-1-paragraph-2"]);
  assert.equal(reader.sections[0].id, "topic-1");
  assert.equal(reader.sections[0].paragraphs[0], readerFixture().sections[0].paragraphs[0]);
  assert.doesNotMatch(readerArticleText(reader), /过期正文/);
  assert.match(readerArticleText(reader), /不能证明回款改善/);
  const roundtrip = parseSecReaderReport(JSON.parse(JSON.stringify(reader)));
  assert.deepEqual(roundtrip.reader, { ...reader, presentationWarnings: reader.presentationWarnings ?? [] });
});

test("generation rejects duplicate IDs, unavailable charts, ungrounded blocks and fabricated assets", () => {
  const duplicate = draftV2(); duplicate.sections[1].content[0].blockId = duplicate.sections[0].content[0].blockId;
  assert.throws(() => normalizeReaderReport(duplicate, args), /id repeats/);
  const unavailable = draftV2(); unavailable.sections[0].content.push({ ...chart, metricKey: "invented" });
  assert.throws(() => normalizeReaderReport(unavailable, args), /unavailable/);
  const evidence = draftV2(); evidence.sections[0].content[0].evidenceIds = ["invented"];
  assert.throws(() => normalizeReaderReport(evidence, args), /grounded evidence/);
  const image = draftV2(); image.sections[0].content.push({ type: "image", blockId: "source-image", assetId: "fake-asset", alt: "原文截图", caption: "公司披露", evidenceIds: ["ev:demand"] });
  assert.throws(() => normalizeReaderReport(image, args), /persisted asset/);
  assert.equal(SEC_READER_CONTENT_BLOCK_SCHEMA.safeParse({ ...chart, points: [1, 2] }).success, false);
});

test("only trusted ready asset manifests may accompany image blocks", () => {
  const input = draftV2(); input.sections[0].content.push({ type: "image", blockId: "source-image", assetId: "cash-screenshot", alt: "现金流原文", caption: "来源于公司申报文件。", evidenceIds: ["ev:demand"] });
  const asset: SecReaderAsset = { assetId: "cash-screenshot", src: "/report-assets/cash.webp", width: 800, height: 400, mimeType: "image/webp", source: { kind: "filing", label: "公司原始申报" } };
  const reader = normalizeReaderReport(input, { ...args, assets: [asset] });
  assert.deepEqual(reader.assets, [asset]);
  assert.throws(() => normalizeReaderReport(input, { ...args, assets: [{ ...asset, src: "data:image/png;base64,fake" }] }));
});

test("formula assumptions and table cells remain in exports and substantive audit checks", () => {
  const input = draftV2(); input.sections[0].content.push(
    { type: "math", blockId: "fcf-formula", latex: "FCF = CFO - CapEx", displayMode: true, explanation: "经营现金流减资本开支。", assumption: "范围为同一季度。", evidenceIds: ["ev:demand"] },
    { type: "table", blockId: "cash-table", headers: ["口径", "说明"], rows: [["现金", "不得重复计入"]], caption: "比较现金口径。", evidenceIds: ["ev:demand"] },
  );
  const reader = normalizeReaderReport(input, args);
  assert.match(readerArticleText(reader), /FCF = CFO - CapEx/);
  assert.match(readerArticleText(reader), /范围为同一季度/);
  assert.match(readerArticleText(reader), /不得重复计入/);
  const formula = reader.sections[0].content?.find((b) => b.type === "math");
  assert.ok(formula?.type === "math"); formula.explanation = "内部nodeId不得暴露";
  assert.throws(() => assertReaderIntegrity(reader, { missingMetrics: [], limitations: [] }), /内部字段/);
  const table = input.sections[0].content.find((b) => b.type === "table");
  assert.ok(table?.type === "table"); table.rows[0] = ["缺列"];
  assert.throws(() => normalizeReaderReport(input, args), /column counts/);
});

test("malformed media stays local; missing text uses the last-good paragraph projection", () => {
  const reader = normalizeReaderReport(draftV2(), args);
  const malformed = JSON.parse(JSON.stringify(reader));
  malformed.sections[0].content.splice(1, 0, { type: "chart", blockId: "broken-chart" });
  const recovered = parseSecReaderReport(malformed);
  assert.ok(recovered.reader); assert.equal(recovered.reader.sections.length, 3);
  assert.deepEqual(recovered.reader.sections[0].paragraphs, reader.sections[0].paragraphs);
  assert.ok(recovered.warnings.length);
  malformed.sections[0].content[0].markdown = null;
  const lastGood = parseSecReaderReport(malformed);
  assert.deepEqual(lastGood.reader?.sections[0].paragraphs, reader.sections[0].paragraphs);
  assert.match(lastGood.warnings.join(" "), /兼容正文/);
  malformed.sections[1].takeaway = null;
  assert.equal(parseSecReaderReport(malformed).reader, undefined);
  assert.equal(parseSecReaderReport({ ...reader, version: "sec-reader.v999" }).unsupportedVersion, "sec-reader.v999");
});

test("one complete schema enforces nested fields and 16 sections in both runtime and public JSON", () => {
  assertSupportedSchema(SEC_READER_JSON_SCHEMA);
  const reader = normalizeReaderReport(draftV2(), args);
  const expanded = { ...reader, sections: Array.from({ length: SEC_READER_MAX_SECTIONS }, (_, i) => ({ ...reader.sections[i % 3], id: `s-${i}` })) };
  assert.equal(SEC_READER_REPORT_SCHEMA.safeParse(expanded).success, true);
  assert.deepEqual(validateJsonSchema(SEC_READER_JSON_SCHEMA, expanded), []);
  expanded.sections.push(expanded.sections[0]);
  assert.equal(SEC_READER_REPORT_SCHEMA.safeParse(expanded).success, false);
  assert.ok(validateJsonSchema(SEC_READER_JSON_SCHEMA, expanded).length);
  const bad = JSON.parse(JSON.stringify(reader)); delete bad.sections[0].content[0].markdown;
  assert.equal(SEC_READER_REPORT_SCHEMA.safeParse(bad).success, false);
  assert.ok(validateJsonSchema(SEC_READER_JSON_SCHEMA, bad).length);
});

test("editorial patch preserves semantic section and existing block identities", () => {
  const reader = normalizeReaderReport(draftV2(), args);
  const section = structuredClone(reader.sections[0]);
  const block = section.content?.find((b) => b.type === "markdown");
  assert.ok(block?.type === "markdown"); block.markdown = "修订后仍然需要核实回款与投入的关系。";
  const result = applyEditorialPatch({ readerReport: reader }, { replaceSections: [{ sectionId: section.id, section }] });
  const next = normalizeReaderReport(result.readerReport, args);
  assert.equal(next.sections[0].id, section.id);
  assert.equal(next.sections[0].content?.[0].blockId, block.blockId);
  assert.equal(next.sections[0].paragraphs[0], block.markdown);
});


test("damaged prose among three paragraphs restores every paragraph without dropping media or colliding IDs", () => {
  const input = draftV2();
  input.sections[0].content.push({ type: "markdown", blockId: "extra-meaning", markdown: "新增第三段强调资产周转仍需验证。", evidenceIds: ["ev:demand"] });
  input.sections[0].content.splice(1, 0, chart);
  const reader = normalizeReaderReport(input, args);
  const malformed = JSON.parse(JSON.stringify(reader));
  malformed.sections[0].content[0].markdown = null;
  malformed.sections[1].content[0].blockId = "topic-1-compat-1";
  const recovered = parseSecReaderReport(malformed);
  assert.ok(recovered.reader);
  assert.deepEqual(recovered.reader.sections[0].paragraphs, reader.sections[0].paragraphs);
  assert.equal(recovered.reader.sections[0].content?.[1].blockId, chart.blockId);
  const ids = recovered.reader.sections.flatMap((section) => section.content?.map((block) => block.blockId) ?? []);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(recovered.reader.sections[0].content?.[0].blockId, "topic-1-compat-1-1");
});

test("asset URLs reject ambiguous authorities, backslashes, credentials and unsafe schemes", () => {
  const asset: SecReaderAsset = { assetId: "asset", src: "/assets/a.png", width: 640, height: 480, mimeType: "image/png", source: { kind: "filing", label: "申报截图" } };
  for (const src of ["//evil.example/a.png", "/\\evil.example/a.png", "https://user:pass@example.com/a.png", "https://example.com\\@evil.example/a.png", "javascript:alert(1)", "data:image/png;base64,abc", "https://example.com/a\nb.png"]) {
    assert.equal(SEC_READER_ASSET_SCHEMA.safeParse({ ...asset, src }).success, false, src);
  }
  for (const src of ["/assets/a.png", "https://example.com/a.png?version=1", "https://cdn.example.com:443/a.webp"]) {
    assert.equal(SEC_READER_ASSET_SCHEMA.safeParse({ ...asset, src }).success, true, src);
  }
  assert.throws(() => normalizeReaderReport(draftV2(), { ...args, assets: [asset, asset] }), /repeats an assetId/);
  assert.equal(SEC_READER_ASSET_SCHEMA.safeParse({ ...asset, mimeType: "image/svg+xml" }).success, false);
});


test("historical readers keep source lists accepted by the original normalizer", () => {
  const legacy = readerFixture();
  legacy.sections[0].evidenceIds = Array.from({ length: 90 }, (_, i) => `ev:historical-${i}`);
  const allowed = new Set([...args.currentEvidence, ...legacy.sections[0].evidenceIds]);
  const normalized = normalizeReaderReport(legacy, { ...args, currentEvidence: allowed });
  const recovered = parseSecReaderReport(normalized);
  assert.ok(recovered.reader);
  assert.deepEqual(recovered.reader.sections[0].evidenceIds, legacy.sections[0].evidenceIds);
  assert.deepEqual(recovered.warnings, []);
});


test("full reader synthesis preserves complete headline and bullets beyond event clipping limits", async () => {
  const headline = "资本投入与现金回收存在时间差，需要结合客户预付款、履约义务和不同口径继续核对。".repeat(7) + "自由现金流为负仍需融资支持。";
  const detail = "订单规模不能直接等同当期现金，公司需要先投入设备并在履约之后确认收入与回款。".repeat(11) + "完整结论是继续观察经营现金流。";
  const label = "客户履约、设备投入与不同现金流计算口径之间的关键关系";
  const analystView = "现有证据仍需结合现金回收验证。";
  assert.ok(headline.length > 240 && detail.length > 320 && label.length > 24);
  for (const reader of [readerFixture(), draftV2()]) {
    const filing = readerFilingFixture();
    const brief = buildSecAnalysisBrief({ ticker: "DEMO", filingId: "demo-quarter", periodId: "DEMO:2026-06-30:quarter", periodScope: "quarter", reportDate: "2026-06-30", history: { registryVersion: "sec-canonical-series.v1", series: [] }, memorySummary: "", memoryItems: [] });
    const result = await summarizePreparedSecFiling({ filing, periodId: brief.periodId, periodScope: "quarter", blockIds: ["ev:demand"], outline: [] },
      { currentPeriodId: brief.periodId, qoqPeriodId: null, yoyPeriodId: null }, async () => ({ readerReport: reader, headline, bullets: [{ label, detail, importance: "high" }], analystView, report: "", keyMetrics: [] }),
      new Date("2026-08-14T12:00:00Z"), plan, readerNodes, brief);
    assert.equal(result.summary.headline, headline);
    assert.equal(result.summary.bullets[0].detail, detail);
    assert.equal(result.summary.bullets[0].label, label);
    assert.equal(result.artifact.report.headline, headline);
    assert.equal(result.artifact.report.publication?.summary.headline, headline);
    assert.deepEqual(validateJsonSchema(FILING_DETAIL_SCHEMA.$defs!.PublishedSecReport, JSON.parse(JSON.stringify(result.artifact.report))), []);
    assert.deepEqual(validateJsonSchema(FILING_DETAIL_SCHEMA.$defs!.SecFilingSummary, JSON.parse(JSON.stringify(result.summary))), []);
  }
  // The short event compatibility path intentionally retains its existing behavior.
  const event = normalizeSecSummary({ headline, bullets: [{ label, detail }], analystView }, { ...readerFilingFixture(), form: "8-K" });
  assert.equal(event.headline.length, 180); assert.equal(event.bullets[0].detail.length, 320);
});

test("over-budget full-report core prose is rejected for revision, never clipped", () => {
  const value = { headline: "完整标题。", bullets: [{ label: "现金", detail: "完整核心结论。" }], analystView: "完整投资含义。" };
  assert.throws(() => normalizeReaderSummaryText({ ...value, headline: "长".repeat(1001) }), /headline.*完整修订/);
  assert.throws(() => normalizeReaderSummaryText({ ...value, bullets: [{ label: "现金", detail: "长".repeat(4001) }] }), /bullets.*完整修订/);
  assert.throws(() => normalizeReaderSummaryText({ ...value, bullets: Array(6).fill(value.bullets[0]) }), /不能截取列表/);
});
