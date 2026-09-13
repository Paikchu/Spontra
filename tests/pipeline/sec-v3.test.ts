import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import {
  buildSecAnalysisBrief,
  MAX_REPAIR_ROUNDS,
  normalizeManagerReview,
  unresolvedFingerprint,
  type CompanyMemoryItem,
  type HistoricalObservation,
} from "../../workers/pipeline/src/sec/analysis.ts";
import {
  COMPANY_FACTS_REGISTRY_VERSION,
  normalizeCompanyFacts,
} from "../../workers/pipeline/src/sec/history.ts";
import {
  buildCompanyMemorySummary,
  consolidateMemoryCandidates,
  normalizeMemoryExtraction,
  type MemoryConsolidationState,
} from "../../workers/pipeline/src/sec/memory.ts";
import { runManagerRepairLoop, type WorkflowStepLike } from "../../workers/pipeline/src/workflow-core.ts";
import type { SecFilingSummary, SecNodePlan, SecNodeResult } from "../../workers/pipeline/src/sec/sec.ts";
import type { SecAnalysisArtifact } from "../../workers/pipeline/src/sec/types.ts";
import { planPreparedSecFiling, prepareSecFiling } from "../../workers/pipeline/src/sec/pipeline.ts";
import { D1SecRepository } from "../../workers/pipeline/src/sec/d1.ts";

/** The sqlite-backed double hands its own richer statements to `batch`, so it is deliberately
 *  narrower than the repository's database parameter. */
type DatabaseMock = ConstructorParameters<typeof D1SecRepository>[0];
const asDatabase = (mock: unknown) => mock as DatabaseMock;

const issuer = "TESTCO";

/** SEC Company Facts keys concepts and units arbitrarily, and only some observations carry a
 *  frame. Modelling that lets a test add or replace a concept without fighting the fixture. */
type CompanyFactObservation = {
  start: string;
  end: string;
  val: number;
  accn: string;
  fy: number;
  fp: string;
  form: string;
  filed: string;
  frame?: string;
};

type CompanyFactsPayload = {
  cik: number;
  entityName: string;
  facts: {
    "us-gaap": Record<string, {
      label?: string;
      units: Record<string, Array<CompanyFactObservation | undefined>>;
    }>;
  };
};

function companyFactsPayload(): CompanyFactsPayload {
  const quarterly = Array.from({ length: 10 }, (_, index) => {
    const year = 2024 + Math.floor(index / 4);
    const quarter = index % 4;
    const endMonth = ["03-31", "06-30", "09-30", "12-31"][quarter];
    const startMonth = ["01-01", "04-01", "07-01", "10-01"][quarter];
    return {
      start: `${year}-${startMonth}`,
      end: `${year}-${endMonth}`,
      val: 100 + index,
      accn: `original-${index}`,
      fy: year,
      fp: quarter === 3 ? "FY" : `Q${quarter + 1}`,
      form: quarter === 3 ? "10-K" : "10-Q",
      filed: `${year}-${endMonth}`,
      frame: `CY${year}Q${quarter + 1}`,
    };
  });
  quarterly.push({ ...quarterly[8], val: 999, accn: "amended", form: "10-Q/A", filed: "2026-05-05" });
  const annual = Array.from({ length: 6 }, (_, index) => ({
    start: `${2020 + index}-01-01`, end: `${2020 + index}-12-31`, val: 400 + index,
    accn: `annual-${index}`, fy: 2020 + index, fp: "FY", form: "10-K", filed: `${2021 + index}-02-15`, frame: `CY${2020 + index}`,
  }));
  return {
    cik: 1,
    entityName: "Test Company",
    facts: {
      "us-gaap": {
        RevenueFromContractWithCustomerExcludingAssessedTax: {
          label: "Revenue",
          units: { USD: [...quarterly, ...annual] },
        },
        NetCashProvidedByUsedInOperatingActivities: {
          label: "Operating cash flow",
          units: { USD: [quarterly.at(-1)] },
        },
        PaymentsToAcquirePropertyPlantAndEquipment: {
          label: "Capital expenditure",
          units: { shares: [quarterly.at(-1)] },
        },
      },
    },
  };
}

test("normalizes Company Facts into versioned 8-quarter and 5-year canonical history", () => {
  const history = normalizeCompanyFacts(issuer, companyFactsPayload());
  const revenue = history.series.find((series) => series.seriesId === "revenue");

  assert.equal(history.registryVersion, COMPANY_FACTS_REGISTRY_VERSION);
  assert.equal(revenue?.quarters.length, 8);
  assert.equal(revenue?.annual.length, 5);
  assert.equal(revenue?.quarters.find((item) => item.endDate === "2026-03-31")?.value, "999");
  assert.ok(revenue?.quarters.every((item) => item.sourceAccession && item.sourceFiledAt && item.unit && item.basis));
  assert.equal(history.series.some((series) => series.seriesId === "free_cash_flow"), false);
});

test("does not classify a nine-month 10-Q cumulative fact as an annual observation", () => {
  const payload = companyFactsPayload() as ReturnType<typeof companyFactsPayload>;
  payload.facts["us-gaap"].RevenueFromContractWithCustomerExcludingAssessedTax.units.USD.push({
    start: "2026-01-01", end: "2026-09-30", val: 300, accn: "nine-month", fy: 2026, fp: "Q3", form: "10-Q", filed: "2026-10-30", frame: "CY2026Q3YTD",
  });
  const revenue = normalizeCompanyFacts(issuer, payload).series.find((series) => series.seriesId === "revenue");

  assert.equal(revenue?.annual.some((item) => item.sourceAccession === "nine-month"), false);
  assert.equal(revenue?.quarters.some((item) => item.sourceAccession === "nine-month"), false);
});

test("recovers a quarterly cash flow from year-to-date 10-Q facts", () => {
  const payload = companyFactsPayload() as ReturnType<typeof companyFactsPayload>;
  // Issuers tag the cash flow statement year-to-date, so Q2 exists only as H1.
  payload.facts["us-gaap"].NetCashProvidedByUsedInOperatingActivities = { units: { USD: [
    { start: "2026-01-01", end: "2026-03-31", val: 100, accn: "q1", fy: 2026, fp: "Q1", form: "10-Q", filed: "2026-04-30" },
    { start: "2026-01-01", end: "2026-06-30", val: 260, accn: "h1", fy: 2026, fp: "Q2", form: "10-Q", filed: "2026-07-30" },
  ] } };
  payload.facts["us-gaap"].PaymentsToAcquirePropertyPlantAndEquipment = { units: { USD: [
    { start: "2026-01-01", end: "2026-03-31", val: 30, accn: "q1", fy: 2026, fp: "Q1", form: "10-Q", filed: "2026-04-30" },
    { start: "2026-01-01", end: "2026-06-30", val: 70, accn: "h1", fy: 2026, fp: "Q2", form: "10-Q", filed: "2026-07-30" },
  ] } };
  // Issuers that fold intangibles into capex tag it as PaymentsToAcquireProductiveAssets.
  payload.facts["us-gaap"].PaymentsToAcquireProductiveAssets = { units: { USD: [
    { start: "2026-01-01", end: "2026-09-30", val: 130, accn: "q3", fy: 2026, fp: "Q3", form: "10-Q", filed: "2026-10-30" },
  ] } };
  const series = normalizeCompanyFacts(issuer, payload).series;
  const quarter = (id: string, endDate: string) => series.find((item) => item.seriesId === id)?.quarters.find((item) => item.endDate === endDate);
  assert.equal(quarter("capex", "2026-09-30"), undefined, "A broader productive-assets concept cannot be subtracted from property-only capex");

  const operating = quarter("operating_cash_flow", "2026-06-30");
  assert.equal(operating?.value, "160", "Q2 operating cash flow is H1 minus Q1");
  assert.equal(operating?.basis, "derived");
  assert.equal(operating?.startDate, "2026-04-01", "the derived quarter starts the day after Q1 ended");
  assert.match(operating?.derivationFormula ?? "", /2026-06-30\] - .*2026-03-31\]/);

  // Q1 is already a single quarter, so it must stay the reported value.
  assert.equal(quarter("operating_cash_flow", "2026-03-31")?.value, "100");
  assert.equal(quarter("operating_cash_flow", "2026-03-31")?.basis, "gaap");

  // Free cash flow then derives from the recovered quarters instead of going missing.
  assert.equal(quarter("free_cash_flow", "2026-06-30")?.value, "120");
});

test("builds a Manager brief from XBRL facts, history, memory, and deterministic comparisons", () => {
  const evidenceId = "ev:test-block";
  const observation = (endDate: string, startDate: string, value: string, id: string): HistoricalObservation => ({
    observationId: id, seriesId: "revenue", metricKey: "revenue", value, unit: "USD", currency: "USD", basis: "gaap",
    periodScope: "quarter", startDate, endDate, sourceAccession: id, sourceFiledAt: endDate,
    sourceVersion: COMPANY_FACTS_REGISTRY_VERSION, qualityStatus: "validated_xbrl",
  });
  const memory: CompanyMemoryItem = {
    memoryId: "memory-1", ticker: issuer, kind: "judgment", topicKey: "margin-recovery", statement: "Margins should recover next quarter.",
    status: "active", materialityScore: 85, confidence: "medium", evidenceIds: [evidenceId], firstSeenPeriod: "2025Q4", lastConfirmedPeriod: "2025Q4",
    horizon: "2026Q1", nextTest: "Gross margin expands", falsifier: "Gross margin contracts",
  };
  const brief = buildSecAnalysisBrief({
    ticker: issuer, filingId: "filing-1", periodId: `${issuer}:2026-03-31:quarter`, periodScope: "quarter",
    reportDate: "2026-03-31",
    history: {
      registryVersion: COMPANY_FACTS_REGISTRY_VERSION,
      series: [{
        seriesId: "revenue",
        quarters: [
          observation("2026-03-31", "2026-01-01", "120", "current"),
          observation("2025-12-31", "2025-10-01", "100", "history-1"),
          observation("2025-03-31", "2025-01-01", "96", "history-4"),
        ],
        annual: [],
      }],
    },
    memorySummary: "Margin recovery remains due.", memoryItems: [memory],
  });

  assert.equal(brief.currentFacts.length, 1);
  assert.equal(brief.currentFacts[0].value, "120");
  assert.deepEqual(brief.currentFacts[0].evidenceIds, ["current"]);
  assert.equal(brief.history.series[0].quarters.length, 3);
  assert.equal(brief.memoryItems[0].memoryId, "memory-1");
  assert.equal(brief.comparisons.find((item) => item.comparisonType === "qoq")?.percentageDelta, "0.2");
  assert.equal(brief.comparisons.find((item) => item.comparisonType === "yoy")?.percentageDelta, "0.25");
  assert.deepEqual(brief.missingSeriesIds, []);
});

test("passes historical series into the Manager plan and holds Company Memory back", async () => {
  const filing = {
    ticker: issuer, cik: "0000000001", cikNumber: 1, companyName: "Test Company", form: "10-Q",
    filingDate: "2026-04-20", reportDate: "2026-03-31", accessionNumber: "test-filing", primaryDocument: "test.htm",
    description: "Quarterly report", items: "", documentUrl: "https://sec.test/test.htm", indexUrl: "https://sec.test/index.htm",
  };
  const prepared = await prepareSecFiling(filing, { userAgent: "test@example.com", fetcher: async () => new Response("<h1>Revenue</h1><p>Revenue was 120.</p>") });
  const memory = { memoryId: "memory-1", ticker: issuer, kind: "fact" as const, topicKey: "backlog", statement: "Backlog expanded.", status: "active" as const, materialityScore: 80, confidence: "high" as const, evidenceIds: ["ev:1"], firstSeenPeriod: "2025Q4", lastConfirmedPeriod: "2025Q4" };
  const brief = buildSecAnalysisBrief({ ticker: issuer, filingId: filing.accessionNumber, periodId: prepared.periodId, periodScope: "quarter", reportDate: filing.reportDate, history: normalizeCompanyFacts(issuer, companyFactsPayload()), memorySummary: "Backlog expanded.", memoryItems: [memory] });
  let managerPayload = "";

  await planPreparedSecFiling(prepared, async (_stage, _system, payload) => {
    managerPayload = JSON.stringify(payload);
    return { nodes: [{ id: "growth", title: "Growth", question: "What changed?", sectionIds: [prepared.outline[0].id], historySeriesIds: ["revenue"], memoryIds: ["memory-1"], acceptanceCriteria: ["Explain the driver"], materiality: "high" }] };
  }, brief);

  assert.match(managerPayload, /sec-analysis-brief\.v2/);
  assert.match(managerPayload, /registryVersion/);
  // Memory stays on the brief for the extraction stage, but the Manager plans on this filing alone.
  assert.doesNotMatch(managerPayload, /memory-1|Backlog expanded/);
  assert.equal(brief.memoryItems[0].memoryId, "memory-1");
});

test("normalizes Manager review repair tasks and fingerprints unresolved work", () => {
  const review = normalizeManagerReview({
    status: "needs_repair",
    questions: [{ questionId: "growth", status: "unanswered", explanation: "Missing driver evidence" }],
    repairTasks: [{ id: "repair-growth", questionId: "growth", targetNodeId: "growth", title: "增长驱动", question: "增长由什么驱动？", sectionIds: ["section-1"], missingEvidence: ["volume-price mix"] }],
    unresolvedQuestions: ["增长由什么驱动？"], coverageScore: 0.55, stopReason: null,
  }, new Set(["growth"]), new Set(["section-1"]));

  assert.equal(review.status, "needs_repair");
  assert.equal(review.repairTasks.length, 1);
  assert.equal(unresolvedFingerprint(review), unresolvedFingerprint({ ...review, coverageScore: 0.7 }));
});

test("memory consolidation is replay-safe and marks explicit conflicts without resolving omissions", () => {
  const state: MemoryConsolidationState = { ticker: issuer, periodId: "2026Q1", items: [] };
  const candidate = {
    candidateId: "candidate-1", kind: "judgment" as const, topicKey: "demand", statement: "Demand should accelerate.",
    evidenceIds: ["ev:1"], materialityScore: 80, confidence: "medium" as const, horizon: "2026Q2", nextTest: "Bookings accelerate", falsifier: "Bookings decline", disposition: "active" as const,
  };
  const first = consolidateMemoryCandidates(state, [candidate], "job-1");
  const replay = consolidateMemoryCandidates({ ...state, items: first.items }, [candidate], "job-1");
  const conflict = consolidateMemoryCandidates({ ...state, items: first.items }, [{ ...candidate, candidateId: "candidate-2", statement: "Demand is declining.", disposition: "contradicted" as const }], "job-2");
  const omitted = consolidateMemoryCandidates({ ...state, items: first.items }, [], "job-3");

  assert.equal(first.events.length, 1);
  assert.equal(replay.events.length, 0);
  assert.equal(conflict.items[0].status, "contradicted");
  assert.equal(omitted.items[0].status, "stale");
  assert.equal(omitted.events[0].eventType, "stale");
  assert.equal(omitted.noOp, false);
});

test("keeps resolved due items out of the injected company summary", () => {
  const item: CompanyMemoryItem = {
    memoryId: "memory-resolved", ticker: issuer, kind: "judgment", topicKey: "guidance", statement: "Target was met.",
    status: "resolved", materialityScore: 90, confidence: "high", evidenceIds: ["ev:1"], firstSeenPeriod: "2025Q4",
    lastConfirmedPeriod: "2026Q1", duePeriod: "2026Q1", horizon: "2026Q1", nextTest: "Target met", falsifier: "Target missed",
  };

  assert.equal(buildCompanyMemorySummary([item]), "");
});

test("Manager repair loop uses deterministic round names and stops after one repair round", async () => {
  const steps: string[] = [];
  const step: WorkflowStepLike = { async do<T>(name: string, callback: () => Promise<T>) { steps.push(name); return callback(); } };
  const plan: SecNodePlan = {
    nodes: [{ id: "growth", title: "Growth", question: "What changed?", sectionIds: ["section-1"], historySeriesIds: [], memoryIds: [], acceptanceCriteria: ["answer"], materiality: "high" }],
    outlineSections: 1,
  };
  const initialNodes: SecNodeResult[] = [{ id: "growth", title: "Growth", status: "empty", findings: [], narrative: "", evidence: [] }];
  let reviews = 0;
  const result = await runManagerRepairLoop("filing-1", step, plan, initialNodes, {
    async review(round) {
      reviews += 1;
      return round < 1 ? {
        status: "needs_repair", questions: [{ questionId: "q-growth", status: "unanswered", explanation: "Missing" }],
        repairTasks: [{ id: `repair-${round}`, questionId: "q-growth", targetNodeId: "growth", title: "Growth", question: "What changed?", sectionIds: ["section-1"], keywords: [], historySeriesIds: [], memoryIds: [], acceptanceCriteria: ["answer"], materiality: "high", missingEvidence: ["driver"] }],
        unresolvedQuestions: [`round-${round}`], coverageScore: 0, stopReason: null,
      } : {
        status: "complete", questions: [{ questionId: "q-growth", status: "answered", explanation: "Answered" }], repairTasks: [], unresolvedQuestions: [], coverageScore: 1, stopReason: "complete",
      };
    },
    async repair(task, round) {
      return { id: task.targetNodeId, title: task.title, status: "complete", findings: [], narrative: `repair-${round}`, evidence: [] };
    },
  });

  assert.equal(result.rounds, 1);
  assert.equal(reviews, 2);
  assert.equal(result.review.status, "complete");
  assert.ok(steps.includes("manager-review:filing-1:round:0"));
  assert.ok(steps.includes("repair-node:filing-1:round:1:0:repair-0"));
  assert.equal(steps.some((name) => name.includes("round:2")), false);
});

test("Manager repair loop repairs the highest-materiality nodes first", async () => {
  const repaired: string[] = [];
  const step: WorkflowStepLike = { async do<T>(_name: string, callback: () => Promise<T>) { return callback(); } };
  const specs = ["low", "high", "medium", "high"].map((materiality, index) => ({
    id: `node-${index}`, title: `Node ${index}`, question: "What changed?", sectionIds: ["section-1"],
    keywords: [], historySeriesIds: [], memoryIds: [], acceptanceCriteria: ["answer"],
    materiality: materiality as "high" | "medium" | "low",
  }));
  const plan: SecNodePlan = { nodes: specs, outlineSections: 1 };
  const initialNodes: SecNodeResult[] = specs.map((spec) => ({ id: spec.id, title: spec.title, status: "empty", findings: [], narrative: "", evidence: [] }));

  await runManagerRepairLoop("filing-1", step, plan, initialNodes, {
    async review(round) {
      return round < 1 ? {
        status: "needs_repair",
        questions: specs.map((spec) => ({ questionId: spec.id, status: "unanswered" as const, explanation: "Missing" })),
        repairTasks: specs.map((spec) => ({ ...spec, questionId: spec.id, targetNodeId: spec.id, missingEvidence: [] })),
        unresolvedQuestions: specs.map((spec) => spec.id), coverageScore: 0, stopReason: null,
      } : {
        status: "complete", questions: specs.map((spec) => ({ questionId: spec.id, status: "answered" as const, explanation: "Answered" })),
        repairTasks: [], unresolvedQuestions: [], coverageScore: 1, stopReason: "complete",
      };
    },
    async repair(task, round) {
      repaired.push(task.targetNodeId);
      return { id: task.targetNodeId, title: task.title, status: "complete", findings: [], narrative: `repair-${round}`, evidence: [] };
    },
  });

  assert.deepEqual(repaired, ["node-1", "node-3", "node-2"]);
});

test("Manager repair loop executes repair steps sequentially", async () => {
  let activeRepairSteps = 0;
  let maxActiveRepairSteps = 0;
  const step: WorkflowStepLike = {
    async do<T>(name: string, callback: () => Promise<T>) {
      if (!name.startsWith("repair-node:")) return callback();
      activeRepairSteps += 1;
      maxActiveRepairSteps = Math.max(maxActiveRepairSteps, activeRepairSteps);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return await callback();
      } finally {
        activeRepairSteps -= 1;
      }
    },
  };
  const plan: SecNodePlan = {
    nodes: [{ id: "growth", title: "Growth", question: "What changed?", sectionIds: ["section-1"], historySeriesIds: [], memoryIds: [], acceptanceCriteria: ["answer"], materiality: "high" }],
    outlineSections: 1,
  };
  let reviews = 0;
  await runManagerRepairLoop("filing-sequential", step, plan, [], {
    async review() {
      reviews += 1;
      if (reviews > 1) return {
        status: "complete", questions: [], repairTasks: [], unresolvedQuestions: [], coverageScore: 1, stopReason: "complete",
      };
      return {
        status: "needs_repair", questions: [], unresolvedQuestions: ["growth", "margin"], coverageScore: 0, stopReason: null,
        repairTasks: ["growth", "margin"].map((id) => ({
          id: `repair-${id}`, questionId: `q-${id}`, targetNodeId: id, title: id, question: id,
          sectionIds: ["section-1"], keywords: [], historySeriesIds: [], memoryIds: [], acceptanceCriteria: ["answer"], materiality: "high" as const, missingEvidence: [id],
        })),
      };
    },
    async repair(task) {
      return { id: task.targetNodeId, title: task.title, status: "complete", findings: [], narrative: "repaired", evidence: [] };
    },
  });

  assert.equal(maxActiveRepairSteps, 1);
});

test("Manager repair loop stops early when unresolved work makes no progress", async () => {
  const step: WorkflowStepLike = { async do<T>(_name: string, callback: () => Promise<T>) { return callback(); } };
  const plan: SecNodePlan = { nodes: [], outlineSections: 1 };
  const review = {
    status: "needs_repair" as const,
    questions: [{ questionId: "q-risk", status: "unanswered" as const, explanation: "Missing" }],
    repairTasks: [], unresolvedQuestions: ["Risk not disclosed"], coverageScore: 0.5, stopReason: null,
  };
  const result = await runManagerRepairLoop("filing-2", step, plan, [], {
    async review() { return review; },
    async repair() { throw new Error("must not run"); },
  });

  assert.equal(result.rounds, 0);
  assert.equal(result.review.status, "partial");
  assert.equal(result.review.stopReason, "analysis_incomplete");
});

test("commits the final report, summary, and pending Memory job in one D1 batch", async () => {
  const batches: Array<Array<{ sql: string; values: unknown[] }>> = [];
  const database = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return { sql, values, async run() { return {}; }, async first<T>() { return null as T | null; }, async all<T>() { return { results: [] as T[] }; } };
        },
      };
    },
    async batch(statements: Array<{ sql: string; values: unknown[] }>) { batches.push(statements); return []; },
  };
  const filing = {
    ticker: issuer, cik: "0000000001", cikNumber: 1, companyName: "Test Company", form: "10-Q",
    filingDate: "2026-04-20", reportDate: "2026-03-31", accessionNumber: "test-filing", primaryDocument: "test.htm",
    description: "Quarterly report", items: "", documentUrl: "https://sec.test/test.htm", indexUrl: "https://sec.test/index.htm",
  };
  const artifact = {
    filing, periodId: `${issuer}:2026-03-31:quarter`, periodScope: "quarter", blocks: [], comparisons: [],
    artifactKeys: { synthesis: "analysis/test/synthesis.json" },
    report: { ticker: issuer, periodId: `${issuer}:2026-03-31:quarter`, reportVersion: "v3", headline: "Test", keyMetrics: [], changes: { qoq: [], yoy: [], guidance: [], risks: [] }, dataQuality: { coverage: 1, verificationStatus: "partial", warnings: [], analysisStatus: "partial" } },
  } satisfies SecAnalysisArtifact;
  const summary = { ticker: issuer, form: "10-Q", filingDate: filing.filingDate, accessionNumber: filing.accessionNumber, headline: "Test", bullets: [], analystView: "Test", report: "Test", source: "deepseek", generatedAt: "2026-04-21T00:00:00.000Z" } satisfies SecFilingSummary;

  const jobId = await new D1SecRepository(asDatabase(database)).commitFinalPublication(artifact, summary);

  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 3);
  assert.ok(batches[0].some((statement) => /sec_published_reports/.test(statement.sql)));
  assert.ok(batches[0].some((statement) => /sec_memory_jobs/.test(statement.sql)));
  assert.match(jobId, /:memory$/);
});

test("refuses to commit a summary for a different filing than the one being published", async () => {
  const database = { prepare() { throw new Error("must not reach the database"); }, async batch() { throw new Error("must not reach the database"); } };
  const filing = {
    ticker: issuer, cik: "0000000001", cikNumber: 1, companyName: "Test Company", form: "10-Q",
    filingDate: "2026-04-20", reportDate: "2026-03-31", accessionNumber: "test-filing", primaryDocument: "test.htm",
    description: "Quarterly report", items: "", documentUrl: "https://sec.test/test.htm", indexUrl: "https://sec.test/index.htm",
  };
  const artifact = {
    filing, periodId: `${issuer}:2026-03-31:quarter`, periodScope: "quarter", blocks: [], comparisons: [],
    artifactKeys: { synthesis: "analysis/test/synthesis.json" },
    report: { ticker: issuer, periodId: `${issuer}:2026-03-31:quarter`, reportVersion: "v3", headline: "Test", keyMetrics: [], changes: { qoq: [], yoy: [], guidance: [], risks: [] }, dataQuality: { coverage: 1, verificationStatus: "partial", warnings: [], analysisStatus: "partial" } },
  } satisfies SecAnalysisArtifact;
  const summary = { ticker: issuer, form: "10-Q", filingDate: filing.filingDate, accessionNumber: "some-other-filing", headline: "Test", bullets: [], analystView: "Test", report: "Test", source: "deepseek", generatedAt: "2026-04-21T00:00:00.000Z" } satisfies SecFilingSummary;

  await assert.rejects(
    () => new D1SecRepository(asDatabase(database)).commitFinalPublication(artifact, summary),
    /does not match the filing/,
  );
});

test("serializes ticker Memory leases and prevents an expired worker from overwriting a new owner", async () => {
  const database = createMemoryD1();
  await database.prepare(`
    INSERT INTO sec_memory_jobs (job_id, ticker, filing_id, period_id, status, source_r2_key)
    VALUES (?, ?, ?, ?, 'pending', ?), (?, ?, ?, ?, 'pending', ?)
  `).bind("job-1", issuer, "filing-1", "2026Q1", "source-1", "job-2", issuer, "filing-2", "2026Q2", "source-2").run();
  const repository = new D1SecRepository(database as never);
  const startedAt = new Date("2026-04-21T00:00:00.000Z");
  const first = await repository.claimMemoryJob("job-1", "owner-a", startedAt, 60_000);
  assert.ok(first);
  assert.equal(await repository.claimMemoryJob("job-2", "owner-c", new Date("2026-04-21T00:00:30.000Z"), 60_000), null);
  assert.equal((await database.prepare("SELECT status FROM sec_memory_jobs WHERE job_id = ?").bind("job-2").first<{ status: string }>())?.status, "pending");

  const replacement = await repository.claimMemoryJob("job-1", "owner-b", new Date("2026-04-21T00:01:01.000Z"), 60_000);
  assert.ok(replacement);
  await assert.rejects(() => repository.commitMemoryJob(first!, { candidates: [] }), /ownership changed/);
  const committed = await repository.commitMemoryJob(replacement!, { candidates: [{
    candidateId: "candidate-lease", kind: "fact", topicKey: "backlog", statement: "Backlog expanded.", evidenceIds: ["ev:1"],
    materialityScore: 80, confidence: "high", disposition: "active",
  }] });
  assert.equal(committed.itemCount, 1);
  assert.equal((await database.prepare("SELECT statement FROM sec_memory_items WHERE ticker = ?").bind(issuer).first<{ statement: string }>())?.statement, "Backlog expanded.");
  assert.deepEqual(await repository.commitMemoryJob(replacement!, { candidates: [] }), { noOp: true, itemCount: 0, memoryVersion: 1 });
});

function createMemoryD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE sec_memory_jobs (
      job_id TEXT PRIMARY KEY, ticker TEXT NOT NULL, filing_id TEXT NOT NULL, period_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', source_r2_key TEXT NOT NULL, owner_token TEXT, lease_until TEXT,
      attempt INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT
    );
    CREATE TABLE sec_company_memory_threads (
      ticker TEXT PRIMARY KEY, summary TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT, lease_until TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE sec_memory_extractions (
      extraction_id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, ticker TEXT NOT NULL, period_id TEXT NOT NULL,
      payload TEXT NOT NULL, input_hash TEXT NOT NULL, schema_version TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE sec_memory_items (
      memory_id TEXT PRIMARY KEY, ticker TEXT NOT NULL, module_key TEXT NOT NULL, topic_key TEXT NOT NULL,
      memory_type TEXT NOT NULL, statement TEXT NOT NULL, normalized_value TEXT NOT NULL DEFAULT '{}',
      first_seen_period TEXT NOT NULL, last_confirmed_period TEXT NOT NULL, expected_resolution_period TEXT,
      status TEXT NOT NULL DEFAULT 'active', materiality_score INTEGER NOT NULL DEFAULT 0,
      confidence TEXT NOT NULL DEFAULT 'medium', evidence_ids TEXT NOT NULL DEFAULT '[]', kind TEXT NOT NULL DEFAULT 'fact',
      horizon TEXT, next_test TEXT, falsifier TEXT, due_period TEXT, source_job_ids TEXT NOT NULL DEFAULT '[]',
      normalized_key TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE sec_memory_events (
      event_id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, ticker TEXT NOT NULL, period_id TEXT NOT NULL,
      event_type TEXT NOT NULL, current_statement TEXT, prior_statement TEXT, evidence_ids TEXT NOT NULL DEFAULT '[]',
      job_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  type Bound = { sql: string; values: unknown[]; run(): Promise<unknown>; first<T>(): Promise<T | null>; all<T>(): Promise<{ results: T[] }> };
  const prepare = (sql: string) => ({
    bind(...values: unknown[]): Bound {
      const bound = values as SQLInputValue[];
      return {
        sql,
        values,
        async run() { return sqlite.prepare(sql).run(...bound); },
        async first<T>() { return (sqlite.prepare(sql).get(...bound) as T | undefined) ?? null; },
        async all<T>() { return { results: sqlite.prepare(sql).all(...bound) as T[] }; },
      };
    },
  });
  return {
    prepare,
    async batch(statements: Bound[]) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

test("memory keeps its thread across a reworded topic when the extractor repeats the memoryId", () => {
  const state: MemoryConsolidationState = { ticker: issuer, periodId: "2026Q1", items: [] };
  const first = consolidateMemoryCandidates(state, [{
    candidateId: "candidate-1", kind: "judgment" as const, topicKey: "data-center-guidance", statement: "Data center revenue should keep accelerating.",
    evidenceIds: ["ev:1"], materialityScore: 80, confidence: "high" as const, horizon: "2026Q2",
    nextTest: "Data center revenue grows again", falsifier: "Data center revenue declines", disposition: "active" as const,
  }], "job-1");
  const memoryId = first.items[0].memoryId;

  const reworded = { candidateId: "candidate-2", kind: "judgment" as const, topicKey: "DC 收入指引", statement: "Data center revenue accelerated again.",
    evidenceIds: ["ev:2"], materialityScore: 85, confidence: "high" as const, horizon: "2026Q3",
    nextTest: "Data center revenue grows again", falsifier: "Data center revenue declines", disposition: "active" as const };

  const continued = consolidateMemoryCandidates({ ...state, items: first.items }, [{ ...reworded, memoryId }], "job-2");
  const forked = consolidateMemoryCandidates({ ...state, items: first.items }, [reworded], "job-3");

  assert.equal(continued.items.length, 1);
  assert.equal(continued.items[0].memoryId, memoryId);
  assert.equal(continued.items[0].topicKey, "DC 收入指引");
  assert.equal(continued.items[0].firstSeenPeriod, "2026Q1");
  assert.equal(continued.events[0].eventType, "reaffirmed");

  assert.equal(forked.items.length, 2);
  assert.equal(forked.items.find((item) => item.memoryId === memoryId)?.status, "stale");
});

test("memory extraction keeps a candidate whose memoryId was invented, minus the id", () => {
  const known = new Set(["memory:real"]);
  const candidate = (memoryId: string) => ({
    memoryId, candidateId: "candidate-1", kind: "fact", topicKey: "backlog", statement: "Backlog expanded.",
    evidenceIds: ["ev:1"], materialityScore: 70, confidence: "high", disposition: "active",
  });

  const kept = normalizeMemoryExtraction({ candidates: [candidate("memory:real")] }, new Set(["ev:1"]), known);
  const invented = normalizeMemoryExtraction({ candidates: [candidate("memory:hallucinated")] }, new Set(["ev:1"]), known);
  const unchecked = normalizeMemoryExtraction({ candidates: [candidate("memory:hallucinated")] }, new Set(["ev:1"]));

  assert.equal(kept.candidates[0].memoryId, "memory:real");
  assert.equal(invented.candidates.length, 1);
  assert.equal(invented.candidates[0].memoryId, undefined);
  assert.equal(unchecked.candidates[0].memoryId, "memory:hallucinated");
});

test("Manager repair loop stops at the single round its prompt promises", async () => {
  assert.equal(MAX_REPAIR_ROUNDS, 1);
  const steps: string[] = [];
  const step: WorkflowStepLike = { async do<T>(name: string, callback: () => Promise<T>) { steps.push(name); return callback(); } };
  const plan: SecNodePlan = {
    nodes: [{ id: "growth", title: "Growth", question: "What changed?", sectionIds: ["section-1"], historySeriesIds: [], memoryIds: [], acceptanceCriteria: ["answer"], materiality: "high" }],
    outlineSections: 1,
  };
  let reviews = 0;
  const result = await runManagerRepairLoop("filing-capped", step, plan, [], {
    async review(round) {
      reviews += 1;
      return {
        status: "needs_repair", questions: [{ questionId: "growth", status: "unanswered", explanation: "Still missing" }],
        repairTasks: [{ id: `repair-${round}`, questionId: "growth", targetNodeId: "growth", title: "Growth", question: "What changed?", sectionIds: ["section-1"], keywords: [], historySeriesIds: [], memoryIds: [], acceptanceCriteria: ["answer"], materiality: "high", missingEvidence: ["driver"] }],
        unresolvedQuestions: [`round-${round}`], coverageScore: round / 10, stopReason: null,
      };
    },
    async repair(task, round) {
      return { id: task.targetNodeId, title: task.title, status: "complete", findings: [], narrative: `repair-${round}`, evidence: [] };
    },
  });

  assert.equal(result.rounds, 1);
  assert.equal(reviews, 2);
  assert.equal(result.review.status, "partial");
  assert.equal(result.review.stopReason, "no_progress");
  assert.equal(steps.some((name) => name.includes("round:2")), false);
});
