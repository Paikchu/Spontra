import { test } from "node:test";
import assert from "node:assert/strict";
import { reportRecipe, type ReportSpec, type ReportState } from "../src/sec/report-agent.ts";
import type { HandResult } from "../src/pi/hand-tools.ts";

const text = "Revenue grew 30% on large customers. Customers with more than $100,000 of annualized revenue rose to 3,000. Remaining performance obligations were $2.0 billion.";
const filing = { ticker: "NET", companyName: "Cloudflare", form: "10-Q", reportDate: "2026-09-30", filingDate: "2026-11-01", accessionNumber: "0001477333-26-000100" };
const prepared = {
  filing, outline: [{ id: "s1", title: "MD&A", start: 0, end: text.length, characters: text.length }], document: { text },
  blocks: [{ blockId: "b1", heading: "MD&A", preview: text.slice(0, 40), body: text, start: 0, end: text.length }], blockIds: ["ev:b1"],
};
const brief = { currentFacts: [], history: { series: [] }, comparisons: [], allowedMetricKeys: [] };
const spec: ReportSpec = { reference: { key: "filings/NET/x", filing: filing as never }, workflowInstanceId: "w", restored: null };

function session(judge: (stage: string) => unknown) {
  const stages: string[] = [];
  const recipe = reportRecipe({ env: {} as never, spec, prepared: prepared as never, brief: brief as never, context: {} as never,
    judge: async (stage) => { stages.push(stage); return judge(stage) as Record<string, unknown>; } } as never);
  const state = recipe.open(spec);
  const tools = new Map(recipe.tools(state).map((t) => [t.name, t]));
  const call = async (name: string, args: Record<string, unknown> = {}) => await tools.get(name)!.execute(args as never, { state } as never) as HandResult;
  return { recipe, state: state as ReportState, call, stages };
}

const question = { id: "customers", title: "Large customers", question: "What drives large-customer growth?", sectionIds: ["s1"], historySeriesIds: [], acceptanceCriteria: ["Cites the count"], materiality: "high" };

test("a question is written only after its sections were read, and coverage is checked only once every question is written", async () => {
  const s = session(() => ({ status: "complete", questions: [{ questionId: "customers", status: "answered", explanation: "ok" }], repairTasks: [], unresolvedQuestions: [], coverageScore: 1, stopReason: "complete" }));
  assert.equal((await s.call("write_node", { id: "customers", narrative: "x" })).error, true);
  assert.equal((await s.call("plan_questions", { nodes: [question] })).error, undefined);
  assert.equal((await s.call("check_coverage")).error, true);
  assert.match((await s.call("write_node", { id: "customers", narrative: "Large customers grew." })).observation, /read_sections/);
  const read = JSON.parse((await s.call("read_sections", { sectionIds: ["s1"] })).observation);
  assert.equal(read.evidence[0].evidenceId, "ev:b1");
  assert.equal((await s.call("write_node", { id: "customers", narrative: "Customers above $100,000 rose to 3,000.", findings: [{ label: "Large customers", detail: "They rose to 3,000.", importance: "high" }] })).error, undefined);
  assert.deepEqual(s.state.stale, ["customers"]);
  assert.equal((await s.call("submit_report", { draft: {} })).error, true);
  const checked = JSON.parse((await s.call("check_coverage")).observation);
  assert.equal(checked.status, "complete");
  assert.ok(s.stages.includes("manager-review:0"));
  assert.equal(s.state.review?.status, "complete");
});

test("a repair request reopens the question, the second check is the last, and a draft without its reader report is answered with the check", async () => {
  const repair = { status: "needs_repair", questions: [{ questionId: "customers", status: "partial", explanation: "no RPO" }], unresolvedQuestions: ["RPO"], coverageScore: 0.5,
    repairTasks: [{ id: "r1", questionId: "customers", targetNodeId: "customers", title: "Large customers", question: "Add RPO.", sectionIds: ["s1"], keywords: [], historySeriesIds: [], acceptanceCriteria: ["RPO"], materiality: "high", missingEvidence: "RPO" }] };
  const s = session(() => repair);
  await s.call("plan_questions", { nodes: [question] });
  await s.call("read_sections", { sectionIds: ["s1"] });
  await s.call("write_node", { id: "customers", narrative: "Customers rose." });
  assert.equal(JSON.parse((await s.call("check_coverage")).observation).status, "needs_repair");
  assert.equal(s.state.plan?.nodes[0]?.question, "Add RPO.");
  await s.call("write_node", { id: "customers", narrative: "Customers rose; RPO was $2.0 billion." });
  const last = JSON.parse((await s.call("check_coverage")).observation);
  assert.equal(last.status, "partial");
  assert.equal(s.state.review?.stopReason, "max_rounds");
  const draft = await s.call("submit_report", { draft: JSON.stringify({ headline: "x" }) });
  assert.equal(draft.error, true);
  assert.match(draft.observation, /failed a check/);
  assert.equal(s.recipe.settled(s.state), false);
});
