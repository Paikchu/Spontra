import { test } from "node:test";
import assert from "node:assert/strict";
import type { BusinessFlowQuarter } from "../../../shared/analysis-contract/business-flow.ts";
import type { CapitalQuarter, CashFlowStatement } from "../../../shared/analysis-contract/capital-structure.ts";
import type { AnalysisFinding, FindingsPublication } from "../../../shared/analysis-contract/findings.ts";
import type { LensDocument } from "../../../shared/analysis-contract/lens.ts";
import type { PeersPublication } from "../../../shared/analysis-contract/peers.ts";
import { mergeDossier, readDossierPublication } from "../../../shared/analysis-runtime/dossier.ts";
import { verifyFindings, type FindingData } from "../../../shared/analysis-runtime/findings.ts";
import { divergence, readDecision, renderTable, runAnalyst, salvageDecision } from "../src/analyst/agent.ts";
import { planFinding } from "../src/analyst/plan.ts";
import { buildLedger } from "../src/findings/ledger.ts";
import { lensCatalogue } from "../src/lens/agent.ts";
import type { SecPipelineEnv } from "../src/operations.ts";

const ENDS = ["2024-09-30", "2024-12-31", "2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30"];
const amount = (v: number) => ({ value: String(v), basis: "reported" as const, definition: "", comparabilityKey: null, sourceIds: ["s1"] });
const quarter = (end: string, i: number): BusinessFlowQuarter => ({
  id: end, label: end, periodStart: null, periodEnd: end, periodType: "3M", currency: "USD", scale: 1e6, basisLabel: "", reportedAt: null,
  figures: { revenue: amount(100 + i * 5), cost: amount(40), gross: amount(60), operating: amount(30), net: amount(20) },
  segments: [{ id: "cloud", name: "Cloud", revenue: amount(40 + i * 6), description: "", products: [], customers: null, monetization: null, disclosure: "", sourceIds: ["s1"] }],
  segmentsComplete: true, sources: [{ id: "s1", title: "10-Q", url: "https://www.sec.gov/x", publishedAt: null } as BusinessFlowQuarter["sources"][number]],
});
const source = { accession: "0001", url: "https://www.sec.gov/x", filedAt: "2026-07-30", form: "10-Q" };
const line = (id: string, group: string, value: number, concept = "x") => ({ id, label: id, concept, group, value: String(value) });
const cashFlow = (end: string, i: number): CashFlowStatement => ({
  periodStart: end, periodEnd: end, currency: "USD", basis: "reported",
  operating: { total: "30000000000", lines: [line("da", "nonCash", 5e9, "DepreciationDepletionAndAmortization")] },
  investing: { total: "-40000000000", lines: [line("c", "capex", i >= 4 ? -40e9 : -10e9)] },
  financing: { total: "20000000000", lines: [line("d", "debtIssued", i >= 4 ? 25e9 : 1e9)] }, fxEffect: null, netChange: "0", supplemental: [], sources: [source],
} as CashFlowStatement);
const capitalQuarter = (end: string, i: number): CapitalQuarter => ({ periodEnd: end, cashFlow: cashFlow(end, i), yearToDate: null, balanceSheet: {
  asOf: end, currency: "USD", assets: [line("cash", "cash", 50e9)], liabilities: [line("d", "debt", 20e9 + i * 5e9), line("l", "leases", 9e9)],
  equity: [], totals: { assets: "200000000000", liabilities: "80000000000", equity: "120000000000", currentAssets: null, currentLiabilities: null }, source,
} });
const PERIOD = ENDS.at(-1)!;
const peers: PeersPublication = { schemaVersion: "peers.v1", generatedAt: "2026-08-01T00:00:00Z", companies: [
  { ticker: "TEST", categories: ["cloud_infrastructure"], newestQuarter: PERIOD, quarters: [] },
  { ticker: "PEER1", categories: ["cloud_infrastructure"], newestQuarter: "2026-06-30", quarters: ENDS.map(end => ({ periodEnd: end, accessions: ["p1"], figures: { capex: "4000000000", debt: "9000000000", equity: "30000000000", revenue: "20000000000", operatingCashFlow: "6000000000", netIncome: "4000000000", depreciation: "2000000000" } })) },
  { ticker: "PEER2", categories: ["cloud_infrastructure"], newestQuarter: "2026-06-30", quarters: ENDS.map(end => ({ periodEnd: end, accessions: ["p2"], figures: { capex: "3000000000", debt: "1000000000", equity: "10000000000", revenue: "8000000000", operatingCashFlow: "2000000000", netIncome: "1000000000", depreciation: "1500000000" } })) },
] };
const data: FindingData = { quarters: ENDS.map(quarter), history: null, capital: { schemaVersion: "capital-structure.v1", ticker: "TEST", quarters: ENDS.map(capitalQuarter) }, fundamentals: null, guidance: null, peers };
const finding: AnalysisFinding = {
  id: "capex-gap", kind: "risk", severity: 3, title: "Capex of $160.0 billion outruns operating cash flow",
  judgment: { text: "Capex over the trailing four quarters was $160.0 billion against operating cash flow of $120.0 billion, funded by $100.0 billion of debt issued. The next report should show whether the gap narrows.", sourceIds: ["s1"] },
  evidence: [{ ref: { capital: "capex" }, periodEnd: PERIOD, span: "fiscal_year", compare: "yoy" }, { ref: { capital: "operatingCashFlow" }, periodEnd: PERIOD, span: "fiscal_year" }, { ref: { capital: "debtIssued" }, periodEnd: PERIOD, span: "fiscal_year" }],
  anchors: { view: "cash", nodeIds: ["cloud"], metrics: [], capital: ["capex"] },
  lens: { type: "compare_bars", refs: [{ capital: "operatingCashFlow" }, { capital: "capex" }], span: "fiscal_year" },
  watch: { ref: { capital: "capex" }, condition: "Capex below its year-ago level.", horizon: "next_quarter", compare: "yoy", test: { expect: "below", against: "yoy" } },
};
const publication: FindingsPublication = { schemaVersion: "findings.v1", ticker: "TEST", periodEnd: PERIOD, generatedAt: "2026-07-31T00:00:00Z", model: "test", fingerprint: "fp-1", findings: [finding], sources: [{ id: "s1", title: "10-Q", url: "https://www.sec.gov/x", kind: "sec", publishedAt: null }] };

test("the planner opens the lines the figures justify, deep for a severity-3 finding, and nothing for a watch item", () => {
  const f = verifyFindings(publication, data).verified[0]!;
  const plan = planFinding(f, data, ["PEER1", "PEER2"]);
  assert.equal(plan.tier, "deep");
  const keys = plan.lines.map(l => l.key);
  assert.ok(keys.includes("capital_intensity") && keys.includes("funding_commitments") && keys.includes("peers") && keys.includes("demand_conversion"), keys.join(","));
  assert.ok(plan.lines.length <= 5);
  const light = planFinding({ ...f, kind: "watch" }, data, []);
  assert.equal(light.tier, "light");
  assert.equal(light.budget.turns, 0);
});

test("the divergence table marks the company outside the peer range and names the peers", () => {
  const lines = divergence(data, "TEST", PERIOD);
  assert.match(lines[0]!, /PEER1, PEER2/);
  assert.ok(lines.some(l => l.startsWith("capex / revenue") && l.includes("outside the peer range")));
});

test("the analyst accepts only a document that compiles, applies the review's removals, and its dossier merges onto the findings it was written for", async () => {
  const f = verifyFindings(publication, data).verified[0]!;
  const plan = planFinding(f, data, ["PEER1", "PEER2"]);
  const chart = { id: "c1", aspect: "square" as const, span: "fiscal_year" as const, periods: 4, series: [{ id: "ocf", ref: { capital: "operatingCashFlow" } }, { id: "capex", ref: { capital: "capex" } }], marks: [{ type: "bar" as const, series: ["ocf", "capex"] }] };
  const bad: LensDocument = { rows: [{ cells: [[{ kind: "chart", chart }], [{ kind: "judgment" }, { kind: "figures" }]] }] };
  const good: LensDocument = { rows: [
    { cells: [[{ kind: "chart", chart }], [{ kind: "judgment" }, { kind: "figures" }, { kind: "watch" }]] },
    { title: "Against tracked peers", cells: [[{ kind: "table", table: { columns: "peers", span: "fiscal_year", rows: [{ ref: { capital: "capex" } }, { ref: { capital: "debt" } }] } }], [{ kind: "prose", paragraphs: [{ text: "Both peers spend less than the company does; the gap is funded with $100.0 billion of debt issued.", sourceIds: ["s1"] }, { text: "A sentence the reviewer will take out.", sourceIds: ["s1"] }] }]] },
    { cells: [[{ kind: "sources" }]] },
  ] };
  const seen: string[] = [];
  const model = async (stage: string, _system: string, payload: unknown) => {
    const p = payload as { history?: Array<{ observation: string }> };
    if (stage.endsWith("-review")) return { remove: [{ row: 1, cell: 1, block: 0, reason: "two paragraphs, one claim" }, { row: 0, cell: 1, block: 0, reason: "not allowed" }] };
    seen.push(p.history?.at(-1)?.observation ?? "");
    const n = p.history?.length ?? 0;
    if (n === 0) return { thought: "peers first", action: "peers", input: {} };
    if (n === 1) return { thought: "draft", action: "compile", input: { document: bad } };
    if (n === 2) return { thought: "finish anyway", action: "finish", input: {} };
    if (n === 3) return { thought: "fix", action: "compile", input: { document: good } };
    return { thought: "done", action: "finish", input: {} };
  };
  const ledger = buildLedger(data, PERIOD, publication.sources);
  const outcome = await runAnalyst({ env: { DB: undefined } as unknown as SecPipelineEnv, ticker: "TEST", finding: f, plan, data, catalogue: lensCatalogue(ledger, data, PERIOD), categories: [], documents: [], record: [], model, stage: (_, cb) => cb(), reserveTurn: async () => true, now: "2026-08-01T00:00:00Z" });
  assert.match(seen[1]!, /PEER1/);
  assert.match(seen[2]!, /watch block/);
  assert.match(seen[3]!, /Not accepted/);
  assert.match(seen[4]!, /This document compiles/);
  assert.ok(outcome.document, JSON.stringify(outcome.turns.map(t => [t.action, t.observation.slice(0, 200)])));
  // The review named the prose block and the judgment; only the prose block may go, and its empty cell closes up.
  assert.equal(outcome.document!.rows[1]!.cells.length, 1);
  assert.equal(outcome.document!.rows[0]!.cells[1]![0]!.kind, "judgment");
  assert.equal(outcome.review.length, 1);
  assert.equal(outcome.turns.length, 5);

  const dossier = { schemaVersion: "dossier.v1" as const, ticker: "TEST", findingsFingerprint: "fp-1", fingerprint: "a-1", generatedAt: "2026-08-01T00:00:00Z", model: "test", documents: { "capex-gap": outcome.document! }, materials: [] };
  assert.ok(readDossierPublication(dossier, "TEST"));
  const merged = mergeDossier(publication, dossier);
  assert.equal(merged.findings[0]!.lens.type, "document");
  assert.equal(mergeDossier({ ...publication, fingerprint: "fp-2" }, dossier).findings[0]!.lens.type, "compare_bars");
});

test("a turn is read as the model meant it: stringified input, arguments beside the action, a nested action, or a JSON object inside prose", () => {
  const stringified = readDecision({ thought: "t", action: "read_section", input: JSON.stringify({ documentId: "d1", focus: ["capex"] }) });
  assert.equal(stringified.input.documentId, "d1");
  assert.match(stringified.note!, /JSON string/);
  const beside = readDecision({ thought: "t", action: "read_section", documentId: "d1", sectionId: "s1" });
  assert.deepEqual(beside.input, { documentId: "d1", sectionId: "s1" });
  assert.match(beside.note!, /beside the action/);
  const named = readDecision({ thought: "t", action: "Compile", arguments: { document: { rows: [] } } });
  assert.equal(named.action, "compile");
  assert.ok(named.input.document);
  const nested = readDecision({ thought: "t", action: { name: "peers", input: {} } });
  assert.equal(nested.action, "peers");
  const clean = readDecision({ thought: "t", action: "finish", input: {} });
  assert.equal(clean.note, null);
  const salvaged = salvageDecision('Here is my turn:\n```json\n{"thought":"x","action":"peers","input":{}}\n```');
  assert.equal(salvaged.action, "peers");
  const hopeless = salvageDecision("I cannot decide");
  assert.equal(hopeless.action, "invalid");
  assert.match(readDecision(hopeless).note!, /began: I cannot decide/);
});

test("a filing table is rendered with row indexes, and focus terms keep the matching rows in full", () => {
  const table = { unit: "in millions", columns: ["", "2026", "2025"], rows: Array.from({ length: 40 }, (_, i) => ({ label: i === 30 ? "Capital expenditures" : i === 35 ? "Net cash provided by financing activities" : `Line ${i}`, cells: [{ text: String(i * 10), value: i * 10 }, { text: String(i), value: i }] })) };
  const focused = renderTable(table, ["capital expenditures", "financing activities"]);
  assert.match(focused, /2 matching focus/);
  assert.match(focused, /row 30: Capital expenditures \| 300 \| 30/);
  assert.match(focused, /row 35: Net cash provided by financing activities/);
  assert.match(focused, /other rows: 0:Line 0/);
  assert.ok(!/row 3: Line 3/.test(focused));
  const whole = renderTable(table, []);
  assert.match(whole, /row 39: Line 39/);
  assert.ok(!/other rows/.test(whole));
});
