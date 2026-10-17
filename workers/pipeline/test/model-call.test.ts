import { test } from "node:test";
import assert from "node:assert/strict";
import { callWorkerSecModel, callWorkerToolModel, SecModelHttpError, type SecPipelineEnv } from "../src/operations.ts";
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

test("a key that is not scoped to a workspace names the configured workspace on every request", async () => {
  const { fetcher, requests } = fakeFetch(sse([start(), ...text(0, "{}"), ...end("end_turn")]));
  await callWorkerSecModel({ ...env, ANTHROPIC_WORKSPACE_ID: "wrkspc_test" } as SecPipelineEnv, fetcher, "findings-write", "W.", {});
  assert.equal(requests[0]!.headers.get("anthropic-workspace-id"), "wrkspc_test");
  const { fetcher: plain, requests: none } = fakeFetch(sse([start(), ...text(0, "{}"), ...end("end_turn")]));
  await callWorkerSecModel(env, plain, "findings-write", "W.", {});
  assert.equal(none[0]!.headers.get("anthropic-workspace-id"), null);
});

const thinking = (index: number, signature: string) => [
  { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } },
  { type: "content_block_delta", index, delta: { type: "signature_delta", signature } },
  { type: "content_block_stop", index },
];
const toolUse = (index: number, id: string, name: string, json: string) => [
  { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } },
  { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(0, 5) } },
  { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(5) } },
  { type: "content_block_stop", index },
];
const tools = [{ name: "read", description: "Read.", strict: true, input_schema: { type: "object" as const, properties: { source: { type: "string" } }, required: ["source"], additionalProperties: false } }];

test("a tool turn sends the tools and the exchange as given, and returns the reply's blocks as they are to be sent back", async () => {
  const { fetcher, requests } = fakeFetch(sse([start("claude-sonnet-5-5"), ...thinking(0, "sig"), ...toolUse(1, "toolu_1", "read", '{"source":"b1-s1"}'), ...end("tool_use")]));
  const messages = [{ role: "user" as const, content: "task" }];
  const reply = await callWorkerToolModel(env, fetcher, "business-tree-1-1", { system: "Agent.", tools, messages }, "claude-sonnet-5-5", undefined, { reasoning: "medium" });
  assert.deepEqual(reply, { stopReason: "tool_use", refusalCategory: null, content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "tool_use", id: "toolu_1", name: "read", input: { source: "b1-s1" } }] });
  const body = requests[0]!.body;
  assert.deepEqual(body.tools, tools);
  assert.deepEqual(body.messages, messages);
  assert.equal(body.tool_choice, undefined, "Sonnet 5.5 refuses a forced tool choice");
  assert.equal(body.thinking, undefined);
  assert.deepEqual(body.cache_control, { type: "ephemeral" });
  assert.equal((body.system as Array<Record<string, unknown>>)[0]!.text, "Agent.");
  assert.equal(body.fallbacks, "default");
});

test("after a fallback mid-reply, only what may be echoed comes back, and a refusal keeps its category", async () => {
  const fallback = [{ type: "content_block_start", index: 2, content_block: { type: "fallback", from: { model: "claude-sonnet-5-5" }, to: { model: "claude-opus-5" } } }, { type: "content_block_stop", index: 2 }];
  const { fetcher } = fakeFetch(sse([start("claude-sonnet-5-5"), ...thinking(0, "declined"), ...toolUse(1, "toolu_1", "read", '{"source":"b1-s1"}'), ...fallback, ...toolUse(3, "toolu_2", "read", '{"source":"b1-s2"}'), ...end("tool_use")]));
  const reply = await callWorkerToolModel(env, fetcher, "business-tree-1-1", { system: "A.", tools, messages: [{ role: "user", content: "t" }] }, "claude-sonnet-5-5");
  assert.deepEqual(reply.content.map(b => b.id ?? b.type), ["toolu_2"]);
  const { fetcher: refusing } = fakeFetch(sse([start("claude-sonnet-5-5"), { type: "message_delta", delta: { stop_reason: "refusal", stop_sequence: null, stop_details: { type: "refusal", category: "cyber", explanation: null } }, usage: { output_tokens: 0 } }, { type: "message_stop" }]));
  const refused = await callWorkerToolModel(env, refusing, "business-tree-1-1", { system: "A.", tools, messages: [{ role: "user", content: "t" }] }, "claude-sonnet-5-5");
  assert.deepEqual([refused.stopReason, refused.refusalCategory], ["refusal", "cyber"]);
});

test("a tool turn keeps HTTP failures typed for the step's retry", async () => {
  const { fetcher } = fakeFetch(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } }), 529);
  await assert.rejects(callWorkerToolModel(env, fetcher, "business-tree-1-1", { system: "A.", tools, messages: [{ role: "user", content: "t" }] }), (error) =>
    error instanceof SecModelHttpError && error.status === 529 && error.providerCode === "overloaded_error");
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
