import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { z } from "zod";
import { documentHtml } from "../workers/analysis/src/artifact/document.ts";
import { filingReportSemantics } from "../workers/analysis/src/filing-analysis/semantic-audit.ts";

const args = process.argv.slice(2);
const option = (name: string) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const base = (option("--base-url") ?? "http://127.0.0.1:8799").replace(/\/$/, "");
const output = resolve(option("--output") ?? ".audit/amzn-sec-material-acceptance");
const key = process.env[option("--key-env") ?? "SEC_ACCEPTANCE_KEY"];
const maxMinutes = Number(option("--timeout-minutes") ?? "240");
const deadline = Date.now() + maxMinutes * 60_000;
const materialRefSchema = z.object({ ticker: z.string(), accession: z.string(), version: z.string() });
const semanticAuditPointerSchema = z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/), key: z.string().min(1), verdict: z.literal("pass"), complete: z.literal(true) });
const reportBlockSchema = z.object({ id: z.string(), title: z.string(), sources: z.array(z.string()), html: z.string(), state: z.enum(["draft", "passed", "conservative", "safe-layout"]) }).passthrough();
const documentSchema = z.object({ schema: z.literal("analysis-artifact.v1"), kind: z.literal("filing-report"), ticker: z.string(), subject: z.string(), version: z.number().int(),
  lang: z.string(), title: z.string(), blocks: z.array(reportBlockSchema),
  charts: z.array(z.object({ id: z.string(), title: z.string(), svg: z.string(), points: z.array(z.object({ series: z.string(), period: z.string(), text: z.string() })) }).passthrough()),
  sources: z.array(z.object({ id: z.string(), title: z.string(), url: z.string().nullable(), kind: z.enum(["sec", "web", "data"]) }).passthrough()) }).passthrough();
const modelCallSchema = z.object({ at: z.string(), runId: z.string().nullable(), stage: z.string(), provider: z.string(), model: z.string(), reasoning: z.string().nullable(),
  inputTokens: z.number().int().nonnegative(), cachedTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), reasoningTokens: z.number().int().nonnegative().nullable(), durationMs: z.number().int().nonnegative(), outcome: z.enum(["ok", "error", "timeout"]) }).strict();
const semanticReportSchema = z.array(z.object({ id: z.string(), title: z.string(), text: z.string(), attributes: z.array(z.unknown()), sources: z.array(z.string()), bindings: z.array(z.unknown()), charts: z.array(z.string()) }).passthrough());
const semanticReceiptSchema = z.object({ digest: z.string(), model: z.string().nullable(), policy: z.string(), policyHash: z.string(), evidenceHash: z.string(), requestHash: z.string(), at: z.string(),
  input: z.object({ materials: z.array(materialRefSchema), report: semanticReportSchema, computations: z.array(z.object({ id: z.string() }).passthrough()), evidence: z.unknown(), aliases: z.record(z.string(), z.string()) }).passthrough(),
  answer: z.object({ verdict: z.literal("pass"), complete: z.literal(true), summary: z.string(), issues: z.array(z.unknown()).length(0),
    computations: z.array(z.object({ id: z.string(), status: z.literal("holds"), problem: z.string().min(1), sources: z.array(z.string()).min(1) }).passthrough()) }).passthrough() }).passthrough();
const entrySchema = z.object({ filing: z.object({ ticker: z.string(), form: z.string(), filingDate: z.string(), accessionNumber: z.string() }).passthrough(), sessionId: z.string(), material: z.unknown() }).passthrough();
const runSchema = z.object({ id: z.string(), discoveredAt: z.string(), entries: z.array(entrySchema) }).passthrough();
const statusSchema = z.array(z.object({ filing: z.object({ accessionNumber: z.string(), form: z.string() }).passthrough(), sessionId: z.string(),
  material: z.object({ status: z.string() }).passthrough().nullable(), analysis: z.object({ status: z.string(), reason: z.string().nullable(), run_id: z.string().nullable() }).passthrough().nullable(),
  complete: z.boolean(), passed: z.boolean(), issues: z.array(z.string()), calls: z.number() }).passthrough());
const markdownSchema = z.object({ key: z.string(), bytes: z.number().int().nonnegative(), chars: z.number().int().nonnegative() });
const textRangeSchema = z.object({ anchorOffset: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), length: z.number().int().nonnegative(), chars: z.number().int().nonnegative(), sha256: z.string() });
const tableCatalogSchema = z.array(z.object({ tableId: z.string(), documentId: z.string(), title: z.string(), description: z.string(), filename: z.string(),
  csvKey: z.string(), sha256: z.string(), sourceUrl: z.string(), anchor: z.string(), form: z.string(), filedAt: z.string(), reportDate: z.string(),
  unit: z.string().nullable(), notes: z.array(z.string()), rowHeader: z.string(), columns: z.array(z.string()), rowCount: z.number().int().nonnegative(), columnCount: z.number().int().positive(),
  locator: z.object({ start: z.number().nullable(), end: z.number().nullable(), page: z.number().nullable() }), markdownRange: textRangeSchema.nullable() }).passthrough());
const exportSchema = z.object({ filing: entrySchema.shape.filing,
  snapshot: z.object({ format: z.literal("filing-material.index.v2"), ref: materialRefSchema, markdown: markdownSchema,
    blocks: z.array(z.object({ id: z.string(), range: textRangeSchema.nullable() }).passthrough()),
    coverage: z.unknown(), documents: z.array(z.unknown()), tables: z.array(z.object({ tableId: z.string(), filename: z.string(), description: z.string() }).passthrough()) }).passthrough(),
  csvFiles: z.array(z.object({ tableId: z.string(), filename: z.string(), csv: z.string(), sha256: z.string() })),
  tableCatalog: tableCatalogSchema,
  artifact: z.object({ title: z.string(), html: z.string(), css: z.string(), hash: z.string() }).passthrough(),
  document: documentSchema, work: z.object({ material: materialRefSchema, periodic: z.object({ materials: z.array(materialRefSchema), semanticAuditReceipt: semanticAuditPointerSchema }).passthrough() }).passthrough(),
  semanticAuditReceipt: semanticAuditPointerSchema, modelCalls: z.array(modelCallSchema),
  formalRead: z.unknown(), turns: z.array(z.unknown()), checks: z.array(z.unknown()), recheck: z.unknown(),
  sourceCheck: z.object({ markdownRead: z.boolean(), tablesRead: z.array(z.string()), successfulTools: z.record(z.string(), z.number().int().nonnegative()), citations: z.array(z.unknown()), claims: z.array(z.unknown()) }).passthrough(),
  preprocessing: z.object({ currentMaterialRunId: z.string(), receipts: z.array(z.object({ index: z.number().int(), key: z.string(), inputHash: z.string(), decisions: z.array(z.unknown()), tableDescriptions: z.array(z.unknown()) }).passthrough()),
    modelCalls: z.array(z.unknown()), currentMaterialModelCalls: z.number().int().nonnegative() }).passthrough(),
  status: z.object({ passed: z.boolean(), issues: z.array(z.string()) }).passthrough(),
}).passthrough();

async function request(path: string, body?: unknown): Promise<unknown> {
  const headers = new Headers({ "content-type": "application/json" });
  if (key) headers.set("x-acceptance-key", key);
  const response = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10 * 60_000) });
  const type = response.headers.get("content-type") ?? "unknown";
  const text = await response.text();
  if (!type.toLowerCase().includes("json")) {
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1] ?? text.replace(/<[^>]*>/g, " ");
    throw new Error(`Acceptance ${path} HTTP ${response.status}, expected JSON but received ${type}: ${title.replace(/\s+/g, " ").trim().slice(0, 300)}`);
  }
  let content: unknown;
  try { content = JSON.parse(text); }
  catch { throw new Error(`Acceptance ${path} HTTP ${response.status}, invalid JSON response (${type})`); }
  if (!response.ok) throw new Error(`Acceptance ${path} HTTP ${response.status}: ${JSON.stringify(content)}`);
  return content;
}

function assertTime(): void {
  if (Date.now() > deadline) throw new Error(`Acceptance did not finish within ${maxMinutes} minutes`);
}

async function saveJson(path: string, data: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
}

async function downloadMarkdown(runId: string, accession: string, snapshot: z.infer<typeof exportSchema>["snapshot"], directory: string): Promise<void> {
  const path = `/acceptance/file?runId=${encodeURIComponent(runId)}&accession=${encodeURIComponent(accession)}&kind=markdown`;
  const headers = new Headers();
  if (key) headers.set("x-acceptance-key", key);
  const response = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(10 * 60_000) });
  const type = response.headers.get("content-type") ?? "unknown";
  if (!response.ok || !type.toLowerCase().startsWith("text/markdown")) throw new Error(`Acceptance ${path} HTTP ${response.status}, expected Markdown but received ${type}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const text = decoder.decode(bytes);
  if (bytes.byteLength !== snapshot.markdown.bytes || text.length !== snapshot.markdown.chars) throw new Error(`Downloaded Markdown length differs from material index for ${accession}`);
  let checkedRanges = 0;
  for (const block of snapshot.blocks) {
    const range = block.range;
    if (!range) continue;
    if (range.anchorOffset > range.offset || range.offset + range.length > bytes.byteLength) throw new Error(`Markdown source range is outside the file: ${block.id}`);
    const body = bytes.subarray(range.offset, range.offset + range.length);
    if (createHash("sha256").update(body).digest("hex") !== range.sha256 || decoder.decode(body).length !== range.chars) throw new Error(`Markdown source range differs from material index: ${block.id}`);
    checkedRanges++;
  }
  await writeFile(join(directory, "filing.md"), bytes);
  await saveJson(join(directory, "markdown-check.json"), { bytes: bytes.byteLength, chars: text.length, checkedRanges, sha256: createHash("sha256").update(bytes).digest("hex") });
}

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const stable = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

async function downloadSemanticAudit(runId: string, payload: z.infer<typeof exportSchema>, directory: string): Promise<void> {
  const accession = payload.filing.accessionNumber;
  const path = `/acceptance/file?runId=${encodeURIComponent(runId)}&accession=${encodeURIComponent(accession)}&kind=semantic-audit`;
  const headers = new Headers();
  if (key) headers.set("x-acceptance-key", key);
  const response = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(10 * 60_000) });
  const type = response.headers.get("content-type") ?? "unknown";
  if (!response.ok || !type.toLowerCase().includes("json")) throw new Error(`Acceptance ${path} HTTP ${response.status}, expected JSON but received ${type}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await writeFile(join(directory, "semantic-audit.json"), bytes);
  const receipt = semanticReceiptSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  const pointer = payload.work.periodic.semanticAuditReceipt;
  if (stable(pointer) !== stable(payload.semanticAuditReceipt) || receipt.digest !== pointer.digest
    || pointer.key !== `filing-semantic-audits/${payload.work.material.ticker}/${accession}/${receipt.digest}.json`) throw new Error(`Semantic audit pointer differs from accepted work: ${accession}`);
  if (digest(JSON.stringify({ model: receipt.model, policyHash: receipt.policyHash, evidenceHash: receipt.evidenceHash, requestHash: receipt.requestHash })) !== receipt.digest) throw new Error(`Semantic audit digest differs from recorded hashes: ${accession}`);
  if (digest(JSON.stringify({ evidence: receipt.input.evidence, aliases: receipt.input.aliases })) !== receipt.evidenceHash) throw new Error(`Semantic audit evidence differs from its recorded hash: ${accession}`);
  const material = payload.work.material;
  if (stable(material) !== stable(payload.snapshot.ref) || material.accession !== accession || material.ticker !== payload.filing.ticker) throw new Error(`Semantic audit work material differs from accepted filing: ${accession}`);
  const pinned = new Set([material, ...payload.work.periodic.materials].map(stable));
  if (!receipt.input.materials.some(ref => stable(ref) === stable(material)) || receipt.input.materials.some(ref => !pinned.has(stable(ref)) || ref.accession === accession && stable(ref) !== stable(material))) throw new Error(`Semantic audit uses material outside accepted work: ${accession}`);
  const document = payload.document;
  if (document.ticker !== material.ticker || document.subject !== accession || documentHtml(document) !== payload.artifact.html
    || digest(`${payload.artifact.html}\n${payload.artifact.css}`) !== payload.artifact.hash) throw new Error(`Published report differs from exported document: ${accession}`);
  const report = filingReportSemantics({ composer: { blocks: document.blocks } });
  if (stable(report) !== stable(receipt.input.report)) throw new Error(`Semantic audit report differs from published report: ${accession}`);
  const inputIds = receipt.input.computations.map(computation => computation.id).sort();
  const reviewIds = receipt.answer.computations.map(computation => computation.id).sort();
  if (new Set(inputIds).size !== inputIds.length || new Set(reviewIds).size !== reviewIds.length || stable(inputIds) !== stable(reviewIds)) throw new Error(`Semantic audit did not review every used computation exactly once: ${accession}`);
  await saveJson(join(directory, "semantic-audit-check.json"), { passed: true, pointer, bytes: bytes.byteLength, sha256: digest(bytes), evidenceHash: receipt.evidenceHash,
    requestHash: receipt.requestHash, policyHash: receipt.policyHash, reportBlocks: report.length, computations: inputIds.length,
    checks: ["work-pointer", "digest", "evidence-hash", "pinned-materials", "published-html-hash", "published-report-semantics", "complete-pass", "zero-issues", "exact-computation-coverage", "all-computations-hold"],
    hashMeaning: "The evidence hash and receipt digest were independently recomputed. Request and policy hashes are recorded from the immutable receipt." });
}

await mkdir(output, { recursive: true });
const health = z.object({ modelConfigured: z.boolean(), judgeConfigured: z.boolean(), browserConfigured: z.boolean(), aiConfigured: z.boolean() }).passthrough().parse(await request("/acceptance/health"));
await saveJson(join(output, "health.json"), health);
if (!health.modelConfigured || !health.judgeConfigured || !health.browserConfigured || !health.aiConfigured) throw new Error("Real model, judge, Browser Rendering and Workers AI bindings are required");

const resumed = option("--run-id");
const run = resumed ? runSchema.parse(JSON.parse(await readFile(join(output, "run.json"), "utf8"))) : runSchema.parse(await request("/acceptance/discover", {}));
if (resumed && run.id !== resumed) throw new Error("--run-id does not match output/run.json");
await saveJson(join(output, "run.json"), run);
console.log(JSON.stringify({ event: "acceptance-start", runId: run.id, filings: run.entries.map(entry => entry.filing), output }));

for (const entry of run.entries) {
  let ready = false;
  while (!ready) {
    assertTime();
    const result = z.array(z.object({ accession: z.string(), state: z.object({ status: z.string() }).passthrough() })).parse(await request("/acceptance/prepare", { runId: run.id, accession: entry.filing.accessionNumber, maxDocuments: 8 }));
    const state = result.find(item => item.accession === entry.filing.accessionNumber)!.state;
    console.log(JSON.stringify({ event: "material-progress", accession: entry.filing.accessionNumber, status: state.status, progress: state.progress, material: state.ref }));
    await appendFile(join(output, "material-progress.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), runId: run.id, accession: entry.filing.accessionNumber, ...state })}\n`);
    await saveJson(join(output, `${entry.filing.form}-material-status.json`), state);
    if (state.status === "blocked") throw new Error(`Material blocked for ${entry.filing.accessionNumber}: ${JSON.stringify(state)}`);
    ready = state.status === "ready";
    if (ready) { entry.material = state.ref; await saveJson(join(output, "run.json"), run); }
    else await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

const before = statusSchema.parse(await request(`/acceptance/status?runId=${encodeURIComponent(run.id)}`));
for (const entry of run.entries) {
  const status = before.find(item => item.sessionId === entry.sessionId);
  if (status?.analysis?.run_id === entry.sessionId) continue;
  await request("/acceptance/start", { runId: run.id, accession: entry.filing.accessionNumber });
}

let finalStatus: z.infer<typeof statusSchema> = [];
let last = "";
while (true) {
  assertTime();
  finalStatus = statusSchema.parse(await request(`/acceptance/status?runId=${encodeURIComponent(run.id)}`));
  await saveJson(join(output, "status.json"), finalStatus);
  const progress = finalStatus.map(item => ({ form: item.filing.form, sessionId: item.sessionId, calls: item.calls, complete: item.complete, passed: item.passed, analysis: item.analysis, issues: item.issues }));
  const line = JSON.stringify(progress);
  if (line !== last) { console.log(JSON.stringify({ event: "report-progress", entries: progress })); last = line; }
  if (finalStatus.every(item => item.complete)) break;
  if (finalStatus.some(item => item.analysis?.status === "failed")) {
    await saveJson(join(output, "failed-run-records.json"), await request(`/acceptance/records?runId=${encodeURIComponent(run.id)}`));
    throw new Error("A real report session failed; inspect status.json and failed-run-records.json");
  }
  await new Promise(resolve => setTimeout(resolve, 5000));
}

const verdicts: Array<{ form: string; accession: string; passed: boolean; issues: string[]; directory: string }> = [];
for (const entry of run.entries) {
  const payload = exportSchema.parse(await request(`/acceptance/export?runId=${encodeURIComponent(run.id)}&accession=${encodeURIComponent(entry.filing.accessionNumber)}`));
  const directory = join(output, `${entry.filing.filingDate}_${entry.filing.form}_${entry.filing.accessionNumber}`);
  await mkdir(directory, { recursive: true });
  await downloadMarkdown(run.id, entry.filing.accessionNumber, payload.snapshot, directory);
  await downloadSemanticAudit(run.id, payload, directory);
  await saveJson(join(directory, "manifest.json"), payload.snapshot.documents);
  await saveJson(join(directory, "coverage.json"), payload.snapshot.coverage);
  await saveJson(join(directory, "snapshot.json"), payload.snapshot);
  await saveJson(join(directory, "tables.json"), payload.tableCatalog);
  for (const table of payload.csvFiles) {
    if (createHash("sha256").update(table.csv, "utf8").digest("hex") !== table.sha256) throw new Error(`Downloaded CSV hash differs from the source table: ${table.tableId}`);
    const folder = join(directory, "tables", table.tableId);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, table.filename.replace(/[\\/]/g, "_")), table.csv);
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${payload.artifact.title.replace(/[<>&]/g, "")}</title><style>${payload.artifact.css}</style></head><body>${payload.artifact.html}</body></html>`;
  await writeFile(join(directory, "report.html"), html);
  await saveJson(join(directory, "report.json"), payload.document);
  await saveJson(join(directory, "formal-read.json"), payload.formalRead);
  await saveJson(join(directory, "work.json"), payload.work);
  await saveJson(join(directory, "turns.json"), payload.turns);
  await saveJson(join(directory, "checks.json"), payload.checks);
  await saveJson(join(directory, "model-calls.json"), payload.modelCalls);
  await saveJson(join(directory, "recheck.json"), payload.recheck);
  await saveJson(join(directory, "source-check.json"), payload.sourceCheck);
  await saveJson(join(directory, "preprocessing.json"), payload.preprocessing);
  await saveJson(join(directory, "verdict.json"), payload.status);
  verdicts.push({ form: entry.filing.form, accession: entry.filing.accessionNumber, passed: payload.status.passed, issues: payload.status.issues, directory });
}
await saveJson(join(output, "verdict.json"), { runId: run.id, finishedAt: new Date().toISOString(), passed: verdicts.every(item => item.passed), entries: verdicts });
console.log(JSON.stringify({ event: "acceptance-finished", runId: run.id, entries: verdicts }));
if (verdicts.some(item => !item.passed)) process.exitCode = 1;
