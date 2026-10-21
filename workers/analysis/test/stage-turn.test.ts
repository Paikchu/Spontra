import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyFindings } from "../../../shared/analysis-runtime/findings.ts";
import { DEFAULT_SCENE_ROWS } from "../../../shared/analysis-contract/scene.ts";
import { runAgentLoop, sequential, type LoopHost } from "../src/agent-loop.ts";
import { buildLedger } from "../src/findings/ledger.ts";
import { lensCatalogue } from "../src/lens/agent.ts";
import { issueReader, readerOf } from "../src/stage/identity.ts";
import { stageRecipeFor, type StageInput, type StageTurn } from "../src/stage/recipe.ts";
import type { AgentMessage, AgentReply } from "../src/tool-loop.ts";
import { data, PERIOD, publication } from "./fixtures/stage-data.ts";

let ids = 0;
const call = (name: string, input: unknown = {}): AgentReply => ({ stopReason: "tool_use", content: [{ type: "tool_use", id: `toolu_${++ids}`, name, input }] });

test("a reader id is signed by the server, and a forged or altered one names nobody", async () => {
  const issued = await issueReader("secret");
  assert.match(issued.userId, /^anon:[0-9a-f]{32}$/);
  assert.equal(await readerOf("secret", issued.token), issued.userId);
  assert.equal(await readerOf("other", issued.token), null);
  assert.equal(await readerOf("secret", issued.token.replace(/.$/, c => c === "0" ? "1" : "0")), null);
  assert.equal(await readerOf("secret", `a1.abcdef.${"0".repeat(32)}.${"0".repeat(32)}`), null);
  assert.equal(await readerOf(undefined, issued.token), null);
});

const ledger = buildLedger(data, PERIOD, []);
const input: StageInput = {
  data: { ticker: "TEST", periodEnd: PERIOD, data, ledger, catalogue: lensCatalogue(ledger, data, PERIOD), publication, findings: verifyFindings(publication, data).verified, basis: {} },
  locale: "en", scene: DEFAULT_SCENE_ROWS, view: null,
};
const host = (records: string[]): LoopHost<StageTurn> => ({ reserve: async () => true, record: r => records.push(`${r.action}: ${r.observation.split("\n")[0]}`), execute: (_t, calls, run) => sequential(calls, run), signal: new AbortController().signal, now: () => 0 });
async function turn(replies: AgentReply[]) {
  const recipe = stageRecipeFor(input), state = recipe.open(input), records: string[] = [];
  const messages: AgentMessage[] = [{ role: "user", content: "request" }];
  const outcome = await runAgentLoop(recipe, input, state, messages, async () => replies.shift() ?? call("finish"), host(records));
  return { outcome, records, state };
}

test("a stage turn reads, compiles a scene against the data and puts it on the stage", async () => {
  const scene = { rows: [{ title: "Capital spending", cells: [[{ kind: "metric-trend", ref: { capital: "capex" }, span: "quarter", periods: 8 }], [{ kind: "lens", findingId: "capex-fcf", document: { rows: [{ cells: [[{ kind: "judgment" }, { kind: "figures" }]] }] } }]] }] };
  const { outcome, records } = await turn([call("company_overview"), call("compile", { scene }), call("finish")]);
  assert.equal(outcome.reason, "finished");
  assert.equal(outcome.output.kind, "scene");
  if (outcome.output.kind !== "scene") return;
  assert.deepEqual(outcome.output.rows[0]!.cells.map(c => c[0]!.kind), ["metric-trend", "lens"]);
  assert.ok(outcome.output.rows[0]!.cells.flat().every(b => /^b[0-9a-z]+$/.test(b.id)));
  assert.match(records.find(r => r.startsWith("compile"))!, /row 1 "Capital spending"/);
});

test("a reply may only state numbers a read in the turn produced", async () => {
  const unread = await turn([call("reply", { paragraphs: [{ text: "Capex was $40.0 billion." }] }), call("reply", { paragraphs: [{ text: "Capex rose sharply this quarter." }] })]);
  assert.match(unread.records[0]!, /no read in this turn produced/);
  assert.equal(unread.outcome.output.kind, "answer");
  const read = await turn([call("findings"), call("reply", { paragraphs: [{ text: "Capex was $40.0 billion." }] })]);
  assert.equal(read.outcome.output.kind, "answer");
  if (read.outcome.output.kind === "answer") assert.equal(read.outcome.output.paragraphs[0]!.text, "Capex was $40.0 billion.");
});

test("a scene that does not match the grammar comes back with its violations, and finish without a compile refuses", async () => {
  const { records, outcome } = await turn([call("compile", { scene: { rows: [{ cells: [[{ kind: "pie" }]] }] } }), call("finish"), call("reply", { paragraphs: [{ text: "Here is the map." }] })]);
  assert.match(records[0]!, /does not match the grammar/);
  assert.match(records[1]!, /Nothing compiled yet/);
  assert.equal(outcome.output.kind, "answer");
});
