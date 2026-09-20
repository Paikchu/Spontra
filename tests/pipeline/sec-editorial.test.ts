import assert from "node:assert/strict";
import test from "node:test";
import { applyEditorialPatch, editorialRequirements, normalizeEditorialIssues } from "../../workers/pipeline/src/sec/editorial.ts";
import { buildFinancialLens } from "../../workers/pipeline/src/sec/reader.ts";
import { buildSecAnalysisBrief, normalizeAnalysisFacts } from "../../workers/pipeline/src/sec/analysis.ts";
import { summarizePreparedSecFiling } from "../../workers/pipeline/src/sec/pipeline.ts";
import { readerFixture, readerFilingFixture, readerNodes } from "../fixtures/sec-reader-fixture.ts";
import type { SecNodePlan } from "../../workers/pipeline/src/sec/sec.ts";

const plan: SecNodePlan = { nodes: [{ id: "demand", title: "需求", question: "回款能否支持增长？", sectionIds: ["s"], materiality: "high", acceptanceCriteria: ["核对回款"], memoryIds: [], historySeriesIds: [] }], outlineSections: 1 };
const brief = () => buildSecAnalysisBrief({ ticker: "DEMO", filingId: "demo-quarter", periodId: "DEMO:2026-06-30:quarter", periodScope: "quarter", reportDate: "2026-06-30", history: { registryVersion: "sec-canonical-series.v1", series: [] }, memorySummary: "", memoryItems: [] });
const draft = () => ({ readerReport: readerFixture(), headline: "现金兑现", bullets: [{ label: "现金", detail: "现金需要核对" }], analystView: "观察后续回款", report: "", keyMetrics: [] });

test("a targeted edit preserves every unaffected section and rejects destructive patches", () => {
  const original = draft();
  const section = structuredClone(original.readerReport.sections[0]);
  section.paragraphs[1] = "原文中的分类尚未查清，应限制对融资安全的判断。";
  const fixed = applyEditorialPatch(original, { replaceSections: [{ sectionId: section.id, section }] });
  assert.deepEqual((fixed.readerReport as typeof original.readerReport).sections.slice(1), original.readerReport.sections.slice(1));
  assert.notDeepEqual(fixed.readerReport, original.readerReport);
  assert.throws(() => applyEditorialPatch(original, { replaceSections: [{ sectionId: section.id, section }] }, new Set(["sec-reader-2"])), /unaffected/);
  assert.throws(() => applyEditorialPatch(original, { readerReport: readerFixture() }), /unsupported/);
  assert.throws(() => applyEditorialPatch(original, { replaceSections: [{ sectionId: "invented", section }] }), /invalid/);
  assert.throws(() => applyEditorialPatch(original, { replaceSections: [{ sectionId: section.id, section: { ...section, nodeIds: [] } }] }), /covered topics/);
  assert.throws(() => applyEditorialPatch(original, { replaceSections: [] }), /no progress/);
});

test("coverage repair receives the saved draft and exact missing topic, not a fresh writing request", async () => {
  const b = brief();
  const topic = { ...plan.nodes[0], id: "concentration", title: "客户集中度", question: "客户集中度是否已披露？" };
  const nodes = [...readerNodes, { ...readerNodes[0], id: topic.id, title: topic.title }];
  const fullPlan = { ...plan, nodes: [...plan.nodes, topic] };
  const original = draft();
  let calls = 0, saved = 0;
  const result = await summarizePreparedSecFiling({ filing: readerFilingFixture(), periodId: b.periodId, periodScope: "quarter", blockIds: ["ev:demand"], outline: [] },
    { currentPeriodId: b.periodId, qoqPeriodId: null, yoyPeriodId: null }, async (stage, _system, input) => {
      calls++;
      const p = input as Record<string, unknown>;
      assert.ok((p.requiredTopics as Array<{ nodeId: string }>).some((r) => r.nodeId === topic.id));
      assert.match(stage, /editorial-revision/);
      assert.match(JSON.stringify(p.issues), /concentration/);
      assert.deepEqual(p.originalDraft, original);
      const section = structuredClone(original.readerReport.sections[2]);
      section.nodeIds.push(topic.id);
      section.paragraphs[0] = "本次材料未提供客户集中度的可核验比例，不能用订单总额证明分散程度；客户付款能力仍是回款判断的限制。";
      return { replaceSections: [{ sectionId: section.id, section }] };
    }, new Date(), fullPlan, nodes, b, undefined, undefined, { candidate: original, saveCandidate: async () => { saved++; } });
  assert.equal(calls, 1);
  assert.ok(saved >= 2);
  assert.deepEqual(result.artifact.report.reader!.sections[1].paragraphs, original.readerReport.sections[1].paragraphs);
  assert.ok(result.artifact.report.reader!.sections[2].nodeIds.includes(topic.id));
});

test("editorial issues retain location and acceptance; ungrounded corrections become evidence questions", () => {
  const findings = normalizeEditorialIssues({ verdict: "revise", issues: [{ id: "cash-class", category: "fact", severity: "critical", sectionIds: ["sec-reader-1"], quote: "classified as financing", evidenceIds: ["invented"], detail: "改变现金分类", acceptance: "核对原文分类" }, { id: "layout", category: "presentation", severity: "minor", detail: "建议加图" }] }, new Set(["ev:demand"]));
  assert.equal(findings[0].category, "evidence");
  assert.deepEqual(findings[0].evidenceIds, []);
  assert.deepEqual(findings[0].sectionIds, ["sec-reader-1"]);
  assert.equal(findings[0].acceptance, "核对原文分类");
  assert.equal(findings[1].category, "presentation");
  assert.throws(() => normalizeEditorialIssues({ verdict: "revise", issues: [] }, new Set()), /actionable/);
});

test("cash classification requires an exact quote in the cited source, not just a valid evidence ID", () => {
  const sourceQuote = "Customer advances were included in financing activities.";
  const facts = normalizeAnalysisFacts([{ metricKey: "customer_advances", value: "10", unit: "USD", periodScope: "quarter", periodEnd: "2026-06-30", evidenceIds: ["ev:demand"], cashFlow: { classification: "financing", includedInOperatingCashFlow: "no", obligation: "future delivery", sourceQuote } }], new Set(["ev:demand"]));
  const nodes = [{ ...readerNodes[0], facts }];
  assert.equal(buildFinancialLens(brief(), nodes, "2026-06-30").cashFlowItems![0].classification, "unknown");
  assert.equal(buildFinancialLens(brief(), nodes, "2026-06-30", [{ evidenceId: "another", text: sourceQuote }]).cashFlowItems![0].classification, "unknown");
  const item = buildFinancialLens(brief(), nodes, "2026-06-30", [{ evidenceId: "ev:demand", text: sourceQuote }]).cashFlowItems![0];
  assert.equal(item.classification, "financing");
  assert.equal(item.evidenceStatus, "quoted");
  assert.equal(item.includedInOperatingCashFlow, "no");
});

test("required topics expose question, acceptance and source status before writing", () => {
  const requirements = editorialRequirements(plan, readerNodes);
  assert.equal(requirements[0].question, plan.nodes[0].question);
  assert.deepEqual(requirements[0].acceptanceCriteria, ["核对回款"]);
  assert.equal(editorialRequirements(plan, [])[0].status, "unanswered");
});

test("a rejected out-of-scope patch is corrected locally without applying it or broadening scope", async () => {
  const original = draft(), b = brief();
  let calls = 0;
  const result = await summarizePreparedSecFiling({ filing: readerFilingFixture(), periodId: b.periodId, periodScope: "quarter", blockIds: ["ev:demand"], outline: [] },
    { currentPeriodId: b.periodId, qoqPeriodId: null, yoyPeriodId: null }, async (_stage, _system, payload) => {
      const p = payload as Record<string, unknown>;
      assert.deepEqual(p.originalDraft, original);
      assert.deepEqual(p.allowedSectionIds, ["sec-reader-1"]);
      calls++;
      if (calls === 1) return { replaceSections: [{ sectionId: "sec-reader-2", section: original.readerReport.sections[1] }] };
      assert.match(String(p.patchError), /unaffected section/);
      const section = structuredClone(original.readerReport.sections[0]);
      section.paragraphs[0] = "当期现金增长仍需与未来交付义务一起判断，不能据此认定无需融资。";
      return { replaceSections: [{ sectionId: "sec-reader-1", section }] };
    }, new Date(), plan, readerNodes, b, undefined, undefined,
    { candidate: original, patch: true, issues: [{ sectionIds: ["sec-reader-1"], detail: "收窄现金判断" }] });
  assert.equal(calls, 2);
  assert.deepEqual(result.artifact.report.reader!.sections[1].paragraphs, original.readerReport.sections[1].paragraphs);
});
