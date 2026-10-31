import { test } from "node:test";
import assert from "node:assert/strict";
import type { BusinessFlowQuarter, FlowAmount } from "../../../shared/analysis-contract/business-flow.ts";
import type { FindingFundamentals } from "../../../shared/analysis-runtime/findings.ts";
import { nonOperating } from "../src/non-operating.ts";

const URL_Q2 = "https://www.sec.gov/Archives/edgar/data/1652044/000165204426000071/goog-20260630.htm";
const amount = (value: number, concept = "x"): FlowAmount => ({ value: String(value), basis: "reported", definition: concept, comparabilityKey: null, sourceIds: ["0001652044-26-000071"],
  lineage: [{ accession: "0001652044-26-000071", url: URL_Q2, concept, contextId: "c", periodStart: "2026-04-01", periodEnd: "2026-06-30", dimensions: {}, parserVersion: "t" }] });
/** Alphabet's quarter to 2026-06-30 as its 10-Q (0001652044-26-000071) states it, in dollars. */
const quarter = (figures: Record<string, number>, rest: Partial<BusinessFlowQuarter> = {}): BusinessFlowQuarter => ({
  id: "q", label: "Q2 2026", periodStart: "2026-04-01", periodEnd: "2026-06-30", periodType: "3M", currency: "USD", scale: 1, basisLabel: "", reportedAt: null,
  figures: Object.fromEntries(Object.entries(figures).map(([k, v]) => [k, amount(v, k)])), segments: [], segmentsComplete: false,
  sources: [{ id: "0001652044-26-000071", title: "SEC filing", url: URL_Q2 }], ...rest });
const GOOGL_Q2 = { operating: 40_770e6, other: 97_983e6, pretax: 138_753e6, tax: 26_560e6, net: 112_193e6 };
/** The other income (expense) note's lines, from Company Facts for the same quarter. */
const series = (metricKey: string, value: number) => ({ metricKey, label: metricKey, category: "income_statement", unitFamily: "currency", currency: "USD", available: true,
  points: [{ periodEnd: "2026-06-30", valueDecimal: String(value) }] }) as FindingFundamentals["series"][number];
const NOTE: FindingFundamentals = { series: [series("equity_securities_gains", 99_031e6), series("nonoperating_interest_income", 1_430e6), series("nonoperating_interest_expense", 1_278e6), series("foreign_exchange_gains", -160e6)] };

test("R28: GOOGL 2026-06, net income 112.2B against operating income 40.8B, includes a non-operating gain", () => {
  const r = nonOperating(quarter(GOOGL_Q2, { otherComponents: [{ id: "oie", name: "Other income (expense), net", amount: amount(97_983e6) }] }), NOTE)!;
  assert.equal(r.kind, "gain");
  assert.equal(r.amount, 97_983e6);
  assert.deepEqual([r.net, r.operating], [112_193e6, 40_770e6]);
  // The note's lines first, the rest of the statement line as other, taxes alongside.
  assert.deepEqual(r.lines.map(l => [l.kind, Math.round(l.value / 1e6)]), [
    ["equity_securities", 99_031], ["interest_income", 1_430], ["interest_expense", -1_278], ["foreign_exchange", -160], ["other", -1_040], ["tax", -26_560]]);
  // Excluding it, about 33.0B: 112.193B less 97.983B after tax at 26.56 / 138.753 = 19.1%.
  assert.equal(Number(r.taxRate!.toFixed(3)), 0.191);
  assert.equal(Math.round(r.adjusted / 1e8) / 10, 33.0);
  assert.equal(r.sourceUrl, URL_Q2);
});

test("R28: without the note, the statement's own lines; a loss reads as a loss (GOOGL 2026-09)", () => {
  const plain = nonOperating(quarter(GOOGL_Q2, { otherComponents: [{ id: "oie", name: "Other income (expense), net", amount: amount(97_983e6) }] }))!;
  assert.deepEqual(plain.lines.map(l => [l.kind, l.name ?? null]), [["statement", "Other income (expense), net"], ["tax", null]]);
  const q3 = nonOperating(quarter({ operating: 40_576e6, other: -8_221e6, pretax: 32_355e6, tax: 5_887e6, net: 26_468e6 }))!;
  assert.equal(q3.kind, "loss");
  assert.equal(q3.amount, 8_221e6);
  assert.equal(Math.round(q3.adjusted / 1e8) / 10, 33.2);
});

test("R28: no tag within 30% of operating income, or when the gap is the tax rather than non-operating lines", () => {
  // NVIDIA-like: net 82% of operating income.
  assert.equal(nonOperating(quarter({ operating: 36_000e6, other: 1_000e6, pretax: 37_000e6, tax: 6_000e6, net: 31_000e6 })), null);
  // A 40% gap made by tax alone, with other income adding to net income: not a non-operating loss.
  assert.equal(nonOperating(quarter({ operating: 1_000e6, other: 50e6, pretax: 1_050e6, tax: 450e6, net: 600e6 })), null);
  // Equity-method results after tax count with other income.
  const r = nonOperating(quarter({ operating: 1_000e6, other: 0, pretax: 1_000e6, tax: 200e6, net: 1_400e6 }, { afterTaxComponents: [{ id: "eq", name: "Equity in earnings of affiliates", amount: amount(600e6) }] }))!;
  assert.deepEqual([r.kind, r.amount, r.adjusted], ["gain", 600e6, 800e6]);
  assert.equal(nonOperating(quarter({ operating: 0, net: 500e6 })), null);
});
