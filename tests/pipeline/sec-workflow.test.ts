import assert from "node:assert/strict";
import test from "node:test";

import { executeSecAnalysisWorkflow, type SecPipelineOperations, type WorkflowStepLike } from "../../workers/pipeline/src/workflow-core.ts";
import { SEC_ANALYSIS_SCHEMA_VERSION, type SecHistorySnapshot } from "../../workers/pipeline/src/sec/analysis.ts";
import type { SecFiling, SecFilingSummary, SecNodeSpec } from "../../workers/pipeline/src/sec/sec.ts";

/** The Manager always fills these; a test only spells out the parts it exercises. */
function nodeSpec(spec: Pick<SecNodeSpec, "id" | "title" | "question" | "sectionIds"> & Partial<SecNodeSpec>): SecNodeSpec {
  return { historySeriesIds: [], memoryIds: [], acceptanceCriteria: [], materiality: "high", ...spec };
}

const filing: SecFiling = {
  ticker: "TESTCO",
  cik: "0000000001",
  cikNumber: 1,
  companyName: "Test Company",
  form: "10-K",
  filingDate: "2026-07-30",
  reportDate: "2026-06-30",
  accessionNumber: "0000000001-26-000001",
  primaryDocument: "testco.htm",
  description: "Annual report",
  items: "",
  documentUrl: "https://sec.test/testco.htm",
  indexUrl: "https://sec.test/index.htm",
};

test("uses the v3 analysis schema for full-report recomputation", () => {
  assert.equal(SEC_ANALYSIS_SCHEMA_VERSION, "sec-analysis.v3");
});

function stepRecorder(names: string[]): WorkflowStepLike {
  return {
    async do<T>(name: string, callback: () => Promise<T>): Promise<T> {
      names.push(name);
      return callback();
    },
  };
}

function xbrlHistory(unitOverride?: { seriesId: "revenue"; unit: string }): SecHistorySnapshot {
  const observation = (unit: string, id: string) => ({
    observationId: id,
    seriesId: "revenue" as const,
    metricKey: "revenue",
    value: "120",
    unit,
    currency: unit === "USD" ? "USD" : undefined,
    basis: "gaap" as const,
    periodScope: "annual" as const,
    startDate: "2025-07-01",
    endDate: "2026-06-30",
    sourceAccession: filing.accessionNumber,
    sourceFiledAt: "2026-07-30",
    sourceVersion: "sec-canonical-series.v1",
    qualityStatus: "validated_xbrl" as const,
  });
  return {
    registryVersion: "sec-canonical-series.v1",
    series: [{
      seriesId: "revenue",
      quarters: [],
      annual: [observation("USD", "xbrl-usd"), ...(unitOverride ? [observation(unitOverride.unit, "xbrl-alt")] : [])],
    }],
  };
}

function operations(overrides: Partial<SecPipelineOperations> = {}): SecPipelineOperations {
  return {
    async discover() { return { feed: { ticker: "TESTCO" }, filings: [filing] }; },
    async publishFeed() {},
    async shouldAnalyze() { return true; },
    async getContext() { return { currentPeriodId: "TESTCO:2026-06-30:annual", qoqPeriodId: null, yoyPeriodId: null, history: xbrlHistory() }; },
    async prepare() { return { key: "TESTCO/acc.json", filing }; },
    async plan() {
      return {
        nodes: [
          nodeSpec({ id: "revenue-growth", title: "收入增长", question: "收入增长由什么驱动？", sectionIds: ["revenue"], keywords: ["revenue"] }),
          nodeSpec({ id: "cash-flow", title: "现金流", question: "现金流发生了什么变化？", sectionIds: ["cash-flow"], keywords: ["cash flow"] }),
        ],
        outlineSections: 8,
      };
    },
    async analyzeNode(spec) {
      return {
        id: spec.id,
        title: spec.title,
        status: "complete",
        findings: [{ label: spec.title, detail: `${spec.title}出现可量化变化。`, importance: "high" }],
        narrative: `${spec.title}的分段分析。`,
        evidence: [{ start: 10, end: 40, score: 90, reasons: ["包含定量数据"], excerpt: "Quantitative evidence." }],
      };
    },
    async summarizeEvent(eventFiling) {
      return {
        ticker: eventFiling.ticker,
        form: eventFiling.form,
        filingDate: eventFiling.filingDate,
        accessionNumber: eventFiling.accessionNumber,
        headline: "事件简析",
        bullets: [{ label: "事件", detail: "事件影响已披露。", importance: "high" }],
        analystView: "事件改变了短期预期。",
        source: "deepseek",
        generatedAt: "2026-08-10T00:00:00.000Z",
      };
    },
    async summarize() {
      return {
        artifact: {
          filing,
          periodId: "TESTCO:2026-06-30:annual",
          periodScope: "annual",
          blocks: [],
          comparisons: [],
          report: {
            ticker: "TESTCO",
            periodId: "TESTCO:2026-06-30:annual",
            reportVersion: "sec-analysis.v2:test",
            headline: "verified",
            keyMetrics: [],
            changes: { qoq: [], yoy: [], guidance: [], risks: [] },
            dataQuality: { coverage: 1, verificationStatus: "verified", warnings: [] },
          },
        },
        summary: {
          ticker: "TESTCO",
          form: "10-K",
          filingDate: "2026-07-30",
          accessionNumber: filing.accessionNumber,
          headline: "完整研报",
          bullets: [{ label: "收入", detail: "收入增长。", importance: "high" }],
          analystView: "关注增长质量。",
          report: "完整分析正文。",
          version: 5,
          source: "deepseek",
          generatedAt: "2026-08-10T00:00:00.000Z",
        },
      };
    },
    async publish() {},
    async publishEvent() {},
    async updateJob() {},
    ...overrides,
  };
}

test("publication preserves the synthesis historical-review node", async () => {
  let summary: SecFilingSummary | null = null;
  const base = operations();
  const ops = operations({
    async summarize(...args) {
      const result = await base.summarize(...args);
      result.summary!.nodes = [{ id: "historical-judgment-review", title: "历史判断复核", status: "complete", findings: [], narrative: "尚不能验证", evidence: [] }];
      return result;
    },
    async publish(_artifact, value) { summary = value; },
  });
  await executeSecAnalysisWorkflow({ ticker: "TESTCO" }, "continuity-test", stepRecorder([]), ops);
  assert.equal((summary as SecFilingSummary | null)?.nodes?.at(-1)?.id, "historical-judgment-review");
});

test("runs filing analysis as durable stages and fans analysis nodes out independently", async () => {
  const steps: string[] = [];
  const nodeIds: string[] = [];
  const jobStages: string[] = [];
  const jobIds: string[] = [];
  let published = 0;
  const publishedSummaries: SecFilingSummary[] = [];
  const ops = operations({
    async analyzeNode(spec: SecNodeSpec) {
      nodeIds.push(spec.id);
      return operations().analyzeNode(spec, {} as never, {} as never);
    },
    async publish(_artifact, summary) {
      published += 1;
      if (summary) publishedSummaries.push(summary);
    },
    async updateJob(job) {
      jobStages.push(job.currentStage);
      jobIds.push(job.jobId);
    },
  });

  const result = await executeSecAnalysisWorkflow(
    { ticker: "TESTCO", requestedBy: "scheduled" },
    "workflow-1",
    stepRecorder(steps),
    ops,
  );

  assert.deepEqual(result, { analyzed: [filing.accessionNumber], skipped: [], failed: [] });
  assert.deepEqual(nodeIds, ["revenue-growth", "cash-flow"]);
  assert.equal(published, 1);
  assert.ok(steps.includes(`prepare:${filing.accessionNumber}`));
  assert.ok(steps.includes(`manager:${filing.accessionNumber}`));
  assert.ok(steps.includes(`node:${filing.accessionNumber}:round:0:0:revenue-growth`));
  assert.ok(steps.includes(`node:${filing.accessionNumber}:round:0:1:cash-flow`));
  assert.ok(steps.includes(`manager-review:${filing.accessionNumber}:round:0`));
  assert.ok(steps.includes(`publish:${filing.accessionNumber}`));
  assert.deepEqual(jobStages, ["prepare", "published"]);
  assert.ok(jobIds.every((jobId) => jobId.endsWith(":workflow-1")));
  assert.equal(jobStages.length, 2, "job state is written once at start and once at completion");
  assert.equal(publishedSummaries.length, 1);
  assert.deepEqual(publishedSummaries[0].nodes?.map((node) => node.id), ["revenue-growth", "cash-flow"]);
  assert.equal(publishedSummaries[0].managerReview?.status, "complete");
});

test("bounds node analysis to two concurrent model calls per workflow", async () => {
  const defaultOperations = operations();
  const plannedNodes = ["one", "two", "three", "four"].map((id) => nodeSpec({
    id,
    title: id,
    question: `Analyze ${id}`,
    sectionIds: [id],
  }));
  let active = 0;
  let maximumActive = 0;
  const ops = operations({
    async plan() {
      return { nodes: plannedNodes, outlineSections: plannedNodes.length };
    },
    async analyzeNode(spec, analyzedFiling, prepared, brief, round, execution) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        return await defaultOperations.analyzeNode(spec, analyzedFiling, prepared, brief, round, execution);
      } finally {
        active -= 1;
      }
    },
  });

  const result = await executeSecAnalysisWorkflow(
    { ticker: "TESTCO", requestedBy: "manual" },
    "workflow-node-concurrency",
    stepRecorder([]),
    ops,
  );

  assert.deepEqual(result, { analyzed: [filing.accessionNumber], skipped: [], failed: [] });
  assert.equal(maximumActive, 2);
});

test("legacy operations without a reader finalizer remain compatible", async () => {
  const steps: string[] = [];
  let published = 0;
  const ops = operations({
    async publish() {
      published += 1;
    },
  });

  const result = await executeSecAnalysisWorkflow(
    { ticker: "TESTCO", requestedBy: "manual" },
    "workflow-without-claim-check",
    stepRecorder(steps),
    ops,
  );

  assert.deepEqual(result, { analyzed: [filing.accessionNumber], skipped: [], failed: [] });
  assert.equal(published, 1);
  assert.equal(steps.some((step) => step.includes("claim-check")), false);
  assert.equal(steps.some((step) => step.includes("synthesis-repair")), false);
});

test("editorial rejection preserves the previous report and never reaches publish", async () => {
  let published = 0;
  const steps: string[] = [];
  const ops = operations({
    async auditReport() { return { issues: ["operating margin wrongly attributed to taxes"], reviewedAt: new Date().toISOString() }; },
    async publish() { published += 1; },
  });
  const result = await executeSecAnalysisWorkflow({ ticker: "TESTCO", requestedBy: "manual" }, "reader-audit-failure", stepRecorder(steps), ops);
  assert.deepEqual(result.failed, [filing.accessionNumber]);
  assert.equal(published, 0);
  assert.ok(steps.includes(`editorial-review:${filing.accessionNumber}:0`));
});

test("published output is the independently reviewed result, not the original draft", async () => {
  let publishedHeadline = "";
  let reviews = 0;
  const base = operations();
  const ops = operations({
    async auditReport() { return { issues: reviews++ ? [] : ["修订会计归因"], reviewedAt: new Date().toISOString() }; },
    async reviseReport(filing, prepared, context, plan, nodes, brief, review) {
      const draft = await base.summarize(filing, prepared, context, plan, nodes, brief, review);
      return { ...draft, artifact: { ...draft.artifact, report: { ...draft.artifact.report, headline: "审稿后的判断" } } };
    },
    async publish(artifact) { publishedHeadline = artifact.report.headline; },
  });
  await executeSecAnalysisWorkflow({ ticker: "TESTCO", requestedBy: "manual" }, "reader-audit-pass", stepRecorder([]), ops);
  assert.equal(publishedHeadline, "审稿后的判断");
  assert.equal(reviews, 2);
});

test("keeps event filings on the compact path without running full-report stages", async () => {
  const eventFiling = { ...filing, form: "8-K", accessionNumber: "event", items: "2.02" };
  const steps: string[] = [];
  let compactPublished = 0;
  let analysisNodes = 0;
  const ops = operations({
    async discover() { return { feed: { ticker: "TESTCO" }, filings: [eventFiling] }; },
    async prepare() { return { key: "TESTCO/event.json", filing: eventFiling }; },
    async analyzeNode(spec: SecNodeSpec) {
      analysisNodes += 1;
      return operations().analyzeNode(spec, {} as never, {} as never);
    },
    async publishEvent(summary) {
      compactPublished += 1;
      assert.equal(summary.form, "8-K");
    },
  });

  const result = await executeSecAnalysisWorkflow(
    { ticker: "TESTCO", requestedBy: "scheduled" },
    "workflow-event",
    stepRecorder(steps),
    ops,
  );

  assert.deepEqual(result.analyzed, ["event"]);
  assert.equal(compactPublished, 1);
  assert.equal(analysisNodes, 0);
  assert.ok(steps.includes("event-summary:event"));
  assert.ok(steps.includes("publish-event:event"));
  assert.equal(steps.some((step) => step.startsWith("manager:event")), false);
});

test("keeps a failed verification artifact out of the published report table", async () => {
  let published = 0;
  const jobStatuses: string[] = [];
  const base = operations();
  const ops = operations({
    async summarize(...args) {
      const result = await base.summarize(...args);
      result.artifact.report.dataQuality.verificationStatus = "failed";
      return result;
    },
    async publish() { published += 1; },
    async updateJob(job) { jobStatuses.push(job.status); },
  });

  const result = await executeSecAnalysisWorkflow(
    { ticker: "TESTCO", requestedBy: "manual" },
    "workflow-2",
    stepRecorder([]),
    ops,
  );

  assert.equal(published, 0);
  assert.deepEqual(result.failed, [filing.accessionNumber]);
  assert.equal(jobStatuses.at(-1), "failed");
});

test("skips a completed filing during scheduled refreshes", async () => {
  const steps: string[] = [];
  let prepared = 0;
  const ops = operations({
    async shouldAnalyze() { return false; },
    async prepare() {
      prepared += 1;
      return { key: "unused", filing };
    },
  });

  const result = await executeSecAnalysisWorkflow(
    { ticker: "TESTCO", requestedBy: "scheduled" },
    "workflow-3",
    stepRecorder(steps),
    ops,
  );

  assert.deepEqual(result, { analyzed: [], skipped: [filing.accessionNumber], failed: [] });
  assert.equal(prepared, 0);
  assert.ok(steps.includes(`status:${filing.accessionNumber}`));
});

test("publishes analysis-incomplete results as partial with unresolved work exposed", async () => {
  let publishedStatus = "";
  let unresolved: string[] = [];
  const ops = operations({
    async analyzeNode(spec) {
      return { id: spec.id, title: spec.title, status: "error", findings: [], narrative: "", evidence: [], error: "missing evidence" };
    },
    async publish(artifact) {
      publishedStatus = artifact.report.dataQuality.analysisStatus ?? "";
      unresolved = artifact.report.dataQuality.unresolvedQuestions ?? [];
    },
  });

  const result = await executeSecAnalysisWorkflow({ ticker: "TESTCO", requestedBy: "manual" }, "workflow-partial", stepRecorder([]), ops);

  assert.deepEqual(result.analyzed, [filing.accessionNumber]);
  assert.equal(publishedStatus, "partial");
  assert.equal(unresolved.length, 2);
});

test("treats missing core facts as a hard failure and keeps the last successful report", async () => {
  let published = 0;
  const ops = operations({
    async getContext() {
      return { currentPeriodId: "TESTCO:2026-06-30:annual", qoqPeriodId: null, yoyPeriodId: null, history: { registryVersion: "sec-canonical-series.v1", series: [] } };
    },
    async publish() { published += 1; },
  });

  const result = await executeSecAnalysisWorkflow({ ticker: "TESTCO", requestedBy: "manual" }, "workflow-hard-failure", stepRecorder([]), ops);

  assert.deepEqual(result.failed, [filing.accessionNumber]);
  assert.equal(published, 0);
});

test("accepts one XBRL series carrying a single unit per reporting period", async () => {
  const result = await executeSecAnalysisWorkflow({ ticker: "TESTCO", requestedBy: "manual" }, "workflow-units-ok", stepRecorder([]), operations());

  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.analyzed, [filing.accessionNumber]);
});

test("still rejects two units for the same XBRL series and period", async () => {
  const ops = operations({
    async getContext() {
      return { currentPeriodId: "TESTCO:2026-06-30:annual", qoqPeriodId: null, yoyPeriodId: null, history: xbrlHistory({ seriesId: "revenue", unit: "shares" }) };
    },
  });

  const result = await executeSecAnalysisWorkflow({ ticker: "TESTCO", requestedBy: "manual" }, "workflow-unit-conflict", stepRecorder([]), ops);

  assert.deepEqual(result.failed, [filing.accessionNumber]);
  assert.deepEqual(result.analyzed, []);
});

test("passes the DeepSeek Flash retry model to a retried analysis step", async () => {
  const base = operations();
  let retriedModel = "";
  const step: WorkflowStepLike = {
    async do<T>(name: string, callback: (context?: { attempt: number }) => Promise<T>): Promise<T> {
      return callback({ attempt: name.endsWith(":cash-flow") ? 2 : 1 });
    },
  };
  const ops = operations({
    async analyzeNode(spec, filingArg, prepared, brief, round, execution) {
      if (spec.id === "cash-flow") retriedModel = execution?.model ?? "";
      return base.analyzeNode(spec, filingArg, prepared, brief, round);
    },
  });

  const result = await executeSecAnalysisWorkflow({ ticker: "TESTCO", requestedBy: "manual" }, "workflow-model-fallback", step, ops);

  assert.deepEqual(result.failed, []);
  assert.equal(retriedModel, "deepseek-flash");
});

test("classifies an exhausted Manager Review as a hard failure", async () => {
  let errorCode = "";
  const ops = operations({
    async review() { throw new Error("DeepSeek manager-review:0 HTTP 524"); },
    async updateJob(job) { errorCode = job.errorCode ?? errorCode; },
  });

  const result = await executeSecAnalysisWorkflow({ ticker: "TESTCO", requestedBy: "manual" }, "workflow-review-hard", stepRecorder([]), ops);

  assert.deepEqual(result.failed, [filing.accessionNumber]);
  assert.equal(errorCode, "hard_failure");
});

test("does not change a published report when asynchronous Memory launch fails", async () => {
  let published = 0;
  const ops = operations({
    async publish() { published += 1; return { memoryJobId: "memory-job-1" }; },
    async enqueueMemory() { throw new Error("workflow unavailable"); },
  });

  const result = await executeSecAnalysisWorkflow({ ticker: "TESTCO", requestedBy: "manual" }, "workflow-memory-failure", stepRecorder([]), ops);

  assert.deepEqual(result.analyzed, [filing.accessionNumber]);
  assert.equal(published, 1);
});


test("retries an empty manager plan inside the durable step before publishing", async () => {
  const base = operations();
  const models: Array<string | undefined> = [];
  const step: WorkflowStepLike = {
    async do<T>(name: string, callback: (context?: { attempt: number }) => Promise<T>): Promise<T> {
      try { return await callback({ attempt: 1 }); }
      catch (error) {
        if (!name.startsWith('manager:')) throw error;
        assert.match(String(error), /Manager planned no analysis nodes/);
        return callback({ attempt: 2 });
      }
    },
  };
  const ops = operations({
    async plan(filingArg, prepared, brief, execution) {
      models.push(execution?.model);
      return execution?.attempt === 1 ? { nodes: [], outlineSections: 1 } : base.plan(filingArg, prepared, brief, execution);
    },
  });
  const result = await executeSecAnalysisWorkflow({ ticker: 'TESTCO', requestedBy: 'manual' }, 'empty-plan-retry', step, ops);
  assert.deepEqual(models, [undefined, 'deepseek-flash']);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.analyzed, [filing.accessionNumber]);
});

test('repairs missing presentation in its own durable step before publication', async () => {
  const steps: string[] = [];
  const ops = operations({
    async composePresentation(_filing, _prepared, report, nodes) {
      return { ...report, presentation: { version: 'sec-presentation.v1', density: 'comfortable', sections: nodes.map((node, i) => ({ id: `section-${i}`, title: node.title, layout: 'flow', blocks: [{ id: node.id, type: 'prose', text: node.narrative }] })) } };
    },
    async publish(artifact) { assert.equal(artifact.report.presentation?.sections.length, 2); },
  });
  const result = await executeSecAnalysisWorkflow({ ticker: 'TESTCO', requestedBy: 'manual' }, 'presentation-retry', stepRecorder(steps), ops);
  assert.equal(result.failed.length, 0);
  assert.ok(steps.indexOf(`synthesis:${filing.accessionNumber}`) < steps.indexOf(`presentation:${filing.accessionNumber}`));
  assert.ok(steps.indexOf(`presentation:${filing.accessionNumber}`) < steps.indexOf(`publish:${filing.accessionNumber}`));
});

test("earnings release and periodic filing execute once while same-day management event executes separately", async () => {
  const { buildEarningsGroups } = await import('../../workers/pipeline/src/sec/earnings.ts');
  const release = { ...filing, form: '8-K', accessionNumber: '0000000001-26-000002', filingDate: '2026-07-29', reportDate: '2026-07-29' };
  const executive = { ...release, accessionNumber: '0000000001-26-000003', filingDate: '2026-07-30' };
  const prepared: SecFiling[] = [];
  const events: string[] = [];
  const result = await executeSecAnalysisWorkflow({ ticker: filing.ticker, requestedBy: 'manual' }, 'grouped-test', stepRecorder([]), operations({
    async discover() { return {feed: {}, filings: [filing,executive,release]}; },
    async classifyEarnings(source) {return source.accessionNumber === executive.accessionNumber ? null : '2026-06-30';},
    async groupEarnings(sources,periods) {return buildEarningsGroups(sources,periods);},
    async prepare(source) {prepared.push(source);return {key: source.accessionNumber,filing:source};},
    async publishEvent(summary) {events.push(summary.accessionNumber);},
  }));
  assert.deepEqual(result.analyzed,[filing.accessionNumber,executive.accessionNumber]);
  assert.equal(prepared[0].earningsGroup?.sources.length,2);
  assert.deepEqual(events,[executive.accessionNumber]);
});

test("disclosure discovery runs before planning and audit may add an omitted theme before review", async () => {
  const stages:string[]=[];
  const extra=nodeSpec({id:'insider-plan',title:'交易计划',question:'计划状态是什么？',sectionIds:['plan']});
  let reviewed:string[]=[];
  const result=await executeSecAnalysisWorkflow({ticker:filing.ticker,requestedBy:'manual'},'discovery',stepRecorder(stages),operations({
    async prepare(){return {key:'test',filing,discoveryChunks:2};},
    async scanDisclosures(_filing,_reference,index){return {index,start:index*20,end:index*20+20,status:'complete',disclosures:[],rejected:0};},
    async finishDiscovery(){return {groundedDisclosures:1};},
    async getContext(){return {currentPeriodId:'TESTCO:2026-06-30:annual',qoqPeriodId:null,yoyPeriodId:null,history:{registryVersion:'sec-canonical-series.v1',series:[]}};},
    async auditDisclosures(){return [extra];},
    async review(_filing,_ref,_brief,plan,nodes){reviewed=plan.nodes.map(n=>n.id);assert.ok(nodes.some(n=>n.id==='insider-plan'));return {status:'complete',questions:[],repairTasks:[],unresolvedQuestions:[],coverageScore:1,stopReason:'complete'};},
  }));
  assert.deepEqual(result.failed,[]);assert.ok(reviewed.includes('insider-plan'));
  assert.ok(stages.indexOf(`discovery-finish:${filing.accessionNumber}`)<stages.indexOf(`manager:${filing.accessionNumber}`));
  assert.ok(stages.indexOf(`discovery-repair:${filing.accessionNumber}:insider-plan`)<stages.indexOf(`manager-review:${filing.accessionNumber}:round:0`));
});


test("multiple editorial repairs receive the latest draft, use distinct durable steps and escalate", async () => {
  const steps: string[] = [];
  let count = 0, published = "";
  const ops = operations({
    async auditReport() { return { issues: count < 3 ? ["仍需核对现金分类"] : [], reviewedAt: new Date().toISOString() }; },
    async reviseReport(_f, _p, _c, _plan, _nodes, _b, _review, _issues, execution, revision) {
      assert.ok(revision);
      if (count) assert.equal(revision.draft.artifact.report.headline, `fixed-${count}`);
      count++;
      assert.equal(revision.round, count);
      if (count >= 2) assert.equal(execution?.model, "deepseek-flash");
      const draft = structuredClone(revision.draft);
      draft.artifact.report.headline = `fixed-${count}`;
      return draft;
    },
    async publish(artifact) { published = artifact.report.headline; },
  });
  const result = await executeSecAnalysisWorkflow({ ticker: "TESTCO", requestedBy: "manual" }, "editorial-local-repair", stepRecorder(steps), ops);
  assert.deepEqual(result.failed, []);
  assert.equal(published, "fixed-3");
  assert.equal(steps.filter((s) => s.startsWith("editorial-revision:")).length, 3);
  assert.equal(new Set(steps).size, steps.length);
});

test("explicit report regeneration reuses verified research but still writes and audits a new report", async () => {
  const steps: string[] = [], base = operations();
  const plan = await base.plan(filing, { key: "test", filing });
  const nodes = await Promise.all(plan.nodes.map(spec => base.analyzeNode(spec, filing, { key: "test", filing })));
  let audited = false, published = false;
  const ops = operations({
    async restoreAnalysis() { return { plan, nodes, rounds: 0, review: { status: "complete", questions: [], repairTasks: [], unresolvedQuestions: [], coverageScore: 1, stopReason: "complete" } }; },
    async plan() { throw new Error("must not replan"); },
    async analyzeNode() { throw new Error("must not rescan"); },
    async auditReport() { audited = true; return { issues: [], reviewedAt: new Date().toISOString() }; },
    async publish() { published = true; },
  });
  const result = await executeSecAnalysisWorkflow({ ticker: filing.ticker, requestedBy: "manual", accessionNumber: filing.accessionNumber, regenerateReport: true }, "regenerate", stepRecorder(steps), ops);
  assert.deepEqual(result.failed, []);
  assert.ok(audited && published);
  assert.ok(steps.some(s => s.startsWith("synthesis:")));
  assert.ok(!steps.some(s => s.startsWith("node:")));
  await assert.rejects(executeSecAnalysisWorkflow({ ticker: filing.ticker, requestedBy: "scheduled", regenerateReport: true }, "invalid", stepRecorder([]), ops), /manual request/);
});
