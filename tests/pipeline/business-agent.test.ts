import assert from "node:assert/strict";
import test from "node:test";

import { runBusinessModelAgent, type BusinessModel } from "../../workers/pipeline/src/company-analysis/business-agent.ts";
import { createBusinessResearchTools, type BusinessResearchTools, type BusinessSource } from "../../workers/pipeline/src/company-analysis/business-tools.ts";
import { COMPANY_ANALYSIS_SCHEMA_VERSION, normalizeCompanyAnalysisPublication, toPublicCompanyAnalysis } from "../../workers/pipeline/src/company-analysis/contracts.ts";
import { ANALYSIS_API_SCHEMAS, validateJsonSchema } from "../../workers/pipeline/src/read-api/contract-support/index.ts";
import type { WebSearchService } from "../../workers/pipeline/src/web-search/service.ts";
import { createAnalysisDatabase } from "./helpers/analysis-backend.ts";
import { VERIFIED_PERIOD_ID, FIXTURE_TICKER, seedAnalysisFixtures } from "./helpers/analysis-fixtures.ts";

const now = "2026-09-25T12:00:00.000Z";
const sec: BusinessSource = { id: "sec-1", title: "Company 10-K", kind: "sec", url: "https://www.sec.gov/example", publishedAt: now, retrievedAt: now };
const web: BusinessSource = { id: "web-1", title: "Investor relations", kind: "web", url: "https://example.com/ir", publishedAt: null, retrievedAt: now };

function tools(): BusinessResearchTools & { actions: string[] } {
  const sources = new Map<string, BusinessSource>();
  const discovered = new Set<string>();
  const actions: string[] = [];
  return {
    actions,
    async availableReports() { return [
      { periodId: "quarter", periodEnd: "2026-06-30", periodScope: "quarter", reportVersion: "v1" },
      { periodId: "annual", periodEnd: "2025-12-31", periodScope: "annual", reportVersion: "v1" },
    ]; },
    async readSecReport(periodId) {
      actions.push(`sec:${periodId}`); sources.set(sec.id, sec);
      return { sourceId: sec.id, observation: { periodId, sourceId: sec.id, revenue: "100 USD in FY2025" } };
    },
    async searchWeb(query) {
      actions.push(`search:${query}`); sources.set(web.id, web); discovered.add(web.url);
      return { sourceId: null, observation: { hits: [{ sourceId: web.id, url: web.url, snippet: "Products and market" }] } };
    },
    async readWeb(url) {
      actions.push(`web:${url}`);
      if (!discovered.has(url)) return { sourceId: null, observation: { error: "Unsearched URL" } };
      return { sourceId: web.id, observation: { sourceId: web.id, text: "Customer uses the product." } };
    },
    sources: () => [...sources.values()],
    restore(snapshot, result) {
      for (const source of snapshot) sources.set(source.id, source);
      const observation = result.observation as { hits?: Array<{ url: string }> };
      for (const hit of observation.hits ?? []) discovered.add(hit.url);
    },
  };
}

const keys = ["business", "mechanics", "revenue", "financials", "industry", "moat", "risks", "investment"];
function model(sourceId = sec.id): BusinessModel {
  return async (stage) => {
    if (stage.startsWith("business-react")) return { action: "finalize" };
    if (stage === "business-evidence-review") return { approved: true, issues: [] };
    return {
      headline: "产品收费方式决定利润与现金流", introduction: "先理解交易和成本，再看财报与行业。",
      sections: keys.map((key) => ({ key, title: key, paragraphs: [{ text: `解释 ${key} 的经营机制。`, sourceIds: [key === "industry" ? web.id : sourceId] }] })),
      limitations: ["某些分部未单独披露。"],
    };
  };
}

test("business Agent researches SEC and web, then publishes sourced operating mechanics", async () => {
  const research = tools();
  const result = await runBusinessModelAgent({
    ticker: "TEST", companyName: "Test Company", reportDate: "2026-06-30", now, tools: research, model: model(),
  });
  assert.deepEqual(research.actions.map((action) => action.split(":")[0]), ["sec", "sec", "search", "web"]);
  assert.equal(result.overview.label, "公司业务拆解");
  assert.equal(result.overview.deepDive?.sections.length, 8);
  assert.deepEqual(result.overview.deepDive?.sources.map((source) => source.id), [sec.id, web.id]);
  assert.equal(result.overview.deepDive?.sections[4]?.paragraphs[0]?.sourceIds[0], web.id);
  const publication = normalizeCompanyAnalysisPublication({
    schemaVersion: COMPANY_ANALYSIS_SCHEMA_VERSION, analysisId: "company:TEST:research", ticker: "TEST",
    triggerRef: "memory-job-01:1", periodId: "quarter", periodEnd: "2026-06-30",
    reportLabel: "截至 2026年6月30日", inputHash: "input-hash-123", memoryVersion: 1,
    fundamentalsDataVersion: "fundamentals-unavailable", status: "ready", coverageStatus: "partial",
    modelVersion: "test-model", promptVersion: "business-deep-dive-react.v1", generatedAt: now,
    overview: result.overview,
  });
  assert.deepEqual(validateJsonSchema(ANALYSIS_API_SCHEMAS.CompanyAnalysis, toPublicCompanyAnalysis(publication)), []);
});

test("business Agent rejects a fabricated citation before publication", async () => {
  await assert.rejects(runBusinessModelAgent({
    ticker: "TEST", companyName: "Test Company", reportDate: "2026-06-30", now, tools: tools(), model: model("fabricated"),
  }), /fabricated citation/i);
});

test("business Agent restores tool evidence when Workflow replays completed steps", async () => {
  const snapshots = new Map<string, unknown>();
  const runStage = async <T>(name: string, callback: () => Promise<T>): Promise<T> => {
    if (snapshots.has(name)) return snapshots.get(name) as T;
    const result = await callback(); snapshots.set(name, result); return result;
  };
  const first = tools();
  const initial = await runBusinessModelAgent({ ticker: "TEST", companyName: "Test Company", reportDate: "2026-06-30", now, tools: first, model: model(), runStage });
  const replay = tools();
  const repeated = await runBusinessModelAgent({ ticker: "TEST", companyName: "Test Company", reportDate: "2026-06-30", now, tools: replay,
    model: async () => { throw new Error("A checkpointed model must not run again"); }, runStage });
  assert.deepEqual(replay.actions, []);
  assert.deepEqual(repeated.overview.deepDive, initial.overview.deepDive);
});

test("SEC adapter only exposes a published report for the requested company and discovered web URLs", async () => {
  const database = await createAnalysisDatabase();
  try {
    await seedAnalysisFixtures(database);
    const search = {
      async search() { return { fetchedAt: now, data: { results: [{ title: "Official IR", url: web.url, snippet: "Test", publishedAt: null }] } }; },
      async fetchContent() { return { fetchedAt: now, data: { text: "Business detail", completeness: "unverified" } }; },
    } as unknown as WebSearchService;
    const adapter = createBusinessResearchTools({ database, search, ticker: FIXTURE_TICKER, reportDate: "2026-06-30", now });
    assert.deepEqual(await adapter.readWeb("https://unsearched.example/secret"), { sourceId: null, observation: { error: "URL was not returned by search" } });
    const reports = await adapter.availableReports();
    assert.ok(reports.some((report) => report.periodId === VERIFIED_PERIOD_ID));
    assert.equal((await adapter.readSecReport("other-company-period")).sourceId, null);
    const filing = await adapter.readSecReport(VERIFIED_PERIOD_ID);
    assert.match(String(filing.sourceId), /^sec-/);
    await adapter.searchWeb("Test company business model");
    assert.equal((await adapter.readWeb(web.url)).sourceId, "web-1");
    assert.equal(adapter.sources().length, 2);
  } finally { database.close(); }
});
