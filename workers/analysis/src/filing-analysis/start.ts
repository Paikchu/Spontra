import { requireDb } from "../core.ts";
import { filingSessions } from "../durable-runs/binding.ts";
import { listLibraryDocuments } from "../filing-library/store.ts";
import { createAnalysisOperations, type AnalysisEnv } from "../operations.ts";
import { D1SecRepository } from "../sec/d1.ts";
import type { SecFiling } from "../sec/sec.ts";
import { jobAnalysisVersionFor, selectLatestWorkflowFilings, type AnalysisOperations } from "../workflow-core.ts";
import { profileById, profileFor, type FilingProfile } from "./profiles.ts";
import type { FilingSpec } from "./recipe.ts";
import { dueFilings, leafSections, registerFilings, updateFiling, type FilingRow } from "./store.ts";

/** What the session opens with: the filing, and every section it can read. */
async function opening(db: D1Database, filing: SecFiling, documentIds: string[], profile: FilingProfile, revise: boolean): Promise<string> {
  const sections = await leafSections(db, documentIds);
  // A periodic report opens on its research pack, which the session asks for itself; the outline here is by part only.
  if (profile.id === "periodic") {
    const parts = new Map<string, { sections: number; chars: number; changed: number }>();
    for (const s of sections) { const top = s.path[0] ?? "(untitled)"; const p = parts.get(top) ?? { sections: 0, chars: 0, changed: 0 }; p.sections++; p.chars += s.chars; if (s.change !== "unchanged") p.changed++; parts.set(top, p); }
    return JSON.stringify({ filing: { ticker: filing.ticker, companyName: filing.companyName, form: filing.form, filingDate: filing.filingDate, reportDate: filing.reportDate, accession: filing.accessionNumber },
      parts: [...parts].map(([part, p]) => ({ part, sections: p.sections, chars: p.chars, sectionsChanged: p.changed })),
      ...(revise ? { published: "A report on this filing is published and is the document you open on: outline lists its blocks, read_block shows one. Revise it, do not rewrite it. Your leads, notes and computed figures from the session that wrote it are carried (list_leads, read_evidence). Check what a reader would still find wrong or missing — blocks marked conservative or safe-layout were cut by the harness and need their gaps filled, open leads may now be answerable, a figure may deserve a chart — and change only that, with edit_block or write_blocks for a block that needs writing again. Leave every block you have no reason to change exactly as it is. Then call finish.", first: "Call outline." } : { first: "Call research_pack." }) });
  }
  return JSON.stringify({ filing: { ticker: filing.ticker, companyName: filing.companyName, form: filing.form, filingDate: filing.filingDate, reportDate: filing.reportDate, accession: filing.accessionNumber, items: filing.items },
    sections: sections.map(s => ({ id: s.sectionId, path: s.path.join(" › "), change: s.change, chars: s.chars })) });
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
  let filings: SecFiling[];
  if (manual) {
    const filing = await operations.loadFiling!(ticker, manual);
    if (!filing) throw new Error("Requested filing is no longer available");
    filings = [filing];
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
  const start = async (row: FilingRow, profile: FilingProfile, filing: SecFiling, documentIds: string[]) => {
    const sessionId = manual && options.runId ? options.runId : `${runId}-${row.accession}`;
    const jobVersion = jobAnalysisVersionFor(row.form);
    const jobId = `${ticker}:${row.accession}:${jobVersion}:${sessionId}`;
    const published = options.mode === "revise" && profile.id === "periodic" && !!await db.prepare("SELECT 1 FROM analysis_artifacts WHERE artifact_id = ? AND published_version IS NOT NULL").bind(`filing-report:${ticker}:${row.accession}`).first().catch(() => null);
    const spec: FilingSpec = { ticker, profile: profile.id, filing, sessionId, jobId, jobVersion, requestedBy: options.requestedBy, mode: published ? "revise" : "rewrite" };
    await updateFiling(db, ticker, row.accession, { status: "running", reason: null, runId }, at);
    await new D1SecRepository(db).upsertAnalysisJob({ jobId, ticker, accessionNumber: row.accession, analysisVersion: jobVersion, status: "running", currentStage: "analysis", attempt: 1, requestedBy: options.requestedBy, workflowInstanceId: sessionId, updatedAt: at });
    await sessions!.start(sessionId, "filing", spec, await opening(db, filing, documentIds, profile, published), `${sessionId}:report`);
    result.started.push(row.accession);
  };
  for (const row of due) {
    const filing = byAccession.get(row.accession);
    const documents = await listLibraryDocuments(db, { ticker, accessions: [row.accession], limit: 20 });
    const ready = documents.filter(d => d.status === "ready");
    if (documents.length && !ready.length) { await updateFiling(db, ticker, row.accession, { status: "failed", reason: "the library could not read this filing", runId }, at); continue; }
    if (!filing || !ready.length) { await updateFiling(db, ticker, row.accession, { status: "waiting", reason: filing ? "waiting for the filing library" : "not in the company's filing list yet", runId }, at); result.waiting.push(row.accession); continue; }
    try { await start(row, profileById(row.profile), filing, ready.map(d => d.documentId)); }
    catch (error) { await updateFiling(db, ticker, row.accession, { status: "failed", reason: error instanceof Error ? error.message : String(error), runId }, at); }
  }
  return result;
}
