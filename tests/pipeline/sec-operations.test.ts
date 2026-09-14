import assert from "node:assert/strict";
import test from "node:test";

import { D1SecRepository, type SecMemoryExtractionPayload } from "../../workers/pipeline/src/sec/d1.ts";
import type { SecAnalysisArtifact } from "../../workers/pipeline/src/sec/types.ts";
import type { SecFiling, SecNodeSpec } from "../../workers/pipeline/src/sec/sec.ts";
import { callWorkerSecModel, createSecPipelineOperations, modelForStage, type SecPipelineEnv } from "../../workers/pipeline/src/operations.ts";
import { executeSecMemoryWorkflow } from "../../workers/pipeline/src/memory-workflow.ts";
import { modelExecutionForAttempt, retryDelayForAttempt } from "../../workers/pipeline/src/retry-policy.ts";

const filing: SecFiling = {
  ticker: "MSFT", cik: "0000789019", cikNumber: 789019, companyName: "Microsoft Corp", form: "10-K",
  filingDate: "2026-07-30", reportDate: "2026-06-30", accessionNumber: "annual", primaryDocument: "msft.htm",
  description: "Annual report", items: "", documentUrl: "https://sec.test/msft.htm", indexUrl: "https://sec.test/index.htm",
};

test("uses hy3 only after the primary model attempt fails", () => {
  assert.deepEqual(modelExecutionForAttempt(1), { attempt: 1, finalAttempt: false });
  assert.deepEqual(modelExecutionForAttempt(2), { attempt: 2, model: "hy3", finalAttempt: false });
  assert.deepEqual(modelExecutionForAttempt(4), { attempt: 4, model: "hy3", finalAttempt: true });
});

test("adds bounded jitter around 30, 90, and 180 second retry delays", () => {
  assert.equal(retryDelayForAttempt(1, () => 0), 24_000);
  assert.equal(retryDelayForAttempt(1, () => 0.5), 30_000);
  assert.equal(retryDelayForAttempt(2, () => 0.5), 90_000);
  assert.equal(retryDelayForAttempt(3, () => 0.5), 180_000);
  assert.equal(retryDelayForAttempt(3, () => 1), 216_000);
});

test("sends an explicit fallback model override to B.ai", async () => {
  let requestedModel = "";
  const env = {
    SEC_REFRESH_KEY: "refresh-key",
    SEC_USER_AGENT: "test@example.com",
    AI_API_KEY: "worker-model-secret",
    SEC_ANALYSIS_MODEL: "primary-model",
    SEC_FILINGS: { async get() { return null; }, async put() { return {}; } },
  } as unknown as SecPipelineEnv;
  const fetcher: typeof fetch = async (_input, init) => {
    requestedModel = (JSON.parse(String(init?.body)) as { model: string }).model;
    return Response.json({ choices: [{ message: { content: "{}" } }] });
  };

  await callWorkerSecModel(env, fetcher, "test", "Return JSON", {}, "hy3");

  assert.equal(requestedModel, "hy3");
});

const modelEnv = {
  SEC_REFRESH_KEY: "refresh-key",
  SEC_USER_AGENT: "test@example.com",
  AI_API_KEY: "worker-model-secret",
  SEC_ANALYSIS_MODEL: "primary-model",
  SEC_FILINGS: { async get() { return null; }, async put() { return {}; } },
} as unknown as SecPipelineEnv;

function sse(...events: string[]): Response {
  return new Response(events.map((event) => `data: ${event}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function delta(content: string, finishReason: string | null = null) {
  return JSON.stringify({ choices: [{ delta: { content }, finish_reason: finishReason }] });
}

test("streams the completion so the provider proxy cannot time the request out", async () => {
  let requestBody: Record<string, unknown> = {};
  let acceptHeader = "";
  const fetcher: typeof fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    acceptHeader = String((init?.headers as Record<string, string>)?.accept ?? "");
    return sse(delta('{"head'), delta('line":"ok"}', "stop"), "[DONE]");
  };

  const result = await callWorkerSecModel(modelEnv, fetcher, "earnings-period", "Identify the fiscal period.", {});

  assert.match(JSON.stringify(requestBody.messages), /JSON/, "JSON mode requires an explicit JSON instruction even for classification prompts");
  assert.equal(requestBody.stream, true, "stream must be requested");
  assert.deepEqual(requestBody.response_format, { type: "json_object" });
  assert.equal(acceptHeader, "text/event-stream");
  assert.deepEqual(result, { headline: "ok" });
});

test("still reads gateways that ignore the stream flag", async () => {
  const fetcher: typeof fetch = async () => Response.json({ choices: [{ message: { content: '{"headline":"ok"}' } }] });

  assert.deepEqual(await callWorkerSecModel(modelEnv, fetcher, "node:test", "Return JSON", {}), { headline: "ok" });
});

test("durable recovery avoids provider JSON mode even after fallback rate limiting", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const env = { ...modelEnv, SEC_FILINGS: {
    async get(key: string) {
      const value = key.endsWith("meta.json") ? { filing }
        : { document: { text: "Current filing disclosure text." }, blocks: [] };
      return { async text() { return JSON.stringify(value); } };
    },
    async put() { return {}; },
  } } as unknown as SecPipelineEnv;
  const fetcher: typeof fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)));
    if (requests.length === 1) return new Response("rate limited", { status: 429 });
    return sse(delta('{"disclosures":[]}', "stop"), "[DONE]");
  };
  const result = await createSecPipelineOperations(env, fetcher).scanDisclosures!(filing, { key: "filings/MSFT/annual", filing }, 0, modelExecutionForAttempt(2));
  assert.equal(result.status, "complete");
  assert.deepEqual(requests.map((r) => r.model), ["hy3", "primary-model"]);
  assert.ok(requests.every((r) => !r.response_format));
  assert.ok(requests.every((r) => /Return one valid JSON object only/.test(JSON.stringify(r.messages))));
});

test("plain transport recovery still rejects invalid JSON and incomplete streams", async () => {
  for (const response of [sse(delta("not JSON", "stop"), "[DONE]"), sse(delta('{"disclosures":[]}'))]) {
    await assert.rejects(callWorkerSecModel(modelEnv, async () => response, "discovery:0", "Return JSON", {}, undefined, 1000, false));
  }
});

test("rejects a truncated stream instead of parsing a plausible fragment", async () => {
  // Without [DONE] or a finish_reason the body is incomplete; parseModelJson would happily read
  // the inner object and return the wrong answer.
  const fetcher: typeof fetch = async () => sse(delta('{"headline":"ok","keyMetrics":[{"metricKey":"revenue"}'));

  await assert.rejects(
    callWorkerSecModel(modelEnv, fetcher, "node:test", "Return JSON", {}),
    (error: Error) => {
      assert.match(error.message, /stream ended before completion/);
      // Must not look like a schema violation, or the retry would resend with the wrong prompt
      // instead of letting the Workflow step retry on the fallback model.
      assert.equal(error instanceof SyntaxError, false);
      assert.equal(error.message.includes("JSON object"), false);
      return true;
    },
  );
});

test("surfaces an error frame carried inside the stream", async () => {
  const fetcher: typeof fetch = async () => sse(JSON.stringify({ error: { message: "upstream overloaded", code: 503 } }));

  await assert.rejects(callWorkerSecModel(modelEnv, fetcher, "node:test", "Return JSON", {}), /stream error.*upstream overloaded/);
});

test("rejects a stream cut short by the output token limit", async () => {
  const fetcher: typeof fetch = async () => sse(delta('{"headline":"tru'), delta("", "length"));

  await assert.rejects(callWorkerSecModel(modelEnv, fetcher, "node:test", "Return JSON", {}), /output token limit/);
});

test("scheduled analysis does not overlap an already running filing job", async () => {
  const env = {
    SEC_REFRESH_KEY: "refresh-key",
    SEC_TRACKED_TICKERS: "MSFT",
    SEC_USER_AGENT: "test@example.com",
    SEC_FILINGS: { async get() { return null; }, async put() { return {}; } },
    DB: {
      prepare() { return { bind() { return { async first() { return { status: "running" }; } }; } }; },
    },
  } as unknown as SecPipelineEnv;
  const operations = createSecPipelineOperations(env);

  assert.equal(await operations.shouldAnalyze(filing, "scheduled"), false);
  assert.equal(await operations.shouldAnalyze(filing, "manual"), true);
});

test("calls B.ai from the workflow worker when its shared AI secret is configured", async () => {
  const objects = new Map<string, string>();
  const requests: string[] = [];
  const env = {
    SEC_REFRESH_KEY: "refresh-key",
    SEC_USER_AGENT: "test@example.com",
    AI_API_KEY: "worker-model-secret",
    SEC_ANALYSIS_MODEL: "glm-5.3-flash",
    SEC_FILINGS: {
      async get(key: string) {
        const value = objects.get(key);
        return value === undefined ? null : { async text() { return value; } };
      },
      async put(key: string, value: string) {
        objects.set(key, value);
        return {};
      },
    },
  } as unknown as SecPipelineEnv;
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url === filing.documentUrl) return new Response("<h1>Item 7. Management Discussion</h1><p>Revenue was 120 USDm.</p>");
    if (url === "https://api.b.ai/v1/chat/completions") {
      const prepared = JSON.parse(objects.get("filings/MSFT/annual/meta.json") ?? "{}") as { outline?: Array<{ id: string }> };
      return Response.json({ choices: [{ message: { content: JSON.stringify({ nodes: [{ id: "growth", title: "增长质量", question: "增长由什么驱动？", sectionIds: [prepared.outline?.[0]?.id] }] }) } }] });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const operations = createSecPipelineOperations(env, fetcher);
  const reference = await operations.prepare(filing);

  await operations.plan(filing, reference);

  assert.ok(requests.includes("https://api.b.ai/v1/chat/completions"));
  assert.equal(requests.some((url) => url.includes("/api/internal/sec/model")), false);
});

test("plans and runs dynamic nodes from the prepared R2 filing", async () => {
  const objects = new Map<string, string>();
  const env = {
    SEC_REFRESH_KEY: "refresh-key",
    SEC_USER_AGENT: "test@example.com",
    AI_API_KEY: "worker-model-secret",
    SEC_FILINGS: {
      async get(key: string) {
        const value = objects.get(key);
        return value === undefined ? null : { async text() { return value; } };
      },
      async put(key: string, value: string) {
        objects.set(key, value);
        return {};
      },
    },
  } as unknown as SecPipelineEnv;
  const fetcher: typeof fetch = async (input, init) => {
    if (String(input) === filing.documentUrl) {
      return new Response("<h1>Item 7. Management Discussion</h1><p>Revenue increased 12% to $120 million due to cloud demand.</p>");
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ content?: string }> };
    const payload = JSON.parse(body.messages?.[1]?.content ?? "{}");
    if (Array.isArray(payload.sections) && !payload.sections.some((section: { text?: string }) => section.text)) {
      const prepared = JSON.parse(objects.get("filings/MSFT/annual/meta.json") ?? "{}") as { outline?: Array<{ id: string }> };
      return Response.json({ choices: [{ message: { content: JSON.stringify({ nodes: [{ id: "growth", title: "增长质量", question: "增长由什么驱动？", sectionIds: [prepared.outline?.[0]?.id], keywords: ["revenue", "cloud"] }] }) } }] });
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify({ findings: [{ label: "收入", detail: "收入同比增长12%。", importance: "high" }], narrative: "云需求推动收入增长。" }) } }] });
  };
  const operations = createSecPipelineOperations(env, fetcher);
  const reference = await operations.prepare(filing);
  const plan = await operations.plan(filing, reference);
  const node = await operations.analyzeNode(plan.nodes[0] as SecNodeSpec, filing, reference);

  assert.equal(plan.nodes.length, 1);
  assert.equal(node.status, "complete");
  assert.match(node.narrative, /云需求/);
});

test("fetches XBRL during prepare and resolves context through one D1 round trip", async () => {
  const objects = new Map<string, string>();
  let factsWritten = 0;
  const env = {
    SEC_REFRESH_KEY: "refresh-key",
    SEC_TRACKED_TICKERS: "MSFT",
    SEC_USER_AGENT: "test@example.com",
    AI_API_KEY: "worker-model-secret",
    SEC_FILINGS: {
      async get(key: string) {
        const value = objects.get(key);
        return value === undefined ? null : { async text() { return value; } };
      },
      async put(key: string, value: string) {
        objects.set(key, value);
        return {};
      },
    },
    DB: {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async first() {
                // getAnalysisContext's own lookups (prior period, memory thread) — none apply here.
                return null;
              },
              async all() {
                if (!/FROM sec_facts/.test(sql)) return { results: [] };
                // Stands in for D1 read-after-write: a real database would hand back the row
                // `saveHistoricalObservation` just inserted below. Read/write consistency itself is
                // D1SecRepository's own contract, covered where that class is tested directly — this
                // double only needs to prove the brief-building pipeline surfaces a row once D1 has
                // one, the same shape the write path would have produced from this filing's XBRL.
                if (!factsWritten) return { results: [] };
                return { results: [{
                  observationId: "fact-revenue", seriesId: "revenue", metricKey: "revenue",
                  value: "120", unit: "USD", currency: "USD", basis: "gaap",
                  startDate: "2025-07-01", endDate: "2026-06-30",
                  sourceAccession: filing.accessionNumber, sourceFiledAt: "2026-07-30", sourceVersion: "sec-structure.v1",
                  xbrlConcept: "us-gaap:Revenues", derivationFormula: "",
                  dimensions: JSON.stringify({ periodScope: "annual" }),
                }] };
              },
              async run() {
                if (/INSERT INTO sec_facts/.test(sql)) factsWritten += 1;
                return {};
              },
            };
          },
        };
      },
    },
  } as unknown as SecPipelineEnv;
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url === filing.documentUrl) return new Response("<h1>Item 7. Management Discussion</h1><p>Revenue was 120 USDm.</p>");
    if (url.includes("/api/xbrl/companyfacts/")) {
      return Response.json({ facts: { "us-gaap": { Revenues: { units: { USD: [
        { start: "2025-07-01", end: "2026-06-30", val: 120, accn: "annual", fy: 2026, fp: "FY", form: "10-K", filed: "2026-07-30" },
      ] } } } } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const operations = createSecPipelineOperations(env, fetcher);

  const reference = await operations.prepare(filing);
  const context = await operations.getContext(filing, reference);
  const brief = await operations.buildBrief!(filing, reference, context);

  assert.ok(factsWritten > 0, "the fetched XBRL history must be persisted to D1 before the context is read back");
  assert.equal(context.currentPeriodId, "MSFT:2026-06-30:annual");
  assert.deepEqual([...objects.keys()].filter((key) => key.startsWith("filings/")).sort(), [
    "filings/MSFT/annual/history.json",
    "filings/MSFT/annual/meta.json",
    "filings/MSFT/annual/text.json",
  ]);
  assert.ok(JSON.parse(objects.get("filings/MSFT/annual/meta.json")!).blockIds.length > 0);
  assert.equal(JSON.parse(objects.get("filings/MSFT/annual/meta.json")!).document, undefined);
  assert.deepEqual(brief.currentFacts.map((fact) => [fact.metricKey, fact.value]), [["revenue", "120"]]);
});

test("publishes cited evidence in bounded D1 bridge calls", async () => {
  const blocks = Array.from({ length: 20 }, (_, ordinal) => ({
    blockId: `block-${ordinal}`,
    ordinal,
    heading: "Financial Statements",
    headingPath: "Item 8",
    elementType: "paragraph" as const,
    preview: `Block ${ordinal}`,
    body: `Revenue evidence ${ordinal}`,
    tokenCount: 3,
    numericDensity: 0.2,
    tableCount: 0,
    contentHash: `hash-${ordinal}`,
  }));
  const citedBlocks = blocks.slice(0, 18);
  const prepared = {
    filing,
    periodId: "MSFT:2026-06-30:annual",
    periodScope: "annual" as const,
    blocks,
    document: { text: blocks.map((block) => block.body).join("\n"), headings: [] },
    outline: [],
  };
  const runCalls: string[] = [];
  const batchCalls: Array<{ sql: string; values: unknown[] }[]> = [];
  const env = {
    SEC_REFRESH_KEY: "refresh-key",
    SEC_TRACKED_TICKERS: "MSFT",
    SEC_USER_AGENT: "test@example.com",
    SEC_FILINGS: {
      async get(key: string) {
        if (key === "filings/MSFT/annual/meta.json") {
          return { async text() { return JSON.stringify({ filing, periodId: prepared.periodId, periodScope: prepared.periodScope, outline: [], blockIds: blocks.map((block) => `ev:${block.blockId}`) }); } };
        }
        if (key === "filings/MSFT/annual/text.json") {
          return { async text() { return JSON.stringify({ document: prepared.document, blocks }); } };
        }
        return null;
      },
      async put() { return {}; },
    },
    DB: {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              async run() { runCalls.push(sql); return {}; },
              async first() { return null; },
              async all() { return { results: [] }; },
              sql,
              values,
            };
          },
        };
      },
      async batch(statements: Array<{ sql: string; values: unknown[] }>) {
        batchCalls.push(statements);
        return statements.map(() => ({}));
      },
    },
  } as unknown as SecPipelineEnv;
  const artifact = {
    filing,
    periodId: prepared.periodId,
    periodScope: prepared.periodScope,
    blocks: [],
    comparisons: [],
    artifactKeys: { synthesis: "analysis/MSFT/annual/synthesis.json" },
    report: {
      ticker: "MSFT",
      periodId: prepared.periodId,
      reportVersion: "v1",
      headline: "verified",
      keyMetrics: [{ metricKey: "revenue", currentValue: "331839", status: "verified" as const, evidenceIds: citedBlocks.map((block) => `ev:${block.blockId}`) }],
      changes: { qoq: [], yoy: [], guidance: [], risks: [] },
      dataQuality: { coverage: 1, verificationStatus: "verified" as const, warnings: [] },
    },
  } satisfies SecAnalysisArtifact;
  const summary = {
    ticker: "MSFT", form: "10-K", filingDate: filing.filingDate, accessionNumber: "annual",
    headline: "verified", bullets: [], analystView: "Test", source: "deepseek" as const, generatedAt: "2026-08-10T00:00:00.000Z",
  };

  const result = await createSecPipelineOperations(env).publish(artifact, summary);

  const blockBatches = batchCalls.filter((statements) => statements.some((statement) => /sec_filing_blocks/.test(statement.sql)));
  const publicationBatches = batchCalls.filter((statements) => statements.some((statement) => /sec_published_reports/.test(statement.sql)));
  assert.equal(blockBatches.length, 1, "18 cited blocks fit in a single 40-block chunk");
  assert.equal(blockBatches[0]!.length, citedBlocks.length * 2, "each block writes its evidence row alongside it");
  assert.equal(publicationBatches.length, 1, "the final commit is a single atomic batch, separate from the evidence writes");
  assert.equal(result?.memoryJobId, "MSFT:MSFT:2026-06-30:annual:v1:memory");
});

test("publishes event summaries without creating a structured filing artifact", async () => {
  const stored: Array<{ sql: string; values: unknown[] }> = [];
  const env = {
    SEC_REFRESH_KEY: "refresh-key",
    SEC_TRACKED_TICKERS: "MSFT",
    SEC_USER_AGENT: "test@example.com",
    SEC_FILINGS: { async get() { return null; }, async put() { return {}; } },
    DB: {
      prepare(sql: string) {
        return { bind(...values: unknown[]) { return { async run() { stored.push({ sql, values }); return {}; } }; } };
      },
    },
  } as unknown as SecPipelineEnv;
  const summary = {
    ticker: "MSFT", form: "8-K", filingDate: "2026-08-10", accessionNumber: "event",
    headline: "事件简析", bullets: [{ label: "事件", detail: "影响已披露。", importance: "high" as const }],
    analystView: "事件改变短期预期。", source: "deepseek" as const, generatedAt: "2026-08-10T00:00:00.000Z",
  };

  await createSecPipelineOperations(env).publishEvent(summary);

  assert.equal(stored.length, 1);
  assert.match(stored[0]!.sql, /sec_filing_summaries/);
  assert.deepEqual(stored[0]!.values, ["MSFT", "event", "2026-08-10T00:00:00.000Z", JSON.stringify(summary)]);
});

test("rejects an event summary whose form does not match the filing it targets", async () => {
  const env = {
    SEC_REFRESH_KEY: "refresh-key",
    SEC_TRACKED_TICKERS: "MSFT",
    SEC_USER_AGENT: "test@example.com",
    SEC_FILINGS: { async get() { return null; }, async put() { return {}; } },
    DB: { prepare() { throw new Error("must not reach the database"); } },
  } as unknown as SecPipelineEnv;
  const summary = {
    ticker: "MSFT", form: "10-Q", filingDate: "2026-08-10", accessionNumber: "event",
    headline: "事件简析", bullets: [], analystView: "事件改变短期预期。", source: "deepseek" as const, generatedAt: "2026-08-10T00:00:00.000Z",
  };

  await assert.rejects(createSecPipelineOperations(env).publishEvent(summary), /SEC 事件简析无效/);
});

test("routes planning, review, and synthesis to the reasoning model and leaves node work on the primary", () => {
  const tiered = { SEC_ANALYSIS_MODEL: "glm-5.3-flash", SEC_REASONING_MODEL: "glm-5.3" } as unknown as SecPipelineEnv;
  const single = { SEC_ANALYSIS_MODEL: "glm-5.3-flash" } as unknown as SecPipelineEnv;

  assert.equal(modelForStage(tiered, "manager"), "glm-5.3");
  assert.equal(modelForStage(tiered, "manager-review:1"), "glm-5.3");
  assert.equal(modelForStage(tiered, "synthesis"), "glm-5.3");
  assert.equal(modelForStage(tiered, "synthesis:schema-retry"), "glm-5.3");
  assert.equal(modelForStage(tiered, "node:revenue-growth"), undefined);
  assert.equal(modelForStage(tiered, "event-summary"), undefined);
  assert.equal(modelForStage(tiered, "manager", "hy3"), "hy3");
  assert.equal(modelForStage(single, "manager"), undefined);
});

test("memory extraction still receives this filing's claims and prior memory ids", async () => {
  const claim = { jobId: "job-1", ticker: "MSFT", filingId: "annual", periodId: "MSFT:2026-06-30:annual", sourceR2Key: "analysis/MSFT/annual/synthesis.json", ownerToken: "owner-1", leaseUntil: "2026-08-28T00:00:00.000Z" };
  const source = {
    artifact: {
      validEvidenceIds: ["ev:block-1"],
      brief: { memoryItems: [{ memoryId: "memory:guidance", topicKey: "guidance", statement: "Management guided to margin recovery." }] },
      report: {
        changes: {
          guidance: [{ topicKey: "fy27-guidance", claimType: "guidance", statement: "FY27 revenue guided higher.", evidenceIds: ["ev:block-1"] }],
          risks: [{ topicKey: "supply", claimType: "risk", statement: "Supply remains constrained.", evidenceIds: ["ev:block-1"] }],
        },
      },
    },
    summary: {
      nodes: [{
        id: "guidance",
        title: "指引",
        findings: [{ label: "指引", detail: "FY27 收入指引上修。", importance: "high" }],
        narrative: "管理层上修了 FY27 指引。",
        facts: [{ metricKey: "segment_revenue", value: "60", unit: "USDm", evidenceIds: ["ev:block-1"] }],
        evidenceIds: ["ev:block-1"],
        evidence: [{ start: 0, end: 30, score: 90, reasons: ["包含定量数据"], excerpt: "LOCATED-EXCERPT-MARKER" }],
      }],
    },
  };
  let modelPayload = "";
  const capturedExtractions: SecMemoryExtractionPayload[] = [];
  let createdCompanyAnalysis: Record<string, unknown> | null = null;
  const env = {
    SEC_REFRESH_KEY: "refresh-key",
    SEC_TRACKED_TICKERS: "MSFT",
    AI_API_KEY: "worker-model-secret",
    // claimMemoryJob and commitMemoryJob are stubbed on the prototype below — their own SQL and
    // the optimistic-locking semantics are D1SecRepository's job and are covered where that class
    // is tested directly. This test is about the workflow's own data shaping around them.
    DB: {},
    SEC_FILINGS: {
      async get(key: string) {
        return key === claim.sourceR2Key ? { async text() { return JSON.stringify(source); } } : null;
      },
      async put() { return {}; },
    },
    COMPANY_ANALYSIS_WORKFLOW: {
      async create(options: Record<string, unknown>) {
        createdCompanyAnalysis = options;
        return { id: String(options.id) };
      },
    },
  } as unknown as SecPipelineEnv;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://api.b.ai/v1/chat/completions") {
      modelPayload = JSON.parse(String(init?.body ?? "{}")).messages[1].content;
      return Response.json({ choices: [{ message: { content: JSON.stringify({ candidates: [
        { candidateId: "c-1", memoryId: "memory:guidance", kind: "fact", topicKey: "margin", statement: "Margin recovered.", evidenceIds: ["ev:block-1"], materialityScore: 80, confidence: "high", disposition: "active" },
        { candidateId: "c-2", memoryId: "memory:invented", kind: "fact", topicKey: "backlog", statement: "Backlog grew.", evidenceIds: ["ev:block-1"], materialityScore: 60, confidence: "medium", disposition: "active" },
      ] }) } }] });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const originalClaim = D1SecRepository.prototype.claimMemoryJob;
  const originalCommit = D1SecRepository.prototype.commitMemoryJob;
  D1SecRepository.prototype.claimMemoryJob = async () => claim;
  D1SecRepository.prototype.commitMemoryJob = async (_claim: unknown, extraction: SecMemoryExtractionPayload) => {
    capturedExtractions.push(extraction);
    return { noOp: false, itemCount: 2, memoryVersion: 3 };
  };
  let result: Awaited<ReturnType<typeof executeSecMemoryWorkflow>>;
  try {
    result = await executeSecMemoryWorkflow({ jobId: "job-1", ticker: "MSFT" }, "instance-1", { do: (_name, callback) => callback() }, env, fetcher);
  } finally {
    D1SecRepository.prototype.claimMemoryJob = originalClaim;
    D1SecRepository.prototype.commitMemoryJob = originalCommit;
  }

  const payload = JSON.parse(modelPayload) as Record<string, unknown>;
  assert.equal(result.status, "committed");
  assert.deepEqual((payload.claims as Array<{ topicKey: string }>).map((item) => item.topicKey), ["fy27-guidance", "supply"]);
  assert.match(JSON.stringify(payload.outputSchema), /memoryId/);
  // Analysis no longer sees memory, so the brief is the only route priorMemory still travels.
  assert.deepEqual((payload.priorMemory as Array<{ memoryId: string }>).map((item) => item.memoryId), ["memory:guidance"]);
  // Node analysis reaches the extractor projected: the citable ids stay, the located excerpts go.
  assert.equal(payload.nodeFindings, undefined);
  assert.deepEqual((payload.nodeAnalyses as Array<{ evidenceIds: string[] }>)[0].evidenceIds, ["ev:block-1"]);
  assert.match(modelPayload, /FY27 收入指引上修/);
  assert.doesNotMatch(modelPayload, /LOCATED-EXCERPT-MARKER/);
  assert.equal(capturedExtractions.length, 1);
  const capturedCandidates = capturedExtractions[0]!.candidates;
  assert.equal(capturedCandidates[0]?.memoryId, "memory:guidance");
  assert.equal(capturedCandidates[1]?.memoryId, undefined);
  assert.equal(result.companyAnalysisQueued, true);
  assert.deepEqual((createdCompanyAnalysis as unknown as { params: Record<string, unknown> }).params, {
    ticker: "MSFT",
    memoryJobId: "job-1",
    memoryVersion: 3,
    periodId: "MSFT:2026-06-30:annual",
    reportDate: "2026-06-30",
    triggerRef: "job-1:3",
  });
});

test("recovers once on the primary model when the fallback is rate limited", async () => {
  for (const status of [429, 503]) {
    const objects = new Map<string, string>();
    const models: string[] = [];
    const env = { ...modelEnv, SEC_FILINGS: {
      async get(key: string) { const value = objects.get(key); return value === undefined ? null : { async text() { return value; } }; },
      async put(key: string, value: string) { objects.set(key, value); return {}; },
    } } as unknown as SecPipelineEnv;
    const fetcher: typeof fetch = async (input, init) => {
      if (String(input) === filing.documentUrl) return new Response('<h1>Item 7. Management Discussion</h1><p>Revenue grew.</p>');
      if (String(input) !== 'https://api.b.ai/v1/chat/completions') throw new Error('Unavailable test source');
      const body = JSON.parse(String(init?.body)); models.push(body.model);
      if (models.length === 1) return new Response('provider unavailable', { status });
      const section = body.messages[1] && JSON.parse(body.messages[1].content).sections[0];
      return Response.json({ choices: [{ message: { content: JSON.stringify({ nodes: [{ id: 'growth', title: '增长', question: '增长来源', sectionIds: [section.id] }] }) } }] });
    };
    const operations = createSecPipelineOperations(env, fetcher);
    const reference = await operations.prepare(filing);
    const run = operations.plan(filing, reference, undefined, modelExecutionForAttempt(2));
    if (status === 429) {
      const plan = await run;
      assert.equal(plan.nodes.length, 1);
      assert.deepEqual(models, ['hy3', 'primary-model']);
    } else {
      await assert.rejects(run, /HTTP 503/);
      assert.deepEqual(models, ['hy3']);
    }
  }
});

test('rebuilds presentation from allowed references and preserves facts on exhausted invalid output', async () => {
  const stored = new Map<string, string>();
  const env = { ...modelEnv, SEC_FILINGS: { async get() { return null; }, async put(key: string, value: string) { stored.set(key, value); return {}; } } } as unknown as SecPipelineEnv;
  const report = { ticker: 'MSFT', periodId: 'annual', reportVersion: 'v3', headline: '增长', keyMetrics: [], changes: { qoq: [], yoy: [], guidance: [], risks: [] }, dataQuality: { coverage: 1, verificationStatus: 'verified', warnings: ['模型报告编排未通过校验，已保留完整标准报告。'] } } as SecAnalysisArtifact['report'];
  const nodes = [{ id: 'growth', title: '增长', narrative: '已核验的业务分析', findings: [], evidence: [], status: 'complete' as const }, { id: 'facts-only', title: '修复证据', narrative: '', findings: [{ label: '收入', detail: '已披露事实', importance: 'high' as const }], evidence: [], status: 'complete' as const }];
  const brief = { periodScope: 'annual', history: { series: [] } } as import('../../workers/pipeline/src/sec/analysis.ts').SecAnalysisBrief;
  let valid = true;
  const ops = createSecPipelineOperations(env, async (_input, init) => {
    const payload = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    assert.deepEqual(payload.requiredNodeIds, ['growth', 'facts-only']);
    assert.equal(payload.nodes[1].findings[0].detail, '已披露事实');
    return Response.json({ choices: [{ message: { content: JSON.stringify({ sections: [{ title: '业务增长', blocks: [{ type: 'narrative', nodeId: valid ? 'growth' : 'invented' }, { type: 'findings', nodeId: 'facts-only' }] }] }) } }] });
  });
  const result = await ops.composePresentation!(filing, { key: 'filings/MSFT/annual', filing }, report, nodes, brief, modelExecutionForAttempt(1));
  assert.equal(result.presentation?.sections[0].blocks[0].type, 'prose');
  assert.equal(result.dataQuality.warnings.length, 0);
  assert.deepEqual(result.keyMetrics, report.keyMetrics);
  assert.ok([...stored.keys()].some((key) => key.endsWith('/presentation/candidate.json')));
  valid = false;
  await assert.rejects(ops.composePresentation!(filing, { key: 'filings/MSFT/annual', filing }, report, nodes, brief, modelExecutionForAttempt(2)), /validation/);
  const fallback = await ops.composePresentation!(filing, { key: 'filings/MSFT/annual', filing }, report, nodes, brief, modelExecutionForAttempt(4));
  assert.equal(fallback.presentation, undefined);
  assert.deepEqual(fallback.keyMetrics, report.keyMetrics);
  assert.ok(fallback.dataQuality.warnings.some((warning) => warning.includes('重试未完成')));
});
