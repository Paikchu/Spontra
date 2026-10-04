import assert from "node:assert/strict";
import test from "node:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createAnalysisDatabase } from "./helpers/analysis-backend.ts";
import { listFinancialCompanies, getFinancialCompany } from "../../workers/pipeline/src/admin/financials.ts";
import { readCompletePublicationForTicker } from "../../workers/pipeline/src/financial-data/publication.ts";
import { historyFromSnapshot } from "../../shared/analysis-runtime/financial-data/history.ts";
import { completeOrclFixture } from "../fixtures/complete-orcl-flow.ts";
import type { SecPipelineEnv } from "../../workers/pipeline/src/operations.ts";

// Native SQLite permits compound SELECTs that workerd D1 rejects. Exercise the actual D1
// binding as well as the existing SQLite suite so a passing local query cannot hide this outage.
test("financial company reads work within real D1 SQL limits", async (t) => {
  const miniflare = new Miniflare(convertV4MiniflareOptions({
    name: "financial-d1-regression", compatibilityDate: "2026-08-28", modules: true,
    script: "export default { fetch() { return new Response('test'); } }",
    d1Databases: { DB: "financial-d1-regression" },
  }));
  t.after(() => miniflare.dispose());
  const db = await miniflare.getD1Database("DB") as unknown as D1Database;
  const migrated = await createAnalysisDatabase();
  try {
    // Copy the schema produced by every real migration; data and queries execute in workerd.
    for (const row of migrated.raw.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all()) {
      await db.prepare(row.sql as string).run();
    }
  } finally { migrated.close(); }

  const cik = "0001341439", publishedAt = "2026-09-15T00:00:00.000Z";
  const cache = (key: string, value: unknown) => db.prepare("INSERT INTO sec_cache(cache_key,payload,fetched_at) VALUES(?,?,?)")
    .bind(key, JSON.stringify(value), publishedAt).run();
  await db.prepare("INSERT INTO financial_complete_versions VALUES(?,?,?,?,?,?)")
    .bind("published", cik, "ORCL", 1, JSON.stringify(completeOrclFixture), publishedAt).run();
  await db.prepare("INSERT INTO financial_complete_current VALUES(?,?,?)").bind(cik, "published", 1).run();
  const documentId = "a".repeat(64);
  await cache(`sec:disclosure-audit:v1:TABLES:${documentId}`, {
    ticker: "TABLES", documentId, source: { ticker: "TABLES", form: "10-Q", reportDate: "2026-08-31" },
    archivedAt: publishedAt, statements: { status: "extracted", tables: 3 },
  });
  await cache("sec:revenue-history:v1:0000000001", "invalid history");

  await t.test("list and detail retain successfully obtained data and statement-only companies", async () => {
    const env = { DB: db, SEC_DATA_TICKERS: "ORCL", SEC_TRACKED_TICKERS: "MSFT" } as SecPipelineEnv;
    const list = await listFinancialCompanies(env);
    assert.deepEqual(list.companies.map(company => company.ticker), ["MSFT", "ORCL", "TABLES"]);
    for (const ticker of ["ORCL", "TABLES"]) {
      const company = list.companies.find(item => item.ticker === ticker)!;
      assert.equal(company.latestPeriodEnd, "2026-08-31");
      assert.equal(company.lastUpdatedAt, publishedAt);
      const detail = await getFinancialCompany(env, ticker);
      assert.deepEqual(detail.company, company);
      if (ticker === "ORCL") assert.ok(detail.periods[0]!.metrics.some(metric => metric.value !== null));
      else assert.deepEqual(detail.periods, []);
    }
  });

  await t.test("issuer fallbacks preserve source priority, generation order and share-class validation", async () => {
    await db.prepare(`INSERT INTO financial_collection_jobs(job_id,cik,ticker,generation,status,next_attempt_at,updated_at)
      VALUES(?,?,?,?,?,?,?)`).bind("older", "0000000002", "ORCL", 1, "succeeded", publishedAt, publishedAt).run();
    await db.prepare(`INSERT INTO financial_collection_jobs(job_id,cik,ticker,generation,status,next_attempt_at,updated_at)
      VALUES(?,?,?,?,?,?,?)`).bind("newer", cik, "ORCL", 2, "succeeded", publishedAt, publishedAt).run();
    assert.equal((await readCompletePublicationForTicker(db, "ORCL")).status, "ready");
    await db.prepare("DELETE FROM financial_collection_jobs").run();
    assert.equal((await readCompletePublicationForTicker(db, "ORCL")).status, "ready");

    await cache(`sec:revenue-history:v1:${cik}`, { schemaVersion: "revenue-history.v1", ticker: "ORCL.A", updatedAt: publishedAt,
      quarters: [historyFromSnapshot(completeOrclFixture.quarters[0])!] });
    // Lower-priority identity must not replace the validated history issuer.
    await cache("admin:financial-issuer:ORCL.A", { cik: "0000000003" });
    await cache("admin:financial-issuer:ORCL.B", { cik });
    await cache("sec:filings:ORCL.B", { company: { cik: "0000000003" } });
    await cache("admin:financial-issuer:ORCL.C", {});
    await cache("sec:filings:ORCL.C", { company: { cik } });
    await db.prepare(`INSERT INTO sec_filings(filing_id,ticker,accession_number,cik,form,filing_date,report_date,document_url,index_url)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind("alias-filing", "ORCL.D", "alias-filing", cik, "10-Q", "2026-09-15", "2026-08-31",
        "https://www.sec.gov/Archives/edgar/data/1341439/report.htm", "https://www.sec.gov/Archives/edgar/data/1341439/index.htm").run();
    for (const ticker of ["ORCL.A", "ORCL.B", "ORCL.C", "ORCL.D"]) {
      const publication = await readCompletePublicationForTicker(db, ticker);
      assert.equal(publication.status, "ready", ticker);
      assert.equal(publication.flow!.ticker, ticker);
      assert.deepEqual(publication.flow!.quarters, JSON.parse(JSON.stringify(completeOrclFixture.quarters)));
    }
    const missing = await readCompletePublicationForTicker(db, "UNKNOWN");
    assert.equal(missing.status, "preparing");
    assert.equal(missing.flow, null);
  });
});
