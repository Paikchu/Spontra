import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCompanyFacts } from "../src/sec/history.ts";
import { historyFromRows } from "../src/sec/d1.ts";
import { refreshSecFundamentals } from "../src/fundamentals/refresh.ts";

const fact = (start: string, end: string, val: number, accn: string, filed: string) => ({ start, end, val, accn, form: "20-F", filed, fp: "FY" });

test("year-end instants retain annual membership and their quarter mirror with the latest 10-Q revision", () => {
  for (const annualForm of ["10-K", "10-K/A", "20-F", "20-F/A"]) {
    const annual = { end: "2025-12-31", val: 100, accn: "annual", form: annualForm, filed: "2026-02-10", fp: "FY" };
    const revised = { end: "2025-12-31", val: 120, accn: "revised", form: "10-Q", filed: "2026-05-05", fp: "Q1" };
    const quarter = { end: "2026-03-31", val: 130, accn: "revised", form: "10-Q", filed: "2026-05-05", fp: "Q1" };
    for (const revisions of [[annual, revised], [revised, annual]]) {
      const cash = normalizeCompanyFacts("TEST", { facts: { "us-gaap": {
        CashAndCashEquivalentsAtCarryingValue: { units: { USD: [...revisions, quarter] } },
      } } }).series.find(s => s.seriesId === "cash")!;
      const point = (o: typeof cash.annual[number]) => [o.endDate, o.value, o.sourceAccession, o.sourceFiledAt];
      assert.deepEqual(cash.annual.map(point), [["2025-12-31", "120", "revised", "2026-05-05"]], annualForm);
      assert.deepEqual(cash.quarters.map(point), [
        ["2026-03-31", "130", "revised", "2026-05-05"],
        ["2025-12-31", "120", "revised", "2026-05-05"],
      ], annualForm);
      assert.notEqual(cash.annual[0]!.observationId, cash.quarters[1]!.observationId);
    }
  }
});

test("an annual backfill does not reuse the identity of a previously stored quarter-only instant", () => {
  const revised = { end: "2025-12-31", val: 120, accn: "revised", form: "10-Q", filed: "2026-05-05" };
  const annual = { ...revised, val: 100, accn: "annual", form: "10-K", filed: "2026-02-10" };
  const cash = (values: unknown[]) => normalizeCompanyFacts("TEST", { facts: { "us-gaap": {
    CashAndCashEquivalentsAtCarryingValue: { units: { USD: values } },
  } } }).series.find(s => s.seriesId === "cash")!;
  // The old normalizer stored the 10-Q winner as a quarter, with this same identity.
  const storedQuarter = cash([revised]).quarters[0]!;
  const rebuilt = cash([annual, revised]);
  assert.notEqual(rebuilt.annual[0]!.observationId, storedQuarter.observationId);
});

test("a bounded fundamentals refresh replaces an affected v6 snapshot even when its latest quarter is unchanged", async () => {
  const facts = { facts: { "us-gaap": {
    CashAndCashEquivalentsAtCarryingValue: { units: { USD: [
      { end: "2025-12-31", val: 100, accn: "annual", form: "10-K", filed: "2026-02-10" },
      { end: "2025-12-31", val: 120, accn: "revised", form: "10-Q", filed: "2026-05-05" },
    ] } },
    Revenues: { units: { USD: [{ start: "2026-01-01", end: "2026-03-31", val: 200, accn: "revised", form: "10-Q", filed: "2026-05-05" }] } },
  } } };
  const old = normalizeCompanyFacts("TEST", facts);
  old.registryVersion = "sec-canonical-series.v6";
  old.series.find(s => s.seriesId === "cash")!.annual = [];
  const writes: Array<{ sql: string; values: unknown[] }> = [];
  const statement = (sql: string, values: unknown[] = []) => ({
    sql, values,
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => {
      if (sql.includes("financial_complete_current")) return { cik: "123", payload: JSON.stringify({ quarters: [{ periodEnd: "2026-03-31", reportedAt: "2026-05-05" }] }) };
      if (sql.includes("FROM sec_cache")) return { payload: JSON.stringify(old), fetchedAt: "2026-05-05T00:00:00Z" };
      throw new Error(`Unexpected query: ${sql}`);
    },
  });
  const db = { prepare: statement, batch: async (batch: typeof writes) => { writes.push(...batch); return []; } } as unknown as D1Database;
  const result = await refreshSecFundamentals({ DB: db, SEC_USER_AGENT: "test" }, "TEST",
    (async () => Response.json(facts)) as typeof fetch, new Date("2026-05-06T00:00:00Z"));
  assert.equal(result.status, "updated");
  const snapshot = writes.find(s => s.sql.includes("INSERT INTO sec_cache"))!;
  const cash = JSON.parse(String(snapshot.values[1])).series.find((s: { seriesId: string }) => s.seriesId === "cash");
  assert.equal(cash.annual[0].value, "120");
  assert.ok(writes.some(s => s.sql.includes("pipeline_outbox") && s.values.includes("fundamentals.updated")));
});

test("a series keeps only the currency its newest filing reports in, so restated comparatives do not mix units", () => {
  // Nebius (formerly Yandex) filed capex in RUB until its 2023 annual report and in USD since; companyfacts keeps both.
  const facts = { facts: { "us-gaap": { PaymentsToAcquirePropertyPlantAndEquipment: { units: {
    RUB: [
      fact("2022-01-01", "2022-12-31", 50544000000, "0001558370-24-005891", "2024-04-26"),
      fact("2023-01-01", "2023-12-31", 90641000000, "0001558370-24-005891", "2024-04-26"),
    ],
    USD: [
      fact("2022-01-01", "2022-12-31", 14600000, "0001558370-25-005991", "2025-04-30"),
      fact("2023-01-01", "2023-12-31", 82900000, "0001104659-26-052948", "2026-04-30"),
      fact("2024-01-01", "2024-12-31", 807500000, "0001104659-26-052948", "2026-04-30"),
      fact("2025-01-01", "2025-12-31", 4066000000, "0001104659-26-052948", "2026-04-30"),
    ],
  } } } } };
  const capex = normalizeCompanyFacts("NBIS", facts).series.find(s => s.seriesId === "capex")!;
  assert.deepEqual(capex.annual.map(o => [o.endDate, o.unit, o.value]), [
    ["2025-12-31", "USD", "4066000000"], ["2024-12-31", "USD", "807500000"], ["2023-12-31", "USD", "82900000"], ["2022-12-31", "USD", "14600000"],
  ]);
});

test("a derived value's id carries its unit, so one derived in RUB and later in USD are stored as two facts", () => {
  const year = (unit: string, ocf: number, capex: number, accn: string, filed: string) => ({ facts: { "us-gaap": {
    NetCashProvidedByUsedInOperatingActivities: { units: { [unit]: [fact("2023-01-01", "2023-12-31", ocf, accn, filed)] } },
    PaymentsToAcquirePropertyPlantAndEquipment: { units: { [unit]: [fact("2023-01-01", "2023-12-31", capex, accn, filed)] } },
  } } });
  const fcf = (facts: unknown) => normalizeCompanyFacts("NBIS", facts).series.find(s => s.seriesId === "free_cash_flow")!.annual[0]!;
  const rub = fcf(year("RUB", 200000000000, 90641000000, "0001558370-24-005891", "2024-04-26"));
  const usd = fcf(year("USD", 300000000, 82900000, "0001104659-26-052948", "2026-04-30"));
  assert.equal(rub.endDate, usd.endDate);
  assert.notEqual(rub.observationId, usd.observationId);
});

test("facts a report stored before the currency changed are read under the same rule", () => {
  const row = (unit: string, value: string, end: string, filed: string) => ({ observationId: `${unit}:${end}`, seriesId: "capex" as const, metricKey: "capex", value, unit, currency: unit === "USD" ? "USD" : "",
    basis: "gaap" as const, startDate: `${end.slice(0, 4)}-01-01`, endDate: end, sourceAccession: "a", sourceFiledAt: filed, sourceVersion: "sec-canonical-series.v4", xbrlConcept: "", derivationFormula: "",
    dimensions: JSON.stringify({ periodScope: "annual" }) });
  const history = historyFromRows([row("USD", "82900000", "2023-12-31", "2026-04-30"), row("RUB", "90641000000", "2023-12-31", "2024-04-26"), row("RUB", "50544000000", "2022-12-31", "2024-04-26")]);
  assert.deepEqual(history.series[0]!.annual.map(o => [o.endDate, o.unit]), [["2023-12-31", "USD"]]);
});
