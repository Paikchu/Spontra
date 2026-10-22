import { test } from "node:test";
import assert from "node:assert/strict";
import { createAnalysisOperations, type AnalysisEnv } from "../src/operations.ts";
import type { SecFiling } from "../src/sec/sec.ts";
import { executeSecAnalysisWorkflow, type AnalysisOperations, type WorkflowJobUpdate, type WorkflowStepLike } from "../src/workflow-core.ts";

const filing = (form: string, accessionNumber = "0001104659-26-065681"): SecFiling => ({
  ticker: "NBIS", cik: "0001513845", cikNumber: 1513845, companyName: "Nebius Group N.V.", form, filingDate: "2026-10-15", reportDate: "2026-09-30", accessionNumber,
  primaryDocument: "doc.htm", description: "", items: "", documentUrl: "https://www.sec.gov/doc.htm", indexUrl: "https://www.sec.gov/index.htm",
});
const point = (unit: string) => ({ periodScope: "quarter", startDate: "2026-07-01", endDate: "2026-09-30", basis: "reported", unit, currency: "USD" });
const step: WorkflowStepLike = { do: (_name, callback) => callback({ attempt: 1 }) };

/** A workflow run over one filing; every operation records its name, and the manager stops the run after discovery. */
function run(form: string, units: [string, string]) {
  const calls: string[] = [], jobs: WorkflowJobUpdate[] = [];
  const target = filing(form);
  const operations = {
    discover: async () => ({ feed: {}, filings: [target] }),
    publishFeed: async () => undefined,
    shouldAnalyze: async () => true,
    updateJob: async (job: WorkflowJobUpdate) => { jobs.push(job); },
    prepare: async () => { calls.push("prepare"); return { key: "filings/NBIS/x", filing: target, discoveryChunks: 2 }; },
    getContext: async () => { calls.push("context"); return {}; },
    buildBrief: async () => { calls.push("brief"); return { history: { series: [{ seriesId: "capex", quarters: [point(units[0]), point(units[1])], annual: [] }] } }; },
    scanDisclosures: async (_f: SecFiling, _r: unknown, index: number) => { calls.push(`discovery:${index}`); return { index, start: 0, end: 1, status: "complete", disclosures: [], rejected: 0 }; },
    finishDiscovery: async () => { calls.push("discovery-finish"); return { groundedDisclosures: 0 }; },
    summarizeEvent: async () => { calls.push("event-summary"); return {}; },
    publishEvent: async () => { calls.push("publish-event"); },
    plan: async () => { calls.push("manager"); throw new Error("stop after discovery"); },
  } as unknown as AnalysisOperations;
  return { calls, jobs, done: executeSecAnalysisWorkflow({ ticker: "NBIS", requestedBy: "scheduled", accessionNumber: target.accessionNumber }, "scheduled-NBIS-1", step, operations) };
}

test("a filing whose history mixes units fails at the brief, before any discovery call", async () => {
  const { calls, jobs, done } = run("20-F", ["USD", "shares"]);
  assert.deepEqual((await done).failed, ["0001104659-26-065681"]);
  assert.deepEqual(calls, ["prepare", "context", "brief"]);
  const failure = jobs.at(-1)!;
  assert.equal(failure.currentStage, "brief");
  assert.equal(failure.errorCode, "hard_failure");
  assert.match(failure.errorDetail ?? "", /Conflicting history units for capex/);
});

test("a usable brief is built before discovery, and the run goes on to the manager", async () => {
  const { calls, done } = run("20-F", ["USD", "USD"]);
  await done;
  assert.deepEqual(calls, ["prepare", "context", "brief", "discovery:0", "discovery:1", "discovery-finish", "manager"]);
});

test("each step a filing's job enters is recorded as the job's stage, with its detail and without the bookkeeping steps", async () => {
  const stages: string[] = [];
  const target = filing("20-F");
  const operations = {
    discover: async () => ({ feed: {}, filings: [target] }),
    publishFeed: async () => undefined,
    shouldAnalyze: async () => true,
    updateJob: async () => undefined,
    markJobStage: async (jobId: string, stage: string) => { assert.match(jobId, /^NBIS:0001104659-26-065681:/); stages.push(stage); },
    prepare: async () => ({ key: "filings/NBIS/x", filing: target, discoveryChunks: 2 }),
    getContext: async () => ({}),
    buildBrief: async () => ({ history: { series: [] } }),
    scanDisclosures: async (_f: SecFiling, _r: unknown, index: number) => ({ index, start: 0, end: 1, status: "complete", disclosures: [], rejected: 0 }),
    finishDiscovery: async () => ({ groundedDisclosures: 1 }),
    plan: async () => { throw new Error("stop after discovery"); },
  } as unknown as AnalysisOperations;
  await executeSecAnalysisWorkflow({ ticker: "NBIS", requestedBy: "scheduled", accessionNumber: target.accessionNumber }, "scheduled-NBIS-stages", step, operations);
  assert.deepEqual(stages, ["prepare", "context", "brief", "discovery:0", "discovery:1", "discovery-finish", "manager"]);
});

test("an exhibit-only amendment is published from the filing and does not enter the reader report", async () => {
  const calls: string[] = [], jobs: WorkflowJobUpdate[] = [];
  const target = filing("20-F/A");
  const operations = {
    discover: async () => ({ feed: {}, filings: [target] }),
    publishFeed: async () => undefined,
    shouldAnalyze: async () => true,
    updateJob: async (job: WorkflowJobUpdate) => { jobs.push(job); },
    prepare: async () => { calls.push("prepare"); return { key: "filings/NBIS/x", filing: target, coverAmendment: { exhibit: "97.1" }, discoveryChunks: 2 }; },
    publishAmendment: async () => { calls.push("publish-amendment"); },
    getContext: async () => { calls.push("context"); throw new Error("cover amendment must not build a brief"); },
    buildBrief: async () => { calls.push("brief"); throw new Error("cover amendment must not build a brief"); },
    plan: async () => { calls.push("manager"); throw new Error("cover amendment must not plan a report"); },
    scanDisclosures: async () => { calls.push("discovery"); throw new Error("cover amendment must not call the model"); },
  } as unknown as AnalysisOperations;
  const result = await executeSecAnalysisWorkflow({ ticker: "NBIS", requestedBy: "scheduled", accessionNumber: target.accessionNumber }, "scheduled-NBIS-amendment", step, operations);
  assert.deepEqual(result.analyzed, ["0001104659-26-065681"]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(calls, ["prepare", "publish-amendment"]);
  assert.equal(jobs.at(-1)?.status, "complete");
  assert.equal(jobs.at(-1)?.currentStage, "published");
});

test("an event filing still skips the brief and goes from discovery to its summary", async () => {
  const { calls, done } = run("6-K", ["USD", "shares"]);
  assert.deepEqual((await done).analyzed, ["0001104659-26-065681"]);
  assert.deepEqual(calls, ["prepare", "discovery:0", "discovery:1", "discovery-finish", "event-summary", "publish-event"]);
});

// --- Discovery reuse across Workflow runs ---

const sse = (events: Array<Record<string, unknown>>) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const reply = (json: string) => sse([
  { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "deepseek-flash", content: [], stop_reason: null, usage: { input_tokens: 40, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: json } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 12 } },
  { type: "message_stop" },
]);
const QUOTE = "The company entered into a five-year capacity agreement with a single customer that accounts for most of its backlog.";
const TEXT = `Item 5. Operating results. ${QUOTE} Revenue grew in the quarter.`;

function storage() {
  const objects = new Map<string, string>();
  return { objects, bucket: {
    async put(key: string, value: string) { objects.set(key, value); return {}; },
    async get(key: string) { return objects.has(key) ? { text: async () => objects.get(key)!, json: async () => JSON.parse(objects.get(key)!) } : null; },
    async list() { return { objects: [], truncated: false }; },
    async delete() { return undefined; },
  } };
}

test("a discovery chunk read once is reused by the next Workflow run of the same filing", async () => {
  const { objects, bucket } = storage();
  const target = filing("20-F");
  const reference = { key: "filings/NBIS/0001104659-26-065681", filing: target, discoveryChunks: 1 };
  objects.set(`${reference.key}/meta.json`, JSON.stringify({ filing: target, sourceMaterials: [], outline: [] }));
  objects.set(`${reference.key}/text.json`, JSON.stringify({ document: { text: TEXT }, blocks: [{ blockId: "b1", start: 0, end: TEXT.length }] }));
  let modelCalls = 0;
  const fetcher = (async () => {
    modelCalls++;
    return new Response(reply(JSON.stringify({ disclosures: [{ title: "Customer concentration", quote: QUOTE, whyItMatters: "One customer carries the backlog.", question: "How exposed is revenue to that customer?" }] })),
      { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const env = { SEC_FILINGS: bucket, DEEPSEEK_API_KEY: "sk-test" } as unknown as AnalysisEnv;

  const first = await createAnalysisOperations(env, fetcher, "scheduled-NBIS-1").scanDisclosures!(target, reference, 0);
  assert.equal(first.status, "complete");
  assert.equal(first.disclosures.length, 1);
  assert.equal(modelCalls, 1);

  const second = await createAnalysisOperations(env, fetcher, "scheduled-NBIS-2").scanDisclosures!(target, reference, 0);
  assert.deepEqual(second, first);
  assert.equal(modelCalls, 1, "the second run reads the stored chunk instead of asking the model");

  // A different model is a different request, so it asks again.
  const other = { ...env, AI_TOOL_SETTINGS: JSON.stringify({ "sec-analysis": { model: "deepseek-v4-pro" } }) } as AnalysisEnv;
  await createAnalysisOperations(other, fetcher, "scheduled-NBIS-3").scanDisclosures!(target, reference, 0);
  assert.equal(modelCalls, 2);
});

test("a chunk whose reply failed validation is not stored, so the next run asks again", async () => {
  const { objects, bucket } = storage();
  const target = filing("20-F");
  const reference = { key: "filings/NBIS/0001104659-26-065681", filing: target, discoveryChunks: 1 };
  objects.set(`${reference.key}/meta.json`, JSON.stringify({ filing: target, sourceMaterials: [], outline: [] }));
  objects.set(`${reference.key}/text.json`, JSON.stringify({ document: { text: TEXT }, blocks: [{ blockId: "b1", start: 0, end: TEXT.length }] }));
  let modelCalls = 0;
  const fetcher = (async () => { modelCalls++; return new Response(reply(JSON.stringify({ items: [] })), { status: 200, headers: { "content-type": "text/event-stream" } }); }) as typeof fetch;
  const env = { SEC_FILINGS: bucket, DEEPSEEK_API_KEY: "sk-test" } as unknown as AnalysisEnv;
  const final = { attempt: 4, finalAttempt: true };
  assert.equal((await createAnalysisOperations(env, fetcher, "a").scanDisclosures!(target, reference, 0, final)).status, "failed");
  const before = modelCalls;
  assert.equal((await createAnalysisOperations(env, fetcher, "b").scanDisclosures!(target, reference, 0, final)).status, "failed");
  assert.ok(modelCalls > before);
  assert.equal([...objects.keys()].some(k => k.includes("/discovery-cache/")), false);
});
