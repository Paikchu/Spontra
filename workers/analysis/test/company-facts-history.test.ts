import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCompanyFacts } from "../src/sec/history.ts";
import { historyFromRows } from "../src/sec/d1.ts";

const fact = (start: string, end: string, val: number, accn: string, filed: string) => ({ start, end, val, accn, form: "20-F", filed, fp: "FY" });

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
