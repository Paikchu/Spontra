import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzePreparedSecNode,
  buildPreparedSecBrief,
  failedSecNode,
  eventHistoryContext,
  discoverSecTicker,
  planPreparedSecFiling,
  prepareSecFiling,
  reviewPreparedSecAnalysis,
  selectWorkflowFilings,
  summarizePreparedSecEvent,
  summarizePreparedSecFiling,
  type SecModelCall,
} from "../../workers/pipeline/src/sec/pipeline.ts";
import type { SecAnalysisContext } from "../../workers/pipeline/src/sec/types.ts";
import { selectReportContinuity } from "../../workers/pipeline/src/sec/continuity.ts";
import type { SecHistorySnapshot } from "../../workers/pipeline/src/sec/analysis.ts";
import { SEC_SUMMARY_VERSION, type SecFiling, type SecNodeSpec } from "../../workers/pipeline/src/sec/sec.ts";

/** The Manager always fills these; a test only spells out the parts it exercises. */
function nodeSpec(spec: Pick<SecNodeSpec, "id" | "title" | "question" | "sectionIds"> & Partial<SecNodeSpec>): SecNodeSpec {
  return { historySeriesIds: [], memoryIds: [], acceptanceCriteria: [], materiality: "high", ...spec };
}

function xbrlHistory(current: string, prior?: string): SecHistorySnapshot {
  const observation = (endDate: string, value: string) => ({
    observationId: `xbrl:revenue:${endDate}`,
    seriesId: "revenue" as const,
    metricKey: "revenue",
    value,
    unit: "USD",
    currency: "USD",
    basis: "gaap" as const,
    periodScope: "annual" as const,
    startDate: endDate,
    endDate,
    sourceAccession: "annual",
    sourceFiledAt: endDate,
    sourceVersion: "sec-canonical-series.v1",
    qualityStatus: "validated_xbrl" as const,
    xbrlConcept: "us-gaap:Revenues",
  });
  return {
    registryVersion: "sec-canonical-series.v1",
    series: [{
      seriesId: "revenue",
      quarters: [],
      annual: [observation("2026-06-30", current), ...(prior ? [observation("2025-06-30", prior)] : [])],
    }],
  };
}

function analysisContext(periodId: string, history?: SecHistorySnapshot): SecAnalysisContext {
  return { currentPeriodId: periodId, qoqPeriodId: null, yoyPeriodId: null, history };
}

const filing: SecFiling = {
  ticker: "MSFT", cik: "0000789019", cikNumber: 789019, companyName: "Microsoft Corp", form: "10-K",
  filingDate: "2026-07-30", reportDate: "2026-06-30", accessionNumber: "annual", primaryDocument: "msft.htm",
  description: "Annual report", items: "", documentUrl: "https://sec.test/msft.htm", indexUrl: "https://sec.test/index.htm",
};

const completeReport = () => "本期经营结果体现出核心业务需求、收入质量、利润率、现金流与资本投入之间的联动。".repeat(24);
const completeBullets = () => [
  { label: "收入", detail: "收入达到 1.2 亿美元。", importance: "high" },
  { label: "利润率", detail: "利润率变化已完成验证。", importance: "medium" },
  { label: "现金流", detail: "现金流与资本投入需要联合观察。", importance: "medium" },
];

test("selected full reports reach synthesis and a validated historical review survives publication", async () => {
  const prepared = await prepareSecFiling(filing, { userAgent: "test@example.com", fetcher: async () => new Response("<h1>Business</h1><p>Current operations.</p>") });
  const quote = "历史判断：增长质量取决于核心业务需求是否持续，并需用现金回款验证。";
  const context = { ...analysisContext(prepared.periodId, xbrlHistory("120", "100")), reportContinuity: selectReportContinuity(filing, [{
    accessionNumber: "old", form: "10-K", reportDate: "2025-06-30", filingDate: "2025-07-30", documentUrl: "https://sec.test/old",
    payload: JSON.stringify({ ticker: filing.ticker, accessionNumber: "old", source: "deepseek", generatedAt: "2025-07-30T12:00:00Z", report: quote }),
  }]) };
  const brief = buildPreparedSecBrief(prepared, context);
  const plan = { nodes: [nodeSpec({ id: "business", title: "Business", question: "Demand?", sectionIds: [prepared.outline[0].id] })], outlineSections: 1 };
  const result = await summarizePreparedSecFiling(prepared, context, async (stage, system, payload) => {
    assert.equal(stage, "synthesis", "continuity shares the existing bounded model step");
    assert.match(JSON.stringify(payload), /历史判断：增长质量/);
    assert.match(system, /重复出现不构成独立佐证/);
    return { headline: "分析", bullets: completeBullets(), analystView: "继续观察", report: completeReport(),
      keyMetrics: [{ metricKey: "revenue", currentValue: "120", evidenceIds: ["xbrl:revenue:2026-06-30"] }],
      reviews: [{ accessionNumber: "old", priorJudgment: quote, status: "supported", evidenceIds: ["xbrl:revenue:2026-06-30"], explanation: "本期营收提供有限支持，现金回款仍待验证。", nextTest: "检查现金回款。" }],
    };
  }, new Date(), plan, [{ id: "business", title: "Business", status: "complete", findings: [], narrative: "本期业务分析", facts: [], evidence: [] }], brief);
  const review = result.summary.nodes?.at(-1);
  assert.equal(review?.id, "historical-judgment-review");
  assert.match(review?.findings[0].label ?? "", /得到支持/);
  assert.deepEqual(result.artifact.report.publication?.summary.nodes, result.summary.nodes);
  assert.deepEqual(result.artifact.brief?.reportContinuity, context.reportContinuity);
});

test("selects the newest periodic filing plus visible event filings", () => {
  const filings: SecFiling[] = [
    filing,
    { ...filing, form: "8-K", accessionNumber: "support", primaryDocument: "support.htm" },
    { ...filing, form: "10-Q", reportDate: "2026-03-31", filingDate: "2026-04-29", accessionNumber: "older", primaryDocument: "older.htm" },
  ];

  assert.deepEqual(selectWorkflowFilings(filings).map((item) => item.accessionNumber), ["annual", "support"]);
});

test("keeps 8-K and 6-K on the compact event-summary contract", async () => {
  const event = { ...filing, form: "8-K", accessionNumber: "event", items: "2.02", description: "Results of Operations" };
  const prepared = await prepareSecFiling(event, {
    userAgent: "test@example.com",
    fetcher: async () => new Response("<h1>Item 2.02 Results of Operations</h1><p>Revenue increased 18% to $120 million.</p>"),
  });
  let payload: unknown;

  const summary = await summarizePreparedSecEvent(prepared, async (stage, system, input) => {
    assert.equal(stage, "event-summary");
    assert.match(system, /事件本身/);
    payload = input;
    return {
      headline: "收入增长事件已披露",
      bullets: completeBullets(),
      analystView: "事件改善了本期增长可见度。",
      eventCategory: "earnings_update",
      report: "附件披露收入增长 18% 至 1.2 亿美元，主要驱动为云业务放量。",
    };
  }, new Date("2026-08-10T00:00:00.000Z"), xbrlHistory("120", "100"));

  assert.equal(summary.form, "8-K");
  assert.equal(summary.version, SEC_SUMMARY_VERSION);
  assert.equal(summary.eventCategory, "earnings_update");
  assert.match(summary.report ?? "", /18%/);
  assert.match(JSON.stringify(payload), /Revenue increased 18%/);
  assert.match(JSON.stringify(payload), /eventCategory/);
  assert.deepEqual((payload as { historicalFinancials: SecHistorySnapshot }).historicalFinancials, xbrlHistory("120", "100"));
});

test("rejects event summaries that omit the event category", async () => {
  const event = { ...filing, form: "8-K", accessionNumber: "event", items: "2.02", description: "Results of Operations" };
  const prepared = await prepareSecFiling(event, {
    userAgent: "test@example.com",
    fetcher: async () => new Response("<h1>Item 2.02 Results of Operations</h1><p>Revenue increased 18% to $120 million.</p>"),
  });

  await assert.rejects(
    summarizePreparedSecEvent(prepared, async () => ({
      headline: "收入增长事件已披露",
      bullets: completeBullets(),
      analystView: "事件改善了本期增长可见度。",
    })),
    /incomplete analysis/,
  );
});

test("discovers SEC filings without invoking an analysis model", async () => {
  const urls: string[] = [];
  const result = await discoverSecTicker("MSFT", {
    userAgent: "test@example.com",
    now: () => new Date("2026-08-05T00:00:00.000Z"),
    fetcher: async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("company_tickers_exchange")) return Response.json({ fields: ["cik", "name", "ticker"], data: [[789019, "Microsoft Corp", "MSFT"]] });
      return Response.json({ name: "Microsoft Corp", filings: { recent: {
        accessionNumber: ["annual"], form: ["10-K"], filingDate: ["2026-07-30"], reportDate: ["2026-06-30"],
        primaryDocument: ["msft.htm"], primaryDocDescription: ["Annual report"], items: [""],
      } } });
    },
  });

  assert.equal(result.feed.status, "ready");
  assert.deepEqual(result.filings.map((item) => item.accessionNumber), ["annual"]);
  assert.equal(urls.some((url) => url.includes("deepseek")), false);
});

test("lets the manager plan a variable node graph from headings without seeing filing text", async () => {
  const prepared = await prepareSecFiling(filing, {
    userAgent: "test@example.com",
    fetcher: async () => new Response(`
      <h1>Item 7. Management's Discussion and Analysis</h1>
      <p>Revenue was $120 million.</p>
      <h1>Item 8. Financial Statements</h1>
      <p>Operating cash flow was $80 million.</p>
      <h1>Item 1A. Risk Factors</h1>
      <p>Demand may decline.</p>
    `),
  });
  let managerPayload: unknown;
  let managerSystem = "";
  const plan = await planPreparedSecFiling(prepared, async (stage, system, payload) => {
    assert.equal(stage, "manager");
    managerSystem = system;
    managerPayload = payload;
    return {
      nodes: prepared.outline.map((section, index) => ({
        id: `topic-${index + 1}`,
        title: `主题 ${index + 1}`,
        question: "本期发生了什么变化？",
        sectionIds: [section.id],
        keywords: ["revenue"],
      })),
    };
  });

  assert.equal(plan.nodes.length, prepared.outline.length);
  assert.ok(plan.nodes.length >= 3);
  assert.doesNotMatch(JSON.stringify(managerPayload), /\$120 million|Operating cash flow was/);
  assert.match(managerSystem, /通常4至8个/);
  assert.match(managerSystem, /不能仅凭标题排除/);
});

test("isolates a failed dynamic node while preserving completed node analysis", async () => {
  const prepared = await prepareSecFiling(filing, {
    userAgent: "test@example.com",
    fetcher: async () => new Response("<h1>Revenue</h1><p>Revenue increased 18% to $120 million, driven by cloud demand.</p>"),
  });
  const sectionId = prepared.outline[0].id;
  const complete = await analyzePreparedSecNode(prepared, nodeSpec({
    id: "revenue-growth",
    title: "收入增长",
    question: "收入增长由什么驱动？",
    sectionIds: [sectionId],
    keywords: ["revenue", "cloud demand"],
  }), async (stage, _system, payload) => {
    assert.equal(stage, "node:revenue-growth");
    assert.match(JSON.stringify(payload), /Revenue increased 18%/);
    return {
      findings: [{ label: "收入", detail: "收入增长 18%。", importance: "high" }],
      narrative: "云需求推动本期收入增长。",
    };
  });
  const spec = nodeSpec({ id: "risk-review", title: "风险变化", question: "风险发生了什么变化？", sectionIds: [sectionId], keywords: ["risk"] });

  // A provider failure must surface so the Workflow step can retry on the fallback model.
  await assert.rejects(
    analyzePreparedSecNode(prepared, spec, async () => { throw new Error("DeepSeek node HTTP 500"); }),
    /HTTP 500/,
  );

  const degraded = failedSecNode(spec, new Error("DeepSeek node HTTP 500"));

  assert.equal(complete.status, "complete");
  assert.equal(complete.findings[0].label, "收入");
  assert.equal(degraded.status, "error");
  assert.match(degraded.error ?? "", /HTTP 500/);
});

test("node facts must cite a block the node actually read", async () => {
  const prepared = await prepareSecFiling(filing, {
    userAgent: "test@example.com",
    fetcher: async () => new Response("<h1>Item 8. Financial Statements</h1><p>Segment revenue was 60 USDm this quarter.</p>"),
  });
  const spec = nodeSpec({ id: "segments", title: "分部", question: "分部收入如何？", sectionIds: [prepared.outline[0].id], keywords: ["segment"] });
  let offered: Array<{ evidenceId: string }> = [];

  const node = await analyzePreparedSecNode(prepared, spec, async (_stage, _system, payload) => {
    offered = (payload as { evidence: Array<{ evidenceId: string }> }).evidence;
    return {
      findings: [{ label: "分部", detail: "分部收入 60 百万美元。", importance: "high" }],
      narrative: "分部收入增长。",
      facts: [
        { metricKey: "segment_revenue", value: "60", unit: "USDm", basis: "gaap", sourceLabel: "fact_source_reported", confidence: "high", evidenceIds: [offered[0]?.evidenceId] },
        { metricKey: "backlog", value: "999", unit: "USDm", basis: "gaap", sourceLabel: "fact_source_reported", confidence: "high", evidenceIds: ["condensed-consolidated-statements-of-cash-flows"] },
      ],
    };
  });

  assert.ok(offered.length > 0, "the node must be handed real evidence ids to cite");
  assert.ok(node.evidenceIds!.length > 0, "section overlap must resolve to blocks");
  assert.deepEqual(node.facts?.map((fact) => fact.metricKey), ["segment_revenue"]);
  assert.deepEqual(node.facts?.[0].evidenceIds, [offered[0].evidenceId]);
});

test("synthesizes one full report from node outputs and verified structured data without raw filing text", async () => {
  const prepared = await prepareSecFiling(filing, {
    userAgent: "test@example.com",
    fetcher: async () => new Response("<h1>Revenue</h1><p>RAW-FILING-MARKER revenue was $120 million.</p>"),
  });
  const context = analysisContext(prepared.periodId, xbrlHistory("120", "100"));
  const plan = normalizePlan(prepared.outline[0].id);
  const nodes = [{
    id: "revenue-growth",
    title: "收入增长",
    status: "complete" as const,
    findings: [{ label: "收入", detail: "收入达到 1.2 亿美元。", importance: "high" as const }],
    narrative: "收入增长由核心业务需求推动。",
    facts: [{
      metricKey: "segment_revenue",
      value: "60",
      unit: "USDm",
      basis: "gaap" as const,
      evidenceIds: [`ev:${prepared.blocks[0].blockId}`],
      confidence: "high" as const,
      sourceLabel: "fact_source_reported" as const,
    }],
    evidence: [],
  }];
  let synthesisPayload: unknown;
  let synthesisSystem = "";
  const result = await summarizePreparedSecFiling(
    prepared,
    context,
    async (stage, system, payload) => {
      assert.equal(stage, "synthesis");
      synthesisSystem = system;
      synthesisPayload = payload;
      return {
        headline: "核心业务推动收入增长",
        bullets: completeBullets(),
        analystView: "增长质量取决于需求能否延续。",
        report: completeReport(),
        presentation: { sections: [{ title: "增长驱动", blocks: [{ type: "narrative", nodeId: "revenue-growth" }, { type: "chart", nodeId: "revenue-growth", metricKey: "revenue", mark: "line" }] }] },
        keyMetrics: [
          { metricKey: "Total Revenues", currentValue: "120", evidenceIds: ["xbrl:revenue:2026-06-30"] },
          { metricKey: "segment_revenue", currentValue: "60", evidenceIds: [`ev:${prepared.blocks[0].blockId}`] },
          { metricKey: "invented_metric", currentValue: "9", evidenceIds: [`ev:${prepared.blocks[0].blockId}`] },
        ],
        changes: { qoq: [], yoy: [], guidance: [], risks: [] },
        dataQuality: { coverage: 1, warnings: [] },
      };
    },
    new Date("2026-08-05T00:00:00.000Z"),
    plan,
    nodes,
  );

  assert.deepEqual(result.artifact.report.publication, { filing: prepared.filing, summary: result.summary });
  assert.match(result.artifact.report.reportVersion, /:2026-06-30-[0-9a-f-]{36}$/);
  assert.equal(result.artifact.report.presentation?.sections[0].title, "增长驱动");
  assert.equal(result.artifact.report.presentation?.sections[0].blocks[1].type, "sec_chart");
  assert.ok(result.artifact.report.sourceMaterials?.length);
  assert.equal(result.summary.version, SEC_SUMMARY_VERSION);
  assert.match(result.summary.report ?? "", /核心业务需求/);
  assert.equal(result.summary.nodes?.length, 1);
  assert.doesNotMatch(JSON.stringify(synthesisPayload), /RAW-FILING-MARKER/);
  assert.match(synthesisSystem, /JSON/i);
  assert.deepEqual(result.artifact.report.keyMetrics.map((metric) => metric.metricKey), ["revenue", "segment_revenue"]);
  assert.equal(result.artifact.report.keyMetrics.find((metric) => metric.metricKey === "revenue")?.yoy, "+20.0%");
  assert.ok(result.artifact.report.dataQuality.warnings.some((warning) => warning.includes("invented_metric")));
  // A metric grounded in XBRL must survive: the brief's evidence namespace is valid evidence.
  assert.deepEqual(result.artifact.report.keyMetrics[0].evidenceIds, ["xbrl:revenue:2026-06-30"]);
});

test("reports a margin move in percentage points and an amount in percent", async () => {
  const prepared = await prepareSecFiling(filing, {
    userAgent: "test@example.com",
    fetcher: async () => new Response("<h1>Revenue</h1><p>Operating margin fell on restructuring charges.</p>"),
  });
  const marginObservation = (endDate: string, value: string) => ({
    observationId: `xbrl:operating_margin:${endDate}`,
    seriesId: "operating_margin" as const,
    metricKey: "operating_margin",
    value,
    unit: "ratio",
    basis: "derived" as const,
    periodScope: "annual" as const,
    startDate: endDate,
    endDate,
    sourceAccession: "annual",
    sourceFiledAt: endDate,
    sourceVersion: "sec-canonical-series.v1",
    qualityStatus: "validated_xbrl" as const,
    derivationFormula: "operating_income/revenue",
  });
  const history = xbrlHistory("120", "100");
  history.series.push({
    seriesId: "operating_margin",
    quarters: [],
    annual: [marginObservation("2026-06-30", "-0.2955143299222338"), marginObservation("2025-06-30", "-0.09690272057271924")],
  });
  const context = analysisContext(prepared.periodId, history);
  const plan = normalizePlan(prepared.outline[0].id);
  const nodes = [{
    id: "revenue-growth",
    title: "收入增长",
    status: "complete" as const,
    findings: [{ label: "利润率", detail: "营业利润率因重组费用走弱。", importance: "high" as const }],
    narrative: "重组费用拖累营业利润率。",
    facts: [],
    evidence: [],
  }];

  const result = await summarizePreparedSecFiling(
    prepared,
    context,
    async () => ({
      headline: "重组费用拖累营业利润率",
      bullets: completeBullets(),
      analystView: "利润率能否回升取决于重组是否一次性。",
      report: completeReport(),
      keyMetrics: [
        { metricKey: "operating_margin", currentValue: "-0.2955143299222338", evidenceIds: ["xbrl:operating_margin:2026-06-30"] },
        { metricKey: "revenue", currentValue: "120", evidenceIds: ["xbrl:revenue:2026-06-30"] },
      ],
      changes: { qoq: [], yoy: [], guidance: [], risks: [] },
      dataQuality: { coverage: 1, warnings: [] },
    }),
    new Date("2026-08-05T00:00:00.000Z"),
    plan,
    nodes,
  );
  const metric = (metricKey: string) => result.artifact.report.keyMetrics.find((item) => item.metricKey === metricKey);

  // The relative form of this move is -205%, which tells a reader nothing once the base is negative.
  assert.equal(metric("operating_margin")?.yoy, "-19.9个百分点");
  assert.equal(metric("revenue")?.yoy, "+20.0%");
});

test("drops unverifiable keyMetrics instead of failing the whole report", async () => {
  const prepared = await prepareSecFiling(filing, {
    userAgent: "test@example.com",
    fetcher: async () => new Response("<h1>Revenue</h1><p>Revenue increased 18%.</p>"),
  });
  const result = await summarizePreparedSecFiling(
    prepared,
    analysisContext(prepared.periodId, xbrlHistory("120")),
    async () => ({
      headline: "收入增长",
      bullets: completeBullets(),
      analystView: "需求仍需观察。",
      report: completeReport(),
      keyMetrics: [{ metricKey: "narrative_only_metric", currentValue: "9", evidenceIds: [`ev:${prepared.blocks[0].blockId}`] }],
      changes: { qoq: [], yoy: [], guidance: [], risks: [] },
      dataQuality: { coverage: 1, verificationStatus: "verified", warnings: [] },
    }),
    new Date("2026-08-05T00:00:00.000Z"),
    normalizePlan(prepared.outline[0].id),
    [{ id: "revenue-growth", title: "收入增长", status: "complete", findings: [], narrative: "收入增长。", evidence: [] }],
  );

  assert.deepEqual(result.artifact.report.keyMetrics, []);
  assert.equal(result.artifact.report.dataQuality.verificationStatus, "partial");
  assert.ok(result.artifact.report.dataQuality.warnings.some((warning) => warning.includes("narrative_only_metric")));
  assert.equal(result.summary.report, completeReport().slice(0, 6_000));
});

function normalizePlan(sectionId: string) {
  return {
    nodes: [nodeSpec({
      id: "revenue-growth",
      title: "收入增长",
      question: "收入增长由什么驱动？",
      sectionIds: [sectionId],
      keywords: ["revenue"],
    })],
    outlineSections: 1,
  };
}

test("keeps XBRL as the numeric source and folds node facts into the same report", async () => {
  const prepared = await prepareSecFiling(filing, {
    userAgent: "test@example.com",
    fetcher: async () => new Response("<h1>Item 8. Financial Statements</h1><p>Revenue was 120 USDm.</p>"),
  });
  const context = analysisContext(prepared.periodId, xbrlHistory("120", "100"));
  const calls: string[] = [];
  let nodePayload: Record<string, unknown> = {};
  const model: SecModelCall = async (stage, _system, payload) => {
    calls.push(stage);
    if (stage.startsWith("node:")) {
      nodePayload = payload as Record<string, unknown>;
      const evidence = (payload as { evidence: Array<{ evidenceId: string }> }).evidence;
      return {
        findings: [{ label: "收入", detail: "收入达到 1.2 亿美元。", importance: "high" }],
        narrative: "收入增长由核心业务需求推动。",
        facts: [{ metricKey: "segment_revenue", value: "60", unit: "USDm", basis: "gaap", sourceLabel: "fact_source_reported", evidenceIds: [evidence[0].evidenceId], confidence: "high" }],
      };
    }
    return {
      headline: "收入数据已验证",
      bullets: completeBullets(),
      analystView: "收入质量保持稳健。",
      report: completeReport(),
      keyMetrics: [{ metricKey: "revenue", currentValue: "120", evidenceIds: [`ev:${prepared.blocks[0].blockId}`] }],
      changes: { qoq: [], yoy: [], guidance: [], risks: [] },
      dataQuality: { coverage: 1, warnings: [] },
    };
  };

  const plan = normalizePlan(prepared.outline[0].id);
  const brief = buildPreparedSecBrief(prepared, context);
  const node = await analyzePreparedSecNode(prepared, plan.nodes[0], model, brief);
  const result = await summarizePreparedSecFiling(prepared, context, model, new Date("2026-08-05T00:00:00.000Z"), plan, [node], brief);

  assert.deepEqual(calls, ["node:revenue-growth", "synthesis"]);
  assert.deepEqual(nodePayload.xbrlFacts, brief.currentFacts);
  assert.ok(Array.isArray(nodePayload.allowedMetricKeys));
  assert.deepEqual(node.facts?.map((fact) => fact.metricKey), ["segment_revenue"]);
  assert.equal(result.artifact.report.dataQuality.verificationStatus, "partial");
  assert.deepEqual(result.artifact.comparisons.map((comparison) => comparison.comparisonType), ["yoy"]);
  assert.equal(result.artifact.comparisons[0].priorPeriodId, "MSFT:2025-06-30:annual");
});

test("rejects a model-reported verified summary when no fact source produced a metric", async () => {
  const prepared = await prepareSecFiling(filing, {
    userAgent: "test@example.com",
    fetcher: async () => new Response("<h1>Item 8. Financial Statements</h1><p>No usable values.</p>"),
  });
  const result = await summarizePreparedSecFiling(
    prepared,
    analysisContext(prepared.periodId),
    async () => ({
      headline: "verified",
      bullets: completeBullets(),
      analystView: "验证结果有限。",
      report: completeReport(),
      keyMetrics: [],
      changes: { qoq: [], yoy: [], guidance: [], risks: [] },
      dataQuality: { coverage: 1, verificationStatus: "verified", warnings: [] },
    }),
    new Date("2026-08-05T00:00:00.000Z"),
    normalizePlan(prepared.outline[0].id),
    [{
      id: "revenue-growth",
      title: "收入增长",
      status: "complete",
      findings: [{ label: "收入", detail: "收入已验证。", importance: "high" }],
      narrative: "收入分析。",
      evidence: [],
    }],
  );

  assert.equal(result.artifact.report.dataQuality.coverage, 0);
  assert.equal(result.artifact.report.dataQuality.verificationStatus, "failed");
});

test("rejects an incomplete synthesis before it can replace the last successful report", async () => {
  const prepared = await prepareSecFiling(filing, {
    userAgent: "test@example.com",
    fetcher: async () => new Response("<h1>Revenue</h1><p>Revenue increased 18%.</p>"),
  });

  await assert.rejects(summarizePreparedSecFiling(
    prepared,
    analysisContext(prepared.periodId, xbrlHistory("120")),
    async () => ({
      headline: "收入增长",
      bullets: [],
      analystView: "需求仍需观察。",
      report: "正文过短。",
      keyMetrics: [], changes: { qoq: [], yoy: [], guidance: [], risks: [] }, dataQuality: { coverage: 1, warnings: [] },
    }),
    new Date("2026-08-05T00:00:00.000Z"),
    normalizePlan(prepared.outline[0].id),
    [{ id: "revenue-growth", title: "收入增长", status: "complete", findings: [], narrative: "收入增长。", evidence: [] }],
  ), /1–5 core conclusions/);
});

test("accepts complete synthesis reports outside the former length range", async () => {
  const prepared = await prepareSecFiling(filing, {
    userAgent: "test@example.com",
    fetcher: async () => new Response("<h1>Revenue</h1><p>Revenue increased 18%.</p>"),
  });

  for (const report of ["简明但完整的研报正文。", "长篇研报正文。".repeat(1_000)]) {
    const result = await summarizePreparedSecFiling(
      prepared,
      analysisContext(prepared.periodId, xbrlHistory("120")),
      async () => ({
        headline: "收入增长",
        bullets: completeBullets(),
        analystView: "需求仍需观察。",
        report,
        keyMetrics: [], changes: { qoq: [], yoy: [], guidance: [], risks: [] }, dataQuality: { coverage: 1, warnings: [] },
      }),
      new Date("2026-08-05T00:00:00.000Z"),
      normalizePlan(prepared.outline[0].id),
      [{ id: "revenue-growth", title: "收入增长", status: "complete", findings: [], narrative: "收入增长。", evidence: [] }],
    );

    assert.equal(result.summary.report, report.slice(0, 6_000));
  }
});

test("keeps Company Memory out of every analysis payload while the brief still records it", async () => {
  const prepared = await prepareSecFiling(filing, {
    userAgent: "test@example.com",
    fetcher: async () => new Response("<h1>Revenue</h1><p>Revenue increased 18% and margins recovered.</p>"),
  });
  const memory = {
    memoryId: "memory:margin", ticker: "MSFT", kind: "judgment" as const, topicKey: "margin-recovery",
    statement: "MEMORY-STATEMENT-MARKER", status: "active" as const, materialityScore: 90,
    confidence: "high" as const, evidenceIds: ["ev:prior"], firstSeenPeriod: "2026Q1", lastConfirmedPeriod: "2026Q1",
    horizon: "2026Q2", nextTest: "Gross margin expands", falsifier: "Gross margin contracts",
  };
  const brief = buildPreparedSecBrief(prepared, {
    ...analysisContext(prepared.periodId, xbrlHistory("120", "100")),
    companyMemorySummary: "MEMORY-SUMMARY-MARKER",
    memoryItems: [memory],
  });

  // The brief itself keeps memory: it is the R2 record, and the extraction stage reads priorMemory from it.
  assert.equal(brief.memoryItems.length, 1);
  assert.match(brief.companyMemorySummary, /MEMORY-SUMMARY-MARKER/);

  let managerSystem = "";
  const payloads: string[] = [];
  await planPreparedSecFiling(prepared, async (_stage, system, payload) => {
    managerSystem = system;
    payloads.push(JSON.stringify(payload));
    return { nodes: [{ id: "margin", title: "利润率", question: "利润率恢复了吗？", sectionIds: [prepared.outline[0].id], memoryIds: ["memory:margin"] }] };
  }, brief);

  let nodeSystem = "";
  await analyzePreparedSecNode(prepared, nodeSpec({
    id: "margin", title: "利润率", question: "利润率恢复了吗？", sectionIds: [prepared.outline[0].id],
    memoryIds: ["memory:margin"],
  }), async (_stage, system, payload) => {
    nodeSystem = system;
    payloads.push(JSON.stringify(payload));
    return { narrative: "毛利率本期回升。", findings: [] };
  }, brief);

  let synthesisSystem = "";
  await summarizePreparedSecFiling(
    prepared,
    analysisContext(prepared.periodId, xbrlHistory("120", "100")),
    async (_stage, system, payload) => {
      synthesisSystem = system;
      payloads.push(JSON.stringify(payload));
      return {
        headline: "利润率回升", bullets: completeBullets(), analystView: "回升能否延续仍需观察。",
        report: completeReport(), keyMetrics: [{ metricKey: "revenue", currentValue: "120", evidenceIds: ["xbrl:revenue:2026-06-30"] }],
        changes: { qoq: [], yoy: [], guidance: [], risks: [] }, dataQuality: { coverage: 1, warnings: [] },
      };
    },
    new Date("2026-08-05T00:00:00.000Z"),
    normalizePlan(prepared.outline[0].id),
    [{ id: "revenue-growth", title: "收入增长", status: "complete" as const, findings: [], narrative: "毛利率本期回升。", evidence: [] }],
    brief,
  );

  await reviewPreparedSecAnalysis(prepared, brief, normalizePlan(prepared.outline[0].id), [], 0, async (_stage, _system, payload) => {
    payloads.push(JSON.stringify(payload));
    return { status: "complete", questions: [{ questionId: "revenue-growth", status: "answered", explanation: "Current filing reviewed" }], repairTasks: [], unresolvedQuestions: [], coverageScore: 1, stopReason: "complete" };
  });

  assert.equal(payloads.length, 4);
  for (const payload of payloads) {
    assert.doesNotMatch(payload, /MEMORY-STATEMENT-MARKER|MEMORY-SUMMARY-MARKER|memory:margin/);
    assert.doesNotMatch(payload, /memoryItems|companyMemorySummary/);
  }
  for (const system of [managerSystem, nodeSystem, synthesisSystem]) {
    assert.doesNotMatch(system, /memory|Memory|记忆/);
  }
});

test("publishes manager planning defects as report warnings", async () => {
  const prepared = await prepareSecFiling(filing, {
    userAgent: "test@example.com",
    fetcher: async () => new Response("<h1>Revenue</h1><p>Revenue increased 18%.</p>"),
  });
  const plan = {
    ...normalizePlan(prepared.outline[0].id),
    warnings: ["Manager referenced unknown history series: bookings"],
  };

  const result = await summarizePreparedSecFiling(
    prepared,
    analysisContext(prepared.periodId, xbrlHistory("120")),
    async () => ({
      headline: "收入增长", bullets: completeBullets(), analystView: "需求仍需观察。", report: completeReport(),
      keyMetrics: [{ metricKey: "revenue", currentValue: "120", evidenceIds: ["xbrl:revenue:2026-06-30"] }],
      changes: { qoq: [], yoy: [], guidance: [], risks: [] }, dataQuality: { coverage: 1, warnings: [] },
    }),
    new Date("2026-08-05T00:00:00.000Z"),
    plan,
    [{ id: "revenue-growth", title: "收入增长", status: "complete" as const, findings: [], narrative: "收入增长。", evidence: [] }],
  );

  assert.ok(result.artifact.report.dataQuality.warnings.some((warning) => warning.includes("bookings")));
});


test("event history excludes later disclosures and bounds comparable history without mutating it", () => {
  const history = xbrlHistory("120", "100");
  const prior = history.series[0].annual[1];
  history.series[0].annual.push({ ...prior, value: "999", sourceFiledAt: "2026-09-11" });
  const result = eventHistoryContext(history, "2026-07-30");
  assert.deepEqual(result.series[0].annual.map((point) => point.value), ["120", "100"]);
  assert.equal(history.series[0].annual.length, 3);
  assert.deepEqual(eventHistoryContext(history, "2024-01-01").series, []);
});

test("identical generations for one financial date have distinct persistent identities", async () => {
  const prepared = await prepareSecFiling(filing, {
    userAgent: "test@example.com",
    fetcher: async () => new Response("<h1>Revenue</h1><p>Revenue grew.</p>"),
  });
  const context = analysisContext(prepared.periodId, xbrlHistory("120", "100"));
  const model = async () => ({ headline: "Revenue", bullets: completeBullets(), analystView: "Watch demand", report: completeReport() });
  const generate = () => summarizePreparedSecFiling(prepared, context, model, new Date("2026-08-05T00:00:00.000Z"), normalizePlan(prepared.outline[0].id), [{ id: "revenue-growth", title: "Revenue", status: "complete", findings: [], narrative: "Demand grew", evidence: [] }]);
  const first = await generate();
  const second = await generate();
  assert.notEqual(first.artifact.report.reportVersion, second.artifact.report.reportVersion);
  assert.equal(first.artifact.report.publication?.summary.report, first.summary.report);
});
