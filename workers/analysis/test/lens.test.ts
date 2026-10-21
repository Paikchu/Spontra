import { test } from "node:test";
import assert from "node:assert/strict";
import type { BusinessFlowQuarter } from "../../../shared/analysis-contract/business-flow.ts";
import type { CapitalQuarter, CashFlowStatement } from "../../../shared/analysis-contract/capital-structure.ts";
import type { AnalysisFinding, FindingsPublication } from "../../../shared/analysis-contract/findings.ts";
import type { LensChart, LensDocument } from "../../../shared/analysis-contract/lens.ts";
import { evidenceCandidates, readFindingsPublication, readLensDocument, verifyFindings, type FindingData } from "../../../shared/analysis-runtime/findings.ts";
import { auditDocument } from "../../../shared/analysis-runtime/lens/audit.ts";
import { compileChart } from "../../../shared/analysis-runtime/lens/compile.ts";
import { describeDocument } from "../../../shared/analysis-runtime/lens/describe.ts";
import { documentFromEvidence, lensDocumentOf } from "../../../shared/analysis-runtime/lens/legacy.ts";
import { renderChartSvg } from "../../../shared/analysis-runtime/lens/render.ts";
import { compileDocument, verifyLensDocument } from "../../../shared/analysis-runtime/lens/verify.ts";
import { buildLedger } from "../src/findings/ledger.ts";
import { lensCatalogue, runLensAgent, writeLensDocuments, LENS_BUDGET, LENS_TOOLS, type LensModel } from "../src/lens/agent.ts";
import type { AgentBlock, AgentMessage, AgentReply } from "../src/tool-loop.ts";

let ids = 0;
/** A reply calling one tool, as the Messages API returns it. */
const call = (name: string, input: unknown = {}): AgentReply => ({ stopReason: "tool_use", content: [{ type: "tool_use", id: `toolu_${++ids}`, name, input }] });
/** The last tool result the harness sent, or "" for the opening. */
const lastResult = (messages: AgentMessage[]) => { const content = messages.at(-1)!.content; return Array.isArray(content) ? String(content.at(-1)?.content ?? "") : ""; };

const ENDS = ["2024-09-30", "2024-12-31", "2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30"];
const amount = (v: number) => ({ value: String(v), basis: "reported" as const, definition: "", comparabilityKey: null, sourceIds: ["s1"] });
function quarter(end: string, i: number): BusinessFlowQuarter {
  const revenue = 100 + i * 5, cloud = 40 + i * 4;
  return {
    id: end, label: end, periodStart: null, periodEnd: end, periodType: "3M", currency: "USD", scale: 1e6, basisLabel: "", reportedAt: null,
    figures: { revenue: amount(revenue), cost: amount(revenue * 0.4), gross: amount(revenue * 0.6), operating: amount(revenue * 0.3), net: amount(revenue * 0.2) },
    segments: [{ id: "cloud", name: "Cloud", revenue: amount(cloud), description: "", products: [], customers: null, monetization: null, disclosure: "", sourceIds: ["s1"] }],
    segmentsComplete: true, sources: [{ id: "s1", title: "10-Q", url: "https://www.sec.gov/x", publishedAt: null } as BusinessFlowQuarter["sources"][number]],
  };
}
const source = { accession: "0001", url: "https://www.sec.gov/x", filedAt: "2026-07-30", form: "10-Q" };
function cashFlow(end: string, capex: number): CashFlowStatement {
  return {
    periodStart: end, periodEnd: end, currency: "USD", basis: "reported",
    operating: { total: "30000000000", lines: null }, investing: { total: String(-capex), lines: [{ id: "c", label: "Capex", concept: "x", group: "capex", value: String(-capex) }] },
    financing: { total: "-1000000000", lines: [] }, fxEffect: null, netChange: "0", supplemental: [], sources: [source],
  } as CashFlowStatement;
}
function capitalQuarter(end: string, i: number): CapitalQuarter {
  return { periodEnd: end, cashFlow: cashFlow(end, i === 7 ? 40e9 : 10e9), yearToDate: null, balanceSheet: {
    asOf: end, currency: "USD", assets: [{ id: "cash", label: "Cash", concept: "x", group: "cash", value: "50000000000" }], liabilities: [{ id: "d", label: "Debt", concept: "x", group: "debt", value: String(20e9 + i * 1e9) }],
    equity: [], totals: { assets: "200000000000", liabilities: "80000000000", equity: "120000000000", currentAssets: null, currentLiabilities: null }, source,
  }, rpo: { asOf: end, currency: "USD", total: String(100e9 + i * 10e9), buckets: [{ start: null, months: 12, share: "0.4", amount: null }, { start: null, months: 24, share: "0.35", amount: null }], source } };
}
const data: FindingData = { quarters: ENDS.map(quarter), history: null, capital: { schemaVersion: "capital-structure.v1", ticker: "TEST", quarters: ENDS.map(capitalQuarter) }, fundamentals: null, guidance: null };
const PERIOD = ENDS.at(-1)!;

const finding: AnalysisFinding = {
  id: "capex-fcf", kind: "risk", severity: 3, title: "Capex of $40.0 billion outruns operating cash flow",
  judgment: { text: "Capex was $40.0 billion in the newest quarter against operating cash flow of $30.0 billion, so free cash flow turned negative at $10.0 billion below zero. The next report should show whether capex eases.", sourceIds: ["s1"] },
  evidence: [{ ref: { capital: "capex" }, periodEnd: PERIOD, span: "quarter", compare: "yoy" }, { ref: { capital: "operatingCashFlow" }, periodEnd: PERIOD, span: "quarter" }, { ref: { capital: "freeCashFlow" }, periodEnd: PERIOD, span: "quarter" }],
  anchors: { view: "cash", nodeIds: [], metrics: [], capital: ["capex"] },
  lens: { type: "compare_bars", refs: [{ capital: "operatingCashFlow" }, { capital: "capex" }, { capital: "freeCashFlow" }], span: "quarter" },
  watch: { ref: { capital: "capex" }, condition: "Capex below operating cash flow would show the build is a phase.", horizon: "next_quarter", compare: "yoy" },
};
const publication: FindingsPublication = { schemaVersion: "findings.v1", ticker: "TEST", periodEnd: PERIOD, generatedAt: "2026-07-31T00:00:00Z", model: "test", findings: [finding], sources: [{ id: "s1", title: "10-Q", url: "https://www.sec.gov/x", kind: "sec", publishedAt: null }] };
const verified = () => verifyFindings(publication, data).verified[0]!;

const chart: LensChart = { id: "c1", aspect: "wide", span: "quarter", periods: 8, series: [{ id: "ocf", ref: { capital: "operatingCashFlow" } }, { id: "capex", ref: { capital: "capex" } }, { id: "rate", ref: { capital: "capex" }, transform: "yoy" }],
  marks: [{ type: "bar", series: ["ocf", "capex"] }, { type: "line", series: ["rate"], axis: "right", color: "muted" }], annotations: [{ series: "capex", period: "latest", text: "{value}, {change} on the year" }] };

test("compile resolves every series, formats values, scales both axes and fills annotation templates", () => {
  const result = compileChart(chart, data, PERIOD);
  assert.deepEqual(result.errors, []);
  const c = result.chart!;
  assert.equal(c.periods.length, 8);
  assert.equal(c.series.find(s => s.id === "capex")!.text.at(-1), "$40.0B");
  assert.equal(c.series.find(s => s.id === "rate")!.unit, "percent");
  assert.equal(c.series.find(s => s.id === "rate")!.values.at(-1), 300);
  assert.ok(c.axes.left && c.axes.left.min === 0 && c.axes.left.max >= 40e9);
  assert.ok(c.axes.right && c.axes.right.unit === "percent");
  assert.equal(c.annotations[0]!.text, "$40.0B, +300% on the year");
});

test("compile rejects a series nothing draws, a reference the data cannot answer, mixed units on one axis and a numeric annotation", () => {
  const unresolved = compileChart({ ...chart, series: [{ id: "x", ref: { fundamental: "diluted_eps" } }], marks: [{ type: "bar", series: ["x"] }], annotations: [] }, data, PERIOD);
  assert.match(unresolved.errors.join(" "), /resolves nothing|no series resolves/);
  const undrawn = compileChart({ ...chart, marks: [{ type: "bar", series: ["ocf"] }], annotations: [] }, data, PERIOD);
  assert.match(undrawn.errors.join(" "), /not drawn by any mark/);
  const mixed = compileChart({ ...chart, marks: [{ type: "bar", series: ["ocf", "capex"] }, { type: "line", series: ["rate"] }], annotations: [] }, data, PERIOD);
  assert.match(mixed.errors.join(" "), /left an axis mixes/);
  const numeric = compileChart({ ...chart, annotations: [{ series: "capex", period: "latest", text: "capex hit 40 billion" }] }, data, PERIOD);
  assert.match(numeric.errors.join(" "), /states a figure/);
});

test("the audit requires the finding's blocks, flags an imbalanced row and a paragraph with an unsupported number", () => {
  const f = verified();
  const doc: LensDocument = { rows: [{ cells: [[{ kind: "chart", chart }], [{ kind: "judgment" }]] }, { cells: [[{ kind: "figures" }]] }, { cells: [[{ kind: "prose", paragraphs: [{ text: "Capex was $99.9 billion.", sourceIds: ["s1"] }] }]] }] };
  const warnings = auditDocument({ document: doc, compiled: compileDocument(doc, data, PERIOD), candidates: f.resolved.flatMap(evidenceCandidates), watch: f.watch, judgmentChars: f.judgment.text.length, figures: f.resolved.length });
  const text = warnings.map(w => `${w.level} ${w.where}: ${w.message}`).join("\n");
  assert.match(text, /error document: the finding has a watch item/);
  assert.match(text, /error prose block .*99\.9/);
  assert.match(text, /warning row 1: chart c1 .* beside judgment/);
  const described = describeDocument(doc, compileDocument(doc, data, PERIOD), warnings);
  assert.match(described, /row 1: \[chart c1 \| judgment\]/);
  assert.match(described, /ocf "Operating cash flow" \[bar, left\]/);
});

test("verification keeps what resolves, drops a chart that no longer resolves and a paragraph with a bad number, and the fallback document always compiles", () => {
  const f = verified();
  const doc: LensDocument = { rows: [{ cells: [[{ kind: "chart", chart }], [{ kind: "judgment" }, { kind: "figures" }, { kind: "watch" }]] }, { cells: [[{ kind: "chart", chart: { ...chart, id: "c2", series: [{ id: "x", ref: { fundamental: "diluted_eps" } }], marks: [{ type: "bar", series: ["x"] }], annotations: [] } }], [{ kind: "prose", paragraphs: [{ text: "Capex reached $40.0 billion.", sourceIds: ["s1"] }, { text: "Capex reached $12.3 billion.", sourceIds: ["s1"] }] }]] }] };
  const lens = verifyLensDocument(doc, f, f.resolved, data, PERIOD)!;
  assert.equal(Object.keys(lens.charts).join(","), "c1");
  assert.equal(lens.document.rows.length, 2);
  assert.deepEqual(lens.document.rows[1]!.cells, [[{ kind: "prose", paragraphs: [{ text: "Capex reached $40.0 billion.", sourceIds: ["s1"] }] }]]);
  assert.equal(lens.reasons.length, 2);
  const fallback = verifyLensDocument(documentFromEvidence(f), f, f.resolved, data, PERIOD)!;
  assert.equal(Object.keys(fallback.charts).length, 1);
});

test("legacy lenses become documents through the grammar, the ladder with the filing's RPO rungs", () => {
  const f = verified();
  const legacy = lensDocumentOf(f, data, PERIOD);
  assert.equal(legacy.rows[0]!.cells[0]![0]!.kind, "chart");
  assert.deepEqual(legacy.rows[0]!.cells[1]!.map(b => b.kind), ["judgment", "figures", "watch"]);
  const ladder = lensDocumentOf({ ...f, lens: { type: "ladder" } }, data, PERIOD);
  const charts = ladder.rows.flatMap(r => r.cells.flat()).flatMap(b => b.kind === "chart" ? [b.chart] : []);
  assert.equal(charts.length, 2);
  assert.deepEqual(charts[1]!.series.map(s => s.ref), [{ rpoBucket: 0 }, { rpoBucket: 1 }]);
  const compiled = compileChart(charts[1]!, data, PERIOD).chart!;
  assert.equal(compiled.series[0]!.label, "RPO due within 12 months");
  assert.equal(compiled.series[0]!.text.at(-1), "$68.0B");
  const shares = lensDocumentOf({ ...f, lens: { type: "share_area", nodeIds: ["cloud"] } }, data, PERIOD);
  const share = shares.rows[0]!.cells[0]![0]!;
  assert.ok(share.kind === "chart" && share.chart.marks[0]!.type === "stacked_area");
  assert.ok(readLensDocument(ladder));
});

test("the renderer writes every label into the SVG and keeps its style free of anything particular to one chart", () => {
  const c = compileChart(chart, data, PERIOD).chart!;
  const svg = renderChartSvg(c, { width: 600, height: 260 });
  assert.match(svg, /^<svg class="lens-svg"/);
  assert.ok(svg.includes("$40.0B") && svg.includes("Operating cash flow") && svg.includes("2026.06"));
  assert.ok(svg.includes('data-col="7" data-show=""'));
  assert.ok(!/data-hover="\d/.test(svg.slice(0, svg.indexOf("</style>"))));
  assert.ok(svg.includes("on the year"));
});

test("the agent compiles, reads its errors back, and finishes only with a document that compiled; the publication carries it", async () => {
  const f = verified();
  const ledger = buildLedger(data, PERIOD, publication.sources);
  const catalogue = lensCatalogue(ledger, data, PERIOD);
  assert.ok(catalogue.some(r => "capital" in r.ref && r.ref.capital === "capex" && r.yoy));
  assert.ok(catalogue.some(r => "rpoBucket" in r.ref));
  const bad: LensDocument = { rows: [{ cells: [[{ kind: "chart", chart: { ...chart, annotations: [{ series: "capex", period: "latest", text: "40 billion" }] } }], [{ kind: "judgment" }, { kind: "figures" }, { kind: "watch" }]] }, { cells: [[{ kind: "sources" }]] }] };
  const good: LensDocument = { rows: [{ cells: [[{ kind: "chart", chart: { ...chart, aspect: "square" } }], [{ kind: "judgment" }, { kind: "figures" }, { kind: "watch" }]] }, { cells: [[{ kind: "sources" }]] }] };
  const seen: string[] = [], sent: AgentMessage[][] = [], systems: string[] = [];
  const replies = [call("compile", { document: bad }), call("finish"), call("compile", { document: good }), call("finish")];
  // Replies by the finding's turn, so the same script serves the publication's run below.
  const model: LensModel = async (stage, system, tools, messages) => {
    assert.deepEqual(tools, LENS_TOOLS);
    sent.push(structuredClone(messages)); systems.push(system); seen.push(lastResult(messages));
    return replies[Number(stage.split("-").at(-1)) - 1] ?? call("finish");
  };
  const outcome = await runLensAgent({ finding: f, resolved: f.resolved, periodEnd: PERIOD, catalogue, data, model, stage: (_, cb) => cb() });
  assert.match(seen[1]!, /states a figure/);
  assert.match(seen[2]!, /Not accepted/);
  assert.match(seen[3]!, /This document compiles/);
  assert.equal(outcome.turns.length, 4);
  assert.deepEqual(outcome.document, good);
  assert.ok(outcome.turns.length <= LENS_BUDGET.turns);
  // The loop is a conversation that only grows, with no written thought, no packed history, and no request for reasoning.
  for (const [i, messages] of sent.entries()) {
    if (i) assert.deepEqual(messages.slice(0, sent[i - 1]!.length), sent[i - 1]);
    messages.forEach((m, k) => assert.equal(m.role, k % 2 ? "assistant" : "user"));
    for (const m of messages) assert.doesNotMatch(typeof m.content === "string" ? m.content : JSON.stringify(m.content), /"thought"|"history"/);
  }
  assert.deepEqual(sent[1]![1], { role: "assistant", content: replies[0]!.content });
  for (const system of systems) assert.doesNotMatch(system, /thought|think|reasoning|explain your|Return only JSON|history/i);
  assert.match(seen[1]!, /Budget left: 5 turns\.$/);

  const written = await writeLensDocuments({ publication, ledger, data, model, version: "test", now: "2026-07-31T00:00:00Z", stage: (_, cb) => cb() });
  const lens = written.publication.findings[0]!.lens;
  assert.ok(lens.type === "document" && lens.document.rows.length === 2);
  assert.ok(readFindingsPublication(written.publication, "TEST"));
  assert.equal(written.trace.findings[0]!.turns.length, 4);
});

test("a lens turn without a usable reply joins nothing; failures in a row keep the original chart", async () => {
  const f = verified();
  const catalogue = lensCatalogue(buildLedger(data, PERIOD, publication.sources), data, PERIOD);
  const sent: AgentMessage[][] = [];
  const replies: AgentReply[] = [{ error: "stream_incomplete: interrupted" }, { content: [], stopReason: "max_tokens" }, { content: [], stopReason: "refusal", refusalCategory: "reasoning_extraction" }];
  const outcome = await runLensAgent({ finding: f, resolved: f.resolved, periodEnd: PERIOD, catalogue, data, stage: (_, cb) => cb(),
    model: async (_stage, _system, _tools, messages) => { sent.push(structuredClone(messages)); return replies[sent.length - 1] ?? call("finish"); } });
  assert.equal(sent.length, 3);
  assert.ok(sent.every(messages => messages.length === 1 && messages[0]!.role === "user"));
  assert.deepEqual(outcome.turns.map(t => t.action), ["invalid", "invalid", "invalid"]);
  assert.match(outcome.turns[2]!.observation, /refusal \(reasoning_extraction\)/);
  assert.equal(outcome.document, null);
  const unknown = await runLensAgent({ finding: f, resolved: f.resolved, periodEnd: PERIOD, catalogue, data, stage: (_, cb) => cb(),
    model: async (stage, _system, _tools, messages) => { if (stage.endsWith("-2")) sent.push(structuredClone(messages)); return stage.endsWith("-1") ? call("draw", {}) : call("finish"); } });
  const answer = (sent.at(-1)!.at(-1)!.content as AgentBlock[])[0]!;
  assert.equal(answer.is_error, true);
  assert.match(String(answer.content), /There is no tool "draw"/);
  assert.equal(unknown.document, null);
});
