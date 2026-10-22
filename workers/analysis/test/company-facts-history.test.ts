import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCompanyFacts } from "../src/sec/history.ts";

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
