import { insiderTone, readEventsPublication } from "../../../../shared/analysis-runtime/events.ts";
import type { CompanyEvent, EventsPublication } from "../../../../shared/analysis-contract/events.ts";
import type { LibraryDocumentSummary } from "../../../../shared/analysis-contract/filing-library.ts";
import { renderTable } from "../analyst/agent.ts";
import { requireDb } from "../core.ts";
import { eventsCacheKey } from "../events/read.ts";
import { librarySectionPassages, listLibraryDocuments } from "../filing-library/store.ts";
import { itemsIndexKey, itemAnalysisKey, type ItemsIndex, type StoredItem } from "../items/read.ts";
import { ITEM_VERSIONS, itemFacts, prepareItem } from "../items/workflow.ts";
import { itemPeriodEnd, itemOpening, type ItemSubject } from "../items/recipe.ts";
import type { AnalysisEnv } from "../operations.ts";
import { outboxStatement } from "../pipeline/outbox.ts";
import { sessionRunner, type SessionRunner } from "../pi/runs.ts";
import type { PiOutcome } from "../pi/host.ts";
import { assertHistoryUnits, type AnalysisOperations, type PreparedFilingReference, type WorkflowStepLike, jobAnalysisVersionFor, selectLatestWorkflowFilings } from "../workflow-core.ts";
import { D1SecRepository } from "../sec/d1.ts";
import type { FilingBlock, SecAnalysisBrief } from "../sec/analysis.ts";
import type { PreparedSecFiling } from "../sec/pipeline.ts";
import { artifactKey, reportOpening, type Restored } from "../sec/report-agent.ts";
import type { SecFiling } from "../sec/sec.ts";
import { ANALYSIS_SINCE, FILING_ANALYSIS_VERSION, profileById, profileFor, type FilingProfile } from "./profiles.ts";
import { filingItemInput, filingItemRecipe, sectionOpening, type ComposeOutcome, type ComposeSpec, type ItemOutcome, type ItemSpec, type PeriodicState, type SectionSpec, type ItemState } from "./recipe.ts";
import { WAITING_FOR_EVENTS, dueFilings, leafSections, readSectionNotes, registerFilings, resetFiling, updateFiling, writeSectionNotes, type FilingRow, type NewFiling, type NoteWrite } from "./store.ts";
import { buildWorklist, notesToNodes, type SectionFacts, type SectionNote, type WorkEntry } from "./worklist.ts";

export type FilingAnalysisParams = { ticker: string; requestedBy: "scheduled" | "manual"; accessionNumber?: string };

/** Filings analysed at once; a filing's section batches run at most this many at a time too. */
const CONCURRENCY = 3;
/** Past this share of unread sections the filing is not reported on; it is tried again. */
const MAX_UNREAD = 1 / 3;

/** A filing still marked running after this long belongs to a run that died; a later run takes it up. */
const STALE_RUN_MS = 6 * 60 * 60_000;

class Withheld extends Error {}

type Known = { accession: string; form: string; filedAt: string; flagged: boolean };

/** Everything the company has filed that the path should hold, from the filing list and the events publication. */
export function knownFilings(filings: SecFiling[], events: EventsPublication | null): Known[] {
  const all = events?.events ?? [];
  const known = new Map<string, Known>();
  for (const f of filings) known.set(f.accessionNumber, { accession: f.accessionNumber, form: f.form, filedAt: f.filingDate, flagged: false });
  for (const e of all) {
    if (known.has(e.id)) continue;
    known.set(e.id, { accession: e.id, form: e.form, filedAt: e.filedAt, flagged: e.class === "insider" && insiderTone(all, e) === "attention" });
  }
  return [...known.values()];
}

const registration = (ticker: string, k: Known): NewFiling => {
  const profile = profileFor({ form: k.form, flagged: k.flagged });
  return { ticker, accession: k.accession, unitKey: `accession:${k.accession}`, form: k.form, filedAt: k.filedAt, profile: profile.id, profileVersion: profile.version };
};

/** The whole of a section as one body of text, so the report's evidence ids are the library's own passages. */
function libraryBody(sections: SectionFacts[], passages: Map<string, Array<{ passageId: string; kind: string; text: string; table: unknown }>>) {
  const outline: PreparedSecFiling["outline"] = [], blocks: FilingBlock[] = [], headings: PreparedSecFiling["document"]["headings"] = [];
  let text = "", ordinal = 0;
  for (const section of sections) {
    const start = text.length, title = section.path.join(" › ");
    text += `${title}\n\n`;
    headings.push({ title, start, level: 1 });
    for (const p of passages.get(section.sectionId) ?? []) {
      const body = p.table ? renderTable(p.table as never, []) : p.text;
      const from = text.length;
      text += `${body}\n\n`;
      blocks.push({ blockId: p.passageId, ordinal: ordinal++, start: from, end: from + body.length, heading: section.path.at(-1) ?? "", headingPath: title, elementType: p.table ? "table_like" : "text", preview: body.slice(0, 200), body, tokenCount: Math.ceil(body.length / 4), numericDensity: 0, tableCount: p.table ? 1 : 0, contentHash: p.passageId, source: "body" });
    }
    outline.push({ id: section.sectionId, title, level: 1, start, end: text.length, characters: text.length - start });
  }
  return { outline, blocks, document: { text, headings } };
}

async function rebaseOnLibrary(env: AnalysisEnv, reference: PreparedFilingReference, documents: LibraryDocumentSummary[]): Promise<void> {
  const db = requireDb(env);
  const sections = await leafSections(db, documents.map(d => d.documentId));
  const passages = new Map<string, Array<{ passageId: string; kind: string; text: string; table: unknown }>>();
  for (const d of documents) for (const p of await librarySectionPassages(db, d.documentId, sections.filter(s => s.documentId === d.documentId).map(s => s.sectionId))) {
    passages.set(p.sectionId, [...(passages.get(p.sectionId) ?? []), p]);
  }
  const object = await env.SEC_FILINGS.get(`${reference.key}/meta.json`);
  if (!object) throw new Error("Prepared filing not found");
  const meta = JSON.parse(await object.text()) as Record<string, unknown>;
  const body = libraryBody(sections, passages);
  await Promise.all([
    env.SEC_FILINGS.put(`${reference.key}/meta.json`, JSON.stringify({ ...meta, outline: body.outline, blockIds: body.blocks.map(b => `ev:${b.blockId}`) })),
    env.SEC_FILINGS.put(`${reference.key}/text.json`, JSON.stringify({ document: body.document, blocks: body.blocks })),
  ]);
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export type FilingDeps = { sessions?: SessionRunner };

/**
 * One company's run of the path: registers what the company has filed, then takes every filing whose materials are
 * ready through the same steps, each with its own state, so one filing's failure touches no other.
 */
export async function executeFilingAnalysisWorkflow(params: FilingAnalysisParams, runId: string, step: WorkflowStepLike, env: AnalysisEnv, operations: AnalysisOperations, deps: FilingDeps = {}) {
  const { ticker } = params;
  const db = requireDb(env);
  const sessions = deps.sessions ?? sessionRunner(env as never, step);
  const manual = params.requestedBy === "manual" ? params.accessionNumber ?? null : null;
  const now = await step.do("fa-time", async () => new Date().toISOString());
  // Each filing is analysed on its own: a run asks for no quarter grouping, and a manual run ignores one stored earlier.
  const discovery = manual ? { filings: [await step.do("fa-load", async () => {
    const filing = await operations.loadFiling!(ticker, manual);
    if (!filing) throw new Error("Requested filing is no longer available");
    const { earningsGroup: _group, ...single } = filing;
    void _group;
    return single as SecFiling;
  })] } : await step.do("fa-discover", async () => {
    const found = await operations.discover(ticker);
    await operations.publishFeed(found.feed);
    return { filings: found.filings };
  });
  const events = await step.do("fa-events", async () => {
    const stored = await new D1SecRepository(db).getCache<unknown>(eventsCacheKey(ticker));
    return stored ? readEventsPublication(stored.payload, ticker) as EventsPublication | null : null;
  });
  const filings = new Map(discovery.filings.map(f => [f.accessionNumber, f]));
  const eventOf = new Map<string, CompanyEvent>((events?.events ?? []).map(e => [e.id, e]));
  const due = await step.do("fa-register", async () => {
    // A company new to the path still gets its latest report and current reports; what the old path analysed stays as it is.
    const analysed = new Set((await db.prepare("SELECT accession_number a FROM sec_filing_summaries WHERE ticker = ?").bind(ticker).all<{ a: string }>()).results.map(r => r.a));
    const latest = new Set(selectLatestWorkflowFilings(discovery.filings).map(f => f.accessionNumber));
    const known = knownFilings(discovery.filings, events).filter(k => k.accession === manual || k.filedAt >= ANALYSIS_SINCE || (latest.has(k.accession) && !analysed.has(k.accession)));
    await registerFilings(db, known.map(k => registration(ticker, k)), now);
    if (manual) await resetFiling(db, ticker, manual, now);
    return dueFilings(db, ticker, manual, new Date(new Date(now).getTime() - STALE_RUN_MS).toISOString());
  });
  if (!due.length) return { status: "empty" };

  const entries: Array<{ id: string; kind: "report" | "current" | "insider"; written: boolean; reason?: string }> = [];

  const analyse = async (row: FilingRow): Promise<void> => {
    const profile = profileById(row.profile);
    const a = row.accession;
    const mark = (update: Parameters<typeof updateFiling>[3]) => step.do(`${a}:status:${update.status}`, async () => { await updateFiling(db, ticker, a, { runId, ...update }, new Date().toISOString()); return true; });
    if (profile.model === "off") { await mark({ status: "recorded", reason: "no model run for this kind of filing" }); return; }
    const filing = filings.get(a) ?? null;
    const event = eventOf.get(a) ?? null;
    const documents = profile.materials === "library" ? await step.do(`${a}:documents`, () => listLibraryDocuments(db, { ticker, accessions: [a], limit: 20 })) : [];
    const ready = documents.filter(d => d.status === "ready");
    if (profile.materials === "library" && !ready.length) {
      if (documents.length) await mark({ status: "recorded", reason: "the library could not read this filing" }); else await mark({ status: "waiting", reason: "waiting for the filing library" });
      return;
    }
    if (profile.id === "periodic" && !filing) { await mark({ status: "waiting", reason: "not in the company's filing list yet" }); return; }
    if (profile.id !== "periodic" && !event) { await mark({ status: "waiting", reason: WAITING_FOR_EVENTS }); return; }
    await mark({ status: "running", reason: null });
    try {
      const outcome = profile.id === "periodic"
        ? await analysePeriodic(row, profile, filing!, ready)
        : await analyseWhole(row, profile, filing, event!);
      entries.push(outcome);
    } catch (error) {
      const withheld = error instanceof Withheld;
      await step.do(`${a}:status:error`, async () => { await updateFiling(db, ticker, a, { status: withheld ? "withheld" : "failed", reason: message(error), runId, failed: !withheld }, new Date().toISOString()); return true; });
      entries.push({ id: a, kind: profile.itemKind, written: false, reason: message(error).slice(0, 600) });
    }
  };

  const saveItem = (id: string, row: FilingRow, profile: FilingProfile, composed: NonNullable<ItemOutcome["composed"]>, periodEnd: string, trail: unknown[]) => step.do(`${row.accession}:save-item`, async () => {
    const record = { schemaVersion: "item-analysis.v1", ticker, itemId: id, itemKind: profile.itemKind, periodEnd, generatedAt: now, version: `${FILING_ANALYSIS_VERSION}:${profile.version}`, ...composed, trace: trail } as StoredItem;
    await new D1SecRepository(db).setCache(itemAnalysisKey(ticker, id), record, now);
    return true;
  });
  const finish = (row: FilingRow, profile: FilingProfile, tokens: number, body: Record<string, unknown>) => step.do(`${row.accession}:publish`, async () => {
    const revision = row.revision + 1, artifactName = `analysis/${ticker}/filing-analysis/${row.unitKey.replace(/[^\w.-]/g, "_")}/r${revision}.json`;
    await env.SEC_FILINGS.put(artifactName, JSON.stringify({ schemaVersion: FILING_ANALYSIS_VERSION, ticker, unitKey: row.unitKey, accession: row.accession, profile: profile.id, profileVersion: profile.version, generatedAt: now, revision, usage: { tokens }, ...body }));
    await updateFiling(db, ticker, row.accession, { status: "published", reason: null, runId, tokens, revision, artifactKey: artifactName, publishedAt: new Date().toISOString() }, new Date().toISOString());
    return true;
  });

  async function analyseWhole(row: FilingRow, profile: FilingProfile, filing: SecFiling | null, event: CompanyEvent) {
    const a = row.accession;
    const subject: ItemSubject = { kind: profile.itemKind === "insider" ? "insider" : "current", id: a, date: event.filedAt, form: event.form, event };
    const prepared = await step.do(`${a}:prepare`, () => prepareItem(env, ticker, subject));
    const spec: ItemSpec = { stage: "item", ticker, profile: profile.id, subject, now, prepared, filing: profile.output.digest ? filing : null, runId };
    const { opening, periodEnd } = await step.do(`${a}:open`, async () => {
      const data = await itemFacts(env, ticker);
      if (!data) throw new Error(`filing-analysis: no stage data for ${ticker}`);
      const input = filingItemInput(env, spec, profile, data);
      return { opening: itemOpening(input, filingItemRecipe(input, spec, profile).open(input)), periodEnd: itemPeriodEnd(subject, data) };
    });
    const outcome: PiOutcome<ItemOutcome> & { state: ItemState } = await sessions(`filing`, spec, opening, `${runId}:${a}:item`);
    const { composed, digest, withheld, errors } = outcome.output;
    if (!composed) throw new (withheld ? Withheld : Error)(withheld ? `checks refused the analysis: ${errors.join("; ")}` : `the session ended (${outcome.reason}) without an analysis`);
    if (profile.output.digest && filing) {
      if (!digest) throw new Withheld("the session ended without a digest");
      await step.do(`${a}:publish-digest`, async () => { await operations.publishEvent(digest); return true; });
    }
    await saveItem(a, row, profile, composed, periodEnd, outcome.trail);
    await finish(row, profile, outcome.spent, { periodEnd, analysis: composed, digest });
    return { id: a, kind: profile.itemKind, written: true };
  }

  async function analysePeriodic(row: FilingRow, profile: FilingProfile, filing: SecFiling, documents: LibraryDocumentSummary[]) {
    const a = row.accession, pass = profile.sectionPass!;
    const jobBase = { jobId: `${ticker}:${a}:${jobAnalysisVersionFor(filing.form)}:${runId}`, ticker, accessionNumber: a, analysisVersion: jobAnalysisVersionFor(filing.form), attempt: 1, requestedBy: params.requestedBy, workflowInstanceId: runId } as const;
    await step.do(`${a}:job-start`, () => operations.updateJob({ ...jobBase, status: "running", currentStage: "prepare", updatedAt: new Date().toISOString() }));
    let tokens = 0;
    try {
      const reference = await step.do(`${a}:prepare`, () => operations.prepare(filing));
      if (reference.coverAmendment && operations.publishAmendment) {
        await step.do(`${a}:amendment`, () => operations.publishAmendment!(filing, reference.coverAmendment!));
        await step.do(`${a}:job-amendment`, () => operations.updateJob({ ...jobBase, status: "complete", currentStage: "published", updatedAt: new Date().toISOString(), completedAt: new Date().toISOString() }));
        await step.do(`${a}:recorded`, async () => { await updateFiling(db, ticker, a, { status: "recorded", reason: "an amendment that only adds an exhibit", runId }, new Date().toISOString()); return true; });
        return { id: a, kind: profile.itemKind, written: false, reason: "cover amendment" };
      }
      await step.do(`${a}:library`, async () => { await rebaseOnLibrary(env, reference, documents); return true; });
      const context = await step.do(`${a}:context`, () => operations.getContext(filing, reference));
      const brief: SecAnalysisBrief = await step.do(`${a}:brief`, () => operations.buildBrief!(filing, reference, context));
      assertHistoryUnits(brief);

      // The walk: what carries forward is written now; the rest becomes batches of work.
      const plan = await step.do(`${a}:worklist`, async () => {
        const sections = await leafSections(db, documents.map(d => d.documentId));
        const passages = (await Promise.all(documents.map(d => librarySectionPassages(db, d.documentId, sections.filter(s => s.documentId === d.documentId).map(s => s.sectionId))))).flat();
        const done = manual ? new Map<string, SectionNote>() : await readSectionNotes(db, sections.map(s => s.sectionId));
        const earlier = await readSectionNotes(db, sections.flatMap(s => s.previousSectionId ? [s.previousSectionId] : []));
        const list = buildWorklist(sections.filter(s => !done.has(s.sectionId)), passages, earlier, pass.batchChars);
        await writeSectionNotes(db, list.carried.map((c): NoteWrite => ({ section: c.section, ticker, status: "carried", carriedFrom: c.from, prior: "note", note: c.note, profileVersion: profile.version })), now);
        return { batches: list.batches, sectionCount: sections.length };
      });
      const failedBatches: WorkEntry[][] = [];
      const readBatch = async (entries: WorkEntry[], index: number) => {
        const spec: SectionSpec = { stage: "section", ticker, profile: profile.id, entries, runId };
        const opening = await step.do(`${a}:s${index}:open`, () => sectionOpening(env, spec));
        const outcome: PiOutcome<SectionNote[] | null> = await sessions("filing", spec, opening, `${runId}:${a}:s${index}`);
        tokens += outcome.spent;
        if (!outcome.output) { failedBatches.push(entries); return; }
        await step.do(`${a}:s${index}:save`, async () => {
          const byId = new Map(entries.map(e => [e.sectionId, e]));
          await writeSectionNotes(db, outcome.output!.map((note): NoteWrite => ({ section: byId.get(note.sectionId)!, ticker, status: "written", carriedFrom: null, prior: byId.get(note.sectionId)!.prior, note, profileVersion: profile.version })), now);
          return true;
        });
      };
      for (let i = 0; i < plan.batches.length; i += CONCURRENCY) await Promise.all(plan.batches.slice(i, i + CONCURRENCY).map((b, j) => readBatch(b, i + j)));
      const unread = failedBatches.flat().length;
      if (plan.sectionCount && unread / plan.sectionCount > MAX_UNREAD) throw new Error(`section pass: ${unread} of ${plan.sectionCount} sections were not read`);

      const restored: Restored = await step.do(`${a}:nodes`, async () => {
        const sections = await leafSections(db, documents.map(d => d.documentId));
        const notes = await readSectionNotes(db, sections.map(s => s.sectionId));
        const texts = new Map<string, Array<{ passageId: string; text: string }>>();
        for (const d of documents) for (const p of await librarySectionPassages(db, d.documentId, sections.filter(s => s.documentId === d.documentId).map(s => s.sectionId))) texts.set(p.sectionId, [...(texts.get(p.sectionId) ?? []), p]);
        const collapse = (t: string) => t.replace(/\s+/g, " ");
        const evidenceOf = (section: SectionFacts, note: SectionNote) => {
          const passages = texts.get(section.sectionId) ?? [];
          const quoted = passages.filter(p => note.quotes.some(q => collapse(p.text).includes(collapse(q))));
          return (quoted.length ? quoted : passages.slice(0, 2)).map(p => `ev:${p.passageId}`);
        };
        return { ...notesToNodes(sections, notes, evidenceOf), rounds: 0 };
      });

      await step.do(`${a}:inputs`, async () => {
        await Promise.all([env.SEC_FILINGS.put(artifactKey(reference, "context"), JSON.stringify(context)), env.SEC_FILINGS.put(artifactKey(reference, "brief"), JSON.stringify(brief))]);
        return true;
      });
      const { opening, periodEnd } = await step.do(`${a}:compose-open`, async () => {
        const object = await env.SEC_FILINGS.get(`${reference.key}/meta.json`), body = await env.SEC_FILINGS.get(`${reference.key}/text.json`);
        const prepared = { ...JSON.parse(await object!.text()), ...JSON.parse(await body!.text()) } as PreparedSecFiling;
        return { periodEnd: filing.reportDate, opening: `${reportOpening(prepared, brief, restored)}\n${JSON.stringify({ nodesToRead: restored.plan.nodes.map(n => ({ id: n.id, title: n.title })) })}` };
      });
      const spec: ComposeSpec = { stage: "compose", ticker, profile: profile.id, reference, restored, now, periodEnd, earlierAvailable: documents.some(d => d.previousDocumentId), workflowInstanceId: runId, runId };
      const composed: PiOutcome<ComposeOutcome> & { state: PeriodicState } = await sessions("filing", spec, opening, `${runId}:${a}:compose`);
      tokens += composed.spent;
      const { written, composed: analysis, withheld } = composed.output;
      if (!written.passed || !written.plan || !written.review) throw new Withheld(written.issues.length ? `the report failed review: ${written.issues.join("; ")}` : `the session ended (${composed.reason}) without a passed report`);
      const result = await step.do(`${a}:result`, () => operations.loadPassedReport!(reference, written.passed!));
      const review = written.review;
      result.artifact.report.dataQuality = { ...result.artifact.report.dataQuality, analysisStatus: review.status === "complete" ? "complete" : "partial", unresolvedQuestions: review.unresolvedQuestions, failedNodeIds: [], stopReason: review.stopReason, managerCoverageScore: review.coverageScore };
      if (result.artifact.report.dataQuality.verificationStatus === "failed") throw new Withheld(`verification failed: ${result.artifact.report.dataQuality.warnings.join("; ").slice(0, 400)}`);
      const summary = result.summary ? { ...result.summary, plan: written.plan, nodes: result.summary.nodes ?? written.nodes, managerReview: review, repairRounds: 0 } : null;
      const publication = await step.do(`${a}:publish-report`, () => operations.publish(result.artifact, summary));
      await step.do(`${a}:job-done`, () => operations.updateJob({ ...jobBase, status: "complete", currentStage: "published", updatedAt: new Date().toISOString(), completedAt: new Date().toISOString() }));
      if (publication?.memoryJobId && operations.enqueueMemory) await step.do(`${a}:memory`, async () => { await operations.enqueueMemory!(publication.memoryJobId!, ticker).catch(() => undefined); return true; });
      if (analysis) await saveItem(a, row, profile, analysis, periodEnd, composed.trail);
      await finish(row, profile, tokens, { periodEnd, analysis, reportKey: written.passed.resultKey, analysisWithheld: withheld });
      return { id: a, kind: profile.itemKind, written: Boolean(analysis), ...(analysis ? {} : { reason: "the report passed; the analysis was withheld by its checks" }) };
    } catch (error) {
      await step.do(`${a}:job-error`, () => operations.updateJob({ ...jobBase, status: "failed", currentStage: "analysis", errorCode: error instanceof Withheld ? "withheld" : "analysis_failed", errorDetail: message(error).slice(0, 500), updatedAt: new Date().toISOString(), completedAt: new Date().toISOString() }));
      throw error;
    }
  }

  for (let i = 0; i < due.length; i += CONCURRENCY) await Promise.allSettled(due.slice(i, i + CONCURRENCY).map(analyse));

  // The index the page and the upper layers read: this run's rows upon what was already there, committed with its event.
  if (entries.length) await step.do("fa-index", async () => {
    const existing = (await new D1SecRepository(db).getCache<ItemsIndex>(itemsIndexKey(ticker)))?.payload;
    const byId = new Map((existing?.items ?? []).map(item => [item.id, item]));
    for (const entry of entries) byId.set(entry.id, entry);
    const index: ItemsIndex = { version: `${FILING_ANALYSIS_VERSION}:${Object.values(ITEM_VERSIONS).join(",")}`, fingerprint: `${runId}`, generatedAt: now, items: [...byId.values()] };
    await db.batch([
      db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at").bind(itemsIndexKey(ticker), JSON.stringify(index), now),
      outboxStatement(db, { type: "items.published", ticker }, now),
    ]);
    return true;
  });
  return { status: "ready", due: due.length, written: entries.filter(e => e.written).length, failed: entries.filter(e => !e.written).map(e => `${e.id}:${e.reason ?? ""}`) };
}
