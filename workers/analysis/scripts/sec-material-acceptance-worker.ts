import { z } from "zod";
import { edgarListings } from "../src/sec-archive/index.ts";
import { secArchiveDocumentUrl, secArchiveRoot } from "../../../shared/analysis-runtime/sec-sources.ts";
import { createAnalysisOperations, type AnalysisEnv } from "../src/operations.ts";
import { D1SecRepository } from "../src/sec/d1.ts";
import type { SecFiling } from "../src/sec/sec.ts";
import type { MaterialBlock, MaterialRef, MaterialSnapshot } from "../../../shared/analysis-contract/filing-material.ts";
import { requestFilingMaterial, prepareFilingMaterial, getFilingMaterial, readMaterialSnapshot } from "../src/filing-material/index.ts";
import { filingMaterialMeta, materialBlockId } from "../src/filing-material/read.ts";
import { readSourceBytes } from "../src/filing-material/archive.ts";
import { organizationBatches, organizationCacheKey, parseOrganizationReceipt } from "../src/filing-material/prepare.ts";
import { MATERIAL_PREFIX, materialBase, materialDigest } from "../src/filing-material/store.ts";
import { tableCatalogEntry, verifyTableCsv } from "../../../shared/analysis-runtime/filing-material.ts";
import { startFilingRuns } from "../src/filing-analysis/start.ts";
import type { FilingWork } from "../src/filing-analysis/recipe.ts";
import { filingSemanticAudit, filingSemanticInput, filingSemanticRequest, type FilingAuditState } from "../src/filing-analysis/semantic-audit.ts";
import { openComposer } from "../src/artifact/document.ts";
import { filingSessions } from "../src/durable-runs/binding.ts";
import { readPreview, readPublishedArtifact, readPublishedDocument, readWorkState } from "../src/artifact/store.ts";
import { recheckFiling } from "../src/filing-analysis/recheck.ts";
import { PERIODIC_BLOCKS } from "../src/filing-analysis/periodic.ts";
import { handleMapRead } from "../src/read-api/router.ts";
import type { ArtifactDocument, PublishedArtifact } from "../../../shared/analysis-contract/artifact.ts";
import type { StoredArtifact } from "../src/artifact/store.ts";
import type { AiUsageRow } from "../src/ai-runs/usage.ts";

export { TaskRunner } from "../src/durable-runs/runner.ts";
export { StageAgent } from "../src/stage/agent.ts";

type Env = AnalysisEnv & { ASSETS?: Fetcher; SEC_ACCEPTANCE_KEY?: string; ACCEPTANCE_STORAGE_MODE?: "isolated" | "production" };
type Entry = { filing: SecFiling; sessionId: string; material: MaterialRef | null };
type Run = { id: string; discoveredAt: string; entries: Entry[] };
type Summary = { run_id: string; status: string; settled_by: string | null; tools: string; degraded: string; detail: string; blocks: number };
type Turn = { turn: number; action: string; input: string; failed: number; at: string };
const requestSchema = z.object({ runId: z.string().min(1), accession: z.string().optional(), maxDocuments: z.number().int().positive().optional() });
const submissionsSchema = z.object({ name: z.string(), filings: z.object({ recent: z.object({
  accessionNumber: z.array(z.string()), form: z.array(z.string()), filingDate: z.array(z.string()),
  reportDate: z.array(z.string()), acceptanceDateTime: z.array(z.string()), primaryDocument: z.array(z.string()),
  items: z.array(z.string()).optional(), primaryDocDescription: z.array(z.string()).optional(),
}) }) });
const runKey = (id: string) => `acceptance:amzn:run:${id}`;
const forbidden = new Set(["research_pack", "read_section", "read_sections", "read_filing_section", "find_sections", "find_filing_sections", "read_report"]);
const needed = ["read_filing_markdown", "find_filing_tables", "read_filing_table", "compute", "finish"];
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const sameMaterial = (a: MaterialRef, b: MaterialRef) => a.ticker === b.ticker && a.accession === b.accession && a.version === b.version;
const organizationMigrationPrefix = (ref: MaterialRef) => `${MATERIAL_PREFIX}${ref.ticker}/${ref.accession}/organization/migrations/`;
const organizationMigrationSchema = z.object({ material: z.object({ ticker: z.string(), accession: z.string(), version: z.string() }), modelRunId: z.string(), complete: z.literal(true),
  receipts: z.array(z.object({ index: z.number().int(), key: z.string(), status: z.string(), blocks: z.number().int(), decisions: z.number().int() })) });

async function loadRun(env: Env, id: string): Promise<Run> {
  const run = (await new D1SecRepository(env.DB!).getCache<Run>(runKey(id)))?.payload;
  if (!run) throw new Error(`Unknown acceptance run ${id}`);
  return run;
}

async function saveRun(env: Env, run: Run): Promise<void> {
  await new D1SecRepository(env.DB!).setCache(runKey(run.id), run, new Date().toISOString());
}

async function discover(env: Env): Promise<Run> {
  const data = submissionsSchema.parse(await edgarListings(env).submissions("0001018724"));
  const recent = data.filings.recent;
  const id = `amzn-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const entries: Entry[] = [];
  for (const form of ["8-K", "10-K"]) {
    const i = recent.form.map((value, index) => ({ value, index })).filter(item => item.value === form)
      .sort((a, b) => recent.acceptanceDateTime[b.index]!.localeCompare(recent.acceptanceDateTime[a.index]!))[0]?.index;
    if (i === undefined) throw new Error(`SEC recent submissions has no ${form}`);
    const accession = recent.accessionNumber[i]!, root = secArchiveRoot(1018724, accession), primary = recent.primaryDocument[i]!;
    const filing: SecFiling = { ticker: "AMZN", cik: "0001018724", cikNumber: 1018724, companyName: data.name,
      form, filingDate: recent.filingDate[i]!, reportDate: recent.reportDate[i]!, accessionNumber: accession,
      primaryDocument: primary, description: recent.primaryDocDescription?.[i] ?? form, items: recent.items?.[i] ?? "",
      documentUrl: secArchiveDocumentUrl(root, primary), indexUrl: secArchiveDocumentUrl(root, `${accession}-index.htm`) };
    const repository = new D1SecRepository(env.DB!);
    await repository.upsertFilingIndex(filing);
    await requestFilingMaterial(env, filingMaterialMeta(filing));
    entries.push({ filing, sessionId: `${id}-${form.replace(/[^A-Za-z0-9]/g, "")}`, material: null });
  }
  const run = { id, discoveredAt: new Date().toISOString(), entries };
  await saveRun(env, run);
  return run;
}

function chosen(run: Run, accession?: string): Entry[] {
  const entries = accession ? run.entries.filter(entry => entry.filing.accessionNumber === accession) : run.entries;
  if (!entries.length) throw new Error("Accession is not part of this acceptance run");
  return entries;
}

async function runStatus(env: Env, run: Run) {
  return Promise.all(run.entries.map(async entry => {
    const accession = entry.filing.accessionNumber, artifactId = `filing-report:AMZN:${accession}`;
    const [material, summary, turns, analysis, artifact, document] = await Promise.all([
      getFilingMaterial(env, "AMZN", accession),
      env.DB!.prepare("SELECT * FROM filing_run_summary WHERE run_id = ?").bind(entry.sessionId).first<Summary>(),
      env.DB!.prepare("SELECT turn, action, input, failed, at FROM filing_run_turns WHERE run_id = ? ORDER BY id").bind(entry.sessionId).all<Turn>(),
      env.DB!.prepare("SELECT status, reason, run_id FROM filing_analyses WHERE ticker = 'AMZN' AND accession_number = ?").bind(accession).first<{ status: string; reason: string | null; run_id: string | null }>(),
      readPublishedArtifact(env, "filing-report", "AMZN", accession),
      readPublishedDocument(env, "filing-report", "AMZN", accession),
    ]);
    const active = analysis?.run_id === entry.sessionId;
    const version = artifact ? await env.DB!.prepare("SELECT run_id FROM analysis_artifact_versions WHERE artifact_id = ? AND version = ?").bind(artifactId, artifact.version).first<{ run_id: string | null }>() : null;
    const actions = turns.results.map(turn => turn.action), tools: Record<string, number> = summary ? JSON.parse(summary.tools) : {};
    const issues: string[] = [];
    if (summary) {
      if (summary.status !== "published") issues.push(`run status ${summary.status}`);
      if (summary.settled_by !== "agent") issues.push(`settled by ${summary.settled_by ?? "unknown"}`);
      if (JSON.parse(summary.degraded).length || artifact?.degraded.length) issues.push("report contains degraded blocks");
      for (const name of needed) if (!turns.results.some(turn => turn.action === name && turn.failed === 0)) issues.push(`required tool not completed successfully: ${name}`);
      for (const name of actions) if (forbidden.has(name)) issues.push(`legacy tool called: ${name}`);
      if (!artifact || !document?.blocks.length) issues.push("published report is missing");
      if (version?.run_id !== entry.sessionId) issues.push("published artifact does not belong to the fresh run");
      if (entry.filing.form === "10-K") for (const name of ["summary", "highlights", "risks", "overlooked", "versus-prior", "what-to-watch"]) {
        if (!document?.blocks.some(block => block.id === name)) issues.push(`required report block missing: ${name}`);
      }
    }
    const session = active ? await filingSessions(env)?.report(entry.sessionId).catch(error => ({ error: error instanceof Error ? error.message : String(error) })) : null;
    return { filing: entry.filing, sessionId: entry.sessionId, material, analysis, summary, tools, calls: turns.results.length,
      artifact: artifact ? { id: artifact.id, version: artifact.version, hash: artifact.hash, degraded: artifact.degraded } : null,
      session, complete: !!summary, passed: !!summary && !issues.length, issues };
  }));
}

const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

function previewShell(artifact: PublishedArtifact): Response {
  const source = scriptJson({ type: "artifact:render", html: artifact.html, css: artifact.css, lang: artifact.lang, hostTitle: artifact.title });
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SEC report acceptance</title><style>body{margin:0;padding:24px;background:#fff}iframe{width:100%;border:0;display:block}@media(prefers-color-scheme:dark){body{background:#121212}}</style></head><body><section class="lens"><iframe sandbox="allow-scripts" data-artifact-frame data-artifact-hash="${artifact.hash}" src="/artifact-frame"></iframe></section><script>const frame=document.querySelector('iframe');const payload=${source};window.addEventListener('message',e=>{if(e.source!==frame.contentWindow)return;if(e.data.type==='artifact:ready')frame.contentWindow.postMessage({...payload,dark:matchMedia('(prefers-color-scheme:dark)').matches},'*');if(e.data.type==='artifact:size'||e.data.type==='artifact:rendered'){frame.style.height=e.data.height+'px';if(e.data.type==='artifact:rendered')frame.setAttribute('data-rendered','true')}});frame.addEventListener('load',()=>frame.contentWindow.postMessage({type:'artifact:ping'},'*'));</script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function materialSourceChecks(snapshot: MaterialSnapshot, refs: Set<string>) {
  const facts = new Map(snapshot.facts.map(item => [item.factId, item]));
  const tables = new Map(snapshot.tables.map(item => [item.tableId, item]));
  const blocks = new Map(snapshot.blocks.map(item => [item.id, item]));
  const originals = new Map(snapshot.documents.map(item => [item.id, item]));
  return [...refs].flatMap(id => {
    const fact = facts.get(id), table = tables.get(id);
    const block = blocks.get(fact?.passageId ?? table?.anchor ?? materialBlockId(id));
    const sourceTable = table ?? (block?.tableId ? tables.get(block.tableId) : undefined);
    if (!fact && !table && !block) return [];
    const documentId = block?.documentId ?? sourceTable?.documentId;
    const original = documentId ? originals.get(documentId) : undefined;
    return [{ id, material: snapshot.ref, anchor: block?.id ?? sourceTable?.anchor ?? null,
      locator: block?.locator ?? null, markdownRange: block?.range ?? null,
      fact: fact ? { shown: fact.shown, value: fact.value, unit: fact.unit, periodStart: fact.periodStart, periodEnd: fact.periodEnd, dimensions: fact.dimensions, row: fact.row, col: fact.col } : null,
      csv: sourceTable ? { tableId: sourceTable.tableId, filename: sourceTable.filename, sha256: sourceTable.sha256, unit: sourceTable.table.unit, columns: sourceTable.table.columns, notes: sourceTable.table.notes } : null,
      original: original ? { filename: original.filename, sha256: original.sha256, rawKey: original.rawKey, url: original.url } : null }];
  });
}

async function originalOrganizationBatches(env: Env, snapshot: MaterialSnapshot) {
  const blocks: MaterialBlock[] = [];
  for (const block of snapshot.blocks) {
    if (block.kind === "code" || block.kind === "image") continue;
    let text = "";
    if (!block.tableId) {
      if (block.storage === "inline") text = block.text;
      else {
        if (!block.range) throw new Error(`Organization source range missing: ${block.id}`);
        const object = await env.SEC_FILINGS.get(snapshot.markdown.key, { range: { offset: block.range.offset, length: block.range.length } });
        if (!object) throw new Error(`Organization source missing: ${block.id}`);
        const bytes = new Uint8Array(await object.arrayBuffer());
        if (bytes.length !== block.range.length || await materialDigest(bytes) !== block.range.sha256) throw new Error(`Organization source differs: ${block.id}`);
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      }
    }
    blocks.push({ ...block, text });
  }
  const tables = snapshot.tables.map(table => ({ ...table,
    description: `${table.title}. ${table.table.rows.length} disclosed rows and ${table.table.columns.length + 1} columns.${table.table.unit ? ` Unit: ${table.table.unit}.` : ""}`,
  }));
  return organizationBatches(blocks, tables);
}

async function preprocessingRecords(env: Env, snapshot: MaterialSnapshot) {
  const batches = await originalOrganizationBatches(env, snapshot), receipts = [];
  for (const [index, batch] of batches.entries()) {
    const key = await organizationCacheKey(snapshot.filing, batch), object = await env.SEC_FILINGS.get(key);
    if (!object) throw new Error(`Organization content receipt missing: ${index}`);
    const answer = parseOrganizationReceipt(JSON.parse(await object.text()), batch);
    receipts.push({ index, key, inputHash: key.slice(key.lastIndexOf("/") + 1, -5), blockIds: batch.blocks.map(block => block.id),
      decisions: answer.decisions, tableDescriptions: answer.tables });
  }
  const migrations = [];
  let cursor: string | undefined;
  do {
    const objects = await env.SEC_FILINGS.list({ prefix: organizationMigrationPrefix(snapshot.ref), ...(cursor ? { cursor } : {}) });
    for (const item of objects.objects) {
      const object = await env.SEC_FILINGS.get(item.key);
      if (!object) throw new Error(`Organization migration record missing: ${item.key}`);
      const migration = organizationMigrationSchema.parse(JSON.parse(await object.text()));
      if (migration.material.ticker !== snapshot.ref.ticker || migration.material.accession !== snapshot.ref.accession) throw new Error("Organization migration filing mismatch");
      const matchingKeys = new Set(receipts.map(receipt => receipt.key));
      if (migration.receipts.some(receipt => matchingKeys.has(receipt.key))) migrations.push({ key: item.key, ...migration });
    }
    cursor = objects.truncated ? objects.cursor : undefined;
  } while (cursor);
  const currentMaterialRunId = `material-${snapshot.ref.accession}-${snapshot.ref.version}`;
  const modelRunIds = [...new Set([currentMaterialRunId, ...migrations.map(migration => migration.modelRunId)])];
  type ModelCall = Pick<AiUsageRow, "at" | "runId" | "stage" | "provider" | "model" | "reasoning" | "inputTokens" | "cachedTokens" | "outputTokens" | "reasoningTokens" | "durationMs" | "outcome">;
  const calls = await env.DB!.prepare(`SELECT at, run_id AS runId, stage, provider, model, reasoning, input_tokens AS inputTokens, cached_tokens AS cachedTokens, output_tokens AS outputTokens, reasoning_tokens AS reasoningTokens, duration_ms AS durationMs, outcome FROM ai_usage WHERE ticker = ? AND stage = 'filing-material-organize' AND run_id IN (${modelRunIds.map(() => "?").join(",")}) ORDER BY at`)
    .bind(snapshot.ref.ticker, ...modelRunIds).all<ModelCall>();
  return { material: snapshot.ref, currentMaterialRunId, receipts, migrations, modelCalls: calls.results,
    currentMaterialModelCalls: calls.results.filter(call => call.runId === currentMaterialRunId).length,
    receiptModelRuns: modelRunIds.map(runId => ({ runId, recordedCalls: calls.results.filter(call => call.runId === runId).length })),
    ledgerMeaning: "The ledger contains recorded provider calls. Input-hash receipts may originate in an earlier material version; reusing them does not constitute another model call." };
}

async function exported(env: Env, run: Run, entry: Entry) {
  const accession = entry.filing.accessionNumber;
  if (!entry.material) throw new Error("The run has no pinned material version");
  const snapshot = await readMaterialSnapshot(env, entry.material);
  const catalogSources = new Map(snapshot.blocks.map(block => [block.id, block]));
  const tableCatalog = snapshot.tables.map(table => tableCatalogEntry(table, catalogSources.get(table.anchor)));
  const storedCatalog = await env.SEC_FILINGS.get(`${materialBase(snapshot.ref)}/tables.json`);
  if (!storedCatalog || await storedCatalog.text() !== JSON.stringify(tableCatalog)) throw new Error("Stored table catalog differs from the pinned material");
  const originals = [];
  for (const source of snapshot.documents) {
    const bytes = await readSourceBytes(env, source);
    originals.push({ documentId: source.id, filename: source.filename, rawKey: source.rawKey, sha256: source.sha256, bytes: bytes.byteLength });
  }
  const csvFiles = [];
  for (const table of snapshot.tables) {
    const object = await env.SEC_FILINGS.get(table.csvKey);
    if (!object) throw new Error(`CSV object missing: ${table.tableId}`);
    const csv = await object.text(), check = verifyTableCsv(table.table, csv);
    if (check.issues.length || csv !== table.csv) throw new Error(`Stored CSV differs from source table: ${table.tableId}`);
    csvFiles.push({ tableId: table.tableId, filename: table.filename, csv, sha256: table.sha256 });
  }
  const api = await handleMapRead(new Request(`https://acceptance.invalid/api/v1/companies/AMZN/filings/${accession}`), env);
  if (!api.ok) throw new Error(`Formal report read failed HTTP ${api.status}`);
  const formalRead: unknown = await api.json();
  const [artifact, document, work, turns, checks, recheck] = await Promise.all([
    readPublishedArtifact(env, "filing-report", "AMZN", accession),
    readPublishedDocument(env, "filing-report", "AMZN", accession),
    readWorkState<FilingWork>(env, "filing-report", "AMZN", accession),
    env.DB!.prepare("SELECT turn, action, input, failed, at FROM filing_run_turns WHERE run_id = ? ORDER BY id").bind(entry.sessionId).all<Turn>(),
    env.DB!.prepare("SELECT version, stage, round, result, created_at FROM analysis_artifact_checks WHERE artifact_id = ? ORDER BY version, stage, round").bind(`filing-report:AMZN:${accession}`).all(),
    recheckFiling(env, "AMZN", accession),
  ]);
  if (!artifact || !document) throw new Error("Published report cannot be read back");
  const status = (await runStatus(env, run)).find(item => item.sessionId === entry.sessionId)!;
  const formal = z.object({ artifact: z.object({ hash: z.string() }), filing: z.object({ summary: z.object({ report: z.string().min(1) }) }) }).safeParse(formalRead);
  if (!formal.success || formal.data.artifact.hash !== artifact.hash) status.issues.push("Formal read API did not return this published report");
  if (!recheck || recheck.checked === 0 || recheck.differs || recheck.unreadable) status.issues.push("Final source recheck did not pass");
  if (snapshot.coverage.issues.length || snapshot.coverage.tableCells !== snapshot.coverage.checkedCells) status.issues.push("Material coverage did not pass");
  if (!work || !sameMaterial(work.material, entry.material)) status.issues.push("Report work does not use the run's pinned material version");
  if (!work?.periodic?.markdownRead) status.issues.push("Report work has no successful Markdown read");
  if (snapshot.tables.length && !work?.periodic?.tablesRead.length) status.issues.push("Report work has no successful CSV table read");
  const readTables = work?.periodic?.tablesRead ?? [];
  for (const tableId of readTables) if (!snapshot.tables.some(table => table.tableId === tableId)) status.issues.push(`Read table is outside the pinned material: ${tableId}`);
  const pinnedMaterials = [...new Map([entry.material, ...(work?.periodic?.materials ?? [])].map(ref => [`${ref.ticker}:${ref.accession}:${ref.version}`, ref])).values()];
  for (const ref of pinnedMaterials) if (ref.accession === accession && !sameMaterial(ref, entry.material)) status.issues.push("Report mixes versions of the accepted filing");
  const sourceIds = new Set([...document.sources.map(source => source.id), ...(recheck?.items.map(item => item.ref) ?? []),
    ...Object.values(work?.periodic?.computed ?? {}).flatMap(computed => Object.keys(computed.inputs))]);
  const sources = materialSourceChecks(snapshot, sourceIds);
  for (const ref of pinnedMaterials) if (!sameMaterial(ref, snapshot.ref)) sources.push(...materialSourceChecks(await readMaterialSnapshot(env, ref), sourceIds));
  const sourceCheck = { expectedMaterial: entry.material, workMaterial: work?.material ?? null, pinnedMaterials, originals,
    markdownRead: work?.periodic?.markdownRead ?? false, tablesRead: readTables,
    successfulTools: Object.fromEntries(needed.map(name => [name, turns.results.filter(turn => turn.action === name && turn.failed === 0).length])),
    tables: snapshot.tables.filter(table => readTables.includes(table.tableId)).map(table => ({ tableId: table.tableId, filename: table.filename,
      description: table.description, sha256: table.sha256, anchor: table.anchor, unit: table.table.unit, columns: table.table.columns, notes: table.table.notes, source: table.sourceUrl })),
    citations: document.sources.map(source => ({ ...source, materials: sources.filter(item => item.id === source.id),
      computation: work?.periodic?.computed[source.id] ?? null, web: work?.web[source.id] === undefined ? null : { url: source.url } })),
    claims: recheck?.items.map(item => ({ ...item, materials: sources.filter(source => source.id === item.ref), computation: work?.periodic?.computed[item.ref] ?? null })) ?? [],
    computationInputs: sources.filter(source => Object.values(work?.periodic?.computed ?? {}).some(computed => source.id in computed.inputs)) };
  const preprocessing = await preprocessingRecords(env, snapshot);
  return { run, filing: entry.filing, snapshot, tableCatalog, csvFiles, artifact, document, work, formalRead, turns: turns.results,
    checks: checks.results, recheck, sourceCheck, preprocessing, status: { ...status, passed: status.passed && !status.issues.length } };
}

const acceptanceWorker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/artifact-frame") return env.ASSETS?.fetch(new Request(new URL("/artifact-frame.html", url), request)) ?? new Response("Assets are not mounted", { status: 404 });
      if (url.pathname.startsWith("/companies/")) {
        const token = url.searchParams.get("artifact-preview");
        const artifact = token ? await readPreview(env, token) : null;
        return artifact ? previewShell(artifact) : new Response("No valid artifact preview", { status: 404 });
      }
      if (url.pathname.startsWith("/api/v1/")) return handleMapRead(request, env);
      if (!url.pathname.startsWith("/acceptance/")) return env.ASSETS?.fetch(request) ?? new Response("Not found", { status: 404 });
      const key = request.headers.get("x-acceptance-key");
      if (env.SEC_ACCEPTANCE_KEY ? key !== env.SEC_ACCEPTANCE_KEY : !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return new Response("Not found", { status: 404 });
      if (url.pathname === "/acceptance/health") return json({ service: "AMZN SEC material acceptance", storage: env.ACCEPTANCE_STORAGE_MODE ?? "isolated", modelConfigured: !!env.DEEPSEEK_API_KEY, judgeConfigured: !!env.OPENAI_API_KEY && !!env.OPENAI_REVIEW_MODEL, browserConfigured: !!env.BROWSER, aiConfigured: !!env.AI });
      if (url.pathname === "/acceptance/discover" && request.method === "POST") return json(await discover(env));
      const args = request.method === "GET" ? requestSchema.parse({ runId: url.searchParams.get("runId"), accession: url.searchParams.get("accession") ?? undefined }) : requestSchema.parse(await request.json());
      const run = await loadRun(env, args.runId), entries = chosen(run, args.accession);
      if (url.pathname === "/acceptance/semantic-probe" && request.method === "POST") {
        if (entries.length !== 1) throw new Error("Choose one filing for a semantic probe");
        const caseId = z.string().regex(/^[a-z0-9-]+$/).parse(url.searchParams.get("caseId"));
        const fixtureKey = `sec-acceptance/${run.id}/semantic-probes/${caseId}.json`;
        const fixtureObject = await env.SEC_FILINGS.get(fixtureKey);
        if (!fixtureObject) throw new Error("Archived semantic fixture is missing");
        const fixture: { document: ArtifactDocument; work: FilingWork; hash: string } = JSON.parse(await fixtureObject.text());
        const entry = entries[0]!;
        if (!entry.material || fixture.document.kind !== "filing-report" || fixture.document.ticker !== "AMZN" || fixture.document.subject !== entry.filing.accessionNumber
          || !sameMaterial(fixture.work.material, entry.material)) throw new Error("Semantic fixture does not match the pinned filing");
        const immutable = await env.SEC_FILINGS.get(`artifacts/filing-report/AMZN/${entry.filing.accessionNumber}/v${fixture.document.version}.json`);
        if (!immutable) throw new Error("Original report edition is missing");
        const original: StoredArtifact = JSON.parse(await immutable.text());
        if (original.hash !== fixture.hash || JSON.stringify(original.document) !== JSON.stringify(fixture.document)) throw new Error("Probe report differs from its immutable edition");
        const composer = openComposer({ kind: fixture.document.kind, ticker: fixture.document.ticker, subject: fixture.document.subject, title: fixture.document.title, lang: fixture.document.lang });
        composer.blocks = fixture.document.blocks;
        composer.charts = Object.fromEntries(fixture.document.charts.map(chart => [chart.id, chart]));
        composer.sources = Object.fromEntries(fixture.document.sources.map(({ id, ...source }) => [id, source]));
        const state: FilingAuditState = { composer, periodic: fixture.work.periodic, web: fixture.work.web };
        const snapshot = await readMaterialSnapshot(env, entry.material);
        const required = entry.filing.form === "10-K" ? PERIODIC_BLOCKS : ["summary"];
        if (url.searchParams.get("mode") === "input") {
          const input = await filingSemanticInput({ env, snapshot, required }, state), modelInput = filingSemanticRequest(input);
          return json({ material: snapshot.ref, requestChars: JSON.stringify(modelInput).length,
            requestHash: await materialDigest(JSON.stringify(modelInput)), input: modelInput });
        }
        const issues = await filingSemanticAudit({ env, snapshot, required, runId: `semantic-probe-${run.id}-${caseId}` }, state);
        return json({ fixtureKey, originalHash: original.hash, material: snapshot.ref, issues, receipt: state.periodic?.semanticAuditReceipt ?? null });
      }
      if (url.pathname === "/acceptance/prepare" && request.method === "POST") {
        const result = [];
        for (const entry of entries) {
          const state = await prepareFilingMaterial(env, filingMaterialMeta(entry.filing), { maxDocuments: args.maxDocuments });
          if (state.status === "ready") entry.material = state.ref;
          result.push({ accession: entry.filing.accessionNumber, state });
        }
        await saveRun(env, run);
        return json(result);
      }
      if (url.pathname === "/acceptance/start" && request.method === "POST") {
        const result = [];
        for (const entry of entries) {
          if (!entry.material) throw new Error("Prepare and pin the material before starting the report");
          const ready = await getFilingMaterial(env, "AMZN", entry.filing.accessionNumber);
          if (ready?.status !== "ready" || !sameMaterial(ready.ref, entry.material)) throw new Error("The ready material differs from this run's pinned version");
          const receipt = `acceptance:amzn:prior:${run.id}:${entry.filing.accessionNumber}`;
          const repository = new D1SecRepository(env.DB!);
          if (!await repository.getCache(receipt)) {
            const [artifact, work] = await Promise.all([readPublishedArtifact(env, "filing-report", "AMZN", entry.filing.accessionNumber), readWorkState(env, "filing-report", "AMZN", entry.filing.accessionNumber)]);
            const key = `sec-acceptance/${run.id}/${entry.filing.accessionNumber}/prior-report.json`;
            await env.SEC_FILINGS.put(key, JSON.stringify({ artifact, work }), { httpMetadata: { contentType: "application/json" } });
            await repository.setCache(receipt, { key, version: artifact?.version ?? null, hash: artifact?.hash ?? null }, new Date().toISOString());
          }
          const operations = createAnalysisOperations(env, fetch, entry.sessionId);
          result.push(await startFilingRuns(env, "AMZN", { requestedBy: "manual", accession: entry.filing.accessionNumber, runId: entry.sessionId, mode: "rewrite" },
            { operations: { ...operations, loadFiling: async (ticker, accession) => ticker === "AMZN" && accession === entry.filing.accessionNumber ? entry.filing : null } }));
        }
        return json(result);
      }
      if (url.pathname === "/acceptance/status") return json(await runStatus(env, run));
      if (url.pathname === "/acceptance/records") return json(await Promise.all(entries.map(async entry => ({ sessionId: entry.sessionId,
        turns: (await env.DB!.prepare("SELECT turn, action, input, failed, at FROM filing_run_turns WHERE run_id = ? ORDER BY id").bind(entry.sessionId).all<Turn>()).results,
        checks: (await env.DB!.prepare("SELECT version, stage, round, result, created_at FROM analysis_artifact_checks WHERE artifact_id = ? ORDER BY version, stage, round").bind(`filing-report:AMZN:${entry.filing.accessionNumber}`).all()).results,
      }))));
      if (url.pathname === "/acceptance/file" && request.method === "GET") {
        if (entries.length !== 1) throw new Error("Choose one accession to download");
        if (url.searchParams.get("kind") !== "markdown") throw new Error("Unknown acceptance file kind");
        const entry = entries[0]!;
        if (!entry.material) throw new Error("The run has no pinned material version");
        const snapshot = await readMaterialSnapshot(env, entry.material);
        const object = await env.SEC_FILINGS.get(snapshot.markdown.key);
        if (!object) throw new Error("Prepared Markdown object is missing");
        if (!("body" in object) || !(object.body instanceof ReadableStream)) throw new Error("Prepared Markdown streaming body is unavailable");
        return new Response(object.body, { headers: {
          "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store",
          "content-disposition": `attachment; filename="AMZN_${entry.filing.filingDate}_${entry.filing.form}.md"`,
        } });
      }
      if (url.pathname === "/acceptance/export") {
        if (entries.length !== 1) throw new Error("Choose one accession to export");
        return json(await exported(env, run, entries[0]!));
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  },
};

export default acceptanceWorker;
