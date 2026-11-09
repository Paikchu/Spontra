import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { PROFILES, profileFor } from "../src/filing-analysis/profiles.ts";
import { filingRecipe, type FilingSpec, type FilingState } from "../src/filing-analysis/recipe.ts";
import { startFilingRuns } from "../src/filing-analysis/start.ts";
import { dueFilings } from "../src/filing-analysis/store.ts";
import { SUBSCRIPTIONS, TASK_NAMES } from "../src/pipeline/registry.ts";
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

const sec = (accessionNumber: string, form: string, filingDate: string) => ({ ticker: "FOO", cik: "1", cikNumber: 1, companyName: "Foo", accessionNumber, form, filingDate, reportDate: "2026-09-30", items: "", primaryDocument: "a.htm", description: "", documentUrl: "https://example.test/a.htm", indexUrl: "https://example.test/" });
const operations = (filings: unknown[]) => ({ discover: async () => ({ feed: {}, filings: filings as never }), publishFeed: async () => undefined });
const sessions = () => { const started: Array<{ id: string; opening: string }> = []; return { started, start: async (id: string, _kind: string, _spec: unknown, opening: string) => { started.push({ id, opening }); } }; };
const row = (db: D1Database, accession: string) => db.prepare("SELECT status, reason, tokens FROM filing_analyses WHERE accession_number = ?").bind(accession).first<{ status: string; reason: string | null; tokens: number }>();
const env = (db: D1Database) => ({ DB: db }) as never;

async function seedLibrary(db: D1Database, accession: string, form: string) {
  await db.prepare("INSERT INTO sec_documents (document_id, ticker, accession_number, form, doc_type, document_url, source_sha256, parser_version, structure, status, previous_document_id, prepared_at) VALUES ('d2', 'FOO', ?, ?, 'primary', 'u', 's', 'v', 'items', 'ready', 'd1', 'x')").bind(accession, form).run();
  await db.prepare("INSERT INTO sec_sections (section_id, document_id, parent_id, ordinal, depth, is_leaf, canonical, item_key, title, path, xbrl_block, role, change, previous_section_id, chars, text_sha256) VALUES ('now', 'd2', NULL, 1, 0, 1, 'mda', NULL, 'MD&A', '[\"MD&A\"]', NULL, 'core', 'changed', 'old', 20, 'h'), ('old', 'd1', NULL, 1, 0, 1, 'mda', NULL, 'MD&A', '[\"MD&A\"]', NULL, 'core', 'unchanged', NULL, 20, 'g')").run();
  await db.prepare("INSERT INTO sec_passages (passage_id, document_id, section_id, ordinal, kind, text, table_json, fact_refs, chars, text_sha256, change) VALUES ('p2', 'd2', 'now', 1, 'paragraph', 'Revenue grew 30%.', NULL, '[]', 17, 'h', 'changed'), ('p1', 'd1', 'old', 1, 'paragraph', 'Revenue grew 20%.', NULL, '[]', 17, 'g', 'unchanged')").run();
}

test("only periodic and current reports have a profile", () => {
  for (const [form, id] of [["10-Q", "periodic"], ["10-K/A", "periodic"], ["20-F", "periodic"], ["8-K", "current"], ["6-K", "current"]] as const) assert.equal(profileFor(form)?.id, id, form);
  for (const form of ["424B5", "4", "DEF 14A"]) assert.equal(profileFor(form), undefined, form);
});

test("all filings reach the path through its own events; the old tasks are gone", () => {
  const started = Object.values(SUBSCRIPTIONS).flatMap(list => (list ?? []).map(s => s.task as string));
  assert.ok(started.includes("filing-analysis"));
  assert.ok(!(TASK_NAMES as readonly string[]).includes("sec-report"));
  assert.ok(!(TASK_NAMES as readonly string[]).includes("items"));
  assert.ok(SUBSCRIPTIONS["library.prepared"]!.some(s => s.task === "filing-analysis"));
});

test("a run starts a session for a filing whose text is ready and leaves without waiting on it", async () => {
  const db = database();
  await seedLibrary(db, "q", "10-Q");
  const s = sessions();
  const result = await startFilingRuns(env(db), "FOO", { requestedBy: "scheduled" }, { operations: operations([sec("c", "8-K", "2026-11-11"), sec("q", "10-Q", "2026-11-10"), sec("x", "ABS-15G", "2026-11-11"), sec("old", "10-Q", "2026-01-01")]), sessions: s });
  assert.deepEqual(result, { started: ["q"], waiting: ["c"] });
  assert.equal(s.started.length, 1);
  assert.deepEqual(JSON.parse(s.started[0]!.opening).sections, [{ id: "now", path: "MD&A", change: "changed", chars: 20 }]);
  assert.equal((await row(db, "q"))!.status, "running");
  assert.equal(await row(db, "old"), null, "only the latest periodic report is taken up");
  assert.equal(await row(db, "x"), null, "a form with no profile is not registered");
  assert.deepEqual((await dueFilings(db, "FOO", null)).map(r => r.accession), ["c"]);
});

test("a filing that fails stays failed until a manual run, which analyses it again", async () => {
  const db = database();
  await seedLibrary(db, "q", "10-Q");
  const filings = [sec("q", "10-Q", "2026-11-10")];
  await startFilingRuns(env(db), "FOO", { requestedBy: "scheduled" }, { operations: operations(filings), sessions: { start: async () => { throw new Error("no agent"); } } });
  assert.equal((await row(db, "q"))!.status, "failed");
  assert.deepEqual(await dueFilings(db, "FOO", null), []);
  const s = sessions();
  assert.deepEqual((await startFilingRuns(env(db), "FOO", { requestedBy: "scheduled" }, { operations: operations(filings), sessions: s })).started, []);
  const started = await startFilingRuns(env(db), "FOO", { requestedBy: "manual", accession: "q", runId: "filing-1" }, { operations: { ...operations(filings), loadFiling: async () => filings[0] as never }, sessions: s });
  assert.deepEqual(started.started, ["q"]);
  assert.equal(s.started[0]!.id, "filing-1");
  assert.equal((await row(db, "q"))!.status, "running");
});

const spec: FilingSpec = { ticker: "FOO", profile: "periodic", filing: sec("q", "10-Q", "2026-11-10") as never, sessionId: "r-q", jobId: "j", jobVersion: "v", requestedBy: "scheduled" };
async function session(db: D1Database) {
  await seedLibrary(db, "q", "10-Q");
  await startFilingRuns(env(db), "FOO", { requestedBy: "scheduled" }, { operations: operations([sec("q", "10-Q", "2026-11-10")]), sessions: sessions() });
  const recipe = filingRecipe(env(db), spec, PROFILES[0]!, null);
  const state = recipe.open(spec) as FilingState;
  const tools = new Map(recipe.tools(state).map(t => [t.name, t]));
  return { recipe, state, call: async (name: string, args: Record<string, unknown>) => await tools.get(name)!.execute(args as never, { state } as never) as HandResult };
}

test("the session reads this filing and the earlier one, and publishing the report ends it", async () => {
  const db = database();
  const { recipe, state, call } = await session(db);
  assert.match((await call("read_sections", { sectionIds: ["now"] })).observation, /grew 30%/);
  assert.match((await call("read_previous", { sectionIds: JSON.stringify(["now"]) })).observation, /grew 20%/);
  assert.equal((await call("publish_report", { headline: "", report: "" })).error, true);
  assert.equal(recipe.settled(state), false);
  const report = `# Report\n\n${"Long text. ".repeat(4000)}`;
  await call("publish_report", { headline: "Growth sped up", analystView: "Good.", bullets: JSON.stringify(Array.from({ length: 7 }, (_, i) => ({ label: `L${i}`, detail: "needs review" }))), report });
  assert.equal(recipe.settled(state), true);
  assert.equal((await row(db, "q"))!.status, "published");
  const stored = await db.prepare("SELECT payload FROM sec_filing_summaries WHERE accession_number = 'q'").first<{ payload: string }>();
  const summary = JSON.parse(stored!.payload);
  assert.equal(summary.report, report.trim(), "the report is stored whole");
  assert.equal(summary.generatedBy, "pi");
  assert.equal(summary.headline, "Growth sped up");
  assert.equal(summary.bullets.length, 7, "what the model wrote is stored as it wrote it");
  const job = await db.prepare("SELECT status FROM sec_analysis_jobs WHERE job_id = 'j'").first<{ status: string }>();
  assert.equal(job!.status, "complete");
  await recipe.afterRun!(state);
  assert.equal((await row(db, "q"))!.status, "published", "a run that published is left as it is");
});

test("a session that ends without a report records the failure itself", async () => {
  const db = database();
  const { recipe, state } = await session(db);
  await recipe.afterRun!(state);
  const failed = await row(db, "q");
  assert.equal(failed!.status, "failed");
  assert.match(failed!.reason!, /without a report/);
});
