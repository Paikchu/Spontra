import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverModelJson, SecModelHttpError, type ModelRequestOptions } from "../src/model-recovery.ts";

const options = { stage: "test", model: "deepseek-flash", fallbackModel: "deepseek-v4-pro" };

test("an unsupported schema parameter propagates immediately without repeating the request", async () => {
  const failure = new SecModelHttpError(400, "unsupported schema parameter");
  let calls = 0;
  const events: Record<string, unknown>[] = [];
  const sleeps: number[] = [];
  await assert.rejects(recoverModelJson({ ...options,
    request: async () => { calls++; throw failure; },
    log: (event) => { events.push(event); },
    sleep: async (ms) => { sleeps.push(ms); },
  }), (error) => error === failure);
  assert.equal(calls, 1);
  assert.deepEqual(events, []);
  assert.deepEqual(sleeps, []);
});

test("invalid JSON is repaired using the previous response", async () => {
  const requests: ModelRequestOptions[] = [];
  const result = await recoverModelJson({ ...options, request: async (request) => {
    requests.push(request);
    return requests.length === 1 ? '{"ok":tru}' : '{"ok":true}';
  } });
  assert.deepEqual(result, { ok: true });
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.repair, '{"ok":tru}');
});

test("a context overflow retries with a smaller completion budget", async () => {
  const requests: ModelRequestOptions[] = [];
  const result = await recoverModelJson({ ...options, request: async (request) => {
    requests.push(request);
    if (requests.length === 1) throw new SecModelHttpError(400,
      "This model's maximum context length is 131072 tokens (120000 tokens in the messages)");
    return '{"ok":true}';
  } });
  assert.deepEqual(result, { ok: true });
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.maxTokens, 131072 - 120000 - 256);
  assert.ok(requests[1]!.maxTokens < requests[0]!.maxTokens);
});

for (const status of [408, 429, 503]) {
  test(`a retryable provider HTTP ${status} backs off and switches models`, async () => {
    const requests: ModelRequestOptions[] = [];
    const sleeps: number[] = [];
    const result = await recoverModelJson({ ...options,
      sleep: async (ms) => { sleeps.push(ms); },
      request: async (request) => {
        requests.push(request);
        if (requests.length === 1) throw new SecModelHttpError(status, "provider unavailable", 7000);
        return '{"ok":true}';
      },
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(requests.length, 2);
    assert.equal(requests[1]!.model, options.fallbackModel);
    assert.deepEqual(sleeps, [7000]);
  });
}
