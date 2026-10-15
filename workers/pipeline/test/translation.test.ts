import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { FindingsPublication } from "../../../shared/analysis-contract/findings.ts";
import { proseNumbers } from "../../../shared/analysis-runtime/findings.ts";
import { checkTranslation, collectProse, langOf, localize } from "../../../shared/analysis-runtime/translation.ts";
import type { SecPipelineEnv } from "../src/operations.ts";
import { validateRegistry } from "../src/pipeline/registry.ts";
import { translationsAdmin } from "../src/translation/admin.ts";
import { publishTables, readTranslationTable, sha256, translateBatch, translationPlan, type TranslationSource } from "../src/translation/translate.ts";

/** D1 over node:sqlite with every migration applied, enough for the translator's statements. */
function database(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(file, dir), "utf8").replace(/--> statement-breakpoint/g, ""));
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    run: async () => { sqlite.prepare(sql).run(...values as never[]); return { success: true }; },
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...values as never[]) as T[] }),
    first: async <T>() => (sqlite.prepare(sql).get(...values as never[]) ?? null) as T | null,
  });
  return { prepare: (sql: string) => statement(sql), batch: async (list: Array<{ run(): Promise<unknown> }>) => { for (const s of list) await s.run(); return []; } } as unknown as D1Database;
}

const publication: FindingsPublication = {
  schemaVersion: "findings.v1", ticker: "TEST", periodEnd: "2026-08-31", generatedAt: "2026-09-10T00:00:00Z", model: "m",
  findings: [{
    id: "capex", kind: "risk", severity: 3, title: "Capex outruns operating cash flow",
    judgment: { text: "Capex was $28.5 billion, up 235.2% year over year.", sourceIds: ["s1"] },
    evidence: [{ ref: { capital: "capex" }, periodEnd: "2026-08-31", span: "quarter", compare: "yoy", label: "Capex in the latest quarter" }],
    anchors: { view: "cash", nodeIds: [], metrics: [], capital: ["capex"] },
    lens: { type: "document", document: { rows: [
      { title: "Where the cash goes", cells: [[{ kind: "chart", chart: { id: "c1", aspect: "wide", span: "quarter", periods: 4, title: "Capex against cash flow", series: [{ id: "s", ref: { capital: "capex" }, label: "Capex" }], marks: [{ type: "bar", series: ["s"] }], annotations: [{ series: "s", period: "latest", text: "{value}, {change} on the year" }] } }],
        [{ kind: "quote", materialId: "m1", text: "We expect capital expenditures to remain elevated." }, { kind: "prose", paragraphs: [{ text: "Spending keeps rising.", sourceIds: ["s1"] }] }]] },
    ] } },
    watch: { ref: { capital: "capex" }, condition: "Capex below operating cash flow next quarter.", horizon: "next_quarter" },
  }],
  sources: [{ id: "s1", title: "Form 10-Q for the quarter", url: "https://www.sec.gov/x", kind: "sec", publishedAt: null }],
  highlights: [{ periodEnd: "2026-08-31", profit: [], cash: [{ title: "Free cash flow", ref: { capital: "freeCashFlow" } }], balance: [] }],
};

test("the findings rule collects titles, judgments, lens words and highlights, never quotes, sources or ids", () => {
  const prose = collectProse("findings", publication);
  for (const s of ["Capex outruns operating cash flow", "Capex was $28.5 billion, up 235.2% year over year.", "Capex in the latest quarter", "Where the cash goes",
    "Capex against cash flow", "Capex", "{value}, {change} on the year", "Spending keeps rising.", "Capex below operating cash flow next quarter.", "Free cash flow"]) assert.ok(prose.includes(s), s);
  for (const s of ["We expect capital expenditures to remain elevated.", "Form 10-Q for the quarter", "capex", "TEST", "m"]) assert.ok(!prose.includes(s), s);
});

test("a table replaces only the prose it knows; the structure, ids and the rest stay, and no table returns the same object", () => {
  const table = { "Capex outruns operating cash flow": "资本开支超过经营现金流", "{value}, {change} on the year": "{value}，同比 {change}" };
  const out = localize("findings", publication, table);
  assert.equal(out.findings[0]!.title, "资本开支超过经营现金流");
  assert.equal(out.findings[0]!.id, "capex");
  assert.equal(out.findings[0]!.judgment.text, publication.findings[0]!.judgment.text);
  const doc = out.findings[0]!.lens.type === "document" ? out.findings[0]!.lens.document : null;
  const chart = doc!.rows[0]!.cells[0]![0]!;
  assert.ok(chart.kind === "chart" && chart.chart.annotations![0]!.text === "{value}，同比 {change}");
  assert.equal(publication.findings[0]!.title, "Capex outruns operating cash flow");
  assert.equal(localize("findings", publication, {}), publication);
  assert.equal(langOf("资本开支"), "zh-CN"); assert.equal(langOf("Capex"), "en");
});

test("Chinese amounts read as the figures English prose writes, so verification holds in both languages", () => {
  assert.deepEqual(proseNumbers("Capex was $28.5 billion, up 235.2%, 90.4 pp more; $350 million; 12 months; Q1 FY2027"), [28.5, 235.2, 90.4, 350]);
  assert.deepEqual(proseNumbers("资本开支为 285亿美元，增长 235.2%，多 90.4个百分点；3.5亿美元；12 个月；第 1 季度；2027 财年"), [28.5, 235.2, 90.4, 350]);
  assert.deepEqual(proseNumbers("1700亿美元，5000万美元，123万股"), [170, 50, 1_230_000]);
});

test("a translation must keep every figure, placeholder and markdown line, be Chinese, and add no English", () => {
  assert.deepEqual(checkTranslation("Capex was $28.5 billion, up 235.2% year over year.", "资本开支为 285亿美元，同比增长 235.2%。"), []);
  assert.deepEqual(checkTranslation("{value}, {change} on the year", "{value}，同比 {change}"), []);
  assert.deepEqual(checkTranslation("Oracle Cloud Infrastructure grew 55%.", "Oracle Cloud Infrastructure 增长 55%。"), []);
  assert.match(checkTranslation("Capex was $28.5 billion.", "资本开支为 28.5亿美元。").join(), /figures missing/);
  assert.match(checkTranslation("{value} on the year", "同比").join(), /placeholders/);
  assert.match(checkTranslation("Capex keeps rising fast.", "Capex keeps rising fast.").join(), /not translated/);
  assert.match(checkTranslation("Spending keeps rising.", "支出持续上升，driven by AI。").join(), /English not in the source/);
  assert.match(checkTranslation("## Growth\n- Cloud rose.\n- Margins fell.", "## 增长\n云业务上升，利润率下降。").join(), /outline/);
});

test("the event graph stays valid with the translator subscribed to every publication", () => {
  assert.deepEqual(validateRegistry(), []);
});

test("a run translates each new string once, rejects one that fails its checks, remembers both, and publishes a table per resource", async () => {
  const db = database();
  const env = { DB: db, TRANSLATION_DAILY_CALLS: "10" } as unknown as SecPipelineEnv;
  const sources: TranslationSource[] = [
    { resource: "findings", scope: "", strings: ["Capex outruns operating cash flow", "Capex was $28.5 billion."] },
    { resource: "events", scope: "", strings: ["Capex outruns operating cash flow", "Results beat guidance."] },
  ];
  const read = async () => sources;
  const plan = await translationPlan(db, "TEST", "zh-CN", read);
  assert.equal(plan!.batches.flat().length, 3, "a string shared by two resources is translated once");
  const calls: string[][] = [];
  const answers: Record<string, string> = { "Capex outruns operating cash flow": "资本开支超过经营现金流", "Results beat guidance.": "业绩超出指引。", "Capex was $28.5 billion.": "资本开支为 28.5亿美元。" };
  const result = await translateBatch(env, "TEST", "run", plan!.batches.flat(), async (_stage, items) => {
    calls.push(items.map(i => i.text));
    return new Map(items.map(i => [i.i, answers[i.text]!]));
  });
  assert.deepEqual(result, { ready: 2, rejected: 1 });
  assert.equal(calls.length, 2, "the failing translation gets one corrective call");
  assert.deepEqual(calls[1], ["Capex was $28.5 billion."]);
  const published = await publishTables(db, "TEST", "zh-CN", read);
  assert.deepEqual(published, { tables: 2, translated: 3, total: 4 });
  assert.deepEqual(await readTranslationTable(db, "zh-CN", "events", "TEST"), { "Capex outruns operating cash flow": "资本开支超过经营现金流", "Results beat guidance.": "业绩超出指引。" });
  assert.equal(await translationPlan(db, "TEST", "zh-CN", read), null, "nothing is left to do, and the rejected string is not paid for again");
  const row = await db.prepare("SELECT status, problems FROM i18n_strings WHERE source_sha256 = ?").bind(await sha256("Capex was $28.5 billion.")).first<{ status: string; problems: string }>();
  assert.equal(row!.status, "rejected"); assert.match(row!.problems, /figures/);
  sources[0]!.strings.push("Margins narrowed.");
  assert.equal((await translationPlan(db, "TEST", "zh-CN", read))!.batches.flat().length, 1, "a new string is the only work");
});

test("the admin sees each resource's coverage, today's calls and every string with its translation or the reasons it failed", async () => {
  const db = database();
  const env = { DB: db, TRANSLATION_DAILY_CALLS: "10", DEEPSEEK_API_KEY: "k" } as unknown as SecPipelineEnv;
  const sources: TranslationSource[] = [{ resource: "findings", scope: "", strings: ["Backlog lengthens", "Capex was $28.5 billion.", "Margins narrowed."] }];
  const read = async () => sources;
  const plan = await translationPlan(db, "TEST", "zh-CN", read);
  const answers: Record<string, string> = { "Backlog lengthens": "订单储备拉长", "Capex was $28.5 billion.": "资本开支为 28.5亿美元。" };
  await translateBatch(env, "TEST", "run", plan!.batches.flat().filter(i => i.text !== "Margins narrowed."), async (_s, items) => new Map(items.map(i => [i.i, answers[i.text]!])));
  await publishTables(db, "TEST", "zh-CN", read);
  const admin = await translationsAdmin(env, "TEST", new Date(), "zh-CN", read);
  assert.deepEqual(admin.resources.map(r => [r.resource, r.total, r.translated, r.rejected, !!r.publishedAt]), [["findings", 3, 1, 1, true]]);
  assert.deepEqual(admin.entries.map(e => e.status), ["rejected", "pending", "ready"]);
  assert.match(admin.entries[0]!.problems.join(), /figures/);
  assert.equal(admin.entries[2]!.text, "订单储备拉长");
  assert.equal(admin.budget.used, 2); assert.equal(admin.budget.cap, 10); assert.equal(admin.enabled, true); assert.equal(admin.run, null);
});
