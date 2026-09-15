import assert from "node:assert/strict";
import test from "node:test";
import { readModelContent } from "../../workers/pipeline/src/model-stream.ts";
import { boundedModelIO } from "../../workers/pipeline/src/model-io.ts";

test("a hanging transport cancellation cannot swallow the stream stall error", { timeout: 1000 }, async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() { cancelled = true; return new Promise<void>(() => {}); },
  });
  await assert.rejects(readModelContent(new Response(stream, { headers: { "content-type": "text/event-stream" } }), "test", undefined, {}, 5), /stream-stall/);
  assert.equal(cancelled, true);
});

test("an unavailable checkpoint does not block the remaining response", { timeout: 1000 }, async () => {
  const content = "x".repeat(40_000);
  const response = new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  const metrics: Record<string, unknown> = {};
  assert.equal(await readModelContent(response, "test", undefined, metrics, 100, { storageTimeoutMs: 5, checkpoint: () => new Promise<void>(() => {}) }), content);
  assert.equal(metrics.checkpointFailures, 1);
});

test("ancillary IO has a real deadline and successful IO retains its value", async () => {
  await assert.rejects(boundedModelIO(new Promise(() => {}), "storage", 5), /model-io-timeout:storage/);
  assert.equal(await boundedModelIO(Promise.resolve(42), "storage", 50), 42);
});
