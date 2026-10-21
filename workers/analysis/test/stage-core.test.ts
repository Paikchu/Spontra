import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { evidenceCandidates, resolveEvidence, verifyFindings } from "../../../shared/analysis-runtime/findings.ts";
import { assignIds, readSceneDraft } from "../../../shared/analysis-runtime/scene/schema.ts";
import { describeScene, verifyScene } from "../../../shared/analysis-runtime/scene/verify.ts";
import { runAgentLoop, sequential, type LoopHost, type Recipe } from "../src/agent-loop.ts";
import { runTool, toolSchema, type AnyTool, type ToolPolicy } from "../src/tools/registry.ts";
import type { AgentMessage, AgentReply } from "../src/tool-loop.ts";
import { data, finding, PERIOD, publication } from "./fixtures/stage-data.ts";

let ids = 0;
const call = (name: string, input: unknown = {}): AgentReply => ({ stopReason: "tool_use", content: [{ type: "tool_use", id: `toolu_${++ids}`, name, input }] });

type S = { added: number[]; done: boolean };
const add: AnyTool<S> = { name: "add", description: "Add a number.", parameters: z.object({ n: z.number() }), concurrencySafe: true,
  execute: ({ n }, ctx) => { ctx.state.added.push(n); return ctx.state.added.reduce((a, b) => a + b, 0); }, observe: (_a, sum) => `sum ${sum}` };
const done: AnyTool<S> = { name: "done", description: "Finish.", parameters: z.object({}), execute: (_a, ctx) => { ctx.state.done = true; return true; }, observe: () => "Accepted." };
const policy: ToolPolicy = { allow: ["add", "done"], post: (exec, value) => exec.name === "add" && (value as number) > 100 ? { kind: "block", feedback: "Too large." } : { kind: "accept" } };
const recipe: Recipe<null, number[], S> = { id: "t", budget: { turns: 5, wallMs: 60_000 }, system: () => "sys", open: () => ({ added: [], done: false }), tools: () => [add, done], policy,
  settled: s => s.done, settle: s => s.added, nudge: "Call a tool." };
const host = (records: string[] = []): LoopHost<S> => ({ reserve: async () => true, record: r => records.push(`${r.action}:${r.observation}`), execute: (_t, calls, run) => sequential(calls, run), signal: new AbortController().signal, now: () => 0 });

test("a tool's model-facing schema is strict and closed unless the tool takes a whole document", () => {
  const schema = toolSchema(add);
  assert.equal(schema.strict, true);
  assert.deepEqual(schema.input_schema.required, ["n"]);
  assert.equal(schema.input_schema.additionalProperties, false);
  assert.equal(toolSchema({ ...add, strict: false }).strict, undefined);
});

test("the pipeline refuses unknown tools and bad arguments, and blocks a result the policy rejects, without throwing", async () => {
  const ctx = { state: { added: [], done: false }, signal: new AbortController().signal, recipe: "t" };
  assert.match((await runTool([add, done], policy, { name: "nope", input: {} }, ctx)).observation, /no tool "nope"/);
  assert.match((await runTool([add, done], policy, { name: "add", input: { n: "x" } }, ctx)).observation, /do not match/);
  assert.equal((await runTool([add, done], policy, { name: "add", input: '{"n":200}' }, ctx)).observation, "Too large.");
  const asked = await runTool([add, done], { ...policy, pre: () => ({ kind: "ask", question: "Sure?" }) }, { name: "add", input: { n: 1 } }, ctx);
  assert.equal(asked.asked, "Sure?");
});

test("the loop runs calls until a terminal tool settles it, and the exchange only grows", async () => {
  const replies = [call("add", { n: 2 }), call("add", { n: 3 }), call("done")];
  const messages: AgentMessage[] = [{ role: "user", content: "go" }];
  const lengths: number[] = [];
  const outcome = await runAgentLoop(recipe, null, recipe.open(null), messages, async (_s, _sys, tools, m) => { assert.deepEqual(tools.map(t => t.name), ["add", "done"]); lengths.push(m.length); return replies.shift()!; }, host());
  assert.equal(outcome.reason, "finished");
  assert.deepEqual(outcome.output, [2, 3]);
  assert.deepEqual(lengths, [1, 3, 5]);
  assert.match(String((messages[2]!.content as Array<{ content: string }>)[0]!.content), /sum 2[\s\S]*Budget left: 4 turns/);
});

test("the loop stops on the budget, on three failed replies, and when the allowance is spent", async () => {
  const forever = await runAgentLoop(recipe, null, recipe.open(null), [{ role: "user", content: "go" }], async () => call("add", { n: 1 }), host());
  assert.equal(forever.reason, "budget");
  assert.equal(forever.turns, 5);
  const broken = await runAgentLoop(recipe, null, recipe.open(null), [{ role: "user", content: "go" }], async () => ({ error: "503" }), host());
  assert.equal(broken.reason, "failed");
  assert.equal(broken.turns, 3);
  const spent = await runAgentLoop(recipe, null, recipe.open(null), [{ role: "user", content: "go" }], async () => call("done"), { ...host(), reserve: async () => false });
  assert.equal(spent.reason, "budget");
  assert.equal(spent.turns, 0);
});

const findings = verifyFindings(publication, data).verified;
const candidates = findings[0]!.resolved.flatMap(evidenceCandidates);
const ctx = { ticker: "TEST", data, findings, candidates };

test("a scene draft reads through the contract and its blocks keep their ids across revisions", () => {
  const read = readSceneDraft({ rows: [{ cells: [[{ kind: "metric-trend", ref: { capital: "capex" }, span: "Q", periods: 8 }], [{ kind: "findings" }]] }] });
  assert.ok("draft" in read);
  const first = assignIds(read.draft.rows);
  const second = assignIds([{ cells: [[{ kind: "findings" }], [{ kind: "prose", paragraphs: [{ text: "x", sourceIds: [] }] }]] }], first);
  assert.equal(second[0]!.cells[0]![0]!.id, first[0]!.cells[1]![0]!.id);
  assert.notEqual(second[0]!.cells[1]![0]!.id, first[0]!.cells[0]![0]!.id);
  const bad = readSceneDraft({ rows: [{ cells: [[{ kind: "chart", chart: { id: "c1", title: "Capex in 2026" } }]] }] });
  assert.ok("issues" in bad && bad.issues.length > 0);
});

test("the verifier keeps what resolves, drops what does not, and checks prose numbers against what the turn read", () => {
  const rows = assignIds([
    { cells: [[{ kind: "metric-trend", ref: { capital: "capex" }, span: "quarter", periods: 8 }], [{ kind: "metric-trend", ref: { fundamental: "diluted_eps" }, span: "quarter", periods: 8 }]] },
    { cells: [[{ kind: "prose", paragraphs: [{ text: "Capex reached $40.0 billion.", sourceIds: [] }, { text: "Capex reached $77 billion.", sourceIds: [] }] }]] },
    { cells: [[{ kind: "lens", findingId: finding.id, document: { rows: [{ cells: [[{ kind: "judgment" }, { kind: "figures" }]] }] } }], [{ kind: "findings", ids: ["capex-fcf", "gone"] }]] },
    { cells: [[{ kind: "lens", findingId: "gone", document: { rows: [{ cells: [[{ kind: "judgment" }]] }] } }]] },
  ]);
  const verified = verifyScene({ scope: { periodEnd: PERIOD }, rows }, ctx);
  assert.equal(verified.rows.length, 3);
  assert.deepEqual(verified.rows[0]!.cells.map(c => c[0]!.kind), ["metric-trend"]);
  const prose = verified.rows[1]!.cells[0]![0]!;
  assert.ok(prose.kind === "prose" && prose.paragraphs.length === 1);
  assert.ok(Object.keys(verified.lenses).length === 1);
  const list = verified.rows[2]!.cells[1]![0]!;
  assert.ok(list.kind === "findings" && list.ids!.join() === "capex-fcf");
  assert.match(describeScene(verified), /taken out \(4\)/);
  assert.ok(resolveEvidence(data, finding.evidence[0]!));
});
