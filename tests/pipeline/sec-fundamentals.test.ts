import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCompanyFacts } from "../../workers/pipeline/src/sec/history.ts";
import { buildSecFundamentals, getSecFundamentals } from "../../workers/pipeline/src/fundamentals/sec-fundamentals.ts";
import { createSecPipelineOperations, type SecPipelineEnv } from "../../workers/pipeline/src/operations.ts";
import { D1SecRepository } from "../../workers/pipeline/src/sec/d1.ts";
import { createAnalysisDatabase, readEnv } from "./helpers/analysis-backend.ts";
import { ANALYSIS_API_SCHEMAS, validateJsonSchema } from "../../workers/pipeline/src/read-api/contract-support/index.ts";
import type { SecFiling } from "../../workers/pipeline/src/sec/sec.ts";

const query = { ticker: "MSFT", periodCount: 5, metricKeys: null };
const filing: SecFiling = {
  ticker: "MSFT", cik: "0000789019", cikNumber: 789019, companyName: "Microsoft", form: "10-K",
  filingDate: "2026-02-01", reportDate: "2025-12-31", accessionNumber: "0000789019-26-000001",
  primaryDocument: "report.htm", description: "Annual", items: "",
  documentUrl: "https://www.sec.gov/report.htm", indexUrl: "https://www.sec.gov/index.htm",
};

function payload(annualRevenue = 1000) {
  const duration = (values: number[]) => values.map((val, index) => ({ start: "2025-01-01",
    end: ["2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31"][index], val,
    form: index === 3 ? "10-K" : "10-Q", accn: filing.accessionNumber, filed: "2026-02-01" }));
  return { facts: { "us-gaap": {
    Revenues: { units: { USD: duration([100, 300, 600, annualRevenue]) } },
    GrossProfit: { units: { USD: duration([40, 120, 240, 400]) } },
    NetCashProvidedByUsedInOperatingActivities: { units: { USD: duration([30, 80, 140, 230]) } },
    PaymentsToAcquirePropertyPlantAndEquipment: { units: { USD: duration([10, 30, 60, 100]) } },
    EarningsPerShareDiluted: { units: { "USD/shares": duration([1, 3, 6, 10]) } },
    CashAndCashEquivalentsAtCarryingValue: { units: { USD: [{ end: "2025-12-31", val: 55, form: "10-K", accn: filing.accessionNumber, filed: "2026-02-01" }] } },
  } } };
}

test("SEC quarters derive Q4 and FCF, scale margins, retain provenance, and never subtract EPS", async () => {
  const result = await buildSecFundamentals(normalizeCompanyFacts("MSFT", payload()), query, "2026-02-02T00:00:00Z", new Date("2026-02-02T01:00:00Z"));
  const point = (key: string) => result.series.find((series) => series.metricKey === key)?.points.at(-1);
  assert.equal(result.source, "sec_xbrl");
  assert.equal(result.periods.length, 4);
  assert.equal(point("total_revenue")?.valueDecimal, "400");
  assert.equal(point("operating_cash_flow")?.valueDecimal, "90");
  assert.equal(point("free_cash_flow")?.valueDecimal, "50");
  assert.equal(point("gross_margin")?.valueDecimal, "40");
  assert.equal(point("cash_and_cash_equivalents")?.valueDecimal, "55");
  assert.equal(point("diluted_eps")?.valueDecimal, null);
  assert.equal(point("total_revenue")?.sourceAccession, filing.accessionNumber);
  assert.match(point("total_revenue")?.derivationFormula ?? "", /2025-09-30/);
  assert.equal(result.stale, false);
  assert.deepEqual(validateJsonSchema(ANALYSIS_API_SCHEMAS.Fundamentals, result), []);
});

test("discovery updates SEC metrics, retries delayed data, and preserves the last good snapshot on failure", async () => {
  const database = await createAnalysisDatabase();
  try {
    const env: SecPipelineEnv = { ...readEnv(database), SEC_REFRESH_KEY: "test", SEC_USER_AGENT: "test@example.com",
      SEC_TRACKED_TICKERS: "MSFT", SEC_ANALYSIS_WORKFLOW: { async create() { return { id: "test" }; } },
      SEC_FILINGS: { async get() { return null; }, async put() {} } };
    let mode = "initial";
    let calls = 0;
    const operations = createSecPipelineOperations(env, async (input) => {
      assert.match(String(input), /companyfacts\/CIK0000789019.json/);
      calls++;
      return mode === "failed" ? new Response("Unavailable", { status: 503 })
        : Response.json(mode === "empty" ? { facts: {} } : payload(mode === "updated" ? 1100 : 1000));
    });
    const feed = { ticker: "MSFT", company: { ticker: "MSFT", name: "Microsoft", cik: filing.cik }, filings: [filing], fetchedAt: "2026-02-02T00:00:00Z" };
    // Existing D1 facts are usable before the first snapshot refresh.
    await new D1SecRepository(database).saveHistory(filing, normalizeCompanyFacts("MSFT", payload()));
    assert.equal((await getSecFundamentals(database, query)).status, "ready");
    await operations.publishFeed(feed);
    const first = await getSecFundamentals(database, query);
    mode = "updated";
    await operations.publishFeed(feed);
    const updated = await getSecFundamentals(database, query);
    assert.notEqual(updated.dataVersion, first.dataVersion);
    assert.equal(updated.series.find((series) => series.metricKey === "total_revenue")?.points.at(-1)?.valueDecimal, "500");
    for (mode of ["failed", "empty"]) {
      await operations.publishFeed(feed);
      assert.deepEqual(await getSecFundamentals(database, query), updated);
    }
    assert.equal(calls, 4, "Unchanged filing indexes still retry Company Facts");
  } finally { database.close(); }
});

test("missing nine-month cash flow and incompatible currencies remain missing, never zero or false ratios", async () => {
  const raw = payload();
  const facts = raw.facts["us-gaap"];
  facts.NetCashProvidedByUsedInOperatingActivities.units.USD.splice(2, 1);
  const mixed = { facts: { "us-gaap": { ...facts, GrossProfit: { units: { EUR: facts.GrossProfit.units.USD } } } } };
  const result = await buildSecFundamentals(normalizeCompanyFacts("MSFT", mixed), query, null);
  assert.equal(result.series.find((series) => series.metricKey === "operating_cash_flow")?.points.at(-1)?.valueDecimal, null);
  assert.equal(result.series.find((series) => series.metricKey === "gross_margin")?.available, false);
  assert.equal(result.partial, true);
  assert.equal(result.stale, true);
});
