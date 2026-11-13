import { requireDb } from "../core.ts";
import { filingSessions } from "../durable-runs/binding.ts";
import { getFilingMaterial, readMaterialSnapshot, requestFilingMaterial } from "../filing-material/index.ts";
import { filingMaterialMeta } from "../filing-material/read.ts";
import type { MaterialSnapshot } from "../../../../shared/analysis-contract/filing-material.ts";
import { createAnalysisOperations, type AnalysisEnv } from "../operations.ts";
import { D1SecRepository } from "../sec/d1.ts";
import type { SecFiling } from "../sec/sec.ts";
import { jobAnalysisVersionFor, selectLatestWorkflowFilings, type AnalysisOperations } from "../workflow-core.ts";
import { profileById, profileFor, type FilingProfile } from "./profiles.ts";
import type { FilingSpec } from "./recipe.ts";
import { dueFilings, registerFilings, updateFiling, type FilingRow } from "./store.ts";

export function filingOpening(filing: SecFiling, material: MaterialSnapshot, revise: boolean): string {
  return JSON.stringify({ filing: { ticker: filing.ticker, companyName: filing.companyName, form: filing.form,
    filingDate: filing.filingDate, reportDate: filing.reportDate, accession: filing.accessionNumber, items: filing.items },
    material: material.ref, coverage: material.coverage, toc: material.toc,
    tables: { count: material.tables.length, lookup: "Use find_filing_tables with a table name or content description, then read the returned tableId with read_filing_table." },
    first: revise ? "Call outline to inspect the published report, then read_filing_markdown for the fixed material version." : "Call read_filing_markdown, then find_filing_tables and read_filing_table for the relevant CSV data.",
    ...(revise ? { published: "Revise the existing report against this material version. Re-read every source that supports a changed block." } : {}) });
}

export type StartOptions = { requestedBy: "scheduled" | "manual"; accession?: string; runId?: string; /** A manual run on a published report revises it unless told to rewrite. */ mode?: "revise" | "rewrite" };
type SessionStarter = { start: (id: string, kind: string, spec: unknown, opening: string, operationId: string) => Promise<void> };

/**
 * Hands every report-worthy filing whose text is ready to a Pi session of its own. Nothing waits on the session: it reads
 * the filing, publishes the report through its last tool, and records how it ended. A filing that fails stays failed
 * until the admin runs it again.
 */
export async function startFilingRuns(env: AnalysisEnv, ticker: string, options: StartOptions, deps: { operations?: Pick<AnalysisOperations, "discover" | "publishFeed" | "loadFiling">; sessions?: SessionStarter } = {}): Promise<{ started: string[]; waiting: string[] }> {
  const db = requireDb(env);
  const now = new Date();
  const at = now.toISOString();
  const runId = options.runId ?? `filings-${ticker}-${now.getTime()}`;
  const manual = options.requestedBy === "manual" ? options.accession ?? null : null;
  const operations = deps.operations ?? createAnalysisOperations(env, fetch, runId);
  const repository = new D1SecRepository(db);
  const requestKey = (accession: string) => `filing-material:analysis-request:v1:${ticker}:${accession}`;
  let filings: SecFiling[];
  if (manual) {
    const filing = await operations.loadFiling!(ticker, manual);
    if (!filing) throw new Error("Requested filing is no longer available");
    filings = [filing];
    await repository.setCache(requestKey(manual), { filing, options }, at);
  } else {
    const found = await operations.discover(ticker);
    await operations.publishFeed(found.feed);
    filings = found.filings;
  }
  // The company's latest report and current reports that have none yet.
  const analysed = new Set((await db.prepare("SELECT accession_number a FROM sec_filing_summaries WHERE ticker = ?").bind(ticker).all<{ a: string }>()).results.map(r => r.a));
  const wanted = manual ? filings : selectLatestWorkflowFilings(filings).filter(f => !analysed.has(f.accessionNumber));
  await registerFilings(db, wanted.flatMap(f => {
    const profile = profileFor(f.form);
    return profile ? [{ ticker, accession: f.accessionNumber, form: f.form, filedAt: f.filingDate, profile: profile.id }] : [];
  }), at);
  const due = await dueFilings(db, ticker, manual);
  const byAccession = new Map(filings.map(f => [f.accessionNumber, f]));
  const result = { started: [] as string[], waiting: [] as string[] };
  const sessions = deps.sessions ?? filingSessions(env);
  const start = async (row: FilingRow, profile: FilingProfile, filing: SecFiling, material: MaterialSnapshot, request: StartOptions) => {
    const sessionId = request.requestedBy === "manual" && request.runId ? request.runId : `${runId}-${row.accession}`;
    const jobVersion = jobAnalysisVersionFor(row.form);
    const jobId = `${ticker}:${row.accession}:${jobVersion}:${sessionId}`;
    const published = request.mode === "revise" && profile.id === "periodic" && !!await db.prepare("SELECT 1 FROM analysis_artifacts WHERE artifact_id = ? AND published_version IS NOT NULL").bind(`filing-report:${ticker}:${row.accession}`).first().catch(() => null);
    const spec: FilingSpec = { ticker, profile: profile.id, filing, sessionId, jobId, jobVersion, requestedBy: request.requestedBy, material: material.ref, mode: published ? "revise" : "rewrite" };
    await updateFiling(db, ticker, row.accession, { status: "running", reason: null, runId }, at);
    await new D1SecRepository(db).upsertAnalysisJob({ jobId, ticker, accessionNumber: row.accession, analysisVersion: jobVersion, status: "running", currentStage: "analysis", attempt: 1, requestedBy: request.requestedBy, workflowInstanceId: sessionId, updatedAt: at });
    await sessions!.start(sessionId, "filing", spec, filingOpening(filing, material, published), `${sessionId}:report`);
    await db.prepare("DELETE FROM sec_cache WHERE cache_key = ?").bind(requestKey(row.accession)).run();
    result.started.push(row.accession);
  };
  for (const row of due) {
    const pending = (await repository.getCache<{ filing: SecFiling; options: StartOptions }>(requestKey(row.accession)))?.payload;
    const material = await getFilingMaterial(env, ticker, row.accession);
    let filing = byAccession.get(row.accession) ?? pending?.filing;
    if (!filing && material) {
      const meta = material.filing;
      filing = { ticker: meta.ticker, cik: meta.cik, cikNumber: Number(meta.cik), companyName: meta.companyName, form: meta.form,
        filingDate: meta.filedAt, reportDate: meta.reportDate, accessionNumber: meta.accession, primaryDocument: meta.primaryDocument,
        documentUrl: meta.documentUrl, indexUrl: meta.indexUrl, description: meta.form, items: "" };
    }
    if (!filing) { await updateFiling(db, ticker, row.accession, { status: "waiting", reason: "not in the company's filing list yet", runId }, at); result.waiting.push(row.accession); continue; }
    if (material?.status !== "ready") {
      if (!material) await requestFilingMaterial(env, filingMaterialMeta(filing));
      await updateFiling(db, ticker, row.accession, { status: "waiting", reason: material?.status === "blocked" ? material.issues.join("; ") : "waiting for complete filing material", runId }, at);
      result.waiting.push(row.accession); continue;
    }
    try { await start(row, profileById(row.profile), filing, await readMaterialSnapshot(env, material.ref), pending?.options ?? options); }
    catch (error) { await updateFiling(db, ticker, row.accession, { status: "failed", reason: error instanceof Error ? error.message : String(error), runId }, at); }
  }
  return result;
}
