import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { BusinessFlowQuarter, FlowAmount, PublicBusinessFlow } from "../../../shared/analysis-contract/business-flow.ts";
import type { RevenueHistory } from "../../../shared/analysis-contract/revenue-history.ts";
import { handleMapRead } from "../src/read-api/router.ts";
import { readHomeDigest } from "../src/read-api/home-digest.ts";

function database(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter(name => name.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(file, dir), "utf8").replace(/--> statement-breakpoint/g, ""));
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    run: async () => { sqlite.prepare(sql).run(...values as never[]); return { success: true }; },
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...values as never[]) as T[] }),
    first: async <T>() => (sqlite.prepare(sql).get(...values as never[]) ?? null) as T | null,
  });
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}

const ACC = "0000320193-26-000001";
const FILING = "https://www.sec.gov/Archives/edgar/data/320193/a.htm";

function amount(value: string, start: string, end: string): FlowAmount {
  return {
    value, basis: "reported", definition: "As filed", comparabilityKey: "same", sourceIds: [ACC],
    lineage: [{ accession: ACC, url: FILING, concept: "us-gaap:Revenue", contextId: `c-${end}`, periodStart: start, periodEnd: end, dimensions: {}, parserVersion: "test" }],
  };
}

function quarter(start: string, end: string, revenue: string, operatingExpenses: string, operating: string, other: string, pretax: string, tax: string, net: string): BusinessFlowQuarter {
  return {
    id: end, incomeModel: "direct_operating", label: `Three months ended ${end}`, periodStart: start, periodEnd: end, periodType: "3M",
    currency: "USD", scale: 1, basisLabel: "As filed", reportedAt: "2026-08-07",
    figures: {
      revenue: amount(revenue, start, end), operatingExpenses: amount(operatingExpenses, start, end), operating: amount(operating, start, end),
      other: amount(other, start, end), pretax: amount(pretax, start, end), tax: amount(tax, start, end), net: amount(net, start, end),
    },
    segments: [{ id: "all", name: "All", revenue: amount(revenue, start, end), description: "Consolidated", products: [], customers: null, monetization: null, disclosure: "One segment", sourceIds: [ACC] }],
    segmentsComplete: true,
    expenseComponents: [{ id: "opex", name: "Operating expenses", group: "direct", amount: amount(operatingExpenses, start, end) }],
    otherComponents: [{ id: "other", name: "Other", amount: amount(other, start, end) }],
    sources: [{ id: ACC, title: "10-Q", url: FILING, publishedAt: "2026-08-07" }],
  };
}

function flow(ticker: string): PublicBusinessFlow {
  return {
    schemaVersion: "business-flow.v1", ticker, fetchedAt: "2026-08-07T00:00:00Z",
    quarters: [
      quarter("2026-01-01", "2026-03-31", "100", "40", "60", "5", "65", "15", "50"),
      quarter("2026-04-01", "2026-06-30", "110", "40", "70", "5", "75", "15", "60"),
    ],
  };
}

const history = (ticker: string): RevenueHistory => ({
  schemaVersion: "revenue-history.v1", ticker, updatedAt: "2026-08-07T00:00:00Z",
  quarters: [
    { periodStart: "2025-04-01", periodEnd: "2025-06-30", currency: "USD", scale: 1, revenue: "100", basis: "reported", segments: [{ id: "all", name: "All", value: "100" }], source: { accession: ACC, url: FILING, filedAt: "2025-08-07", form: "10-Q" } },
    { periodStart: "2026-01-01", periodEnd: "2026-03-31", currency: "USD", scale: 1, revenue: "100", basis: "reported", segments: [{ id: "all", name: "All", value: "100" }], source: { accession: ACC, url: FILING, filedAt: "2026-05-07", form: "10-Q" } },
    { periodStart: "2026-04-01", periodEnd: "2026-06-30", currency: "USD", scale: 1, revenue: "110", basis: "reported", segments: [{ id: "all", name: "All", value: "110" }], source: { accession: ACC, url: FILING, filedAt: "2026-08-07", form: "10-Q" } },
  ],
});

const finding = (id: string, kind: "risk" | "strength", severity: 1 | 2 | 3, title: string) => ({
  id, kind, severity, title,
  judgment: { text: "The filing shows a change that is worth a reader's attention this quarter.", sourceIds: ["s1"] },
  evidence: [{ ref: { metric: "revenue" }, periodEnd: "2026-06-30", span: "quarter" }],
  anchors: { view: "profit", nodeIds: [], metrics: ["revenue"] },
  lens: { type: "trend", refs: [{ metric: "revenue" }], span: "quarter" },
});

function findings(ticker: string) {
  return {
    schemaVersion: "findings.v1", ticker, periodEnd: "2026-06-30", generatedAt: "2026-08-07T00:00:00Z", model: "test",
    findings: [finding("f-risk", "risk", 3, "Cloud demand outran capacity"), finding("f-strength", "strength", 1, "Cash stayed ahead of the build")],
    sources: [{ id: "s1", title: "10-Q", url: FILING, kind: "sec", publishedAt: "2026-08-07" }],
  };
}

async function seed(db: D1Database) {
  const insert = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values).run();
  await insert("INSERT INTO financial_complete_versions (version_id, cik, ticker, generation, payload_json, published_at) VALUES ('v-acme', '0000320193', 'ACME', 1, ?, '2026-08-07T13:05:00Z')", JSON.stringify(flow("ACME")));
  await insert("INSERT INTO financial_complete_current (cik, version_id, generation) VALUES ('0000320193', 'v-acme', 1)");
  await insert("INSERT INTO financial_complete_versions (version_id, cik, ticker, generation, payload_json, published_at) VALUES ('v-hide', '0000320194', 'HIDE', 1, ?, '2026-07-01T00:00:00Z')", JSON.stringify(flow("HIDE")));
  await insert("INSERT INTO financial_complete_current (cik, version_id, generation) VALUES ('0000320194', 'v-hide', 1)");
  await insert("INSERT INTO financial_complete_versions (version_id, cik, ticker, generation, payload_json, published_at) VALUES ('v-bad', '0000320195', 'BAD', 1, ?, '2026-07-01T00:00:00Z')", "{");
  await insert("INSERT INTO financial_complete_current (cik, version_id, generation) VALUES ('0000320195', 'v-bad', 1)");
  await insert("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES ('sec:revenue-history:v1:0000320193', ?, '2026-08-07T00:00:00Z')", JSON.stringify(history("ACME")));
  await insert("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES ('findings:v2:ACME', ?, '2026-08-07T00:00:00Z')", JSON.stringify(findings("ACME")));
  await insert("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES ('findings:v2:HIDE', ?, '2026-08-07T00:00:00Z')", JSON.stringify(findings("HIDE")));
  await insert("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES ('admin:financial-issuer:ACME', ?, '2026-08-07T00:00:00Z')", JSON.stringify({ name: "Acme Cloud Inc." }));
  await insert("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES ('i18n:v1:zh-CN:findings:ACME', ?, '2026-08-07T00:00:00Z')", JSON.stringify({ strings: { "Cloud demand outran capacity": "云需求超过产能" } }));
  await insert("INSERT INTO business_feature_settings (ticker, feature, generate, display, updated_at) VALUES ('HIDE', 'findings', 0, 0, '2026-08-01T00:00:00Z')");
}

const env = { SEC_DATA_TICKERS: "ACME,HIDE,WAIT,BAD", SEC_AI_TICKERS: "ACME,HIDE", SEC_AI_ENABLED: "true" };

test("the homepage digest lists covered companies and refuses to invent a missing one", async () => {
  const db = database();
  await seed(db);
  const digest = await readHomeDigest(db, env, null, new Date("2026-10-23T02:00:00Z"), { ACME: { nameZh: "艾克米", aliases: ["ACMECLOUD"], sector: "ai-cloud" } });
  assert.equal(digest.schemaVersion, "home-digest.v1");
  assert.equal(digest.status, "partial");
  assert.equal(digest.generatedAt, "2026-10-23T02:00:00.000Z");
  assert.deepEqual(digest.companies.map(company => company.ticker), ["ACME", "BAD", "HIDE", "WAIT"]);
  assert.equal(digest.companies.some(company => company.ticker === "ZZZZ"), false);

  const acme = digest.companies.find(company => company.ticker === "ACME")!;
  assert.equal(acme.name, "Acme Cloud Inc.");
  assert.equal(acme.nameZh, "艾克米");
  assert.ok(acme.aliases.includes("CLOUD"));
  assert.ok(acme.aliases.includes("ACMECLOUD"));
  assert.equal(acme.sector, "ai-cloud");
  assert.equal(acme.status, "ready");
  assert.deepEqual(acme.latestPeriod, {
    periodEnd: "2026-06-30", periodStart: "2026-04-01", fiscalLabel: "2026 Q2", calendarLabel: "2026 Q2", filedAt: "2026-08-07",
    fiscalYear: null, fiscalQuarter: null, fiscalYearEndMonth: null, labelSource: "unknown",
  });
  assert.equal(acme.revenue?.value, "110");
  assert.equal(acme.revenue?.currency, "USD");
  assert.equal(acme.revenue?.yoyPct, 10);
  assert.equal(acme.revenue?.qoqPct, 10);
  assert.equal(acme.revenueReason, null);
  assert.deepEqual(acme.revenueTrend.map(point => point.periodEnd), ["2025-06-30", "2026-03-31", "2026-06-30"]);
  assert.deepEqual(acme.findingCounts, { risk: 1, strength: 1, shift: 0, watch: 0 });
  assert.equal(acme.topFindings[0]?.title, "Cloud demand outran capacity");
  assert.equal(acme.topFindings.length, 2);

  const hide = digest.companies.find(company => company.ticker === "HIDE")!;
  assert.deepEqual(hide.findingCounts, { risk: 0, strength: 0, shift: 0, watch: 0 });
  assert.deepEqual(hide.topFindings, []);

  const wait = digest.companies.find(company => company.ticker === "WAIT")!;
  assert.equal(wait.status, "preparing");
  assert.equal(wait.revenue, null);
  assert.equal(wait.latestPeriod, null);

  const bad = digest.companies.find(company => company.ticker === "BAD")!;
  assert.equal(bad.status, "preparing");
  assert.equal(bad.revenue, null);
});

test("Chinese titles come from the translation table and nowhere else", async () => {
  const db = database();
  await seed(db);
  const digest = await readHomeDigest(db, env, "zh-CN", new Date("2026-10-23T02:00:00Z"));
  const acme = digest.companies.find(company => company.ticker === "ACME")!;
  assert.equal(acme.topFindings.find(finding => finding.id === "f-risk")?.title, "云需求超过产能");
  assert.equal(acme.topFindings.find(finding => finding.id === "f-strength")?.title, "Cash stayed ahead of the build");
  assert.equal(acme.nameZh, null);
});

test("the read route serves the digest and rejects a stray query", async () => {
  const db = database();
  await seed(db);
  const ok = await handleMapRead(new Request("https://analysis.internal/api/v1/home"), { DB: db, ...env });
  assert.equal(ok.status, 200);
  const body = await ok.json() as { schemaVersion?: string; companies?: Array<{ ticker: string }> };
  assert.equal(body.schemaVersion, "home-digest.v1");
  assert.equal(body.companies?.some(company => company.ticker === "ZZZZ"), false);
  const rejected = await handleMapRead(new Request("https://analysis.internal/api/v1/home?lang=zh-CN"), { DB: db, ...env });
  assert.equal(rejected.status, 404);
});
