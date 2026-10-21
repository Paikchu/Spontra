import { test } from "node:test";
import assert from "node:assert/strict";
import type { FindingPassage } from "../../../shared/analysis-contract/findings.ts";
import { verifyFindings } from "../../../shared/analysis-runtime/findings.ts";
import { DEFAULT_SCENE_ROWS } from "../../../shared/analysis-contract/scene.ts";
import { buildLedger } from "../src/findings/ledger.ts";
import { lensCatalogue } from "../src/lens/agent.ts";
import type { AnalysisEnv } from "../src/operations.ts";
import { reportRecipe, reportTools, type ReportInput, type ReportState } from "../src/stage/report.ts";
import { STAGE_POLICY } from "../src/stage/recipe.ts";
import { runTool } from "../src/tools/registry.ts";
import { data, PERIOD, publication } from "./fixtures/stage-data.ts";

const ledger = buildLedger(data, PERIOD, []);
const stageData = { ticker: "TEST", periodEnd: PERIOD, data, ledger, catalogue: lensCatalogue(ledger, data, PERIOD), publication, findings: verifyFindings(publication, data).verified, basis: {} };
const input = (earlierAvailable: boolean): ReportInput => ({ env: { DB: {} as D1Database } as AnalysisEnv, data: stageData, question: "Is the capex surge funded?", locale: "en", documents: [], now: "2026-08-01T00:00:00Z", earlierAvailable });
const passage = (id: string, reportDate: string, text: string): FindingPassage => ({ passageId: id, documentId: `d-${id}`, title: `TEST 10-Q ${reportDate}`, form: "10-Q", filedAt: reportDate, url: "https://www.sec.gov/x", path: ["Liquidity"], text, table: null });
function stateWith(materials: FindingPassage[]): ReportState {
  const s = reportRecipe(input(true)).open(input(true));
  materials.forEach((p, i) => s.materials.push({ id: `m${i + 1}`, kind: "sec", title: p.title, url: p.url, publishedAt: p.filedAt, passageId: p.passageId, documentId: p.documentId, form: p.form, path: p.path, passage: p }));
  return s;
}
const now = passage("aaaaaaaa01", PERIOD, "We expect capital expenditures to remain elevated as we build data center capacity for contracted demand.");
const earlier = passage("aaaaaaaa02", "2025-06-30", "We intend to fund capital expenditures primarily from operating cash flow and existing liquidity.");
const report = (quotes: Array<{ m: string; text: string }>, judgment = "Capex was $40.0 billion in the newest quarter against operating cash flow of $30.0 billion, so the build is funded partly from outside cash. The filing says spending stays elevated.") => ({
  title: "Capex runs ahead of operating cash", kind: "risk", judgment,
  evidence: [{ ref: { capital: "capex" }, periodEnd: PERIOD, span: "quarter", compare: "yoy" }, { ref: { capital: "operatingCashFlow" }, periodEnd: PERIOD, span: "quarter" }],
  document: { rows: [{ cells: [[{ kind: "judgment" }, { kind: "figures" }], quotes.map(q => ({ kind: "quote", materialId: q.m, text: q.text }))].filter(c => c.length) }] },
});
async function compose(state: ReportState, value: unknown) {
  const tools = reportTools(input(true));
  return (await runTool(tools, { allow: ["compose", "finish"] }, { name: "compose", input: { report: value } }, { state, signal: new AbortController().signal, recipe: "t", stage: (_n, w) => w() })).observation;
}

test("a report must quote a filing, quote an earlier one when it exists, and state only numbers its evidence produces", async () => {
  const s = stateWith([now, earlier]);
  assert.match(await compose(s, report([])), /quote at least one filing material/);
  assert.match(await compose(s, report([{ m: "m1", text: now.text.slice(0, 60) }])), /quote an earlier filing too/);
  assert.match(await compose(s, report([{ m: "m1", text: now.text.slice(0, 60) }, { m: "m2", text: earlier.text.slice(0, 60) }], "Capex reached $77 billion in the quarter, far above operating cash flow of $30.0 billion, so outside funding grows.")), /number 77 unsupported/);
  assert.match(await compose(s, report([{ m: "m1", text: "Words the filing never said about the data center build." }, { m: "m2", text: earlier.text.slice(0, 60) }])), /not found in the passage/);
  const accepted = await compose(s, report([{ m: "m1", text: now.text.slice(0, 60) }, { m: "m2", text: earlier.text.slice(0, 60) }]));
  assert.match(accepted, /accepted as written/);
  const tools = reportTools(input(true));
  const done = await runTool(tools, { allow: ["finish"] }, { name: "finish", input: {} }, { state: s, signal: new AbortController().signal, recipe: "t", stage: (_n, w) => w() });
  assert.equal(done.observation, "Published.");
  assert.equal(s.composed?.materials.length, 2);
  assert.equal(s.composed?.passages.length, 2);
});

test("a report is only proposed: starting one waits for the reader", () => {
  const decision = STAGE_POLICY.pre!({ name: "write_report", args: { question: "Is the capex surge funded?" } });
  assert.deepEqual(decision, { kind: "ask", question: "Is the capex surge funded?" });
  assert.deepEqual(STAGE_POLICY.pre!({ name: "compile", args: {} }), { kind: "allow" });
  assert.ok(DEFAULT_SCENE_ROWS.length === 1);
});
