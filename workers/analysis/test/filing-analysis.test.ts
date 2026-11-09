import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { executeFilingAnalysisWorkflow, knownFilings } from "../src/filing-analysis/workflow.ts";
import { PROFILES, profileFor } from "../src/filing-analysis/profiles.ts";
import { sectionRecipe, type SectionSpec } from "../src/filing-analysis/recipe.ts";
import { dueFilings, failedFilings } from "../src/filing-analysis/store.ts";
import { buildWorklist, missingQuotes, notesToNodes, readNotes, type SectionFacts, type SectionNote } from "../src/filing-analysis/worklist.ts";
import { SUBSCRIPTIONS } from "../src/pipeline/registry.ts";
import type { HandResult } from "../src/pi/hand-tools.ts";

function database() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(file, dir), "utf8").replace(/--> statement-breakpoint/g, ""));
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    run: async () => { sqlite.prepare(sql).run(...values as never[]); return { success: true, meta: { changes: 1 } }; },
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...values as never[]) as T[] }),
    first: async <T>() => (sqlite.prepare(sql).get(...values as never[]) ?? null) as T | null,
  });
  return { prepare: (sql: string) => statement(sql), batch: async (list: Array<{ run(): Promise<unknown> }>) => { for (const s of list) await s.run(); return []; } } as unknown as D1Database;
}

const facts = (over: Partial<{ form: string; flagged: boolean }>) => ({ form: "8-K", flagged: false, ...over });
test("every form gets exactly one profile, and the running code needs no other branch", () => {
  assert.equal(profileFor(facts({ form: "10-Q" })).id, "periodic");
  assert.equal(profileFor(facts({ form: "10-K/A" })).id, "periodic");
  assert.equal(profileFor(facts({ form: "20-F" })).id, "periodic");
  assert.equal(profileFor(facts({ form: "8-K" })).id, "current");
  assert.equal(profileFor(facts({ form: "6-K" })).id, "current");
  assert.equal(profileFor(facts({ form: "424B5" })).id, "offering");
  assert.equal(profileFor(facts({ form: "4", flagged: true })).id, "insider");
  assert.equal(profileFor(facts({ form: "4" })).id, "record-only");
  assert.equal(profileFor(facts({ form: "DEF 14A" })).id, "proxy");
  assert.equal(profileFor(facts({ form: "SOMETHING" })).id, "record-only");
  for (const id of ["proxy", "record-only"]) assert.equal(PROFILES.find(p => p.id === id)!.model, "off");
  assert.ok(PROFILES.filter(p => p.model === "agent").every(p => p.compose.turns > 0), "a session is bounded by turns and time, not tokens");
});

const section = (id: string, change: SectionFacts["change"], over: Partial<SectionFacts> = {}): SectionFacts => ({ documentId: "d2", sectionId: id, path: ["Item 2", id], canonical: id, change, previousSectionId: `old-${id}`, chars: 1000, ...over });
const note = (id: string): SectionNote => ({ sectionId: id, summary: `about ${id}`, changes: [], watch: [], quotes: [] });

test("the walk visits every section: unchanged ones with a conclusion carry it, everything else is work", () => {
  const sections = [section("a", "unchanged"), section("b", "unchanged"), section("c", "changed"), section("d", "new", { previousSectionId: null })];
  const list = buildWorklist(sections, [{ sectionId: "c", chars: 300, change: "changed" }, { sectionId: "c", chars: 700, change: "unchanged" }], new Map([["old-a", note("old-a")], ["old-c", note("old-c")]]), 24_000);
  assert.deepEqual(list.carried.map(c => [c.section.sectionId, c.from]), [["a", "old-a"]]);
  const work = list.batches.flat();
  assert.deepEqual(work.map(w => w.sectionId), ["b", "c", "d"]);
  assert.deepEqual(work.map(w => w.prior), ["text", "note", "none"]);
  assert.equal(work[1]!.workChars, 300, "a changed section costs only its changed passages");
  assert.equal(work[0]!.workChars, 1000, "an unchanged section without a conclusion is read whole, once");
});

test("batches keep document order and their size", () => {
  const sections = Array.from({ length: 10 }, (_, i) => section(`s${i}`, "new", { chars: 5000 }));
  const { batches } = buildWorklist(sections, [], new Map(), 12_000);
  assert.deepEqual(batches.map(b => b.length), [2, 2, 2, 2, 2]);
  assert.deepEqual(batches.flat().map(e => e.sectionId), sections.map(s => s.sectionId));
});

test("notes must cover the batch, and quotes must be the filing's own words", () => {
  assert.match((readNotes([{ sectionId: "a", summary: "x" }], ["a", "b"]) as { error: string }).error, /Missing: b/);
  assert.match((readNotes([{ sectionId: "z", summary: "x" }, { sectionId: "a", summary: "y" }], ["a"]) as { error: string }).error, /not sections/);
  assert.deepEqual(missingQuotes(["revenue  grew", "invented"], ["Revenue was up; revenue grew 30%."]), ["invented"]);
});

test("the notes become nodes that hold every section once, and a section without a note is named", () => {
  const sections = [section("a", "changed"), section("b", "changed"), section("c", "changed", { path: ["Item 3", "c"] })];
  const full = notesToNodes(sections, new Map(sections.map(s => [s.sectionId, note(s.sectionId)])), () => ["ev:p"]);
  assert.deepEqual(full.plan.nodes.map(n => n.sectionIds), [["a", "b"], ["c"]]);
  assert.equal(full.review.status, "complete");
  const partial = notesToNodes(sections, new Map([["a", note("a")]]), () => []);
  assert.equal(partial.review.status, "partial");
  assert.equal(partial.review.unresolvedQuestions.length, 2);
});

test("all filings reach the path through its own events; the old tasks are started by nothing", () => {
  const started = Object.values(SUBSCRIPTIONS).flatMap(list => (list ?? []).map(s => s.task));
  assert.ok(started.includes("filing-analysis"));
  assert.ok(!started.includes("sec-report"));
  assert.ok(!started.includes("items"));
  assert.ok(SUBSCRIPTIONS["filing.discovered"]!.some(s => s.task === "filing-analysis"));
  assert.ok(SUBSCRIPTIONS["library.prepared"]!.some(s => s.task === "filing-analysis"));
});

test("each filing stands alone, and a current report is not sorted by its item numbers", () => {
  const filing = (accessionNumber: string, form: string, items = "", earningsGroup?: unknown) => ({ accessionNumber, form, filingDate: "2026-11-10", reportDate: "2026-09-30", items, earningsGroup }) as never;
  const known = knownFilings([filing("q", "10-Q"), filing("k", "8-K", "2.02,9.01"), filing("o", "8-K", "5.02"), filing("g", "6-K", "", { periodEnd: "2026-09-30" })], { events: [{ id: "f", form: "424B5", filedAt: "2026-11-11", items: [], class: "financing" }] } as never);
  assert.deepEqual(known.map(k => k.accession), ["q", "k", "o", "g", "f"]);
  for (const k of known.filter(k => /^(?:8|6)-K/.test(k.form))) assert.equal(profileFor(k).id, "current");
});

async function seedSections(db: D1Database) {
  await db.prepare("INSERT INTO sec_sections (section_id, document_id, parent_id, ordinal, depth, is_leaf, canonical, item_key, title, path, xbrl_block, role, change, previous_section_id, chars, text_sha256) VALUES ('now', 'd2', NULL, 1, 0, 1, 'mda', NULL, 'MD&A', '[\"MD&A\"]', NULL, 'core', 'changed', 'old', 20, 'h'), ('old', 'd1', NULL, 1, 0, 1, 'mda', NULL, 'MD&A', '[\"MD&A\"]', NULL, 'core', 'unchanged', NULL, 20, 'g')").run();
  await db.prepare("INSERT INTO sec_passages (passage_id, document_id, section_id, ordinal, kind, text, table_json, fact_refs, chars, text_sha256, change) VALUES ('p2', 'd2', 'now', 1, 'paragraph', 'Revenue grew 30% on large customers.', NULL, '[]', 36, 'h', 'changed'), ('p1', 'd1', 'old', 1, 'paragraph', 'Revenue grew 20% last year.', NULL, '[]', 27, 'g', 'unchanged')").run();
}

test("a section session reads the earlier filing, refuses invented quotes, and ends with its notes", async () => {
  const db = database();
  await seedSections(db);
  const entry = { documentId: "d2", sectionId: "now", path: ["MD&A"], canonical: "mda", change: "changed", previousSectionId: "old", chars: 20, prior: "text", workChars: 20 } as const;
  const spec: SectionSpec = { stage: "section", ticker: "FOO", profile: "periodic", entries: [entry], runId: "r" };
  const recipe = sectionRecipe({ DB: db } as never, spec, PROFILES[0]!);
  const state = recipe.open(spec);
  const tools = new Map(recipe.tools(state).map(t => [t.name, t]));
  const call = async (name: string, args: Record<string, unknown>) => await tools.get(name)!.execute(args as never, { state } as never) as HandResult;
  assert.match((await call("read_previous", { sectionId: "now" })).observation, /grew 20%/);
  assert.equal((await call("read_section", { sectionId: "other" })).error, true);
  const bad = await call("save_note", { notes: [{ sectionId: "now", summary: "x", quotes: ["Revenue tripled"] }] });
  assert.equal(bad.error, true);
  assert.equal(recipe.settled(state), false);
  await call("save_note", { notes: JSON.stringify([{ sectionId: "now", summary: "Growth sped up.", quotes: ["Revenue grew 20%"] }]) });
  assert.equal(recipe.settled(state), true);
  assert.equal(recipe.settle(state, "finished")![0]!.summary, "Growth sped up.");
});

const steps = { do: async <T>(_name: string, work: (c?: { attempt: number }) => Promise<T>) => work({ attempt: 1 }) } as never;
const operations = (filings: unknown[]) => ({ discover: async () => ({ feed: {}, filings }), publishFeed: async () => undefined, updateJob: async () => undefined }) as never;
const sec = (accessionNumber: string, form: string, filingDate: string) => ({ ticker: "FOO", accessionNumber, form, filingDate, reportDate: "2026-09-30", items: "" });
async function row(db: D1Database, accession: string) { return db.prepare("SELECT status, reason, attempts, run_id FROM filing_analyses WHERE accession_number = ?").bind(accession).first<{ status: string; reason: string | null; attempts: number; run_id: string | null }>(); }

test("a run registers every filing, records the ones without a model, and leaves the others waiting for their text", async () => {
  const db = database();
  await db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES ('sec:events:FOO', '{}', 'x')").run().catch(() => undefined);
  const env = { DB: db, SEC_FILINGS: {} } as never;
  const result = await executeFilingAnalysisWorkflow({ ticker: "FOO", requestedBy: "scheduled" }, "filings-1", steps, env, operations([sec("x", "ABS-15G", "2026-11-11"), sec("c", "8-K", "2026-11-11"), sec("q", "10-Q", "2026-11-10"), sec("old", "10-Q", "2026-01-01")]));
  assert.equal((result as { status: string }).status, "ready");
  assert.equal(await row(db, "old"), null, "a filing from before the path went live is not taken up");
  const fresh = database();
  await executeFilingAnalysisWorkflow({ ticker: "FOO", requestedBy: "scheduled" }, "filings-2", steps, { DB: fresh, SEC_FILINGS: {} } as never, operations([sec("old", "10-Q", "2026-01-01")]));
  assert.equal((await row(fresh, "old"))!.status, "waiting", "but a company new to the path gets its latest report");
  assert.equal((await row(db, "q"))!.status, "waiting");
  assert.equal((await row(db, "c"))!.status, "waiting");
  assert.equal((await row(db, "x"))!.status, "recorded");
  // Still due for the next run, and a recorded filing is not.
  assert.deepEqual((await dueFilings(db, "FOO", null)).map(r => r.accession), ["q", "c"]);
});

test("a filing that fails keeps its own state and is tried again by later runs, up to the limit", async () => {
  const db = database();
  await db.prepare("INSERT INTO sec_documents (document_id, ticker, accession_number, form, doc_type, document_url, source_sha256, parser_version, structure, status, prepared_at) VALUES ('d', 'FOO', 'q', '10-Q', 'primary', 'u', 's', 'v', 'items', 'ready', 'x')").run();
  const env = { DB: db, SEC_FILINGS: {} } as never;
  const failing = { ...(operations([sec("q", "10-Q", "2026-11-10")]) as object), prepare: async () => { throw new Error("provider down"); } } as never;
  for (const n of [1, 2, 3]) {
    await executeFilingAnalysisWorkflow({ ticker: "FOO", requestedBy: "scheduled" }, `filings-${n}`, steps, env, failing);
    assert.equal((await row(db, "q"))!.attempts, n);
    assert.equal((await row(db, "q"))!.status, "failed");
  }
  assert.deepEqual(await dueFilings(db, "FOO", null), [], "past the limit it waits for the admin");
  assert.equal(await failedFilings(db, "filings-3"), null, "and the run is not retried for it");
  assert.equal(await failedFilings(db, "filings-1"), null);
});

test("a release and the report of one quarter are two filings, and a run asks no model to group them", async () => {
  const db = database();
  const env = { DB: db, SEC_FILINGS: {} } as never;
  let classified = 0;
  const ops = { ...(operations([sec("q", "10-Q", "2026-11-10"), { ...sec("k", "8-K", "2026-11-09"), items: "2.02" }]) as object), classifyEarnings: async () => { classified++; return "2026-09-30"; }, groupEarnings: async (f: unknown) => f } as never;
  await executeFilingAnalysisWorkflow({ ticker: "FOO", requestedBy: "scheduled" }, "filings-1", steps, env, ops);
  assert.equal(classified, 0);
  assert.deepEqual([(await row(db, "q"))!.status, (await row(db, "k"))!.status], ["waiting", "waiting"]);
  const units = await db.prepare("SELECT profile, unit_key u FROM filing_analyses ORDER BY accession_number").all<{ profile: string; u: string }>();
  assert.deepEqual(units.results.map(r => [r.profile, r.u]), [["current", "accession:k"], ["periodic", "accession:q"]]);
});

test("a periodic filing walks its sections, carries what did not change, and publishes one report and one analysis", async () => {
  const db = database();
  await db.prepare("INSERT INTO sec_documents (document_id, ticker, accession_number, form, doc_type, document_url, source_sha256, parser_version, structure, status, previous_document_id, prepared_at) VALUES ('d2', 'FOO', 'q', '10-Q', 'primary', 'u', 's', 'v', 'items', 'ready', 'd1', 'x')").run();
  await seedSections(db);
  await db.prepare("INSERT INTO sec_sections (section_id, document_id, parent_id, ordinal, depth, is_leaf, canonical, item_key, title, path, xbrl_block, role, change, previous_section_id, chars, text_sha256) VALUES ('risk', 'd2', NULL, 2, 0, 1, 'risk', NULL, 'Risk', '[\"Risk\"]', NULL, 'signal', 'unchanged', 'risk-old', 10, 'r')").run();
  await db.prepare("INSERT INTO filing_section_notes (section_id, document_id, ticker, canonical, status, carried_from, prior, note_json, profile_version, created_at) VALUES ('risk-old', 'd1', 'FOO', 'risk', 'written', NULL, 'none', ?, 'v', 'x')").bind(JSON.stringify(note("risk-old"))).run();
  const r2 = new Map<string, string>([["prep/meta.json", JSON.stringify({ filing: sec("q", "10-Q", "2026-11-10"), outline: [], blockIds: [] })], ["prep/text.json", "{}"]]);
  const bucket = { get: async (k: string) => r2.has(k) ? { text: async () => r2.get(k)! } : null, put: async (k: string, v: string) => { r2.set(k, v); } };
  const published: unknown[] = [], ran: string[] = [];
  const composed = { finding: { title: "Growth sped up", judgment: { text: "x" } }, materials: [], passages: [], sources: [] };
  const sessions = async (kind: string, spec: { stage: string; entries?: Array<{ sectionId: string }> }, _opening: string, id: string) => {
    assert.equal(kind, "filing");
    ran.push(spec.stage);
    if (spec.stage === "section") return { output: spec.entries!.map(e => ({ ...note(e.sectionId), quotes: ["Revenue grew 30%"] })), reason: "finished", turns: 1, spent: 1000, trail: [], state: {}, id };
    return { output: { written: { plan: { nodes: [] }, nodes: [], review: { status: "complete", unresolvedQuestions: [], coverageScore: 1, stopReason: "complete" }, passed: { resultKey: "k", reviewedAt: "t", notes: [] }, issues: [] }, composed, withheld: false }, reason: "finished", turns: 3, spent: 5000, trail: [], state: {} };
  };
  const ops = { ...(operations([sec("q", "10-Q", "2026-11-10")]) as object), prepare: async () => ({ key: "prep", filing: sec("q", "10-Q", "2026-11-10") }), getContext: async () => ({}), buildBrief: async () => ({ currentFacts: [], history: { series: [] }, comparisons: [] }),
    loadPassedReport: async () => ({ artifact: { report: { dataQuality: { verificationStatus: "verified", warnings: [] } } }, summary: { nodes: [] } }), publish: async (a: unknown) => { published.push(a); return {}; } } as never;
  const result = await executeFilingAnalysisWorkflow({ ticker: "FOO", requestedBy: "scheduled" }, "filings-1", steps, { DB: db, SEC_FILINGS: bucket } as never, ops, { sessions: sessions as never });
  assert.deepEqual(result, { status: "ready", due: 1, written: 1, failed: [] });
  assert.deepEqual(ran, ["section", "compose"], "one batch for the changed section, then one writing session");
  assert.equal(published.length, 1);
  const status = await db.prepare("SELECT status, tokens, revision FROM filing_analyses WHERE accession_number = 'q'").first<{ status: string; tokens: number; revision: number }>();
  assert.deepEqual({ ...status }, { status: "published", tokens: 6000, revision: 1 });
  const carried = await db.prepare("SELECT status, carried_from FROM filing_section_notes WHERE section_id = 'risk'").first<{ status: string; carried_from: string }>();
  assert.deepEqual({ ...carried }, { status: "carried", carried_from: "risk-old" });
  const item = await db.prepare("SELECT payload FROM sec_cache WHERE cache_key = 'item-analysis:v1:FOO:q'").first<{ payload: string }>();
  assert.equal(JSON.parse(item!.payload).itemKind, "report");
  const prepared = JSON.parse(r2.get("prep/text.json")!);
  assert.equal(prepared.blocks[0].blockId, "p2", "the report's evidence ids are the library's passages");
  assert.match(String(r2.get("analysis/FOO/filing-analysis/accession_q/r1.json")), /filing-analysis\.v1/);
});
