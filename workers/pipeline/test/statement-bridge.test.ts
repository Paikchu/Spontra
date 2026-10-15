import { test } from "node:test";
import assert from "node:assert/strict";
import type { BusinessFlowQuarter, FlowAmount, PublicBusinessFlow } from "../../../shared/analysis-contract/business-flow.ts";
import { checkCompleteQuarter } from "../../../shared/analysis-runtime/financial-data/completeness.ts";
import { applyStructure, structureFromCalculation, structureFromStatement, structureKey } from "../src/financial-data/bridge.ts";
import { parseIncomeCalculation, type IncomeCalculation } from "../src/financial-data/calculation.ts";
import { bridgePeriods, type Fact } from "../src/financial-data/parser.ts";
import { checkProposal, judgeStructure, statementLines } from "../src/financial-data/presentation.ts";
import { markBasisChanges, restatedConcepts } from "../src/financial-data/restatement.ts";
import { validateRegistry } from "../src/pipeline/registry.ts";

const source = (accession: string, filedAt = "2026-07-31") => ({ url: `https://www.sec.gov/Archives/edgar/data/1/${accession}/doc.htm`, accession, filedAt, cik: "0000000001", industry: "standard" as const });
let order = 0;
const fact = (tag: string, value: number, start = "2026-04-01", end = "2026-06-30", row?: string, accession = "a-new", filedAt?: string): Fact =>
  ({ source: source(accession, filedAt), precision: -6, tag: `us-gaap:${tag}`, value, currency: "USD", start, end, context: `c-${start}-${end}`, dimensions: {}, ...(row ? { statementRow: { order: order++, label: row, flip: false } } : {}) });

// Amazon's statement as its 10-Q for the quarter ended June 30, 2026 declares it (values in millions).
const metaLinks = {
  instance: { "amzn-20260630.htm": {
    report: {
      R2: { role: "http://www.amazon.com/role/ConsolidatedStatementsofCashFlows", shortName: "Consolidated Statements of Cash Flows", groupType: "statement", order: "2" },
      R4: { role: "http://www.amazon.com/role/ConsolidatedStatementsofOperations", shortName: "Consolidated Statements of Operations", groupType: "statement", order: "4" },
    },
    tag: {
      "us-gaap_NetIncomeLoss": { calculation: { "http://www.amazon.com/role/ConsolidatedStatementsofOperations": { root: true }, "http://www.amazon.com/role/ConsolidatedStatementsofCashFlows": { parentTag: "us-gaap_NetCashProvidedByUsedInOperatingActivities", weight: 1, order: 1 } } },
      "us-gaap_IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments": { calculation: { "http://www.amazon.com/role/ConsolidatedStatementsofOperations": { parentTag: "us-gaap_NetIncomeLoss", weight: 1, order: 1 } } },
      "us-gaap_IncomeTaxExpenseBenefit": { calculation: { "http://www.amazon.com/role/ConsolidatedStatementsofOperations": { parentTag: "us-gaap_NetIncomeLoss", weight: -1, order: 2 } } },
      "us-gaap_IncomeLossFromEquityMethodInvestments": { calculation: { "http://www.amazon.com/role/ConsolidatedStatementsofOperations": { parentTag: "us-gaap_NetIncomeLoss", weight: 1, order: 3 } }, lang: { "en-us": { role: { terseLabel: "Equity-method investment activity, net of tax" } } } },
      "us-gaap_OperatingIncomeLoss": { calculation: { "http://www.amazon.com/role/ConsolidatedStatementsofOperations": { parentTag: "us-gaap_IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments", weight: 1, order: 1 } } },
      "us-gaap_NonoperatingIncomeExpense": { calculation: { "http://www.amazon.com/role/ConsolidatedStatementsofOperations": { parentTag: "us-gaap_IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments", weight: 1, order: 2 } } },
    },
  } },
};
const amazon = (scale = 1, start = "2026-04-01", end = "2026-06-30") => {
  const f = (tag: string, v: number, row: string) => fact(tag, v * scale, start, end, row);
  return [f("OperatingIncomeLoss", 27461, "Operating income"), f("NonoperatingIncomeExpense", 53396, "Total non-operating income (expense)"),
    f("IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments", 80857, "Income (loss) before income taxes"),
    f("IncomeTaxExpenseBenefit", 18199, "Provision for income taxes"), f("IncomeLossFromEquityMethodInvestments", -11, "Equity-method investment activity, net of tax"),
    f("NetIncomeLoss", 62647, "Net income (loss)")];
};

test("the income statement's calculation tree is read from MetaLinks, and a combined operations-and-comprehensive statement roots it at net income", () => {
  const calculation = parseIncomeCalculation(metaLinks)!;
  assert.equal(calculation.title, "Consolidated Statements of Operations");
  assert.equal(calculation.root, "us-gaap:NetIncomeLoss");
  assert.equal(calculation.arcs.filter(a => a.parent === "us-gaap:NetIncomeLoss").length, 3);
  assert.equal(calculation.labels["us-gaap:IncomeLossFromEquityMethodInvestments"], "Equity-method investment activity, net of tax");
  const combined = structuredClone(metaLinks) as any;
  const instance = combined.instance["amzn-20260630.htm"];
  instance.report.R4.shortName = "Condensed Consolidated Statements of Operations and Comprehensive Loss";
  for (const tag of Object.values<any>(instance.tag)) { const c = tag.calculation["http://www.amazon.com/role/ConsolidatedStatementsofOperations"]; if (c?.root) { delete c.root; c.parentTag = "us-gaap_ComprehensiveIncomeNetOfTax"; c.weight = 1; c.order = 1; } }
  assert.equal(parseIncomeCalculation(combined)!.root, "us-gaap:NetIncomeLoss");
  assert.equal(parseIncomeCalculation({ instance: { x: { report: {}, tag: {} } } }), null);
});

test("the calculation names pretax income and the lines after taxes, and the reported facts must balance them", () => {
  const calculation = parseIncomeCalculation(metaLinks)!;
  const [period] = bridgePeriods(amazon(1e6));
  const structure = structureFromCalculation(calculation, period.anchors)!;
  assert.equal(structure.pretax, "us-gaap:IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments");
  assert.deepEqual(structure.afterTax, [{ concept: "us-gaap:IncomeLossFromEquityMethodInvestments", weight: 1 }]);
  const resolved = applyStructure(structure, "calculation", period.anchors, period.pick, calculation)!;
  assert.equal(resolved.pretax.value, 80857e6);
  assert.deepEqual(resolved.afterTax.map(a => a.value), [-11e6]);
  // A net income that the lines do not reach is refused, not forced.
  const off = amazon(1e6).map(f => f.tag.endsWith("NetIncomeLoss") ? { ...f, value: 62000e6 } : f);
  const [bad] = bridgePeriods(off);
  assert.equal(applyStructure(structure, "calculation", bad.anchors, bad.pick, calculation), null);
  // Operating income directly beside the taxes leaves "which lines come before taxes" to the statement rows.
  const flat: IncomeCalculation = { role: "r", title: "Statements of Operations", root: "us-gaap:NetIncomeLoss", labels: {}, arcs: [
    { parent: "us-gaap:NetIncomeLoss", child: "us-gaap:OperatingIncomeLoss", weight: 1, order: 1 },
    { parent: "us-gaap:NetIncomeLoss", child: "us-gaap:NonoperatingIncomeExpense", weight: 1, order: 2 },
    { parent: "us-gaap:NetIncomeLoss", child: "us-gaap:IncomeTaxExpenseBenefit", weight: -1, order: 3 }] };
  assert.equal(structureFromCalculation(flat, period.anchors), null);
  assert.equal(structureKey(structure), structureKey({ ...structure, afterTax: [...structure.afterTax] }));
});

test("without a calculation, the statement rows give the same structure, with the sign that balances", () => {
  const facts = amazon(1e6);
  const [period] = bridgePeriods(facts);
  const structure = structureFromStatement(facts, period.anchors)!;
  assert.deepEqual(structure.afterTax, [{ concept: "us-gaap:IncomeLossFromEquityMethodInvestments", weight: 1 }]);
  assert.ok(applyStructure(structure, "statement", period.anchors, period.pick));
  // Nothing printed between taxes and net income: pretax − taxes is net income, and that is the structure.
  const plain = facts.filter(f => !f.tag.endsWith("EquityMethodInvestments") || f.tag.includes("BeforeIncomeTaxes")).map(f => f.tag.endsWith("NetIncomeLoss") ? { ...f, value: 62658e6 } : f);
  const [p2] = bridgePeriods(plain);
  assert.deepEqual(structureFromStatement(plain, p2.anchors)!.afterTax, []);
});

test("a later filing that changed an earlier period's figure marks that line uncompared, and the pair still publishes", () => {
  const facts = [
    fact("Revenues", 100, "2026-01-01", "2026-03-31", undefined, "a-old", "2026-05-01"),
    fact("Revenues", 104, "2026-01-01", "2026-03-31", undefined, "a-new", "2026-08-01"),
    fact("CostOfRevenue", 40, "2026-01-01", "2026-03-31", undefined, "a-old", "2026-05-01"),
    fact("CostOfRevenue", 40, "2026-01-01", "2026-03-31", undefined, "a-new", "2026-08-01"),
  ].map(f => ({ ...f, precision: 0 }));
  const restated = restatedConcepts(facts);
  assert.deepEqual(restated, [{ newer: "a-new", older: "a-old", newerFiledAt: "2026-08-01", concepts: ["Revenues"] }]);
  const amount = (value: number, concept: string, accession: string, key = "k:" + concept): FlowAmount => ({ value: String(value), basis: "reported", definition: concept, comparabilityKey: key, sourceIds: [accession],
    lineage: [{ accession, url: source(accession).url, concept: "us-gaap:" + concept, contextId: "c", periodStart: "", periodEnd: "", dimensions: {}, parserVersion: "t" }] });
  const quarter = (periodEnd: string, accession: string, filedAt: string): BusinessFlowQuarter => ({ id: periodEnd, label: periodEnd, periodStart: null, periodEnd, periodType: "3M", currency: "USD", scale: 1, basisLabel: "", reportedAt: filedAt,
    figures: { revenue: amount(100, "Revenues", accession), cost: amount(40, "CostOfRevenue", accession) }, segments: [], segmentsComplete: false, sources: [{ id: accession, title: accession, url: source(accession).url, publishedAt: filedAt }] });
  const flow: PublicBusinessFlow = { schemaVersion: "business-flow.v1", ticker: "T", fetchedAt: null, quarters: [quarter("2026-06-30", "a-new", "2026-08-01"), quarter("2026-03-31", "a-old", "2026-05-01")] };
  const marked = markBasisChanges(flow, restated);
  assert.deepEqual(marked.quarters[0].basisChanges, ["revenue"]);
  assert.notEqual(marked.quarters[1].figures.revenue!.comparabilityKey, marked.quarters[0].figures.revenue!.comparabilityKey);
  assert.equal(marked.quarters[1].figures.cost!.comparabilityKey, marked.quarters[0].figures.cost!.comparabilityKey);
  assert.equal(marked.quarters[1].figures.revenue!.value, "100");
  assert.equal(markBasisChanges(flow, []), flow);
});

test("lines after taxes close the publication gate's net income check", () => {
  const q = (net: string, after?: string): BusinessFlowQuarter => {
    const a = (value: string, definition: string): FlowAmount => ({ value, basis: "reported", definition, comparabilityKey: "k:" + definition, sourceIds: ["s"], lineage: [{ accession: "s", url: "https://www.sec.gov/x", concept: "c:" + definition, contextId: "c", periodStart: "2026-04-01", periodEnd: "2026-06-30", dimensions: {}, parserVersion: "t" }] });
    return { id: "q", label: "q", periodStart: "2026-04-01", periodEnd: "2026-06-30", periodType: "3M", currency: "USD", scale: 1, basisLabel: "", reportedAt: null, incomeModel: "standard",
      figures: { revenue: a("100", "revenue"), cost: a("40", "cost"), gross: a("60", "gross"), operatingExpenses: a("20", "opex"), operating: a("40", "operating"), other: a("5", "other"), pretax: a("45", "pretax"), tax: a("10", "tax"), net: a(net, "net") },
      segments: [{ id: "s", name: "S", revenue: a("100", "seg"), description: "", products: [], customers: null, monetization: null, disclosure: "", sourceIds: ["s"] }], segmentsComplete: true,
      ...(after ? { afterTaxComponents: [{ id: "equity", name: "Equity-method results", amount: a(after, "equity") }] } : {}), sources: [{ id: "s", title: "s", url: "https://www.sec.gov/x" }] };
  };
  const check = (quarter: BusinessFlowQuarter) => checkCompleteQuarter(quarter).reasons;
  assert.deepEqual(check(q("33", "-2")), []);
  assert.ok(check(q("33")).includes("UNBALANCED_STATEMENT"));
});

test("the judge accepts only a proposal the reported facts balance, after showing the model each imbalance", async () => {
  order = 0;
  const facts = [...amazon(1e6), ...amazon(1e6, "2025-04-01", "2025-06-30").map(f => ({ ...f, value: f.value * 0.5 }))];
  const periods = bridgePeriods(facts), lines = statementLines(periods);
  assert.equal(periods.length, 2);
  assert.deepEqual(checkProposal({ pretax: "us-gaap:Nope", afterTax: [] }, periods, lines), ["us-gaap:Nope is not a line of this statement"]);
  const pretax = "us-gaap:IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments";
  const seen: unknown[] = [];
  const answers = [{ pretax, afterTax: [] }, { pretax, afterTax: [{ concept: "us-gaap:IncomeLossFromEquityMethodInvestments", weight: 1 }] }];
  const judgement = await judgeStructure(facts, { ticker: "AMZN", form: "10-Q", accession: "a-new", reportDate: "2026-06-30" }, async (_stage, _system, payload) => { seen.push(payload); return answers.shift()!; });
  assert.equal(judgement.attempts, 2);
  assert.deepEqual(judgement.structure!.afterTax, [{ concept: "us-gaap:IncomeLossFromEquityMethodInvestments", weight: 1 }]);
  assert.match(JSON.stringify((seen[1] as { previousAnswers: unknown[] }).previousAnswers), /reported net income/);
  const refused = await judgeStructure(facts, { ticker: "AMZN", form: "10-Q", accession: "a-new", reportDate: "2026-06-30" }, async () => ({ pretax, afterTax: [] }), 2);
  assert.equal(refused.structure, null);
  assert.equal(refused.attempts, 2);
  const broke = await judgeStructure(facts, { ticker: "AMZN", form: "10-Q", accession: "a-new", reportDate: "2026-06-30" }, async () => ({ pretax, afterTax: [] }), 3, async () => false);
  assert.deepEqual(broke.issues, ["daily model budget spent"]);
});

test("the event graph stays acyclic with the presentation judge in it", () => {
  assert.deepEqual(validateRegistry(), []);
});
