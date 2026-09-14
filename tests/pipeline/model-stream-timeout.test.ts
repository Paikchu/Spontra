import test from "node:test";
import assert from "node:assert/strict";
import { readModelContent, callWorkerSecModel } from "../../workers/pipeline/src/operations.ts";

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
test("total deadline aborts a request which never returns headers", async () => {
  const fetcher: typeof fetch = async (_url, init) => new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  await assert.rejects(callWorkerSecModel({ AI_API_KEY: "test" }, fetcher, "synthesis", "test", {}, undefined, 10), /model-timeout:total/);
});
