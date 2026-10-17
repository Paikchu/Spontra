import { test } from "node:test";
import assert from "node:assert/strict";
import { callWorkerSecModel, SecModelHttpError, type SecPipelineEnv } from "../src/operations.ts";
import { SecModelOutputError } from "../src/model-stream.ts";

const env = { ANTHROPIC_API_KEY: "sk-test" } as unknown as SecPipelineEnv;
const sse = (events: Array<Record<string, unknown>>) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const start = (model = "claude-opus-5-5") => ({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 40, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
const text = (index: number, value: string) => [
  { type: "content_block_start", index, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index, delta: { type: "text_delta", text: value } },
  { type: "content_block_stop", index },
];
const end = (stop_reason: string, usage: Record<string, unknown> = { output_tokens: 12 }) => [
  { type: "message_delta", delta: { stop_reason, stop_sequence: null }, usage },
  { type: "message_stop" },
];
function fakeFetch(body: string, status = 200, headers: Record<string, string> = {}) {
  const requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return new Response(body, { status, headers: { "content-type": status === 200 ? "text/event-stream" : "application/json", ...headers } });
  }) as typeof fetch;
  return { fetcher, requests };
}

test("a model call streams one JSON object from the Messages API with effort, caching and server-side fallback", async () => {
  const { fetcher, requests } = fakeFetch(sse([start(), ...text(0, '{"ok":'), ...text(1, "true}"), ...end("end_turn")]));
  const value = await callWorkerSecModel(env, fetcher, "findings-write", "Write findings.", { ticker: "MSFT" }, undefined, undefined, true, { reasoning: "low" });
  assert.deepEqual(value, { ok: true });
  const [request] = requests;
  assert.match(request!.url, /api\.anthropic\.com\/v1\/messages/);
  assert.equal(request!.headers.get("x-api-key"), "sk-test");
  assert.match(request!.headers.get("anthropic-beta") ?? "", /server-side-fallback-2026-07-01/);
  assert.equal(request!.body.model, "claude-opus-5-5");
  assert.equal(request!.body.stream, true);
  assert.equal(request!.body.fallbacks, "default");
  assert.deepEqual(request!.body.output_config, { effort: "low" });
  assert.equal(request!.body.thinking, undefined);
  assert.deepEqual((request!.body.system as Array<Record<string, unknown>>)[0]!.cache_control, { type: "ephemeral" });
  assert.deepEqual(request!.body.messages, [{ role: "user", content: '{"ticker":"MSFT"}' }]);
});

test("Haiku has no server-side fallback, so its requests carry none", async () => {
  const { fetcher, requests } = fakeFetch(sse([start("claude-haiku-5-5"), ...text(0, "{}"), ...end("end_turn")]));
  await callWorkerSecModel(env, fetcher, "library-cards", "Cards.", {}, "claude-haiku-5-5");
  assert.equal(requests[0]!.body.fallbacks, undefined);
  assert.doesNotMatch(requests[0]!.headers.get("anthropic-beta") ?? "", /fallback/);
});

test("output cut off at max_tokens is a resumable failure that keeps the partial text", async () => {
  const { fetcher } = fakeFetch(sse([start(), ...text(0, '{"a":"unfinis'), ...end("max_tokens")]));
  await assert.rejects(callWorkerSecModel(env, fetcher, "synthesis", "S.", {}), (error) =>
    error instanceof SecModelOutputError && error.code === "output_token_limit" && error.partialContent === '{"a":"unfinis');
});

test("a refusal is not accepted as output", async () => {
  const { fetcher } = fakeFetch(sse([start(), ...end("refusal", { output_tokens: 0 })]));
  await assert.rejects(callWorkerSecModel(env, fetcher, "synthesis", "S.", {}), (error) =>
    error instanceof SecModelOutputError && error.code === "invalid_stream");
});

test("HTTP errors keep their status, provider code and retry-after for the recovery loop", async () => {
  const { fetcher } = fakeFetch(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }), 429, { "retry-after": "7" });
  await assert.rejects(callWorkerSecModel(env, fetcher, "synthesis", "S.", {}), (error) =>
    error instanceof SecModelHttpError && error.status === 429 && error.retryAfterMs === 7000 && error.providerCode === "rate_limit_error");
});
