import { test } from "node:test";
import assert from "node:assert/strict";
import { PiTurnTraces, type PiSpan, type PiTracer } from "../src/pi/tracing.ts";

function recorder() {
  const spans: Array<{ name: string; attributes: Record<string, unknown>; ended: number }> = [];
  const span = (name: string): PiSpan => {
    const row = { name, attributes: {} as Record<string, unknown>, ended: 0 };
    spans.push(row);
    return { setAttribute: (k, v) => { row.attributes[k] = v; }, end: () => { row.ended++; } };
  };
  const tracer: PiTracer = { startSpan: span, enterSpan: (name, callback) => { const s = span(name); const out = callback(s); void Promise.resolve(out).finally(() => s.end()); return out; } };
  return { spans, tracer };
}
const who = { kind: "sec-report", conversation: "c1" };

test("a turn is one invoke_agent, one chat and its tool runs, each carrying the agent identity and no payload", async () => {
  const { spans, tracer } = recorder();
  const traces = new PiTurnTraces(() => tracer);
  traces.beginTurn(who, "deepseek-flash", 3);
  traces.endChat("c1", { inputTokens: 10, outputTokens: 2, finishReason: "toolUse" });
  await traces.tool(who, "submit_report", "call-1", async () => ({ observation: "secret draft check", error: true }));
  traces.endTurn("c1");
  assert.deepEqual(spans.map((s) => s.name), ["invoke_agent spontra-sec-report", "chat deepseek-flash", "execute_tool submit_report"]);
  for (const s of spans) {
    assert.equal(s.ended, 1, s.name);
    assert.equal(s.attributes["gen_ai.agent.name"], "spontra-sec-report");
    assert.equal(s.attributes["gen_ai.conversation.id"], "c1");
  }
  assert.equal(spans[1]!.attributes["gen_ai.usage.output_tokens"], 2);
  assert.equal(spans[2]!.attributes["error.type"], "tool_error");
  assert.doesNotMatch(JSON.stringify(spans), /secret/);
});

test("a tracer that throws or is absent never stops the work, and the next turn closes one left open", async () => {
  const broken: PiTracer = { startSpan() { throw new Error("no"); }, enterSpan() { throw new Error("no"); } };
  const quiet = new PiTurnTraces(() => broken);
  quiet.beginTurn(who, "m", 1);
  assert.deepEqual(await quiet.tool(who, "t", "c", async () => ({ ok: 1 })), { ok: 1 });
  assert.deepEqual(await new PiTurnTraces(() => undefined).tool(who, "t", "c", async () => ({ ok: 2 })), { ok: 2 });
  const { spans, tracer } = recorder();
  const traces = new PiTurnTraces(() => tracer);
  traces.beginTurn(who, "m", 1);
  traces.beginTurn(who, "m", 2);
  assert.deepEqual(spans.slice(0, 2).map((s) => s.ended), [1, 1]);
});
