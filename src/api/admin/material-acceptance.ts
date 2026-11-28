import { z } from "zod";
import { getAgentByName } from "agents";
import { edgarListings } from "../../domains/sec-archive";
import { issuerDirectory, listedIssuer } from "../../lib/catalog/issuer-directory.ts";
import { TICKER_PATTERN } from "../../domains/financials/runtime/policy.ts";
import { secArchiveDocumentUrl, secArchiveRoot } from "../../domains/sec-archive/sec-sources.ts";
import { createAnalysisOperations, type AnalysisEnv } from "../../operations.ts";
import { D1SecRepository } from "../../domains/filing-analysis/sec/d1.ts";
import type { SecFiling } from "../../domains/filing-analysis/sec/sec.ts";
import type { MaterialRef, MaterialSnapshot } from "../../domains/filing-material/contract.ts";
import { requestFilingMaterial, prepareFilingMaterial, getFilingMaterial, readMaterialSnapshot, readMaterialBrief } from "../../domains/filing-material";
import { filingMaterialMeta, materialBlockId, readFilingMarkdown } from "../../domains/filing-material/read.ts";
import { readSourceBytes } from "../../domains/filing-material/archive.ts";
import { materialBase } from "../../domains/filing-material/store.ts";
import { tableCatalogEntry, verifyTableCsv } from "../../domains/filing-material/runtime.ts";
import { startFilingRuns } from "../../domains/filing-analysis/start.ts";
import { readFilingCheckpoint, type FilingWork } from "../../domains/filing-analysis/recipe.ts";
import { filingSessions } from "../../ai/durable-runs/binding.ts";
import { readPublishedArtifact, readPublishedDocument, readWorkState } from "../../domains/publishing/artifact/store.ts";
import { recheckFiling } from "../../domains/filing-analysis/recheck.ts";
import { handleMapRead } from "../public/router.ts";
import { TASK_IMPLEMENTATIONS } from "../../pipeline/tasks.ts";
import type { AiUsageRow } from "../../ai/runs/usage.ts";

type Env = AnalysisEnv & { TASK_RUNS?: Cloudflare.Env["TASK_RUNS"]; ACCEPTANCE_STORAGE_MODE?: "isolated" | "production" };
type Entry = { role: "subject" | "comparison"; filing: SecFiling; sessionId: string; material: MaterialRef | null };
type Run = { id: string; discoveredAt: string; entries: Entry[] };
type Summary = { run_id: string; status: string; settled_by: string | null; tools: string; degraded: string; detail: string; blocks: number };
type Turn = { turn: number; action: string; input: string; failed: number; at: string };
type ModelCall = Pick<AiUsageRow, "at" | "runId" | "stage" | "provider" | "model" | "reasoning" | "inputTokens" | "cachedTokens" | "outputTokens" | "reasoningTokens" | "durationMs" | "outcome">;
const semanticAuditPointerSchema = z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/), key: z.string().min(1), verdict: z.literal("pass"), complete: z.literal(true) });
const requestSchema = z.object({ runId: z.string().min(1), accession: z.string().optional(), maxDocuments: z.number().int().positive().optional(), cursor: z.string().optional(), checkpoint: z.string().min(1).optional() });
const discoverSchema = z.object({ tickers: z.array(z.string().regex(TICKER_PATTERN)).nonempty(), forms: z.array(z.enum(["10-K", "10-Q", "20-F", "40-F", "8-K", "6-K"])).nonempty().default(["10-Q"]) });
const submissionsSchema = z.object({ name: z.string(), filings: z.object({ recent: z.object({
  accessionNumber: z.array(z.string()), form: z.array(z.string()), filingDate: z.array(z.string()),
  reportDate: z.array(z.string()), acceptanceDateTime: z.array(z.string()), primaryDocument: z.array(z.string()),
  items: z.array(z.string()).optional(), primaryDocDescription: z.array(z.string()).optional(),
}) }) });
const runKey = (id: string) => `acceptance:material:run:${id}`;
const forbidden = new Set(["research_pack", "read_section", "read_sections", "read_filing_section", "find_sections", "find_filing_sections", "read_report"]);
const observedTools = ["read_filing_markdown", "find_filing_tables", "read_filing_table", "compute", "finish"];
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const sameMaterial = (a: MaterialRef, b: MaterialRef) => a.ticker === b.ticker && a.accession === b.accession && a.version === b.version;

async function loadRun(env: Env, id: string): Promise<Run> {
  const run = (await new D1SecRepository(env.DB!).getCache<Run>(runKey(id)))?.payload;
  if (!run) throw new Error(`Unknown acceptance run ${id}`);
  return run;
}

async function saveRun(env: Env, run: Run): Promise<void> {
  await new D1SecRepository(env.DB!).setCache(runKey(run.id), run, new Date().toISOString());
}

function acceptedSemanticAudit(work: FilingWork | null, entry: Entry) {
  if (!entry.material || !work || !sameMaterial(work.material, entry.material)) throw new Error("Report work does not use the run's pinned material version");
  const pointer = semanticAuditPointerSchema.parse(work.periodic?.semanticAuditReceipt);
  if (pointer.key !== `filing-semantic-audits/${entry.material.ticker}/${entry.material.accession}/${pointer.digest}.json`) throw new Error("Semantic audit receipt key differs from the accepted filing and digest");
  return pointer;
}

async function sessionChecks(env: Env, entry: Entry) {
  return (await env.DB!.prepare("SELECT version, stage, round, result, created_at FROM analysis_artifact_checks WHERE artifact_id = ? AND created_at >= (SELECT MIN(at) FROM filing_run_turns WHERE run_id = ?) ORDER BY created_at, version, stage, round")
    .bind(`filing-report:${entry.filing.ticker}:${entry.filing.accessionNumber}`, entry.sessionId).all()).results;
}

async function analysisModelCalls(env: Env, entry: Entry) {
  return (await env.DB!.prepare("SELECT at, run_id AS runId, stage, provider, model, reasoning, input_tokens AS inputTokens, cached_tokens AS cachedTokens, output_tokens AS outputTokens, reasoning_tokens AS reasoningTokens, duration_ms AS durationMs, outcome FROM ai_usage WHERE ticker = ? AND run_id = ? ORDER BY at, id")
    .bind(entry.filing.ticker, entry.sessionId).all<ModelCall>()).results;
}

async function discover(env: Env, input: z.infer<typeof discoverSchema>): Promise<Run> {
  const listings = edgarListings(env), directory = await issuerDirectory(env.DB!, listings);
  const id = `material-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const entries: Entry[] = [];
  for (const ticker of input.tickers) {
    const issuer = listedIssuer(directory, ticker);
    if (!issuer?.[3]) throw new Error(`SEC issuer directory has no CIK for ${ticker}`);
    const cik = issuer[3], cikNumber = Number(cik);
    const data = submissionsSchema.parse(await listings.submissions(cik));
    const recent = data.filings.recent;
    for (const form of input.forms) {
      const selected = recent.form.map((value, index) => ({ value, index })).filter(item => item.value === form)
        .sort((a, b) => recent.acceptanceDateTime[b.index]!.localeCompare(recent.acceptanceDateTime[a.index]!)).slice(0, 2);
      if (!selected.length) throw new Error(`SEC recent submissions for ${ticker} has no ${form}`);
      for (const [position, { index: i }] of selected.entries()) {
        const accession = recent.accessionNumber[i]!, root = secArchiveRoot(cikNumber, accession), primary = recent.primaryDocument[i]!;
        const filing: SecFiling = { ticker, cik, cikNumber, companyName: data.name,
          form, filingDate: recent.filingDate[i]!, reportDate: recent.reportDate[i]!, accessionNumber: accession,
          primaryDocument: primary, description: recent.primaryDocDescription?.[i] ?? form, items: recent.items?.[i] ?? "",
          documentUrl: secArchiveDocumentUrl(root, primary), indexUrl: secArchiveDocumentUrl(root, `${accession}-index.htm`) };
        await new D1SecRepository(env.DB!).upsertFilingIndex(filing);
        await requestFilingMaterial(env, filingMaterialMeta(filing));
        entries.push({ role: position === 0 ? "subject" : "comparison", filing,
          sessionId: `${id}-${ticker}-${accession.replace(/-/g, "")}`, material: null });
      }
    }
  }
  const run = { id, discoveredAt: new Date().toISOString(), entries };
  await saveRun(env, run);
  return run;
}

function chosen(run: Run, accession?: string): Entry[] {
  const entries = accession ? run.entries.filter(entry => entry.filing.accessionNumber === accession) : run.entries.filter(entry => entry.role === "subject");
  if (!entries.length) throw new Error("Accession is not part of this acceptance run");
  return entries;
}

async function runStatus(env: Env, run: Run) {
  return Promise.all(run.entries.filter(entry => entry.role === "subject").map(async entry => {
    const accession = entry.filing.accessionNumber, artifactId = `filing-report:${entry.filing.ticker}:${accession}`;
    const [material, summary, turns, analysis, artifact, document] = await Promise.all([
      getFilingMaterial(env, entry.filing.ticker, accession),
      env.DB!.prepare("SELECT * FROM filing_run_summary WHERE run_id = ?").bind(entry.sessionId).first<Summary>(),
      env.DB!.prepare("SELECT turn, action, input, failed, at FROM filing_run_turns WHERE run_id = ? ORDER BY id").bind(entry.sessionId).all<Turn>(),
      env.DB!.prepare("SELECT status, reason, run_id FROM filing_analyses WHERE ticker = ? AND accession_number = ?").bind(entry.filing.ticker, accession).first<{ status: string; reason: string | null; run_id: string | null }>(),
      readPublishedArtifact(env, "filing-report", entry.filing.ticker, accession),
      readPublishedDocument(env, "filing-report", entry.filing.ticker, accession),
    ]);
    const active = analysis?.run_id === entry.sessionId;
    const version = artifact ? await env.DB!.prepare("SELECT run_id FROM analysis_artifact_versions WHERE artifact_id = ? AND version = ?").bind(artifactId, artifact.version).first<{ run_id: string | null }>() : null;
    const actions = turns.results.map(turn => turn.action), tools: Record<string, number> = summary ? JSON.parse(summary.tools) : {};
    const issues: string[] = [];
    if (summary) {
      if (summary.status !== "published") issues.push(`run status ${summary.status}`);
      if (summary.settled_by !== "agent") issues.push(`settled by ${summary.settled_by ?? "unknown"}`);
      if (JSON.parse(summary.degraded).length || artifact?.degraded.length) issues.push("report contains degraded blocks");
      for (const name of actions) if (forbidden.has(name)) issues.push(`legacy tool called: ${name}`);
      if (!artifact || !document?.blocks.length) issues.push("published report is missing");
      if (version?.run_id !== entry.sessionId) issues.push("published artifact does not belong to the fresh run");
      if (/^(?:10-[KQ]|20-F|40-F)(?:\/A)?$/.test(entry.filing.form)) for (const name of ["summary", "highlights", "risks", "overlooked", "versus-prior", "what-to-watch"]) {
        if (!document?.blocks.some(block => block.id === name)) issues.push(`required report block missing: ${name}`);
      }
    }
    const session = active ? await filingSessions(env)?.report(entry.sessionId).catch(error => ({ error: error instanceof Error ? error.message : String(error) })) : null;
    return { filing: entry.filing, sessionId: entry.sessionId, material, analysis, summary, tools, calls: turns.results.length,
      artifact: artifact ? { id: artifact.id, version: artifact.version, hash: artifact.hash, degraded: artifact.degraded } : null,
      session, complete: !!summary, passed: !!summary && !issues.length, issues };
  }));
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

async function preprocessingRecords(env: Env, snapshot: MaterialSnapshot) {
  const brief = await readMaterialBrief(env, snapshot.ref);
  const currentMaterialRunId = `material-${snapshot.ref.accession}-${snapshot.ref.version}`;
  const calls = await env.DB!.prepare(`SELECT at, run_id AS runId, stage, provider, model, reasoning, input_tokens AS inputTokens, cached_tokens AS cachedTokens, output_tokens AS outputTokens, reasoning_tokens AS reasoningTokens, duration_ms AS durationMs, outcome FROM ai_usage WHERE ticker = ? AND stage = 'filing-material-brief' ORDER BY at`)
    .bind(snapshot.ref.ticker).all<ModelCall>();
  return {
    material: snapshot.ref,
    currentMaterialRunId,
    l1Layout: { sourceBlocks: snapshot.coverage.sourceBlocks, retainedBlocks: snapshot.coverage.retainedBlocks, duplicates: snapshot.coverage.duplicates.length },
    l2Brief: { state: brief.state, hasBrief: !!brief.brief },
    modelCalls: calls.results,
    ledgerMeaning: "L1 uses zero LLM calls (deterministic native layout). L2 uses a single full-document filing-material-brief call when triggered.",
  };
}

async function materialPackage(env: Env, entry: Entry) {
  if (!entry.material) throw new Error("The run has no pinned material version");
  const snapshot = await readMaterialSnapshot(env, entry.material);
  if (snapshot.coverage.issues.length || snapshot.coverage.tableCells !== snapshot.coverage.checkedCells) throw new Error("Material coverage did not pass");
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
  return { snapshot, tableCatalog, csvFiles, originals };
}

async function exported(env: Env, run: Run, entry: Entry) {
  const accession = entry.filing.accessionNumber;
  const { snapshot, tableCatalog, csvFiles, originals } = await materialPackage(env, entry);
  const api = await handleMapRead(new Request(`https://acceptance.invalid/api/v1/companies/${entry.filing.ticker}/filings/${accession}`), env);
  if (!api.ok) throw new Error(`Formal report read failed HTTP ${api.status}`);
  const formalRead: unknown = await api.json();
  const [artifact, document, work, turns, recheck, modelCalls] = await Promise.all([
    readPublishedArtifact(env, "filing-report", entry.filing.ticker, accession),
    readPublishedDocument(env, "filing-report", entry.filing.ticker, accession),
    readWorkState<FilingWork>(env, "filing-report", entry.filing.ticker, accession),
    env.DB!.prepare("SELECT turn, action, input, failed, at FROM filing_run_turns WHERE run_id = ? ORDER BY id").bind(entry.sessionId).all<Turn>(),
    recheckFiling(env, entry.filing.ticker, accession),
    analysisModelCalls(env, entry),
  ]);
  if (!artifact || !document) throw new Error("Published report cannot be read back");
  const semanticAuditReceipt = acceptedSemanticAudit(work, entry);
  const checks = await sessionChecks(env, entry);
  const status = (await runStatus(env, run)).find(item => item.sessionId === entry.sessionId)!;
  const formal = z.object({ artifact: z.object({ hash: z.string() }), filing: z.object({ summary: z.object({ report: z.string().min(1) }) }) }).safeParse(formalRead);
  if (!formal.success || formal.data.artifact.hash !== artifact.hash) status.issues.push("Formal read API did not return this published report");
  if (!recheck || recheck.checked === 0 || recheck.differs || recheck.unreadable) status.issues.push("Final source recheck did not pass");
  if (snapshot.coverage.issues.length || snapshot.coverage.tableCells !== snapshot.coverage.checkedCells) status.issues.push("Material coverage did not pass");
  if (!work || !sameMaterial(work.material, snapshot.ref)) status.issues.push("Report work does not use the run's pinned material version");
  if (!work?.periodic?.markdownRead) status.issues.push("Report work has no successful Markdown read");
  if (snapshot.tables.length && !work?.periodic?.tablesRead.length) status.issues.push("Report work has no successful CSV table read");
  const readTables = work?.periodic?.tablesRead ?? [];
  for (const tableId of readTables) if (!snapshot.tables.some(table => table.tableId === tableId)) status.issues.push(`Read table is outside the pinned material: ${tableId}`);
  const pinnedMaterials = [...new Map([snapshot.ref, ...(work?.periodic?.materials ?? [])].map(ref => [`${ref.ticker}:${ref.accession}:${ref.version}`, ref])).values()];
  for (const ref of pinnedMaterials) if (ref.accession === accession && !sameMaterial(ref, snapshot.ref)) status.issues.push("Report mixes versions of the accepted filing");
  const sourceIds = new Set([...document.sources.map(source => source.id), ...(recheck?.items.map(item => item.ref) ?? []),
    ...Object.values(work?.periodic?.computed ?? {}).flatMap(computed => Object.keys(computed.inputs))]);
  const sources = materialSourceChecks(snapshot, sourceIds);
  for (const ref of pinnedMaterials) if (!sameMaterial(ref, snapshot.ref)) sources.push(...materialSourceChecks(await readMaterialSnapshot(env, ref), sourceIds));
  const sourceCheck = { expectedMaterial: snapshot.ref, workMaterial: work?.material ?? null, pinnedMaterials, originals,
    markdownRead: work?.periodic?.markdownRead ?? false, tablesRead: readTables,
    successfulTools: Object.fromEntries(observedTools.map(name => [name, turns.results.filter(turn => turn.action === name && turn.failed === 0).length])),
    tables: snapshot.tables.filter(table => readTables.includes(table.tableId)).map(table => ({ tableId: table.tableId, filename: table.filename,
      description: table.description, sha256: table.sha256, anchor: table.anchor, unit: table.table.unit, columns: table.table.columns, notes: table.table.notes, source: table.sourceUrl })),
    citations: document.sources.map(source => ({ ...source, materials: sources.filter(item => item.id === source.id),
      computation: work?.periodic?.computed[source.id] ?? null, web: work?.web[source.id] === undefined ? null : { url: source.url } })),
    claims: recheck?.items.map(item => ({ ...item, materials: sources.filter(source => source.id === item.ref), computation: work?.periodic?.computed[item.ref] ?? null })) ?? [],
    computationInputs: sources.filter(source => Object.values(work?.periodic?.computed ?? {}).some(computed => source.id in computed.inputs)) };
  const preprocessing = await preprocessingRecords(env, snapshot);
  return { run, filing: entry.filing, snapshot, tableCatalog, csvFiles, artifact, document, work, formalRead, turns: turns.results,
    checks, modelCalls, semanticAuditReceipt, recheck, sourceCheck, preprocessing, status: { ...status, passed: status.passed && !status.issues.length } };
}

export async function handleMaterialAcceptance(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/acceptance/health") return json({ service: "SEC material acceptance", storage: env.ACCEPTANCE_STORAGE_MODE ?? "production", modelConfigured: !!env.DEEPSEEK_API_KEY, judgeConfigured: !!env.OPENAI_API_KEY && !!env.OPENAI_REVIEW_MODEL, browserConfigured: !!env.BROWSER, aiConfigured: !!env.AI });
    if (url.pathname === "/acceptance/retire-runs" && request.method === "POST") {
      const { names } = z.object({ names: z.array(z.string().min(1)) }).parse(await request.json());
      if (!env.TASK_RUNS) throw new Error("TaskRunner binding is unavailable");
      const retired = [];
      for (const name of names) {
        const run = await getAgentByName(env.TASK_RUNS, name);
        await run.terminate();
        retired.push({ name, terminated: true });
      }
      return json({ retired });
    }
    if (url.pathname === "/acceptance/discover" && request.method === "POST") return json(await discover(env, discoverSchema.parse(await request.json())));
    const args = request.method === "GET" ? requestSchema.parse({ runId: url.searchParams.get("runId"), accession: url.searchParams.get("accession") ?? undefined, cursor: url.searchParams.get("cursor") ?? undefined }) : requestSchema.parse(await request.json());
    const run = await loadRun(env, args.runId), entries = chosen(run, args.accession);
    if (url.pathname === "/acceptance/business" && request.method === "POST") {
      const results = [];
      for (const entry of entries) {
        const context = { causeId: run.id, trigger: run.id, now: new Date() };
        const ticker = entry.filing.ticker;
        results.push({ ticker,
          classification: await TASK_IMPLEMENTATIONS["business-classification"].run(env, ticker, context),
          tags: await TASK_IMPLEMENTATIONS["business-tags"].run(env, ticker, context) });
      }
      await TASK_IMPLEMENTATIONS.peers.run(env, "*", { causeId: run.id, trigger: run.id, now: new Date() });
      return json(results);
    }
    if (url.pathname === "/acceptance/prepare" && request.method === "POST") {
      const result = [];
      for (const entry of entries) {
        const state = await prepareFilingMaterial(env, filingMaterialMeta(entry.filing), { maxDocuments: args.maxDocuments });
        if (state.status === "ready") {
          await env.DB!.prepare("UPDATE sec_cache SET payload = json_set(payload, ?, json(?)), fetched_at = ? WHERE cache_key = ?")
            .bind(`$.entries[${run.entries.indexOf(entry)}].material`, JSON.stringify(state.ref), new Date().toISOString(), runKey(run.id)).run();
        }
        result.push({ accession: entry.filing.accessionNumber, state });
      }
      return json(result);
    }
    if (url.pathname === "/acceptance/material" && request.method === "GET") {
      if (entries.length !== 1) throw new Error("Choose one material to read");
      return json(await materialPackage(env, entries[0]!));
    }
    if (url.pathname === "/acceptance/read-markdown" && request.method === "GET") {
      if (entries.length !== 1 || !entries[0]!.material) throw new Error("Choose one pinned material to read");
      const snapshot = await readMaterialSnapshot(env, entries[0]!.material);
      return json(await readFilingMarkdown(env, snapshot, { cursor: args.cursor, maxChars: 64_000 }));
    }
    if (url.pathname === "/acceptance/read-markdown-pages" && request.method === "GET") {
      if (entries.length !== 1 || !entries[0]!.material) throw new Error("Choose one pinned material to read");
      const snapshot = await readMaterialSnapshot(env, entries[0]!.material);
      const pages: Awaited<ReturnType<typeof readFilingMarkdown>>[] = [];
      let cursor = args.cursor;
      for (let index = 0; index < 20; index++) {
        const page = await readFilingMarkdown(env, snapshot, { cursor, maxChars: 64_000 });
        pages.push(page);
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      return json(pages);
    }
    if (url.pathname === "/acceptance/resume" && request.method === "POST") {
      if (entries.length !== 1 || !entries[0]!.material) throw new Error("Choose one pinned material to resume");
      const entry = entries[0]!, checkpoint = z.string().min(1).parse(args.checkpoint);
      await readFilingCheckpoint(env, checkpoint, entry.material!);
      const ready = await getFilingMaterial(env, entry.filing.ticker, entry.filing.accessionNumber);
      if (ready?.status !== "ready" || !sameMaterial(ready.ref, entry.material!)) throw new Error("The ready material differs from the checkpoint's pinned version");
      const previous = entry.sessionId, sessionId = `${previous}-resume-${crypto.randomUUID().slice(0, 8)}`;
      const path = `$.entries[${run.entries.indexOf(entry)}].sessionId`;
      const updated = await env.DB!.prepare("UPDATE sec_cache SET payload = json_set(payload, ?, ?), fetched_at = ? WHERE cache_key = ? AND json_extract(payload, ?) = ?")
        .bind(path, sessionId, new Date().toISOString(), runKey(run.id), path, previous).run();
      if (!updated.meta.changes) throw new Error("The acceptance session changed before resuming");
      const operations = createAnalysisOperations(env, fetch, sessionId);
      const result = await startFilingRuns(env, entry.filing.ticker, { requestedBy: "manual", accession: entry.filing.accessionNumber, runId: sessionId, mode: "resume", checkpoint },
        { operations: { ...operations, loadFiling: async (ticker, accession) => ticker === entry.filing.ticker && accession === entry.filing.accessionNumber ? entry.filing : null } });
      return json({ previousSessionId: previous, sessionId, checkpoint, ...result });
    }
    if (url.pathname === "/acceptance/start" && request.method === "POST") {
      const result = [];
      for (const entry of entries) {
        if (!entry.material) throw new Error("Prepare and pin the material before starting the report");
        const ready = await getFilingMaterial(env, entry.filing.ticker, entry.filing.accessionNumber);
        if (ready?.status !== "ready" || !sameMaterial(ready.ref, entry.material)) throw new Error("The ready material differs from this run's pinned version");
        const operations = createAnalysisOperations(env, fetch, entry.sessionId);
        result.push(await startFilingRuns(env, entry.filing.ticker, { requestedBy: "manual", accession: entry.filing.accessionNumber, runId: entry.sessionId, mode: "rewrite" },
          { operations: { ...operations, loadFiling: async (ticker, accession) => ticker === entry.filing.ticker && accession === entry.filing.accessionNumber ? entry.filing : null } }));
      }
      return json(result);
    }
    if (url.pathname === "/acceptance/status") return json(await runStatus(env, run));
    if (url.pathname === "/acceptance/records") return json(await Promise.all(entries.map(async entry => ({ sessionId: entry.sessionId,
      turns: (await env.DB!.prepare("SELECT turn, action, input, failed, at FROM filing_run_turns WHERE run_id = ? ORDER BY id").bind(entry.sessionId).all<Turn>()).results,
      checks: await sessionChecks(env, entry), modelCalls: await analysisModelCalls(env, entry),
    }))));
    if (url.pathname === "/acceptance/file" && request.method === "GET") {
      if (entries.length !== 1) throw new Error("Choose one accession to download");
      const entry = entries[0]!;
      if (!entry.material) throw new Error("The run has no pinned material version");
      if (url.searchParams.get("kind") === "semantic-audit") {
        const work = await readWorkState<FilingWork>(env, "filing-report", entry.filing.ticker, entry.filing.accessionNumber);
        const pointer = acceptedSemanticAudit(work, entry);
        const artifact = await readPublishedArtifact(env, "filing-report", entry.filing.ticker, entry.filing.accessionNumber);
        const version = artifact ? await env.DB!.prepare("SELECT run_id FROM analysis_artifact_versions WHERE artifact_id = ? AND version = ?").bind(artifact.id, artifact.version).first<{ run_id: string | null }>() : null;
        if (version?.run_id !== entry.sessionId) throw new Error("Published artifact does not belong to the accepted run");
        const object = await env.SEC_FILINGS.get(pointer.key);
        if (!object) throw new Error("Accepted semantic audit receipt is missing");
        if (!("body" in object) || !(object.body instanceof ReadableStream)) throw new Error("Semantic audit receipt streaming body is unavailable");
        return new Response(object.body, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
          "content-disposition": `attachment; filename="${entry.filing.ticker}_${entry.filing.filingDate}_${entry.filing.form}_semantic-audit.json"` } });
      }
      if (url.searchParams.get("kind") !== "markdown") throw new Error("Unknown acceptance file kind");
      const snapshot = await readMaterialSnapshot(env, entry.material);
      const object = await env.SEC_FILINGS.get(snapshot.markdown.key);
      if (!object) throw new Error("Prepared Markdown object is missing");
      if (!("body" in object) || !(object.body instanceof ReadableStream)) throw new Error("Prepared Markdown streaming body is unavailable");
      return new Response(object.body, { headers: {
        "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store",
        "content-disposition": `attachment; filename="${entry.filing.ticker}_${entry.filing.filingDate}_${entry.filing.form}.md"`,
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
}
