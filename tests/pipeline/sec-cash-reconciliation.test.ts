import assert from "node:assert/strict";
import test from "node:test";
import { reconcileCapitalOutlay } from "../../workers/pipeline/src/sec/cash-reconciliation.ts";
import { assertReaderIntegrity } from "../../workers/pipeline/src/sec/editorial.ts";
import { readerFixture } from "../fixtures/sec-reader-fixture.ts";

const table = (adjustment = "30", net = "230") => `($ in millions)\nCapital Expenditures\n100\n250\nLess: supplier financing\n(10)\n${adjustment}\nLess: customer advances\n(20)\n(50)\nNet Cash Outlay for Capital Expenditures\n70\n${net}\n(1) Notes`;
test("cash reconciliation uses signed cells, not the Less label, and anchors to verified gross capex", () => {
  const r = reconcileCapitalOutlay([{ evidenceId: "ev:table", text: table() }], 250e6, "USD")!;
  assert.equal(r.netCapex, 230e6);
  assert.deepEqual(r.adjustments.map(a => a.value), [30e6, -50e6]);
  assert.equal(reconcileCapitalOutlay([{ evidenceId: "ev:table", text: table() }], 999e6, "USD"), undefined);
});
test("unknown units, truncated or arithmetically inconsistent tables cannot supply a financial value", () => {
  for (const source of [{ text: table("30", "170") }, { text: table(), truncated: true }, { text: table().replace("millions", "thousands") }]) {
    assert.equal(reconcileCapitalOutlay([{ evidenceId: "ev:table", ...source }], 250e6, "USD"), undefined);
  }
});
test("ambiguous matching columns with different adjustments are rejected", () => {
  const text = table().replace("100\n250", "250\n250").replace("70\n230", "220\n230");
  assert.equal(reconcileCapitalOutlay([{ evidenceId: "ev:table", text }], 250e6, "USD"), undefined);
});
test("reader cannot invent a second rendered FCF, reverse a signed adjustment or expose internal IDs", () => {
  const reader = readerFixture();
  reader.sections[0].paragraphs = ["页面已固定并列展示两种FCF。"];
  assert.throws(() => assertReaderIntegrity(reader, { missingMetrics: [], limitations: [] }), /没有第二种/);
  reader.sections[0].paragraphs = ["资本开支扣除0.3亿美元供应链融资。"];
  assert.throws(() => assertReaderIntegrity(reader, { missingMetrics: [], limitations: [], cashBridge: { currency: "USD", period: "quarter", operatingCashFlow: 0, grossCapex: 250e6, standardFCF: -250e6, evidenceIds: [], adjustments: [{ label: "supplier", value: 30e6 }] } }), /正向加回/);
  reader.sections[0].paragraphs = ["requiredTopics中该节点为partial。"];
  assert.throws(() => assertReaderIntegrity(reader, { missingMetrics: [], limitations: [] }), /内部字段/);
});
