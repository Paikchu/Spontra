import { test } from "node:test";
import assert from "node:assert/strict";
import type { BusinessFlowQuarter } from "../../../shared/analysis-contract/business-flow.ts";
import type { CapitalQuarter, CashFlowStatement } from "../../../shared/analysis-contract/capital-structure.ts";
import type { AnalysisFinding, FindingsPublication } from "../../../shared/analysis-contract/findings.ts";
import type { LensDocument } from "../../../shared/analysis-contract/lens.ts";
import type { PeersPublication } from "../../../shared/analysis-contract/peers.ts";
import { mergeDossier, readDossierPublication } from "../../../shared/analysis-runtime/dossier.ts";
import { verifyFindings, type FindingData } from "../../../shared/analysis-runtime/findings.ts";
import { ANALYST_TOOLS, divergence, renderTable, runAnalyst, type AnalystModel } from "../src/analyst/agent.ts";
import { planFinding } from "../src/analyst/plan.ts";
import { buildLedger } from "../src/findings/ledger.ts";
import { lensCatalogue } from "../src/lens/agent.ts";
import type { SecPipelineEnv } from "../src/operations.ts";
import type { AgentBlock, AgentMessage, AgentReply } from "../src/tool-loop.ts";

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

let ids = 0;
/** A reply calling the given tools, as the Messages API returns it. */
const calls = (...list: Array<[string, unknown]>): AgentReply => ({ stopReason: "tool_use", content: list.map(([name, input]) => ({ type: "tool_use", id: `toolu_${++ids}`, name, input })) });
const call = (name: string, input: unknown = {}) => calls([name, input]);
/** The last tool result the harness sent, or "" for the opening. */
const lastResult = (messages: AgentMessage[]) => { const content = messages.at(-1)!.content; return Array.isArray(content) ? String(content.at(-1)?.content ?? "") : ""; };
/**
 * What every request of the loop must be: the exchange extends the one before it, user and assistant turns alternate from
 * a user opening to a user turn, no turn carries a written thought or a packed history, and the prompt never asks for reasoning.
 */
function assertConversation(sent: AgentMessage[][], systems: string[]) {
  for (const [i, messages] of sent.entries()) {
    if (i) assert.deepEqual(messages.slice(0, sent[i - 1]!.length), sent[i - 1], `request ${i + 1} rewrote the exchange`);
    messages.forEach((m, k) => assert.equal(m.role, k % 2 ? "assistant" : "user", `request ${i + 1}, turn ${k + 1}`));
    assert.equal(messages.at(-1)!.role, "user");
    for (const m of messages) assert.doesNotMatch(typeof m.content === "string" ? m.content : JSON.stringify(m.content), /"thought"|"history"/);
  }
  for (const system of systems) assert.doesNotMatch(system, /thought|think|reasoning|explain your|Return only JSON|history/i);
}

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
  const seen: string[] = [], sent: AgentMessage[][] = [], systems: string[] = [];
  const replies = [call("peers"), call("compile", { document: bad }), call("finish"), call("compile", { document: good }), call("finish")];
  const model: AnalystModel = {
    act: async (_stage, system, tools, messages) => {
      assert.equal(tools, ANALYST_TOOLS);
      sent.push(structuredClone(messages)); systems.push(system); seen.push(lastResult(messages));
      return replies[sent.length - 1] ?? call("finish");
    },
    judge: async () => ({ remove: [{ row: 1, cell: 1, block: 0, reason: "two paragraphs, one claim" }, { row: 0, cell: 1, block: 0, reason: "not allowed" }] }),
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
  assertConversation(sent, systems);
  assert.match(sent[0]![0]!.content as string, /"subject":\{"id":"capex-gap"/);
  assert.match(seen[1]!, /Budget left: \d+ turns/);

  const dossier = { schemaVersion: "dossier.v1" as const, ticker: "TEST", findingsFingerprint: "fp-1", fingerprint: "a-1", generatedAt: "2026-08-01T00:00:00Z", model: "test", documents: { "capex-gap": outcome.document! }, materials: [] };
  assert.ok(readDossierPublication(dossier, "TEST"));
  const merged = mergeDossier(publication, dossier);
  assert.equal(merged.findings[0]!.lens.type, "document");
  assert.equal(mergeDossier({ ...publication, fingerprint: "fp-2" }, dossier).findings[0]!.lens.type, "compare_bars");
});

test("the research tools are strict and closed; compile and finish take an open document the harness checks", () => {
  assert.deepEqual(ANALYST_TOOLS.map(t => t.name), ["find_sections", "read_section", "peers", "search", "read_web", "compile", "finish"]);
  const closed = (schema: unknown): boolean => {
    if (!schema || typeof schema !== "object") return true;
    const s = schema as Record<string, unknown>;
    if (s.type === "object" && s.additionalProperties !== false) return false;
    return Object.values(s).every(v => Array.isArray(v) ? v.every(closed) : closed(v));
  };
  for (const tool of ANALYST_TOOLS.filter(t => t.name !== "compile" && t.name !== "finish")) { assert.equal(tool.strict, true, tool.name); assert.ok(closed(tool.input_schema), tool.name); }
  for (const name of ["compile", "finish"]) assert.equal(ANALYST_TOOLS.find(t => t.name === name)!.strict, undefined);
  assert.deepEqual(ANALYST_TOOLS.find(t => t.name === "compile")!.input_schema.required, ["document"]);
});

test("a turn without a usable reply joins nothing, the next asks again, and failures in a row end the finding as an outage", async () => {
  const f = verifyFindings(publication, data).verified[0]!;
  const plan = planFinding(f, data, ["PEER1", "PEER2"]);
  const ledger = buildLedger(data, PERIOD, publication.sources);
  const runWith = (act: AnalystModel["act"]) => runAnalyst({ env: { DB: undefined } as unknown as SecPipelineEnv, ticker: "TEST", finding: f, plan, data, catalogue: lensCatalogue(ledger, data, PERIOD), categories: [], documents: [], record: [], model: { act, judge: async () => ({ remove: [] }) }, stage: (_, cb) => cb(), reserveTurn: async () => true, now: "2026-08-01T00:00:00Z" });
  const sent: AgentMessage[][] = [], systems: string[] = [];
  const thinking: AgentBlock = { type: "thinking", thinking: "", signature: "sig-1" };
  const replies: AgentReply[] = [
    { stopReason: "tool_use", content: [thinking, { type: "tool_use", id: "toolu_peers", name: "peers", input: {} }] },
    { content: [], stopReason: "refusal", refusalCategory: "reasoning_extraction" },
    { error: "stream_incomplete: interrupted" },
    calls(["compile", { document: JSON.stringify({ rows: [] }) }], ["Peers", {}]),
    { stopReason: "end_turn", content: [{ type: "text", text: "Done." }] },
    { stopReason: "end_turn", content: [{ type: "text", text: "Still done." }] },
  ];
  const outcome = await runWith(async (_stage, system, _tools, messages) => { sent.push(structuredClone(messages)); systems.push(system); return replies[sent.length - 1] ?? call("finish"); });
  assertConversation(sent, systems);
  // The reply goes back exactly as returned, thinking included; the failed turns send the same exchange again.
  assert.deepEqual(sent[1]![1], { role: "assistant", content: replies[0]!.content });
  assert.deepEqual(sent[2], sent[1]);
  assert.deepEqual(sent[3], sent[1]);
  assert.deepEqual(outcome.turns.slice(1, 3).map(t => [t.action, t.observation]), [["invalid", "refusal (reasoning_extraction)"], ["invalid", "stream_incomplete: interrupted"]]);
  // Two calls in one reply each get their result: a document sent as a string is read, and a tool named in another case runs.
  const both = sent[4]!.at(-1)!.content as AgentBlock[];
  assert.deepEqual(both.map(b => b.tool_use_id), [replies[3]!.content[0]!.id, replies[3]!.content[1]!.id]);
  assert.match(String(both[0]!.content), /arrived as a JSON string[\s\S]*does not match the contract/);
  assert.equal(both[0]!.is_error, true);
  assert.match(String(both[1]!.content), /PEER1/);
  // A reply calling no tool is asked once to go on; the second ends the finding.
  assert.match(sent[5]!.at(-1)!.content as string, /^Continue by calling the tools/);
  assert.equal(sent.length, 6);
  assert.equal(outcome.document, null);

  const { providerOutage } = await import("../src/analyst/workflow.ts");
  let asked = 0;
  const declined = await runWith(async () => { asked++; return { content: [], stopReason: "refusal", refusalCategory: "reasoning_extraction" }; });
  assert.equal(asked, 3);
  assert.equal(providerOutage([{ status: "fulfilled", value: declined }]), true);
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

test("a run in which no researched finding got an answer is a provider outage; one real answer is not", async () => {
  const { providerOutage } = await import("../src/analyst/workflow.ts");
  const outcome = (turns: Array<{ action: string; thought: string }>, document: unknown = null) => ({ status: "fulfilled" as const, value: { id: "f", tier: "standard" as const, lines: [], document: document as never, materials: [], warnings: [], review: [], turns: turns.map((t, i) => ({ turn: i + 1, input: "{}", observation: "", ...t })) } });
  const silent = outcome([{ action: "invalid", thought: "" }, { action: "invalid", thought: "" }]);
  assert.equal(providerOutage([silent, { status: "rejected", reason: new Error("HTTP 503") }]), true);
  assert.equal(providerOutage([silent, outcome([{ action: "invalid", thought: "" }, { action: "compile", thought: "draft" }])]), false);
  assert.equal(providerOutage([]), false);
});

test("a dossier prefixes filing materials by finding and keeps web materials as read, so a long finding id stays within the contract", async () => {
  const { dossierContent } = await import("../src/analyst/workflow.ts");
  const web = "w" + "a".repeat(27);
  const document: LensDocument = { rows: [{ cells: [[{ kind: "judgment" }, { kind: "figures" }], [{ kind: "quote", materialId: web, text: "a quote from the page long enough" }, { kind: "quote", materialId: "m1", text: "a quote from the filing long enough" }]] }] };
  const materials = [
    { id: web, kind: "web" as const, title: "Press release", url: "https://example.com/news", publishedAt: "2026-06-01", passageId: web },
    { id: "m1", kind: "sec" as const, title: "TEST 10-Q", url: "https://www.sec.gov/x", publishedAt: "2026-07-30", passageId: "abcdef0123456789" },
  ];
  const content = dossierContent([{ id: "ocf-customer-advances", tier: "deep", lines: [], document, materials, turns: [], warnings: [], review: [] }]);
  assert.deepEqual(content.materials.map(m => m.id), [web, "ocf-customer-advances:m1"]);
  assert.deepEqual(content.documents["ocf-customer-advances"]!.rows[0]!.cells[1]!.map(b => b.kind === "quote" ? b.materialId : ""), [web, "ocf-customer-advances:m1"]);
  assert.ok(readDossierPublication({ schemaVersion: "dossier.v1", ticker: "TEST", findingsFingerprint: "fp-1", fingerprint: "a-1", generatedAt: "2026-08-01T00:00:00Z", model: "test", ...content }, "TEST"));
});
