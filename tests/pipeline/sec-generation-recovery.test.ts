import assert from "node:assert/strict";
import test from "node:test";
import { readModelContent, MODEL_STREAM_LIMITS, parseModelJson, SecModelOutputError } from "../../workers/pipeline/src/model-stream.ts";
import { recoverModelJson, SecModelHttpError, type ModelCheckpoint, type ModelRequestOptions } from "../../workers/pipeline/src/model-recovery.ts";
import { storeWorkflowResult, loadWorkflowResult } from "../../workers/pipeline/src/workflow-results.ts";
import { normalizeReaderReport, readerArticleText } from "../../workers/pipeline/src/sec/reader.ts";
import { readerFixture, readerNodes } from "../fixtures/sec-reader-fixture.ts";
import type { SecNodePlan } from "../../workers/pipeline/src/sec/sec.ts";

const enc = new TextEncoder();
const event = (content: string, reason: string | null = null) => `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: reason }] })}\n\n`;
const stream = (text: string, piece = 89) => {
  const bytes = enc.encode(text); let position = 0;
  return new Response(new ReadableStream({ pull(c) {
    if (position >= bytes.length) { c.close(); return; }
    c.enqueue(bytes.slice(position, position += piece));
  } }), { headers: { "content-type": "text/event-stream" } });
};
const checkpointStore = () => {
  let saved: ModelCheckpoint | null = null;
  return { load: async () => saved, save: async (value: ModelCheckpoint | null) => { saved = value; } };
};
const recovery = { stage: "synthesis", model: "qwen3.8-flash", fallbackModel: "hy3", jsonMode: true, sleep: async () => {} };

test("SSE envelope overhead above the old 2 MB cap does not discard useful content", async () => {
  let index = 0;
  const response = new Response(new ReadableStream({ pull(c) {
    if (index++ === 0) { c.enqueue(enc.encode(event('{"text":"'))); return; }
    if (index <= 9000) {
      c.enqueue(enc.encode(`data: ${JSON.stringify({ id: "request-envelope-".repeat(18), choices: [{ delta: { content: "字", reasoning_content: "分析" } }] })}\n\n`)); return;
    }
    c.enqueue(enc.encode(event('"}', "stop") + "data: [DONE]\n\n")); c.close();
  } }), { headers: { "content-type": "text/event-stream" } });
  const metrics: Record<string, unknown> = {};
  const result = parseModelJson(await readModelContent(response, "large", undefined, metrics));
  assert.equal((result.text as string).length, 8999);
  assert.ok(Number(metrics.wireBytes) > 2_000_000);
  assert.ok(Number(metrics.contentBytes) < 40_000);
  assert.ok(Number(metrics.reasoningBytes) > 0);
});

test("independent wire, frame, reasoning and content guards cancel runaway streams", async () => {
  const cases = [
    { key: "wire", code: "wire_limit", text: event("abcdef") },
    { key: "frame", code: "frame_limit", text: event("abcdef") },
    { key: "content", code: "content_limit", text: event("超出正文") },
    { key: "reasoning", code: "reasoning_limit", text: 'data: {"choices":[{"delta":{"reasoning_content":"超出推理"}}]}\n\n' },
  ];
  for (const c of cases) await assert.rejects(readModelContent(stream(c.text), "limits", undefined, {}, undefined,
    { limits: { ...MODEL_STREAM_LIMITS, [c.key]: 4 } }), (e: unknown) => e instanceof SecModelOutputError && e.code === c.code);
});

test("a durable retry resumes persisted output and grows the token budget without truncating", async () => {
  const checkpoint = checkpointStore();
  const partial = '{"report":"已完成的一段🚀';
  await assert.rejects(recoverModelJson({ ...recovery, checkpoint, maxCalls: 1, request: async () => {
    throw new SecModelOutputError("output_token_limit", "length", partial);
  } }), /length/);
  assert.equal((await checkpoint.load())?.content, partial);
  const requests: ModelRequestOptions[] = [];
  const result = await recoverModelJson({ ...recovery, checkpoint, request: async (o) => {
    requests.push(o);
    if (requests.length === 1) throw new SecModelOutputError("output_token_limit", "length", "，保留后续推导");
    return '。","complete":true}';
  } });
  assert.equal(requests[0].continuation, partial);
  assert.equal(requests[0].jsonMode, false);
  assert.ok(requests[1].maxTokens > requests[0].maxTokens);
  assert.deepEqual(result, { report: "已完成的一段🚀，保留后续推导。", complete: true });
  assert.equal(await checkpoint.load(), null);
});

test("malformed JSON is repaired with the draft, not extracted from an arbitrary inner object", async () => {
  const malformed = 'preface {"inner":{"valid":true}} trailing junk';
  assert.throws(() => parseModelJson(malformed), /complete JSON/);
  let calls = 0;
  const result = await recoverModelJson({ ...recovery, request: async (o) => {
    if (++calls === 1) return malformed;
    assert.equal(o.repair, malformed); assert.equal(o.jsonMode, false);
    return '{"inner":{"valid":true}}';
  } });
  assert.equal(calls, 2); assert.deepEqual(result, { inner: { valid: true } });
});

test("HTTP recovery changes the relevant constraint and authentication fails without retries", async () => {
  for (const status of [429, 408, 500, 503]) {
    const waits: number[] = []; const models: string[] = [];
    assert.deepEqual(await recoverModelJson({ ...recovery, sleep: async (ms) => { waits.push(ms); }, request: async (o) => {
      models.push(o.model); if (models.length === 1) throw new SecModelHttpError(status, "temporary", 2000);
      return '{"ok":true}';
    } }), { ok: true });
    assert.deepEqual(models, ["qwen3.8-flash", "hy3"]); assert.equal(waits[0], 2000);
  }
  let calls = 0;
  await assert.rejects(recoverModelJson({ ...recovery, request: async () => { calls++; throw new SecModelHttpError(401, "bad auth"); } }), /bad auth/);
  assert.equal(calls, 1);
  calls = 0;
  await recoverModelJson({ ...recovery, request: async (o) => {
    if (++calls === 1) throw new SecModelHttpError(400, "max_tokens must be at most 32768");
    assert.equal(o.maxTokens, 32768); return '{}';
  } });
});

test("large Workflow results are lossless, isolated per run and integrity checked on replay", async () => {
  const objects = new Map<string, string>();
  const bucket = { async put(key: string, value: string) { objects.set(key, value); }, async get(key: string) {
    const value = objects.get(key); return value === undefined ? null : { text: async () => value };
  } };
  const result = { prose: "中文大报告".repeat(100_000), evidenceIds: ["original:table"] };
  const stored = await storeWorkflowResult(bucket, "run-1", "synthesis", result);
  assert.ok(enc.encode(JSON.stringify(stored)).length < 1024);
  assert.deepEqual(await loadWorkflowResult(bucket, stored), result);
  assert.notDeepEqual(await storeWorkflowResult(bucket, "run-2", "synthesis", result), stored);
  const key = [...objects.keys()][0]; objects.set(key, '{}');
  await assert.rejects(loadWorkflowResult(bucket, stored), /integrity/);
});

const plan: SecNodePlan = { nodes: [{ id: "demand", title: "需求", question: "变化？", sectionIds: [], historySeriesIds: [], memoryIds: [], acceptanceCriteria: [], materiality: "high" }], outlineSections: 1 };
const readerArgs = { nodes: readerNodes, plan, currentEvidence: new Set(["ev:demand"]), priorEvidence: new Set(["xbrl:prior"]), chartKeys: new Set<string>(), requireVisual: true };

test("500 varied fault-injection reports preserve the complete article through stream and display recovery", async (t) => {
  // This is deterministic engineering coverage, not an estimate of the provider's production SLA.
  let recovered = 0;
  for (let seed = 1; seed <= 500; seed++) {
    const reader = readerFixture();
    reader.sections[0].paragraphs[0] += ` 案例${seed}：保留转义字符\\、引号\"以及跨字节边界🚀。`;
    if (seed % 2) delete reader.sections[0].visual;
    else reader.sections[0].visual = { layout: "chart_focus", rationale: "检查图表" };
    if (seed % 3 === 0) reader.sections[2].visual!.paragraphLabels = ["缺失标签"];
    const expected = JSON.stringify({ readerReport: reader });
    const cut = 20 + (seed * 131) % (expected.length - 40);
    let calls = 0;
    const value = await recoverModelJson({ ...recovery, request: async (o) => {
      calls++;
      if (calls === 1 && seed % 5 === 0) throw new SecModelHttpError(503, "injected outage");
      if (calls === 1) return readModelContent(stream(event(expected.slice(0, cut), seed % 2 ? "length" : null), 1 + seed % 71), "synthesis");
      const text = o.continuation ? expected.slice(cut) : expected;
      return readModelContent(stream(event(text, "stop") + "data: [DONE]\n\n", 1 + seed % 97), "synthesis");
    } });
    const normalized = normalizeReaderReport(value.readerReport, readerArgs);
    assert.deepEqual(normalized.sections.map(s => s.paragraphs), reader.sections.map(s => s.paragraphs));
    assert.deepEqual(normalized.sections.map(s => s.evidenceIds), reader.sections.map(s => s.evidenceIds));
    assert.ok(readerArticleText(normalized).includes("案例" + seed));
    assert.ok(normalized.sections.some(s => s.role === "bear_case"));
    assert.equal(normalized.sections[0].visual?.chart, undefined);
    recovered++;
  }
  assert.equal(recovered, 500);
  t.diagnostic(`Synthetic recovery cases: ${recovered}/500; production SLO is measured separately.`);
});

test("recovering presentation never turns invalid evidence or incomplete research into a published report", () => {
  const reader = readerFixture(); delete reader.sections[0].visual;
  reader.sections[0].evidenceIds = ["invented:evidence"];
  assert.throws(() => normalizeReaderReport(reader, readerArgs), /grounded/);
});
