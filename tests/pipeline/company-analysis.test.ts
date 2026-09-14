import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPANY_ANALYSIS_SCHEMA_VERSION,
  normalizeCompanyAnalysisOverview,
  normalizeCompanyAnalysisPublication,
  toPublicCompanyAnalysis,
} from "../../workers/pipeline/src/company-analysis/contracts.ts";
import {
  COMPANY_ANALYSIS_BLOCK_TYPES,
  COMPANY_ANALYSIS_OVERVIEW_LABEL,
  COMPANY_ANALYSIS_MAX_BLOCKS_PER_HIGHLIGHT,
  COMPANY_ANALYSIS_MAX_HIGHLIGHTS,
  COMPANY_ANALYSIS_MIN_HIGHLIGHTS,
} from "../../shared/analysis-contract/company-analysis.ts";
import { buildCompanyFeaturePack } from "../../workers/pipeline/src/company-analysis/feature-engine.ts";
import { resolveTargetPeriodEnd, type CompanyAnalysisPacket } from "../../workers/pipeline/src/company-analysis/packet.ts";
import { D1CompanyAnalysisRepository } from "../../workers/pipeline/src/company-analysis/repository.ts";
import type { FundamentalCurrentObservation } from "../../workers/pipeline/src/fundamentals/fundamentals-d1.ts";
import { applySqlMigration, SqliteD1Database } from "./helpers/sqlite-d1.ts";
import { COMPANY_AGENT_MODEL_STEP_CONFIG } from "../../workers/pipeline/src/company-analysis-workflow.ts";
import { COMPANY_TRAJECTORY_KEYS, runCompanyAnalysisAgent } from "../../workers/pipeline/src/company-analysis-agent.ts";
import type { SecPipelineEnv } from "../../workers/pipeline/src/operations.ts";

const generatedAt = "2026-09-03T08:00:00.000Z";

function overview(titles = ["增长逻辑", "平台优势", "再投资", "现金约束"]) {
  return {
    label: "业务前瞻 · AI 综述",
    headline: "核心需求仍在扩张，但资本回报进入验证期",
    introduction: "公司仍处于增长与再投资并行阶段，现有优势保持韧性，但新增投入需要转化为持续现金回报。",
    highlights: titles.map((title, index) => ({
      title,
      body: `${title}是本期最重要的变化之一。`,
      evidenceRefs: [`evidence-${index + 1}`],
    })),
  };
}

function publication(inputHash = "input-hash-123") {
  return {
    schemaVersion: COMPANY_ANALYSIS_SCHEMA_VERSION,
    analysisId: "company:AMZN:analysis-1",
    ticker: "AMZN",
    triggerRef: "memory-job-1:3",
    periodId: "AMZN:2026-03-31:quarterly",
    periodEnd: "2026-03-31",
    reportLabel: "截至 2026年3月31日",
    inputHash,
    memoryVersion: 3,
    fundamentalsDataVersion: "fundamentals-123",
    status: "ready",
    coverageStatus: "complete",
    overview: overview(),
    modelVersion: "glm-5.3",
    promptVersion: "company-analysis-skill.v1",
    generatedAt,
  };
}

/**
 * Evidence references used to be stripped from the public overview. They are published now: a
 * consumer that has to re-derive which observation backs a claim by reading the prose does not have
 * a usable contract. Everything internal to *how* the analysis was produced still stays inside.
 */
test("publishes the evidence backing each highlight", () => {
  const normalized = normalizeCompanyAnalysisPublication(publication());
  assert.equal(normalized.overview.highlights.length, 4);
  const publicValue = toPublicCompanyAnalysis(normalized);
  assert.equal(publicValue.overview?.highlights.length, 4);
  assert.deepEqual(
    publicValue.overview!.highlights.map((highlight) => highlight.evidenceRefs),
    normalized.overview.highlights.map((highlight) => highlight.evidenceRefs),
  );
  assert.equal("sourceLabel" in publicValue.overview!.highlights[0]!, false);
  // Internal pipeline versions are labels, reported under their own key — never a prompt.
  assert.equal(publicValue.versions.prompt, normalized.promptVersion);
  assert.equal(publicValue.versions.contentRevision, normalized.inputHash);
});

/**
 * The count is the editorial phase's call now, so normalization enforces a range rather than a
 * number. A quarter with two things worth saying should not be padded to four, and one that runs
 * long should not take the page with it.
 */
test("an overview carries as many judgments as the analysis composed, within bounds", () => {
  for (const count of [COMPANY_ANALYSIS_MIN_HIGHLIGHTS, 3, COMPANY_ANALYSIS_MAX_HIGHLIGHTS]) {
    const titles = Array.from({ length: count }, (_, index) => `判断 ${index + 1}`);
    const normalized = normalizeCompanyAnalysisPublication({ ...publication(), overview: overview(titles) });
    assert.equal(normalized.overview.highlights.length, count);
    // Ordinals number the published order rather than echoing anything the model chose.
    assert.deepEqual(
      normalized.overview.highlights.map((highlight) => highlight.ordinal),
      titles.map((_, index) => String(index + 1).padStart(2, "0")),
    );
    assert.deepEqual(normalized.overview.highlights.map((highlight) => highlight.title), titles);
  }
});

test("too few judgments fail the publication; too many are truncated from the least important end", () => {
  const short = Array.from({ length: COMPANY_ANALYSIS_MIN_HIGHLIGHTS - 1 }, (_, index) => `判断 ${index + 1}`);
  assert.throws(
    () => normalizeCompanyAnalysisPublication({ ...publication(), overview: overview(short) }),
    /at least 2 evidence-backed highlights/i,
  );
  const long = Array.from({ length: COMPANY_ANALYSIS_MAX_HIGHLIGHTS + 3 }, (_, index) => `判断 ${index + 1}`);
  const normalized = normalizeCompanyAnalysisPublication({ ...publication(), overview: overview(long) });
  assert.equal(normalized.overview.highlights.length, COMPANY_ANALYSIS_MAX_HIGHLIGHTS);
  assert.equal(normalized.overview.highlights.at(-1)!.title, `判断 ${COMPANY_ANALYSIS_MAX_HIGHLIGHTS}`);
});

test("publishes immutable analysis rows and reads the latest ready version", async () => {
  const database = new SqliteD1Database();
  try {
    await applySqlMigration(database, "../../../workers/pipeline/migrations/0009_company_analysis.sql");
    await applySqlMigration(database, "../../../workers/pipeline/migrations/0010_company_analysis_recovery.sql");
    const repository = new D1CompanyAnalysisRepository(database);
    const first = await repository.publish(publication());
    const duplicate = await repository.publish(publication());
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal((await repository.getLatestPublication("AMZN"))?.overview.headline, publication().overview.headline);
    await assert.rejects(() => repository.publish(publication("different-input-hash")), /immutable/i);
  } finally {
    database.close();
  }
});

test("promotes the same in-progress analysis row to an immutable publication", async () => {
  const database = new SqliteD1Database();
  try {
    await applySqlMigration(database, "../../../workers/pipeline/migrations/0009_company_analysis.sql");
    await applySqlMigration(database, "../../../workers/pipeline/migrations/0010_company_analysis_recovery.sql");
    const repository = new D1CompanyAnalysisRepository(database);
    await repository.upsertRun({
      analysisId: publication().analysisId,
      ticker: "AMZN",
      triggerRef: publication().triggerRef,
      periodId: publication().periodId,
      memoryVersion: publication().memoryVersion,
      status: "waiting_fundamentals",
      modelVersion: publication().modelVersion,
      promptVersion: publication().promptVersion,
      updatedAt: "2026-09-03T07:00:00.000Z",
    });

    const promoted = await repository.publish(publication());

    assert.equal(promoted.duplicate, false);
    assert.equal(promoted.publication.status, "ready");
    assert.equal((await repository.getLatestPublication("AMZN"))?.analysisId, publication().analysisId);
  } finally {
    database.close();
  }
});

test("backfill selects only the latest completed Memory version without an analysis run", async () => {
  const database = new SqliteD1Database();
  try {
    await applySqlMigration(database, "../../../workers/pipeline/migrations/0009_company_analysis.sql");
    await applySqlMigration(database, "../../../workers/pipeline/migrations/0010_company_analysis_recovery.sql");
    database.raw.exec(`
      CREATE TABLE sec_periods (period_id TEXT PRIMARY KEY, ticker TEXT NOT NULL, end_date TEXT NOT NULL);
      CREATE TABLE sec_memory_jobs (
        job_id TEXT PRIMARY KEY, ticker TEXT NOT NULL, period_id TEXT NOT NULL,
        status TEXT NOT NULL, completed_at TEXT
      );
      CREATE TABLE sec_company_memory_threads (ticker TEXT PRIMARY KEY, version INTEGER NOT NULL);
      INSERT INTO sec_periods VALUES
        ('AMZN:2025-12-31:quarter', 'AMZN', '2025-12-31'),
        ('AMZN:2026-03-31:quarter', 'AMZN', '2026-03-31');
      INSERT INTO sec_memory_jobs VALUES
        ('memory-old', 'AMZN', 'AMZN:2025-12-31:quarter', 'complete', '2026-02-01T00:00:00Z'),
        ('memory-latest', 'AMZN', 'AMZN:2026-03-31:quarter', 'complete', '2026-05-01T00:00:00Z');
      INSERT INTO sec_company_memory_threads VALUES ('AMZN', 7);
    `);
    const repository = new D1CompanyAnalysisRepository(database);
    assert.deepEqual(await repository.listBackfillCandidates(["AMZN"]), [{
      ticker: "AMZN",
      memoryJobId: "memory-latest",
      memoryVersion: 7,
      periodId: "AMZN:2026-03-31:quarter",
      reportDate: "2026-03-31",
      triggerRef: "memory-latest:7",
    }]);

    await repository.upsertRun({
      analysisId: "company:AMZN:backfill",
      ticker: "AMZN",
      triggerRef: "memory-latest:7",
      periodId: "AMZN:2026-03-31:quarter",
      memoryVersion: 7,
      status: "waiting_fundamentals",
      modelVersion: "test-model",
      promptVersion: "company-analysis-skill.v1",
      updatedAt: generatedAt,
    });
    assert.deepEqual(await repository.listBackfillCandidates(["AMZN"]), []);
    assert.deepEqual(await repository.listBackfillCandidates(["AMZN"], 100, true), [], "force recovery must not duplicate active work");

    await repository.upsertRun({
      analysisId: "company:AMZN:backfill",
      ticker: "AMZN",
      triggerRef: "memory-latest:7",
      periodId: publication().periodId,
      memoryVersion: 7,
      status: "ready",
      modelVersion: publication().modelVersion,
      promptVersion: publication().promptVersion,
      updatedAt: generatedAt,
    });
    assert.deepEqual(await repository.listBackfillCandidates(["AMZN"], 100, true), []);
  } finally {
    database.close();
  }
});

test("feature engine calculates trends only from Yahoo quarterly observations", () => {
  const periods = ["2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31"];
  const observations = periods.flatMap((periodEnd, index) => [
    observation(periodEnd, "total_revenue", String(100 + index * 10)),
    observation(periodEnd, "net_income", String(10 + index * 2)),
    observation(periodEnd, "operating_cash_flow", String(12 + index * 2)),
    observation(periodEnd, "capital_expenditure", String(-4 - index)),
    observation(periodEnd, "long_term_debt", String(40 + index)),
    observation(periodEnd, "stockholders_equity", String(80 + index * 4)),
  ]);
  const features = buildCompanyFeaturePack({
    source: "yahoo_finance",
    ticker: "AMZN",
    targetPeriodEnd: "2026-03-31",
    observations,
  });
  const revenue = features.features.find((item) => item.metricKey === "total_revenue")!;
  assert.equal(revenue.qoqGrowth, 10 / 130);
  assert.equal(revenue.yoyGrowth, 0.4);
  assert.equal(revenue.ttmValue, 500);
  assert.ok(features.derived.every((item) => item.source === "yahoo_finance"));
  assert.throws(() => buildCompanyFeaturePack({
    source: "sec",
    ticker: "AMZN",
    targetPeriodEnd: "2026-03-31",
    observations,
  }), /only accepts Yahoo Finance/i);
});

test("aligns 4-4-5 filing dates only to a nearby Yahoo revenue quarter", () => {
  const observations = [
    observation("2026-04-30", "total_revenue", "100"),
    observation("2026-01-31", "total_revenue", "90"),
  ];
  assert.equal(resolveTargetPeriodEnd(observations, "2026-05-03"), "2026-04-30");
  assert.equal(resolveTargetPeriodEnd(observations, "2026-07-26"), null);
});

test("bounds each company Agent model turn independently", () => {
  assert.deepEqual(COMPANY_AGENT_MODEL_STEP_CONFIG, {
    retries: {
      limit: 3,
      delay: "1 minute",
      backoff: "exponential",
    },
    timeout: "60 minutes",
  });
});

test("checkpoints one Agent's turns and retries invalid decisions inside the model step", async () => {
  const features = buildCompanyFeaturePack({
    source: "yahoo_finance",
    ticker: "AMZN",
    targetPeriodEnd: "2026-03-31",
    observations: [observation("2026-03-31", "total_revenue", "100")],
  });
  const evidenceRef = features.features[0]!.featureRef;
  const packet: CompanyAnalysisPacket = {
    ticker: "AMZN", periodId: "AMZN:2026-03-31:quarter", reportDate: "2026-03-31",
    targetPeriodEnd: "2026-03-31", memoryVersion: 1, fundamentalsDataVersion: "test-version",
    ready: true, reason: null, features, currentMemory: [], historicalMemory: [], priorConclusion: null,
  };
  const keys = [...COMPANY_TRAJECTORY_KEYS];
  const decision = {
    headline: "扩张的约束从需求转向交付", thesis: "未来四个季度的路径由建设节奏决定。",
    internalTrajectories: keys.map((key) => ({
      key, trajectory: "inflecting", horizon: "next_4_quarters",
      mechanism: "新增产能转固后折旧上台阶，抵消收入增长带来的杠杆。",
      claim: "利润率先降后升。", evidenceRefs: [evidenceRef],
      falsifier: "折旧摊销占收入比重不再上升。", nextCheck: "观察下一季度折旧摊销占比。",
    })),
    selectedEvidenceRefs: [evidenceRef],
  };
  const responses = [
    { summary: "本季经营保持稳定。", drivers: [{ statement: "需求支撑经营。", evidenceRefs: [evidenceRef] }], risks: [], unresolved: [] },
    // Rejected inside the model step and retried: an axis set that covers nothing.
    { action: "finalize", decision: { ...decision, internalTrajectories: [] } },
    { action: "finalize", decision },
    // Three judgments, not four: the editorial turn's own count has to survive to the publication.
    {
      ...overview(["判断一", "判断二", "判断三"]),
      highlights: overview(["判断一", "判断二", "判断三"]).highlights.map((highlight) => ({ ...highlight, evidenceRefs: [evidenceRef] })),
    },
  ];
  const payloads: Record<string, unknown>[] = [];
  const systemPrompts: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    systemPrompts.push(String(body.messages[0].content));
    payloads.push(JSON.parse(body.messages[1].content));
    return Response.json({ choices: [{ message: { content: JSON.stringify(responses.shift()) } }] });
  };
  const stages: string[] = [];
  const result = await runCompanyAnalysisAgent({
    env: { AI_API_KEY: "test-key" } as SecPipelineEnv,
    fetcher, currentPacket: packet, crossPeriodPacket: packet,
    analysisId: "company:AMZN:test", generatedAt,
    runStage: async (stage, callback) => {
      stages.push(stage);
      try { return await callback(); } catch (error) {
        if (stage === "cross-period-round-01") return callback();
        throw error;
      }
    },
  });
  assert.deepEqual(stages, ["current-quarter", "cross-period-round-01", "editorial"]);
  assert.equal(payloads.length, 4);
  const schema = payloads[1]!.outputSchema as { decision: { internalTrajectories: Array<{ key: string; mechanism: string }> } };
  assert.deepEqual(schema.decision.internalTrajectories.map((axis) => axis.key), keys);
  // The axes are asked for as trajectories with a mechanism, not as present-tense quality states.
  assert.match(schema.decision.internalTrajectories[0]!.mechanism, /causal chain/);
  const crossPeriod = systemPrompts[1]!;
  assert.match(crossPeriod, /Decide where this business is heading/);
  assert.match(crossPeriod, /direction of travel, not a verdict on current quality/);
  assert.match(crossPeriod, /must name the mechanism that moves it/);
  assert.doesNotMatch(crossPeriod, /valuation_readiness/);
  assert.equal(result.overview.highlights.length, 3);
  // The model is told the range in both halves of the turn it has to satisfy, and told nothing
  // that contradicts it — a prompt still asking for four would quietly restore the fixed count.
  const editorialSchema = payloads.at(-1)!.outputSchema as { highlights: string; blockTypes: Record<string, string> };
  assert.match(editorialSchema.highlights, /2-6/);
  assert.match(systemPrompts.at(-1)!, /2-6 highlights/);
  assert.doesNotMatch(systemPrompts.at(-1)!, /exactly four/i);
  // The forms it may choose, and the only metrics a chart may name — both supplied, not recalled.
  assert.deepEqual(Object.keys(editorialSchema.blockTypes), [...COMPANY_ANALYSIS_BLOCK_TYPES]);
  assert.deepEqual(payloads.at(-1)!.chartMetricKeys, ["total_revenue"]);
  // The section is briefed as a forward view. Both drifts seen in published copy are named: a
  // quarter recap, and prose reporting on how much evidence the run managed to observe.
  const editorial = systemPrompts.at(-1)!;
  assert.match(editorial, /where this company and its industry are heading/);
  assert.match(editorial, /not a quarter recap and not earnings commentary/);
  assert.match(editorial, /evidence for that judgment, never its subject/);
  assert.match(editorial, /Never write about the sufficiency of your own evidence/);
  // The name is not the model's to move, so it is not in the shape it is asked for.
  assert.equal("label" in editorialSchema, false);
});

function observation(
  periodEnd: string,
  metricKey: FundamentalCurrentObservation["metricKey"],
  valueDecimal: string,
): FundamentalCurrentObservation {
  return {
    observationId: `${periodEnd}:${metricKey}`,
    periodId: `AMZN:${periodEnd}:3M`,
    ticker: "AMZN",
    periodType: "3M",
    periodEnd,
    metricKey,
    sourceField: `quarterly${metricKey}`,
    valueDecimal,
    unitFamily: "currency",
    unit: "USD",
    currency: "USD",
    basis: "reported",
    derivationFormula: null,
    derivationVersion: null,
    sourceRunId: "run-1",
    revision: 1,
    updatedAt: generatedAt,
  };
}

/**
 * A judgment chooses its own form now. These cover the seam where an untrusted composition meets a
 * closed vocabulary: what survives, what is dropped, and what a dropped block costs.
 */
function withBlocks(blocks: unknown[]) {
  const base = overview(["判断一", "判断二"]);
  return { ...base, highlights: base.highlights.map((highlight, index) => index === 0 ? { ...highlight, blocks } : highlight) };
}

function firstBlocks(value: unknown, chartMetricKeys?: ReadonlySet<string>) {
  return normalizeCompanyAnalysisOverview(value, chartMetricKeys ? { chartMetricKeys } : {}).highlights[0]!.blocks ?? [];
}

test("a judgment keeps the forms it chose from the vocabulary the page can render", () => {
  const blocks = firstBlocks(withBlocks([
    { type: "key_points", points: [{ label: "毛利率", detail: "结构性改善。", importance: "high" }] },
    { type: "callout", tone: "caution", text: "含一次性项目。" },
  ]));
  assert.deepEqual(blocks.map((block) => block.type), ["key_points", "callout"]);
  // Ids are positional, like the ordinals: a shared anchor must survive regeneration.
  assert.deepEqual(blocks.map((block) => block.id), ["company-block-01-1", "company-block-01-2"]);
});

test("forms outside this surface's vocabulary are dropped, and the judgment survives them", () => {
  const overviewValue = withBlocks([
    { type: "metrics", metricKeys: ["revenue"] },
    { type: "evidence", items: [{ excerpt: "x", start: 1, end: 2, score: 9 }] },
    { type: "prose", text: "补充说明。" },
  ]);
  const normalized = normalizeCompanyAnalysisOverview(overviewValue);
  assert.deepEqual(normalized.highlights[0]!.blocks?.map((block) => block.type), ["prose"]);
  assert.equal(normalized.highlights[0]!.title, "判断一");
  assert.equal(normalized.highlights.length, 2);
});

test("a chart may name only metrics the run observed, and never carries its own points", () => {
  const chart = [{ type: "chart", title: "收入趋势", series: [{ metricKey: "total_revenue" }, { metricKey: "inventory" }] }];
  const observed = firstBlocks(withBlocks(chart), new Set(["total_revenue"]));
  assert.equal(observed.length, 1);
  const series = observed[0]!.type === "chart" ? observed[0]!.series : [];
  assert.deepEqual(series.map((entry) => entry.metricKey), ["total_revenue"]);
  assert.equal("points" in series[0]!, false);
  assert.equal("value" in series[0]!, false);
  // Every series unobservable: the chart goes, the judgment stays.
  assert.deepEqual(firstBlocks(withBlocks(chart), new Set(["gross_margin"])), []);
});

test("a chart's mark and transform fall back to the catalog rather than honouring an invalid one", () => {
  const blocks = firstBlocks(withBlocks([
    { type: "chart", title: "收入", series: [{ metricKey: "total_revenue", mark: "pie", transform: "cagr" }] },
  ]));
  const series = blocks[0]!.type === "chart" ? blocks[0]!.series[0]! : null;
  assert.equal(series?.mark, "bar");
  assert.equal(series?.transform, "value");
});

test("blocks are capped per judgment, and a judgment that chose none carries the field at all", () => {
  const many = Array.from({ length: COMPANY_ANALYSIS_MAX_BLOCKS_PER_HIGHLIGHT + 2 }, (_, index) => ({ type: "prose", text: `补充 ${index + 1}。` }));
  assert.equal(firstBlocks(withBlocks(many)).length, COMPANY_ANALYSIS_MAX_BLOCKS_PER_HIGHLIGHT);
  // Absent rather than empty: an overview composed before blocks existed reads identically.
  assert.equal("blocks" in normalizeCompanyAnalysisOverview(overview(["判断一", "判断二"])).highlights[0]!, false);
});

test("a stored publication reads its blocks back without the feature pack that vetted them", () => {
  const stored = { ...publication(), overview: withBlocks([{ type: "callout", tone: "negative", text: "杠杆上升。" }]) };
  const normalized = normalizeCompanyAnalysisPublication(stored);
  const blocks = toPublicCompanyAnalysis(normalized).overview!.highlights[0]!.blocks;
  assert.deepEqual(blocks?.map((block) => block.type), ["callout"]);
});

/**
 * The section is a forward view on the business and its industry, not a quarter recap. Two things
 * hold that: a name the run cannot restate, and the briefing asserted in the Agent test below.
 */
test("the section names itself, including for an overview published under the old free-form label", () => {
  const stored = { ...publication(), overview: { ...overview(), label: "财报点评" } };
  const normalized = normalizeCompanyAnalysisPublication(stored);
  assert.equal(normalized.overview.label, COMPANY_ANALYSIS_OVERVIEW_LABEL);
  // Applied on the read path, so existing publications re-frame without being regenerated.
  assert.equal(toPublicCompanyAnalysis(normalized).overview!.label, COMPANY_ANALYSIS_OVERVIEW_LABEL);
});


/**
 * The guard that keeps unsupported forward claims out of the decision. An axis that asserts a
 * direction has to say what moves it, over what period, on what evidence. An axis that admits it
 * could not be assessed is held to none of that — the prompt asks for an honest unobserved, so
 * validation must not make it the expensive answer.
 */
test("an axis claiming a direction must carry mechanism, horizon and evidence; an unobserved one need not", async () => {
  const features = buildCompanyFeaturePack({
    source: "yahoo_finance", ticker: "AMZN", targetPeriodEnd: "2026-03-31",
    observations: [observation("2026-03-31", "total_revenue", "100")],
  });
  const evidenceRef = features.features[0]!.featureRef;
  const packet: CompanyAnalysisPacket = {
    ticker: "AMZN", periodId: "AMZN:2026-03-31:quarter", reportDate: "2026-03-31",
    targetPeriodEnd: "2026-03-31", memoryVersion: 1, fundamentalsDataVersion: "test-version",
    ready: true, reason: null, features, currentMemory: [], historicalMemory: [], priorConclusion: null,
  };
  const axis = (key: string) => ({
    key, trajectory: "improving", horizon: "next_4_quarters",
    mechanism: "产能转固推高折旧基数。", claim: "利润率先降后升。", evidenceRefs: [evidenceRef],
    falsifier: "折旧占比停止上升。", nextCheck: "观察下季折旧占比。",
  });
  const decisionWhere = (mutate: (value: Record<string, unknown>) => Record<string, unknown>) => ({
    headline: "扩张的约束从需求转向交付", thesis: "未来四个季度由建设节奏决定。",
    internalTrajectories: COMPANY_TRAJECTORY_KEYS.map((key, index) => index === 0 ? mutate(axis(key)) : axis(key)),
    selectedEvidenceRefs: [evidenceRef],
  });

  const without = (value: Record<string, unknown>, field: string) => {
    const copy = { ...value };
    delete copy[field];
    return copy;
  };
  const rejected = [
    (value: Record<string, unknown>) => without(value, "mechanism"),
    (value: Record<string, unknown>) => ({ ...value, horizon: "unobserved" }),
    (value: Record<string, unknown>) => ({ ...value, evidenceRefs: [] }),
  ];
  // Accepted with no mechanism, no horizon, no evidence — only what would make it assessable.
  const honestUnobserved = (value: Record<string, unknown>) => ({
    key: value.key, trajectory: "unobserved", horizon: "unobserved", nextCheck: "需要估值口径数据才能评估。",
  });

  const responses: unknown[] = [
    { summary: "本季经营保持稳定。", drivers: [{ statement: "需求支撑经营。", evidenceRefs: [evidenceRef] }], risks: [], unresolved: [] },
    ...rejected.map((mutate) => ({ action: "finalize", decision: decisionWhere(mutate) })),
    { action: "finalize", decision: decisionWhere(honestUnobserved) },
    { ...overview(["判断一", "判断二"]), highlights: overview(["判断一", "判断二"]).highlights.map((highlight) => ({ ...highlight, evidenceRefs: [evidenceRef] })) },
  ];
  let attempts = 0;
  const fetcher: typeof fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify(responses.shift()) } }] });
  const result = await runCompanyAnalysisAgent({
    env: { AI_API_KEY: "test-key" } as SecPipelineEnv,
    fetcher, currentPacket: packet, crossPeriodPacket: packet,
    analysisId: "company:AMZN:axes", generatedAt,
    runStage: async (stage, callback) => {
      if (stage !== "cross-period-round-01") return callback();
      for (;;) {
        attempts += 1;
        try { return await callback(); } catch (error) { if (attempts > rejected.length) throw error; }
      }
    },
  });
  // Every malformed claim was rejected, and the run only settled on the one that was honest.
  assert.equal(attempts, rejected.length + 1);
  const first = result.decision.internalTrajectories[0]!;
  assert.equal(first.trajectory, "unobserved");
  assert.equal(first.mechanism, "");
  assert.equal(result.decision.internalTrajectories.length, COMPANY_TRAJECTORY_KEYS.length);
});

test("prose over its cap is cut, not refused: a long paragraph must not fail the whole run", () => {
  const long = "字".repeat(2_000);
  const base = overview(["判断一", "判断二"]);
  const normalized = normalizeCompanyAnalysisOverview({
    ...base,
    headline: long,
    introduction: long,
    highlights: base.highlights.map((highlight, index) => index === 0
      ? { ...highlight, title: long, body: long, blocks: [{ type: "prose", text: long }] }
      : highlight),
  });
  const first = normalized.highlights[0]!;
  for (const [label, value, cap] of [
    ["headline", normalized.headline, 180],
    ["introduction", normalized.introduction, 1_200],
    ["title", first.title, 100],
    ["body", first.body, 700],
  ] as const) {
    assert.equal(value.length, cap, label);
    assert.ok(value.endsWith("…"), `${label} should show it was cut`);
  }
  const block = first.blocks?.[0];
  assert.equal(block?.type === "prose" && block.text.length, 700);
});

test("cutting prose never splits a character in half", () => {
  // Astral code points are two UTF-16 units; a naive slice at the cap would leave half of one.
  const emoji = "🚀".repeat(500);
  const normalized = normalizeCompanyAnalysisOverview({ ...overview(["判断一", "判断二"]), headline: emoji });
  assert.equal(Array.from(normalized.headline).length, 180);
  assert.ok(!/[\uD800-\uDBFF]$/.test(normalized.headline.slice(0, -1)));
});

test("a decision that observed nothing is refused rather than published as invention", async () => {
  const features = buildCompanyFeaturePack({
    source: "yahoo_finance", ticker: "AMZN", targetPeriodEnd: "2026-03-31",
    observations: [observation("2026-03-31", "total_revenue", "100")],
  });
  const evidenceRef = features.features[0]!.featureRef;
  const packet: CompanyAnalysisPacket = {
    ticker: "AMZN", periodId: "AMZN:2026-03-31:quarter", reportDate: "2026-03-31",
    targetPeriodEnd: "2026-03-31", memoryVersion: 1, fundamentalsDataVersion: "test-version",
    ready: true, reason: null, features, currentMemory: [], historicalMemory: [], priorConclusion: null,
  };
  // Five axes, all honestly unobserved. The count check passes; nothing has been seen.
  const blind = {
    headline: "证据不足以判断方向", thesis: "无法形成前瞻判断。",
    internalTrajectories: COMPANY_TRAJECTORY_KEYS.map((key) => ({
      key, trajectory: "unobserved", horizon: "unobserved", nextCheck: "需要更多披露。",
    })),
    selectedEvidenceRefs: [evidenceRef],
  };
  const responses: unknown[] = [
    { summary: "本季经营保持稳定。", drivers: [{ statement: "需求支撑经营。", evidenceRefs: [evidenceRef] }], risks: [], unresolved: [] },
    { action: "finalize", decision: blind },
  ];
  const fetcher: typeof fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify(responses.shift() ?? blind) } }] });
  await assert.rejects(
    () => runCompanyAnalysisAgent({
      env: { AI_API_KEY: "test-key" } as SecPipelineEnv,
      fetcher, currentPacket: packet, crossPeriodPacket: packet,
      analysisId: "company:AMZN:blind", generatedAt,
      runStage: async (_stage, callback) => callback(),
    }),
    /observed 0 of 5 axes/,
  );
});
