import { test } from "node:test";
import assert from "node:assert/strict";
import { emitTurnSpans, PiTurnTraces, type PiSpan, type PiTracer, type TurnTrace } from "../src/pi/tracing.ts";

function recorder() {
  const spans: Array<{ name: string; parent: string | null; attributes: Record<string, unknown>; ended: number }> = [];
  const stack: string[] = [];
  const tracer: PiTracer = { enterSpan: (name, callback) => {
    const row = { name, parent: stack.at(-1) ?? null, attributes: {} as Record<string, unknown>, ended: 0 };
    spans.push(row);
    stack.push(name);
    const span: PiSpan = { setAttribute: (k, v) => { row.attributes[k] = v; }, end: () => { row.ended++; } };
    try { return callback(span); } finally { stack.pop(); row.ended++; }
  } };
  return { spans, tracer };
}
const who = { kind: "filing", conversation: "c1" };

async function oneTurn() {
  const sent: TurnTrace[] = [];
  const traces = new PiTurnTraces((turn) => sent.push(turn));
  traces.beginTurn(who, "deepseek-flash", 3);
  traces.endChat("c1", { inputTokens: 10, outputTokens: 2, finishReason: "toolUse" });
  await traces.tool(who, "submit_report", "call-1", async () => ({ observation: "secret draft check", error: true }));
  traces.endTurn("c1");
  return sent;
}

test("nothing is traced while a turn runs: its record goes out once when it ends, with no payload", async () => {
  const sent = await oneTurn();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.tools.map(t => [t.name, t.error]), [["submit_report", true]]);
  assert.equal(sent[0]!.inputTokens, 10);
  assert.doesNotMatch(JSON.stringify(sent), /secret/);
});

test("a recorded turn becomes invoke_agent holding chat and its tools, each with the agent identity", async () => {
  const { spans, tracer } = recorder();
  emitTurnSpans(tracer, (await oneTurn())[0]);
  assert.deepEqual(spans.map(s => [s.name, s.parent]), [
    ["invoke_agent spontra-filing", null],
    ["chat deepseek-flash", "invoke_agent spontra-filing"],
    ["execute_tool submit_report", "invoke_agent spontra-filing"],
  ]);
  for (const s of spans) {
    assert.equal(s.ended, 1, s.name);
    assert.equal(s.attributes["gen_ai.agent.name"], "spontra-filing");
    assert.equal(s.attributes["gen_ai.conversation.id"], "c1");
  }
  assert.equal(spans[1]!.attributes["gen_ai.usage.output_tokens"], 2);
  assert.equal(spans[2]!.attributes["error.type"], "tool_error");
});

test("a broken or absent tracer stops nothing, a sink that throws stops nothing, and the next turn closes one left open", async () => {
  const broken: PiTracer = { enterSpan() { throw new Error("no"); } };
  const turn = (await oneTurn())[0]!;
  emitTurnSpans(broken, turn);
  emitTurnSpans(undefined, turn);
  const quiet = new PiTurnTraces(() => { throw new Error("no"); });
  quiet.beginTurn(who, "m", 1);
  assert.deepEqual(await quiet.tool(who, "t", "c", async () => ({ ok: 1 })), { ok: 1 });
  quiet.endTurn("c1");
  const sent: TurnTrace[] = [];
  const traces = new PiTurnTraces(t => sent.push(t));
  traces.beginTurn(who, "m", 1);
  traces.beginTurn(who, "m", 2);
  assert.deepEqual(sent.map(t => t.turn), [1]);
});
