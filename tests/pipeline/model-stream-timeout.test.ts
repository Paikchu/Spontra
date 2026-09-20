import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { readModelContent, callWorkerSecModel } from "../../workers/pipeline/src/operations.ts";
import { SEC_MODEL_EXECUTION_BUDGET_MS, SEC_WORKFLOW_STEP_TIMEOUT } from "../../workers/pipeline/src/retry-policy.ts";
import { MODEL_STREAM_LIMITS } from "../../workers/pipeline/src/model-stream.ts";

const enc = new TextEncoder();
function stream(parts: string[]) {
  return new Response(new ReadableStream({ start(c) { for (const p of parts) c.enqueue(enc.encode(p)); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
}
test("assembles split SSE lines and records content progress", async () => {
  let progress = 0;
  const result = await readModelContent(stream(['data: {"choices":[{"delta":{"cont', 'ent":"你好"}}]}\n', 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n']), "test", () => progress++);
  assert.equal(result, "你好"); assert.equal(progress, 1);
});
test("rejects truncated content even if it contains valid JSON", async () => {
  await assert.rejects(readModelContent(stream(['data: {"choices":[{"delta":{"content":"{}"}}]}\n']), "test"), /before completion/);
});
test("rejects token limited completions", async () => {
  await assert.rejects(readModelContent(stream(['data: {"choices":[{"delta":{"content":"{}"},"finish_reason":"length"}]}\n']), "test"), /token limit/);
});
test("heartbeats cannot hide a stalled model and reader is cancelled", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(': heartbeat\n\n')); }, cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } });
  await assert.rejects(readModelContent(response, "test", () => {}, {}, 10), /stream-stall/);
  assert.equal(cancelled, true);
});
test("safety budget still aborts a runaway request", async () => {
  const fetcher: typeof fetch = async (_url, init) => new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  await assert.rejects(callWorkerSecModel({ DEEPSEEK_API_KEY: "test" }, fetcher, "synthesis", "test", {}, undefined, 10), /model-timeout:execution-budget/);
});

test("active reasoning and content survive the old 3-minute and 10-minute cutoffs", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let aborted = false;
  const fetcher: typeof fetch = async (_url, init) => {
    init?.signal?.addEventListener("abort", () => { aborted = true; controller.error(new Error("aborted")); }, { once: true });
    return new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { "content-type": "text/event-stream" } });
  };
  const pending = callWorkerSecModel({ DEEPSEEK_API_KEY: "test" }, fetcher, "discovery:0", "Return JSON", {});
  const checked = assert.doesNotReject(pending);
  await setImmediate();
  for (let i = 0; i < 16; i++) {
    t.mock.timers.tick(45_000);
    controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: i % 2 ? { content: i === 1 ? '{"ok":' : ' ' } : { reasoning_content: 'Still analyzing source evidence' } }] })}\n\n`));
    // Supply meaningful body tokens too, without making the final JSON invalid.
    if (i % 2) controller.enqueue(enc.encode('data: {"choices":[{"delta":{"reasoning_content":"Checking the next source"}}]}\n\n'));
    await setImmediate();
    assert.equal(aborted, false);
  }
  controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"true}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
  controller.close();
  assert.deepEqual(await pending, { ok: true });
  await checked;
  assert.equal(SEC_WORKFLOW_STEP_TIMEOUT, "60 minutes");
  assert.ok(SEC_MODEL_EXECUTION_BUDGET_MS > 30 * 60_000 && SEC_MODEL_EXECUTION_BUDGET_MS < 60 * 60_000);
});

test("first response still times out at 90 seconds", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const fetcher: typeof fetch = async (_url, init) => new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  const checked = assert.rejects(callWorkerSecModel({ DEEPSEEK_API_KEY: "test" }, fetcher, "node", "JSON", {}), /model-timeout:first-response/);
  await setImmediate();
  t.mock.timers.tick(90_000);
  await checked;
});

test("repeated heartbeats and empty reasoning cannot refresh the stall clock", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(c) { controller = c; }, cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } });
  const checked = assert.rejects(readModelContent(response, "test"), /stream-stall/);
  await setImmediate();
  for (let i = 0; i < 2; i++) {
    t.mock.timers.tick(20_000);
    controller.enqueue(enc.encode(': heartbeat\n\ndata: {"choices":[{"delta":{"content":" ","reasoning_content":""}}]}\n\n'));
    await setImmediate();
  }
  t.mock.timers.tick(20_000);
  await checked;
  assert.equal(cancelled, true);
});

test("oversized streams are cancelled without publishing a truncated answer", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(' '.repeat(1025))); }, cancel() { cancelled = true; } }));
  await assert.rejects(readModelContent(response, "test", undefined, {}, undefined, { limits: { ...MODEL_STREAM_LIMITS, wire: 1024 } }), /wire budget/);
  assert.equal(cancelled, true);
});
