import assert from "node:assert/strict";
import test from "node:test";
import type { HomeCompany, HomeFinding, HomeFindingKind } from "../../../shared/analysis-contract/home.ts";
import { worthWatching } from "../src/worth-watching.ts";

function finding(id: string, kind: HomeFindingKind, severity: 1 | 2 | 3, periodEnd: string): HomeFinding {
  return { id, kind, severity, title: id, periodEnd };
}

function company(ticker: string, findings: HomeFinding[], counts?: Partial<HomeCompany["findingCounts"]>): HomeCompany {
  const base = { risk: 0, strength: 0, shift: 0, watch: 0, ...counts };
  for (const item of findings) base[item.kind] = Math.max(base[item.kind], 1);
  return {
    ticker, name: ticker, nameZh: null, aliases: [], sector: null, status: "ready", latestPeriod: null,
    revenue: null, revenueReason: null, revenueTrend: [], findingCounts: base, topFindings: findings,
  };
}

test("six or more companies produce six cards from six companies", () => {
  const companies = ["META", "ORCL", "AMZN", "NVDA", "AAPL", "MSFT", "GOOGL"].map((ticker, index) => company(ticker, [
    finding(`${ticker}-a`, "risk", index === 0 ? 3 : 2, "2026-06-30"),
    finding(`${ticker}-b`, "risk", 1, "2026-03-31"),
  ], { risk: 4 }));
  const cards = worthWatching(companies, "all");
  assert.equal(cards.length, 6);
  assert.equal(new Set(cards.map(card => card.company.ticker)).size, 6);
  assert.deepEqual(cards.map(card => card.finding.id), ["META-a", "AAPL-a", "AMZN-a", "GOOGL-a", "MSFT-a", "NVDA-a"]);
  assert.equal(cards.every(card => card.extra === 3), true);
});

test("five companies fill the sixth card with a second finding after every first", () => {
  const companies = ["META", "ORCL", "AMZN", "NVDA", "AAPL"].map(ticker => company(ticker, [
    finding(`${ticker}-a`, "risk", ticker === "META" ? 3 : 2, "2026-06-30"),
    finding(`${ticker}-b`, "strength", ticker === "ORCL" ? 2 : 1, "2026-06-30"),
  ], { risk: 2, strength: 2 }));
  const cards = worthWatching(companies, "all");
  assert.equal(cards.length, 6);
  assert.equal(new Set(cards.slice(0, 5).map(card => card.company.ticker)).size, 5);
  assert.equal(cards[5]?.finding.id, "ORCL-b");
  assert.equal(cards.slice(0, 5).every(card => card.finding.id.endsWith("-a")), true);
});

test("a filter keeps the same one-company-first rule and can be empty", () => {
  const companies = [
    company("META", [finding("m-risk", "risk", 3, "2026-06-30"), finding("m-shift", "shift", 2, "2026-06-30")], { risk: 3, shift: 1 }),
    company("ORCL", [finding("o-risk", "risk", 2, "2026-05-31"), finding("o-old", "risk", 1, "2026-01-31")], { risk: 2 }),
    company("AMZN", [finding("a-strength", "strength", 3, "2026-06-30")], { strength: 1 }),
  ];
  const risks = worthWatching(companies, "risk");
  assert.deepEqual(risks.map(card => card.finding.id), ["m-risk", "o-risk", "o-old"]);
  assert.equal(risks[0]?.extra, 2);
  assert.equal(risks[1]?.extra, 1);
  assert.deepEqual(worthWatching(companies, "strength").map(card => card.finding.id), ["a-strength"]);
  assert.equal(worthWatching(companies, "strength")[0]?.extra, 0);
  assert.deepEqual(worthWatching(companies, "shift").map(card => card.company.ticker), ["META"]);
  assert.deepEqual(worthWatching([company("NET", [], {})], "all"), []);
});

test("the newest period breaks a severity tie, then the ticker", () => {
  const cards = worthWatching([
    company("MSFT", [finding("msft", "shift", 2, "2026-03-31")]),
    company("AAPL", [finding("aapl", "shift", 2, "2026-06-30")]),
    company("NVDA", [finding("nvda", "shift", 2, "2026-06-30")]),
  ], "shift");
  assert.deepEqual(cards.map(card => card.company.ticker), ["AAPL", "NVDA", "MSFT"]);
});
