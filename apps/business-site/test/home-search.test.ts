import { test } from "node:test";
import assert from "node:assert/strict";
import { searchRows, tickerToOpen, type CatalogCompany } from "../src/home-search.ts";
import { homeLocale, parseHomeDigest, unavailableHome } from "../src/home-model.ts";
import { reasonKeys } from "../src/public-reason.ts";

const catalog: CatalogCompany[] = [
  { ticker: "META", name: "Meta Platforms", nameZh: null, aliases: ["META", "PLATFORMS"] },
  { ticker: "METC", name: "Ramaco Resources", nameZh: null, aliases: ["RAMACO"] },
  { ticker: "NBIS", name: "Nebius Group", nameZh: null, aliases: ["NEBIUS"] },
  { ticker: "TSM", name: "Taiwan Semiconductor", nameZh: "台积电", aliases: ["TAIWAN", "SEMICONDUCTOR"] },
  ...Array.from({ length: 8 }, (_, i) => ({ ticker: `M${i}`, name: `Match ${i}`, nameZh: null, aliases: ["MATCH"] })),
];

test("search ranks an exact ticker ahead of a prefix and matches a name", () => {
  const meta = searchRows("met", catalog, [], [], "ready").filter(row => row.kind === "company");
  assert.equal(meta[0] && meta[0].kind === "company" && meta[0].ticker, "META");
  assert.equal(meta[1] && meta[1].kind === "company" && meta[1].ticker, "METC");
  const exact = searchRows("meta", catalog, [], [], "ready").filter(row => row.kind === "company");
  assert.equal(exact[0] && exact[0].kind === "company" && exact[0].ticker, "META");
  const nebius = searchRows("Nebius", catalog, [], [], "ready");
  assert.equal(nebius[0] && nebius[0].kind === "company" && nebius[0].ticker, "NBIS");
  const tsm = searchRows("台积电", catalog, [], [], "ready");
  assert.equal(tsm[0] && tsm[0].kind === "company" && tsm[0].ticker, "TSM");
  assert.ok(searchRows("MATCH", catalog, [], [], "ready").filter(row => row.kind === "company").length <= 8);
});

test("an unknown ticker is not covered and cannot open a company page", () => {
  const rows = searchRows("ZZZZ", catalog, ["ACME"], [], "ready");
  assert.deepEqual(rows, [{ kind: "uncovered", ticker: "ZZZZ" }]);
  assert.equal(tickerToOpen(rows[0]), null);
  assert.equal(tickerToOpen(undefined), null);
  assert.deepEqual(searchRows("!!!", catalog, [], [], "ready"), [{ kind: "status", status: "invalid" }]);
});

test("a catalog that is still loading does not call a typed ticker uncovered", () => {
  const rows = searchRows("ZZZZ", catalog, ["ACME", "MSFT"], [], "loading");
  assert.equal(rows.at(-1)?.kind === "status" && rows.at(-1)?.status, "loading");
  assert.equal(rows.some(row => row.kind === "uncovered"), false);
  assert.equal(tickerToOpen(rows.find(row => row.kind === "company")), null);
  const remembered = searchRows("AC", [], ["ACME"], [], "loading");
  assert.equal(remembered[0] && remembered[0].kind === "company" && remembered[0].ticker, "ACME");
  assert.equal(tickerToOpen(remembered[0]), "ACME");
});

test("an empty query keeps five recent companies and does not repeat them as popular", () => {
  const extra: CatalogCompany[] = ["CRWV", "TTMI", "ORCL", "AAPL"].map(ticker => ({ ticker, name: ticker, nameZh: null, aliases: [] }));
  const recent = ["NBIS", "META", "TSM", "CRWV", "TTMI", "ORCL"];
  const rows = searchRows("", [...catalog, ...extra], recent, ["NBIS", "META", "AAPL"], "ready");
  const companies = rows.filter(row => row.kind === "company");
  assert.equal(companies.filter(row => row.kind === "company" && row.group === "recent").length, 5);
  assert.equal(companies.some(row => row.kind === "company" && row.ticker === "ORCL"), false);
  assert.equal(companies.some(row => row.kind === "company" && row.group === "popular" && row.ticker === "AAPL"), true);
  assert.equal(companies.some(row => row.kind === "company" && row.group === "popular" && row.ticker === "NBIS"), false);
});

test("the homepage body is accepted only when it matches the digest", () => {
  const company = {
    ticker: "ACME", name: "Acme", nameZh: null, aliases: [], sector: null, status: "ready",
    latestPeriod: { periodEnd: "2026-06-30", fiscalLabel: "2026 Q2", filedAt: null },
    revenue: { value: "110", currency: "USD", yoyPct: 10, qoqPct: null }, revenueReason: "MISSING_TWO_QUARTERS",
    revenueTrend: [{ periodEnd: "2026-06-30", value: "110" }],
    findingCounts: { risk: 1, strength: 0, shift: 0, watch: 0 },
    topFindings: [{ id: "f", kind: "risk", severity: 2, title: "Demand", periodEnd: "2026-06-30" }],
  };
  const body = { schemaVersion: "home-digest.v1", status: "ready", generatedAt: "2026-08-07T00:00:00Z", coverage: { count: 1, lastUpdatedAt: null }, companies: [company], popular: ["ACME"] };
  assert.equal(parseHomeDigest(body)?.companies[0]?.ticker, "ACME");
  assert.equal(parseHomeDigest({ ...body, status: "unavailable" }), null);
  assert.equal(parseHomeDigest({ ...body, coverage: { count: 2, lastUpdatedAt: null } }), null);
  assert.equal(parseHomeDigest({ ...body, companies: [{ ...company, ticker: "not a ticker" }] }), null);
  assert.equal(unavailableHome("2026-08-07T00:00:00Z").status, "unavailable");
  assert.equal(homeLocale(new URLSearchParams("lang=zh-CN")), "zh-CN");
  assert.equal(homeLocale(new URLSearchParams("lang=en")), null);
  assert.equal(homeLocale(new URLSearchParams("lang=zh-CN&rev=1")), "reject");
  assert.equal(homeLocale(new URLSearchParams("locale=zh-CN")), "reject");
});

test("a company page never echoes a machine reason code", () => {
  const keys = reasonKeys(["MISSING_TWO_QUARTERS", "NOT_A_CODE", "MISSING_TWO_QUARTERS"]);
  assert.deepEqual(keys, ["missingQuarters", "unavailable"]);
  assert.equal(JSON.stringify(keys).includes("MISSING_TWO_QUARTERS"), false);
  assert.deepEqual(reasonKeys([]), ["unavailable"]);
});
