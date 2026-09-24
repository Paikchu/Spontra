import assert from "node:assert/strict";
import { test } from "node:test";
import { investigate, type ResearchModel } from "../../workers/pipeline/src/research/engine.ts";
import { WebSearchService } from "../../workers/pipeline/src/web-search/service.ts";
import type { SearchStore } from "../../workers/pipeline/src/web-search/store.ts";
const now = "2026-09-24T15:00:00.000Z";
const queries: string[] = [];
const store: SearchStore = { async read() { return null; }, async claim() { return true; }, async publish() { return true; }, async release() {} };
function search() { return new WebSearchService({ id: "fixture", async search(request) {
  queries.push(request.query); return { kind: "search", results: [{ title: "Official disclosure", url: "https://example.com/ir", snippet: "Costs grew faster than revenue", publishedAt: now, score: 1 }] };
}, async fetchContent({ url }) { return { kind: "content", url, text: "Costs grew faster than revenue", format: "markdown", completeness: "unverified" }; } }, store, () => Date.parse(now)); }
const event = { id: "test-event", ticker: "ORCL", kind: "news" as const, observedAt: now, sourceAt: now, payload: {} };
const model: ResearchModel = async stage => {
  if (stage === "research-plan") return { questions: [{ query: "disconfirm cost growth competitor benefit", purpose: "检查反证与竞争影响" }] };
  if (stage === "research-evidence-review") return { approved: true, issues: [] };
  return { publish: true, title: "成本增速待验证", summary: "成本增长可能影响现金流。", tickers: ["ORCL"], content: [{ type: "markdown", blockId: "cost", markdown: "成本增速高于收入。", evidenceIds: ["web-1"] }], hypotheses: [], followups: [{ question: "利润率会否变化？", query: "Oracle margin", dueAt: now }], limitations: [] };
};
test("research seeks counterevidence, extracts original text, and publishes validated reader blocks", async () => {
  queries.length = 0;
  const report = await investigate({ event, previous: [], search: search(), model, now });
  assert.ok(report); assert.equal(report.sources.length, 1);
  assert.ok(queries.includes("disconfirm cost growth competitor benefit"));
  assert.equal(report.followups[0].dueAt, "2026-09-25T15:00:00.000Z");
  assert.equal(report.content[0].type, "markdown");
});
test("quiet outcomes create no report; failed evidence review blocks publication", async () => {
  assert.equal(await investigate({ event, previous: [], search: search(), now, model: async (stage, system, payload) => stage === "research-synthesis" ? { publish: false } : model(stage, system, payload) }), null);
  await assert.rejects(investigate({ event, previous: [], search: search(), now, model: async (stage, system, payload) => stage === "research-evidence-review" ? { approved: false, issues: ["Unsupported fact"] } : model(stage, system, payload) }), /research_evidence_review_rejected/);
});
