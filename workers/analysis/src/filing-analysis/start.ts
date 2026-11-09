import { readEventsPublication } from "../../../../shared/analysis-runtime/events.ts";
import type { EventsPublication } from "../../../../shared/analysis-contract/events.ts";
import { requireDb } from "../core.ts";
import { filingSessions } from "../durable-runs/binding.ts";
import { eventsCacheKey } from "../events/read.ts";
import { listLibraryDocuments } from "../filing-library/store.ts";
import { createAnalysisOperations, type AnalysisEnv } from "../operations.ts";
import { D1SecRepository } from "../sec/d1.ts";
import type { SecFiling } from "../sec/sec.ts";
import { jobAnalysisVersionFor, selectLatestWorkflowFilings, type AnalysisOperations } from "../workflow-core.ts";
import { ANALYSIS_SINCE, profileById, profileFor, type FilingProfile } from "./profiles.ts";
import type { FilingSpec } from "./recipe.ts";
import { dueFilings, leafSections, registerFilings, resetFiling, updateFiling, type FilingRow, type NewFiling } from "./store.ts";

/** A filing still marked running after this long belongs to a session that died; a later run takes it up. */
const STALE_RUN_MS = 6 * 60 * 60_000;

type Known = { accession: string; form: string; filedAt: string };

/** Everything the company has filed that the path should hold, from the filing list and the events publication. */
export function knownFilings(filings: SecFiling[], events: EventsPublication | null): Known[] {
  const known = new Map<string, Known>();
  for (const f of filings) known.set(f.accessionNumber, { accession: f.accessionNumber, form: f.form, filedAt: f.filingDate });
  for (const e of events?.events ?? []) if (!known.has(e.id)) known.set(e.id, { accession: e.id, form: e.form, filedAt: e.filedAt });
  return [...known.values()];
}

const registration = (ticker: string, k: Known): NewFiling => {
  const profile = profileFor({ form: k.form });
  return { ticker, accession: k.accession, unitKey: `accession:${k.accession}`, form: k.form, filedAt: k.filedAt, profile: profile.id, profileVersion: profile.version };
};

/** What the session opens with: the filing, and every section it can read. */
async function opening(db: D1Database, filing: SecFiling, documentIds: string[]): Promise<string> {
  const sections = await leafSections(db, documentIds);
  return JSON.stringify({ filing: { ticker: filing.ticker, companyName: filing.companyName, form: filing.form, filingDate: filing.filingDate, reportDate: filing.reportDate, accession: filing.accessionNumber, items: filing.items },
    sections: sections.map(s => ({ id: s.sectionId, path: s.path.join(" › "), change: s.change, chars: s.chars })) });
}

export type StartOptions = { requestedBy: "scheduled" | "manual"; accession?: string; runId?: string };

/**
 * Registers what the company has filed and hands every filing whose text is ready to a Pi session of its own. Nothing
 * waits on the session: it reads the filing, publishes the report through its last tool, and records how it ended.
 */
export async function startFilingRuns(env: AnalysisEnv, ticker: string, options: StartOptions, deps: { operations?: Pick<AnalysisOperations, "discover" | "publishFeed" | "loadFiling">; sessions?: { start: (id: string, kind: string, spec: unknown, opening: string, operationId: string) => Promise<void> } } = {}): Promise<{ started: string[]; waiting: string[]; recorded: string[] }> {
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
  const repository = new D1SecRepository(db);
  const stored = await repository.getCache<unknown>(eventsCacheKey(ticker));
  const events = stored ? readEventsPublication(stored.payload, ticker) as EventsPublication | null : null;
  const analysed = new Set((await db.prepare("SELECT accession_number a FROM sec_filing_summaries WHERE ticker = ?").bind(ticker).all<{ a: string }>()).results.map(r => r.a));
  // A company new to the path still gets its latest report and current reports.
  const latest = new Set(selectLatestWorkflowFilings(filings).map(f => f.accessionNumber));
  const known = knownFilings(filings, events).filter(k => k.accession === manual || k.filedAt >= ANALYSIS_SINCE || (latest.has(k.accession) && !analysed.has(k.accession)));
  await registerFilings(db, known.map(k => registration(ticker, k)), at);
  if (manual) await resetFiling(db, ticker, manual, at);
  const due = await dueFilings(db, ticker, manual, new Date(now.getTime() - STALE_RUN_MS).toISOString());
  const byAccession = new Map(filings.map(f => [f.accessionNumber, f]));
  const result = { started: [] as string[], waiting: [] as string[], recorded: [] as string[] };
  const sessions = deps.sessions ?? filingSessions(env);
  const start = async (row: FilingRow, profile: FilingProfile, filing: SecFiling, documentIds: string[]) => {
    const sessionId = manual && options.runId ? options.runId : `${runId}-${row.accession}`;
    const jobVersion = jobAnalysisVersionFor(row.form);
    const jobId = `${ticker}:${row.accession}:${jobVersion}:${sessionId}`;
    const spec: FilingSpec = { ticker, profile: profile.id, filing, runId, sessionId, jobId, jobVersion, requestedBy: options.requestedBy };
    await updateFiling(db, ticker, row.accession, { status: "running", reason: null, runId }, at);
    await repository.upsertAnalysisJob({ jobId, ticker, accessionNumber: row.accession, analysisVersion: jobVersion, status: "running", currentStage: "analysis", attempt: 1, requestedBy: options.requestedBy, workflowInstanceId: sessionId, updatedAt: at });
    await sessions!.start(sessionId, "filing", spec, await opening(db, filing, documentIds), `${sessionId}:report`);
    result.started.push(row.accession);
  };
  for (const row of due) {
    const profile = profileById(row.profile);
    if (profile.model === "off") { await updateFiling(db, ticker, row.accession, { status: "recorded", reason: "no model run for this kind of filing", runId }, at); result.recorded.push(row.accession); continue; }
    const filing = byAccession.get(row.accession);
    const documents = await listLibraryDocuments(db, { ticker, accessions: [row.accession], limit: 20 });
    const ready = documents.filter(d => d.status === "ready");
    if (documents.length && !ready.length) { await updateFiling(db, ticker, row.accession, { status: "recorded", reason: "the library could not read this filing", runId }, at); result.recorded.push(row.accession); continue; }
    if (!filing || !ready.length) { await updateFiling(db, ticker, row.accession, { status: "waiting", reason: filing ? "waiting for the filing library" : "not in the company's filing list yet", runId }, at); result.waiting.push(row.accession); continue; }
    try { await start(row, profile, filing, ready.map(d => d.documentId)); }
    catch (error) { await updateFiling(db, ticker, row.accession, { status: "failed", reason: error instanceof Error ? error.message : String(error), runId, failed: true }, at); }
  }
  return result;
}
