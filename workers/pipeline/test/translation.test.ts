import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { FindingsPublication } from "../../../shared/analysis-contract/findings.ts";
import { proseNumbers } from "../../../shared/analysis-runtime/findings.ts";
import { checkTranslation, collectProse, langOf, localize, normalizeTranslation } from "../../../shared/analysis-runtime/translation.ts";
import type { SecPipelineEnv } from "../src/operations.ts";
import { validateRegistry } from "../src/pipeline/registry.ts";
import { translationsAdmin } from "../src/translation/admin.ts";
import { ModelUnavailable, publishTables, readTranslationTable, sha256, translateBatch, translationPlan, type TranslationSource } from "../src/translation/translate.ts";

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
  const env = { DB: db, TRANSLATION_DAILY_CALLS: "10", ANTHROPIC_API_KEY: "k" } as unknown as SecPipelineEnv;
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

test("a model that gives no answer marks nothing: the strings stay pending, the run stops, and rows an earlier release wrongly rejected are retried", async () => {
  const db = database();
  const env = { DB: db, TRANSLATION_DAILY_CALLS: "10" } as unknown as SecPipelineEnv;
  const read = async (): Promise<TranslationSource[]> => [{ resource: "events", scope: "", strings: ["Results beat guidance.", "Margins narrowed."] }];
  const plan = await translationPlan(db, "TEST", "zh-CN", read);
  const result = await translateBatch(env, "TEST", "run", plan!.batches.flat(), async () => { throw new ModelUnavailable("stream_stall"); });
  assert.deepEqual(result, { ready: 0, rejected: 0, stopped: "unavailable" });
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM i18n_strings").first<{ n: number }>())!.n, 0);
  assert.equal((await translationPlan(db, "TEST", "zh-CN", read))!.batches.flat().length, 2);
  await db.prepare("INSERT INTO i18n_strings (locale, source_sha256, source, text, status, problems, version, model, created_at) VALUES ('zh-CN', ?, 'Results beat guidance.', NULL, 'rejected', ?, 'translate.v1', 'm', 'x')")
    .bind(await sha256("Results beat guidance."), JSON.stringify(["no translation returned"])).run();
  assert.equal((await translationPlan(db, "TEST", "zh-CN", read))!.batches.flat().length, 2, "an unanswered rejection is still pending");
  const omitted = await translateBatch(env, "TEST", "run", plan!.batches.flat(), async (_s, items) => new Map(items.filter(i => i.text === "Results beat guidance.").map(i => [i.i, "业绩超出指引。"])));
  assert.deepEqual(omitted, { ready: 1, rejected: 1 });
  assert.equal(await translationPlan(db, "TEST", "zh-CN", read) == null || (await translationPlan(db, "TEST", "zh-CN", read))!.batches.length === 0, true, "a string the model left out of a real answer is settled, not retried forever");
});

test("the checker compares figures at full value, so unit changes, ordinals, possessives and standard abbreviations pass, and a wrong scale does not", () => {
  const ok: Array<[string, string]> = [
    ["The restructuring table shows fiscal 2026 plan costs of $1,640 million, cash payments of $1,236 million.", "重组表显示 2026 财年计划成本为 16.40亿美元，现金支付为 12.36亿美元。"],
    ["About 12% of the $638 billion RPO over the next twelve months, 34% over months 13-36, 34% over months 37-60.", "6380亿美元 RPO 中约 12% 在未来十二个月内确认，34% 在第 13 至 36 个月，34% 在第 37 至 60 个月。"],
    ["A Rule 10b5-1 plan permits sales of up to 50 million shares, about 1.65% of shares outstanding; one of its CEOs is named.", "Rule 10b5-1 计划允许出售最多 5000万股，约占流通股的 1.65%；其一位 CEO 被点名。"],
    ["Claimant TPC seeks €100 per user under article 82 GDPR.", "原告 TPC 依据 GDPR 第 82 条要求每位用户赔偿 100欧元。"],
    ["Oracle's remaining performance obligations rose to $638 billion.", "Oracle 的剩余履约义务（RPO）增至 6380亿美元。"],
    ["PP&E is depreciated over lives from one to 40 years.", "不动产、厂房和设备按 1 至 40 年的使用寿命计提折旧。"],
  ];
  for (const [en, zh] of ok) assert.deepEqual(checkTranslation(en, normalizeTranslation(zh)), [], en);
  assert.match(checkTranslation("Capex was $28.5 billion.", "资本开支为 28.5亿美元。").join(), /figures missing: 28.5/);
  assert.equal(normalizeTranslation("下降 0.21 个百分点，增至 28.5 亿美元，5000 万股"), "下降 0.21个百分点，增至 28.5亿美元，5000万股");
  assert.deepEqual(collectProse("events", { summary: { headline: "公司预计营收增长。" } }), [], "text already in Chinese is not sent");
});
