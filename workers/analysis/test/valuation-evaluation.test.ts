import assert from "node:assert/strict";
import test from "node:test";
import { readHistoryInput, type HistoryInput } from "../../../shared/analysis-runtime/valuation/history.ts";
import { historicalResearchInput } from "../src/valuation/evaluation.ts";
import { valuationTools } from "../src/valuation/tools.ts";

const snapshot = (): HistoryInput => readHistoryInput({
  schemaVersion: "valuation-history-input.v1", ticker: "TEST", currency: "USD", cutoff: "2025-12-12T21:00:00Z", financialPeriodEnd: "2025-11-30", cutoffPolicy: "completed session after disclosure",
  sources: [
    { id: "filing", kind: "sec_filing", accession: "0000000001-25-000001", url: "https://example.test/filing", availableAt: "2025-12-11T21:00:00Z", path: "filing.txt", sha256: "a".repeat(64) },
    { id: "market", kind: "market_daily", url: "https://example.test/market", availableAt: "2025-12-12T21:00:00Z", path: "market.json", sha256: "b".repeat(64) },
  ],
  facts: [{ id: "revenue_ttm", label: "Revenue", value: 1000, unit: "USD", currency: "USD", periodType: "ttm", periodStart: "2024-12-01", periodEnd: "2025-11-30", basis: "reported", formula: null, sourceRefs: ["filing"], rationale: null }],
  management: null, peers: [], market: {
    quote: { price: 80, priceDate: "2025-12-12", sourceId: "market" }, riskFree: { value: 0.04, date: "2025-12-12", sourceId: "market" }, beta: null,
    series: [{ symbol: "TEST", sourceId: "market", bars: [{ date: "2025-12-12", closeAt: "2025-12-12T21:00:00Z", close: 80, dividend: 0 }] }],
  },
  researchMaterials: [{ sourceId: "filing", title: "Original filing", text: "The company expects quarterly demand to remain stable.", sha256: "c".repeat(64) }], missing: [], limitations: ["No transcript available."],
  outcome: "FUTURE_OUTCOME_MUST_NOT_REACH_RESEARCH",
});

test("the historical research view uses only frozen figures and sources, without current projections or outcome series", () => {
  const input = snapshot(), before = JSON.stringify(input);
  const view = historicalResearchInput(input, "d".repeat(64), "2026-11-03T00:00:00Z");
  assert.equal(view.market.quote?.price, 80);
  assert.equal(view.market.quote?.priceDate, "2025-12-12");
  assert.equal(view.market.quote?.fetchedAt, "2026-11-03T00:00:00Z");
  assert.deepEqual(view.input.facts, input.facts);
  assert.equal(view.sources[0]?.text, input.researchMaterials[0]?.text);
  assert.equal(view.sources[0]?.publishedAt, "2025-12-11T21:00:00Z");
  assert.equal(view.sources[0]?.kind, "sec");
  assert.deepEqual(view.input.documents, []);
  assert.deepEqual(view.input.transcripts, []);
  assert.equal(view.market.multipleHistory, null);
  assert.equal(JSON.stringify(view).includes("FUTURE_OUTCOME"), false);
  assert.equal(JSON.stringify(view).includes('"bars"'), false);
  assert.equal(JSON.stringify(input), before);
});

test("snapshot tools require a known original and a valid next-quarter forecast contract", () => {
  const tools = valuationTools({});
  const forecast = tools.find(t => t.name === "submit_next_quarter_forecast");
  assert.ok(forecast);
  assert.equal(forecast.parameters.safeParse({ status: "available", forecasts: [{ metric: "revenue", value: Infinity, rationale: "A sourced explanation of the next quarter's demand outlook.", evidenceIds: ["e1234567890"] }] }).success, false);
  assert.equal(forecast.parameters.safeParse({ status: "unavailable", reason: "The frozen sources do not establish a quarterly revenue forecast." }).success, true);
  const reader = tools.find(t => t.name === "read_snapshot_source");
  assert.ok(reader);
  assert.equal(reader.parameters.safeParse({ sourceId: "filing", offset: -1, length: 5000 }).success, false);
});
