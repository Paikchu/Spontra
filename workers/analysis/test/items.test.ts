import { test } from "node:test";
import assert from "node:assert/strict";
import type { CompanyEvent, EventsPublication, InsiderTransaction } from "../../../shared/analysis-contract/events.ts";
import type { PublicFilingDigest, PublicFilingDigestPage } from "../../../shared/analysis-contract/filings.ts";
import type { FindingPassage } from "../../../shared/analysis-contract/findings.ts";
import { verifyFindings } from "../../../shared/analysis-runtime/findings.ts";
import { runAgentLoop, sequential } from "../src/agent-loop.ts";
import { buildLedger } from "../src/findings/ledger.ts";
import { itemOpening, itemRecipe, itemSubjects, type ItemInput } from "../src/items/recipe.ts";
import { lensCatalogue } from "../src/lens/agent.ts";
import type { AnalysisEnv } from "../src/operations.ts";
import type { AgentMessage, AgentReply } from "../src/tool-loop.ts";
import { data as baseData, PERIOD, publication } from "./fixtures/stage-data.ts";

const insider = (owner: string, sold: number | null, heldAfter: number, plan: boolean | null = null): InsiderTransaction => ({
  ownerCik: owner, ownerName: `Owner ${owner}`, title: "Chief Executive Officer", isDirector: false, isOfficer: true, isTenPercentOwner: false, rule10b51: plan, planAdoptedOn: null,
  securityTitle: "Common Stock", lines: [], sold: sold ? { shares: sold, proceeds: sold * 100, averagePrice: 100 } : null, bought: null, exercised: 0, heldAfter, footnotes: ["Sold to cover taxes on vested units."],
});
const event = (id: string, form: CompanyEvent["form"], filedAt: string, extra: Partial<CompanyEvent> = {}): CompanyEvent => ({
  id, ticker: "TEST", form, filedAt, eventDate: filedAt, items: form.startsWith("4") ? [] : ["5.02"], class: form.startsWith("4") ? "insider" : "executive", description: "", edgarUrl: "https://www.sec.gov/i", documentUrl: "https://www.sec.gov/d.htm",
  exhibits: [], summary: null, insider: null, title: null, importance: "normal", ...extra,
});
const digest = (id: string, periodEnd: string, date: string): PublicFilingDigest => ({
  accessionNumber: id, form: "10-Q", filingDate: date, reportDate: periodEnd, periodEnd, periodLabel: "Q2", date, sources: [], headline: "", bullets: [], analystView: "", report: null, warnings: [], generatedAt: null,
  keyMetrics: [], changes: [], risks: [], guidance: [], verification: null, analysisStatus: "ready", hasReport: true, snapshot: null, edgarUrl: "https://www.sec.gov/i", documentUrl: "https://www.sec.gov/d.htm",
});

const events: EventsPublication = { schemaVersion: "events.v1", ticker: "TEST", checkedAt: "2026-08-10T00:00:00Z", pendingInsider: 0, events: [
  // A first sale of a third of the holding: the rules flag it.
  event("0000000001-26-000003", "4", "2026-08-05", { insider: insider("1", 50_000, 100_000) }),
  // A small planned sale: routine, left to its figures.
  event("0000000001-26-000004", "4", "2026-08-04", { insider: insider("2", 1_000, 900_000, true) }),
  // A grant: nothing traded, folded on the rail.
  event("0000000001-26-000005", "4", "2026-08-03", { insider: insider("3", null, 10_000) }),
  event("0000000001-26-000002", "8-K", "2026-08-01"),
  event("0000000001-24-000001", "8-K", "2024-01-15"),
] };
const filings: PublicFilingDigestPage = { schemaVersion: "filing-digests.v1", ticker: "TEST", total: 1, checkedAt: null, filings: [digest("0000000001-26-000001", PERIOD, "2026-07-30")] };

test("the rows that get an analysis: every recent report and current report, and only the Form 4s the rules flag", () => {
  const subjects = itemSubjects(filings, events, new Date("2026-08-10T00:00:00Z"));
  assert.deepEqual(subjects.map(s => [s.kind, s.id]), [
    ["insider", "0000000001-26-000003"], ["current", "0000000001-26-000002"], ["report", "0000000001-26-000001"],
  ]);
});

const ledger = buildLedger(baseData, PERIOD, []);
const facts = { ...baseData, events };
const stageData = { ticker: "TEST", periodEnd: PERIOD, data: facts, ledger, catalogue: lensCatalogue(ledger, facts, PERIOD), publication, findings: verifyFindings(publication, facts).verified, basis: {} };
const block: FindingPassage = { passageId: "0000000001-26-000002:b1", documentId: "0000000001-26-000002", title: "TEST 8-K 2026-08-01", form: "8-K", filedAt: "2026-08-01", url: "https://www.sec.gov/d.htm", path: ["Item 5.02"], text: "On July 30, the Board appointed a new Chief Financial Officer, effective September 1.", table: null };
const call = (name: string, input: unknown): AgentReply => ({ content: [{ type: "tool_use", id: `t-${name}-${Math.random()}`, name, input }], stopReason: "tool_use" });

async function run(input: ItemInput, replies: unknown[][]) {
  const recipe = itemRecipe(input);
  const state = recipe.open(input);
  const messages: AgentMessage[] = [{ role: "user", content: itemOpening(input, state) }];
  const results: string[] = [];
  let turn = 0;
  const outcome = await runAgentLoop(recipe, input, state, messages, async (_stage, _system, _tools, msgs) => {
    const last = msgs.at(-1)!;
    if (Array.isArray(last.content)) results.push(...last.content.map(b => String((b as { content?: unknown }).content ?? "")));
    const reply = replies[turn++] ?? [["finish", {}]];
    return { content: reply.map(([name, args]) => call(name as string, args).content[0]!), stopReason: "tool_use" } as AgentReply;
  }, { reserve: async () => true, record: () => {}, execute: (_t, calls, go) => sequential(calls, go), signal: new AbortController().signal, now: () => 0 });
  return { outcome, state, results, opening: JSON.parse(messages[0]!.content as string) };
}

test("a current report is read from its own words, seeded as m1, and its analysis may state no figure at all", async () => {
  const subject = itemSubjects(filings, events, new Date("2026-08-10T00:00:00Z")).find(s => s.kind === "current")!;
  const input: ItemInput = { env: { DB: {} as D1Database } as AnalysisEnv, data: stageData, subject, periodEnd: PERIOD, documents: [], earlierAvailable: false, seed: [block], now: "2026-08-10T00:00:00Z" };
  const doc = (quote: string) => ({ rows: [{ cells: [[{ kind: "judgment" }], [{ kind: "quote", materialId: "m1", text: quote }]] }, { cells: [[{ kind: "sources" }]] }] });
  const judgment = (text: string) => ({ title: "A new finance chief takes over", kind: "shift", judgment: text, evidence: [], document: doc(block.text.slice(0, 50)) });
  const { outcome, results, opening } = await run(input, [
    [["compose", { report: judgment("The board named a new chief financial officer with a $2.5 million award, which puts the next report under a new signature. Nothing in the filing changes the figures, but the handover deserves attention in the call.") }]],
    [["compose", { report: judgment("The board named a new chief financial officer who starts next month, so the next report is signed under new finance leadership. Nothing in the filing changes the figures; the handover is what to watch in the call.") }]],
    [["finish", {}]],
  ]);
  assert.equal(opening.materials[0].id, "m1");
  assert.equal(opening.subject.kind, "current");
  assert.match(results[0]!, /number 2.5 unsupported/);
  assert.match(results[1]!, /accepted as written/);
  assert.equal(outcome.reason, "finished");
  assert.equal(outcome.output?.passages[0]?.passageId, block.passageId);
  assert.equal(outcome.output?.finding.lens.type, "document");
});

test("a flagged Form 4 must cite its own figures through event refs, and one of the owner's earlier filings when there is one", async () => {
  const flagged = event("0000000001-26-000003", "4", "2026-08-05", { insider: insider("1", 50_000, 100_000) });
  const earlier = event("0000000001-26-000006", "4", "2026-03-02", { insider: insider("1", 5_000, 150_000) });
  const withHistory = { ...events, events: [...events.events, earlier] };
  const data = { ...stageData, data: { ...facts, events: withHistory } };
  const subject = itemSubjects(filings, withHistory, new Date("2026-08-10T00:00:00Z")).find(s => s.kind === "insider") ?? { kind: "insider" as const, id: flagged.id, date: flagged.filedAt, form: flagged.form, event: flagged };
  const input: ItemInput = { env: { DB: {} as D1Database } as AnalysisEnv, data, subject, periodEnd: PERIOD, documents: [], earlierAvailable: false, seed: [], now: "2026-08-10T00:00:00Z" };
  const doc = { rows: [{ cells: [[{ kind: "judgment" }, { kind: "figures" }]] }] };
  const report = (ids: string[]) => ({ title: "The chief executive sells a third of the stake", kind: "watch", evidence: ids.map(id => ({ ref: { event: { id, field: "sharesSold" } }, periodEnd: id === flagged.id ? flagged.eventDate : earlier.eventDate, span: "quarter" })), document: doc,
    judgment: "The chief executive sold a third of the direct holding in one filing, outside a trading plan, after a much smaller sale earlier in the year. A sale this size from the top officer is the rule's attention case; it signals reduced exposure rather than anything about the quarter." });
  const { outcome, results, opening } = await run(input, [
    [["compose", { report: report([earlier.id]) }]],
    [["compose", { report: report([flagged.id]) }]],
    [["compose", { report: report([flagged.id, earlier.id]) }]],
    [["finish", {}]],
  ]);
  assert.ok(opening.subject.refs.some((r: { ref: { event: { id: string } } }) => r.ref.event.id === earlier.id));
  assert.match(results[0]!, /cite at least one figure of this filing/);
  assert.match(results[1]!, /cite one of the owner's earlier filings too/);
  assert.match(results[2]!, /accepted as written/);
  assert.equal(outcome.reason, "finished");
});
