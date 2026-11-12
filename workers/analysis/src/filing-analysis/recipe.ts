import { modelFor } from "../ai-config.ts";
import { renderTable } from "../analyst/agent.ts";
import { webTools, type WebToolState } from "../compose/tools.ts";
import { librarySectionPassages } from "../filing-library/store.ts";
import { readFilingReadme, readmePage, resolveReadmeAccession } from "../filing-library/readme.ts";
import type { AnalysisEnv } from "../operations.ts";
import { handPolicy, handTool, type HandResult } from "../pi/hand-tools.ts";
import type { PiLoaded } from "../pi/host.ts";
import { defaultBudgetLine, type Recipe } from "../recipe.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { SEC_SUMMARY_VERSION, type SecFiling, type SecFilingSummary } from "../sec/sec.ts";
import { loadStageData, type StageData } from "../stage/data.ts";
import { stageTools } from "../stage/recipe.ts";
import type { AnyTool } from "../tools/registry.ts";
import type { LibraryPassageView } from "../../../../shared/analysis-contract/filing-library.ts";
import { FILING_SYSTEM, profileById, type FilingProfile, type ProfileId } from "./profiles.ts";
import { recordRunSummary, recordRunTurn, sectionDocuments, updateFiling } from "./store.ts";
import { filingMemoryStatements } from "./memory-source.ts";
import { COMPOSER_GUIDE, composerTools, deliverComposer, type ComposerSetup } from "../artifact/compose.ts";
import { PERIODIC_BLOCKS, periodicTools, type PeriodicState } from "./periodic.ts";
import { PERIODIC_EVIDENCE, PERIODIC_SYSTEM } from "./prompts.ts";
import { blockText, openComposer, registerSource, sentencesOf, type ComposerState } from "../artifact/document.ts";
import { readPublishedDocument, readWorkState, saveWorkState } from "../artifact/store.ts";
import type { ArtifactDocument } from "../../../../shared/analysis-contract/artifact.ts";

/** What the session is rebuilt from after an eviction. */
export type FilingSpec = { ticker: string; profile: ProfileId; filing: SecFiling; sessionId: string; jobId: string; jobVersion: string; requestedBy: "scheduled" | "manual";
  /** "revise": open on the published report and change it; otherwise start from an empty document (docs/filing-analysis-optimization.md §4.6). */
  mode?: "revise" | "rewrite" };
/** What a session keeps beside the published document, for the session that revises it and for a recheck. */
export type FilingWork = { periodic?: PeriodicState; data: Record<string, string>; web: Record<string, string>; read: string[] };
/**
 * `read`: the sections the session read, in order; they are what a memory item drawn from the report may cite.
 * `data` and `web`: the text of the figures and pages read, so a block citing them can be checked against them.
 */
type FilingState = WebToolState & { composer: ComposerState; candidates: unknown[]; read?: string[]; data: Record<string, string>; web: Record<string, string>; category?: string; periodic?: PeriodicState };

const ok = (observation: string): HandResult => ({ observation });
/** DeepSeek sometimes sends a nested argument as a JSON string. */
const passageText = (p: LibraryPassageView) => p.table ? renderTable(p.table, []) : p.text;
const RESULT_CHARS = 100_000;
const CATEGORIES = ["earnings_update", "guidance", "m&a", "executive", "legal", "other"] as const;

function job(spec: FilingSpec, status: "complete" | "failed", at: string, errorDetail?: string) {
  return { jobId: spec.jobId, ticker: spec.ticker, accessionNumber: spec.filing.accessionNumber, analysisVersion: spec.jobVersion, attempt: 1, requestedBy: spec.requestedBy, workflowInstanceId: spec.sessionId,
    status, currentStage: status === "complete" ? "published" : "analysis", updatedAt: at, completedAt: at, ...(errorDetail ? { errorCode: "analysis_failed", errorDetail } : {}) };
}

/** The report as the filings list and the readers before artifacts store it: the summary block's title and the document's text. */
export function filingSummary(filing: SecFiling, report: { headline: string; text: string; category?: string }, at: string): SecFilingSummary {
  return { ticker: filing.ticker, form: filing.form, filingDate: filing.filingDate, accessionNumber: filing.accessionNumber, headline: report.headline, bullets: [], analystView: "", report: report.text,
    ...(report.category ? { eventCategory: report.category as SecFilingSummary["eventCategory"] } : {}), version: SEC_SUMMARY_VERSION, source: "deepseek", generatedBy: "pi", generatedAt: at };
}

const openState = (spec: FilingSpec): ComposerState => openComposer({ kind: "filing-report", ticker: spec.ticker, subject: spec.filing.accessionNumber, title: `${spec.ticker} ${spec.filing.form} ${spec.filing.reportDate || spec.filing.filingDate}`, lang: "en" });

function filingRecipe(env: AnalysisEnv, spec: FilingSpec, profile: FilingProfile, data: StageData | null, base: { document: ArtifactDocument; work: FilingWork | null } | null): Recipe<FilingSpec, boolean, FilingState> {
  const db = env.DB!;
  const repository = new D1SecRepository(db);
  const { ticker, filing } = spec;
  const accession = filing.accessionNumber;
  // The figures the session reads are sources a block may cite; their text is kept so a cited figure can be checked.
  const figures = (data ? stageTools({ data, locale: "en", scene: [], view: null }).filter(t => ["company_overview", "read_series"].includes(t.name)) as unknown as AnyTool<FilingState>[] : []).map((t): AnyTool<FilingState> => ({
    ...t, observe: (args: unknown, value: unknown, state: FilingState) => {
      const text = t.observe(args, value, state);
      const id = `d${Object.keys(state.data).length + 1}`;
      state.data[id] = text.slice(0, 30_000);
      registerSource(state.composer, id, { title: `Figures read with ${t.name}`, url: null, kind: "data" });
      return `[source ${id}]\n${text}`;
    },
  }));
  const web = webTools<FilingState>({ env, ticker, now: new Date().toISOString(), periodEnd: filing.reportDate, budget: { searches: 8, webReads: 8 }, register: (state, passage) => {
    const id = `w${state.used.webReads}`;
    state.web[id] = passage.text.slice(0, 30_000);
    registerSource(state.composer, id, { title: passage.title, url: /^https:\/\//.test(passage.url) ? passage.url : null, kind: "web" });
    return id;
  } });
  const sectionText = async (sectionId: string) => {
    const [pair] = await sectionDocuments(db, [sectionId]);
    return pair ? (await librarySectionPassages(db, pair[1], [sectionId])).map(passageText).join("\n\n") : null;
  };
  // The passages of this filing that hold a name or figure, for a review whose cited sources do not (§4.1).
  const find = async (terms: string[]) => {
    const documents = (await db.prepare("SELECT document_id FROM sec_documents WHERE ticker = ? AND accession_number = ? AND status = 'ready'").bind(ticker, accession).all<{ document_id: string }>()).results.map(r => r.document_id);
    if (!documents.length || !terms.length) return [];
    const statement = db.prepare("SELECT passage_id, section_id, text FROM sec_passages WHERE document_id IN (SELECT value FROM json_each(?)) AND instr(lower(text), lower(?)) > 0 ORDER BY ordinal LIMIT 3");
    const found = await db.batch<{ passage_id: string; section_id: string; text: string }>(terms.map(term => statement.bind(JSON.stringify(documents), term)));
    const seen = new Set<string>();
    return found.flatMap((rows, i) => rows.results.flatMap(row => {
      if (seen.has(row.passage_id)) return [];
      seen.add(row.passage_id);
      return [{ id: row.passage_id, title: `${filing.form} ${filing.reportDate || filing.filingDate}, section ${row.section_id}, found for "${terms[i]}"`, text: row.text.slice(0, 1800) }];
    }));
  };
  // A periodic report is investigated (§4.10, §4.11); a current report keeps the tools it had.
  const periodic = profile.id === "periodic" ? periodicTools<FilingState>({ env, ticker, filing, runId: spec.sessionId, ...(data ? { flags: data.ledger.flags.slice(0, 12).map(f => ({ rule: f.rule, level: f.level, metric: f.metric, value: f.value })) } : {}) }) : null;
  const summarise = (state: FilingState, status: "published" | "failed") => recordRunSummary(db, {
    runId: spec.sessionId, ticker, accession, profile: profile.id, status, settledBy: state.composer.settledBy ?? null,
    reviewRounds: state.composer.rounds?.content ?? 0, renderRounds: state.composer.rounds?.render ?? 0, sectionsRead: state.read ?? [],
    blocks: state.composer.blocks.length, degraded: state.composer.blocks.filter(b => b.state === "conservative" || b.state === "safe-layout").map(b => b.id),
    detail: { ...(periodic ? periodic.detail(state) : {}), mode: base ? "revise" : "rewrite", ...(state.composer.changes ? { changes: state.composer.changes } : {}), edits: state.composer.log.filter(l => l.phase === "edit").length },
  }).catch(error => console.error(JSON.stringify({ event: "filing-run-summary", ticker, accession, error: error instanceof Error ? error.message : String(error) })));
  const own: AnyTool<FilingState>[] = [
    handTool<FilingState>({ name: "read_filing", description: "Read this filing's README: boilerplate removed, this filing's exhibits included, passages marked [p…]. previous: true reads the earlier filing. offset continues a long README. Cite the current filing as source readme and an earlier one as source readme:<accession>.", input_schema: { type: "object", properties: { previous: { type: "boolean" }, offset: { type: "number" } }, required: [] } },
      async (args, state) => {
        const previous = args.previous === true;
        const offset = Number(args.offset ?? 0) || 0;
        const target = await resolveReadmeAccession(db, ticker, { accession, previous });
        if (!target) return ok(previous ? "The earlier filing has no README." : "This filing has no README yet.");
        const readme = await readFilingReadme(env, ticker, target);
        if (!readme) return ok("The README is not ready yet.");
        const sourceId = previous ? `readme:${target}` : "readme";
        state.read = [...new Set([...(state.read ?? []), sourceId])];
        registerSource(state.composer, sourceId, { title: `${readme.form} ${readme.reportDate} README`, url: /^https:\/\//.test(filing.indexUrl) ? filing.indexUrl : null, kind: "sec" });
        const page = readmePage(readme.markdown, offset);
        return ok(`[source ${sourceId}] ${readme.form} ${readme.reportDate}\n${page.text}`);
      }),
    ...(profile.id === "current" ? [handTool<FilingState>({ name: "set_category", description: `What kind of current report this is: ${CATEGORIES.join(", ")}.`, input_schema: { type: "object", properties: { category: { type: "string", enum: [...CATEGORIES] } }, required: ["category"] } },
      (args, state) => { state.category = CATEGORIES.includes(args.category as never) ? String(args.category) : "other"; return ok(`Category: ${state.category}.`); })] : []),
  ];
  const setup: ComposerSetup<FilingState> = {
    env, chart: data ? { data: data.data, periodEnd: data.periodEnd } : null, ledger: { ticker, runId: spec.sessionId }, budgetTurns: profile.turns,
    research: periodic ? ["read_sections", "grep", "section_history", "query_facts", "fact_history", "read_transcript", "read_report"] : ["read_filing", ...(figures.length ? ["read_series"] : []), "search", "read_web"],
    previewQuery: `report=${encodeURIComponent(accession)}`,
    find: terms => find(terms),
    ...(periodic ? { resolve: periodic.resolve, figure: periodic.figure, required: () => PERIODIC_BLOCKS, precheck: periodic.precheck } : {}),
    read: async (id, state) => {
      // A fact or paragraph named by a report opened for revision is read again the first time it is needed.
      const held = periodic?.read(id, state) ?? (periodic && await periodic.resolve(id, state).catch(() => false) ? periodic.read(id, state) : null);
      if (held) return held;
      if (state.data[id] !== undefined) return { title: state.composer.sources[id]?.title ?? id, text: state.data[id]! };
      if (state.web[id] !== undefined) return { title: state.composer.sources[id]?.title ?? id, text: state.web[id]! };
      if (id === "readme" || id.startsWith("readme:")) {
        const accession = id === "readme" ? filing.accessionNumber : id.slice("readme:".length);
        const readme = await readFilingReadme(env, ticker, accession);
        return readme ? { title: state.composer.sources[id]?.title ?? `${readme.form} ${readme.reportDate}`, text: readme.markdown } : null;
      }
      const text = state.composer.sources[id] ? await sectionText(id) : null;
      return text === null ? null : { title: state.composer.sources[id]!.title, text };
    },
    onPublish: async (state, published) => {
      const now = new Date().toISOString();
      const headline = state.composer.blocks.find(b => b.id === "summary")?.title || state.composer.artifact.title;
      const summary = filingSummary(filing, { headline, text: published.text, ...(state.category ? { category: state.category } : {}) }, now);
      // A periodic report is also the company memory's source: the memory job is published with the report.
      const memory = profile.id === "periodic" ? await filingMemoryStatements(env, { filing, summary, sessionId: spec.sessionId, readSectionIds: state.read ?? [] }) : [];
      return repository.summaryStatements({ ticker, accessionNumber: accession, form: filing.form }, summary, memory) as unknown as D1PreparedStatement[];
    },
    afterPublish: async (state) => {
      const now = new Date().toISOString();
      const spent = await db.prepare("SELECT SUM(input_tokens - COALESCE(cached_tokens, 0) + output_tokens) n FROM ai_usage WHERE run_id = ?").bind(spec.sessionId).first<{ n: number | null }>();
      await updateFiling(db, ticker, accession, { status: "published", reason: null, tokens: spent?.n ?? 0, publishedAt: now }, now);
      await repository.upsertAnalysisJob(job(spec, "complete", now));
      await saveWorkState(env, "filing-report", ticker, accession, { ...(state.periodic ? { periodic: state.periodic } : {}), data: state.data, web: state.web, read: state.read ?? [] } satisfies FilingWork)
        .catch(error => console.error(JSON.stringify({ event: "filing-work-state", ticker, accession, error: error instanceof Error ? error.message : String(error) })));
      await summarise(state, "published");
    },
  };
  const compose = composerTools(setup);
  const list = [...(periodic ? periodic.tools : own), ...figures, ...web, ...compose];
  return {
    id: periodic ? "filing.periodic.v5" : `filing.${spec.profile}.v4`,
    budget: { turns: profile.turns, wallMs: profile.wallMs },
    resultChars: periodic ? 90_000 : RESULT_CHARS,
    callsPerTurn: Infinity,
    concurrent: ["read_filing", "read_sections", "read_previous", "grep", "section_history", "query_facts", "fact_history", "read_report", "read_transcript", "read_evidence", "list_leads", "read_series", "company_overview", "read_block", "outline", "view_issue"],
    system: () => periodic ? `${PERIODIC_SYSTEM(ticker)}\n\n${COMPOSER_GUIDE}\n${PERIODIC_EVIDENCE}` : `${FILING_SYSTEM(ticker)}\n${profile.prompt}\n\n${COMPOSER_GUIDE}`,
    open: () => {
      const state: FilingState = { composer: openState(spec), candidates: [], hits: [], used: { searches: 0, webReads: 0 }, data: {}, web: {} };
      if (!base) return state;
      // The published report is the document the session opens on: its blocks stand as they were reviewed, and only
      // what the session changes is reviewed again.
      const c = state.composer;
      c.blocks = base.document.blocks.map(b => ({ ...b }));
      c.charts = Object.fromEntries(base.document.charts.map(chart => [chart.id, chart]));
      c.sources = Object.fromEntries(base.document.sources.map(({ id, ...source }) => [id, source]));
      c.passed = Object.fromEntries(c.blocks.map(b => [b.id, sentencesOf(blockText(b.html)).map(s => s.key)]));
      if (base.work) { state.data = base.work.data ?? {}; state.web = base.work.web ?? {}; state.read = base.work.read ?? []; if (base.work.periodic) state.periodic = base.work.periodic; }
      return state;
    },
    tools: () => list,
    policy: { allow: list.map(t => t.name), post: handPolicy(periodic ? periodic.tools : own).post },
    onTurn: (s, turn) => { s.composer.turns = turn; },
    settled: s => s.composer.phase === "published",
    settle: s => s.composer.phase === "published",
    nudge: periodic ? "Continue: work the leads, record what you confirm, write the blocks, then call finish." : "Continue reading and writing blocks, then call finish.",
    budgetLine: (s, left) => `${defaultBudgetLine(left)}${periodic && s.composer.phase !== "published" ? periodic.standing(s) : ""}${s.composer.phase === "published" ? "" : !s.composer.blocks.length && left <= profile.turns * 0.45 ? " Write the blocks now with write_blocks: the review at finish and its fixes need the turns that are left." : s.composer.blocks.length && left <= profile.turns * 0.3 ? " Call finish now: its review may ask for fixes, and they need turns." : ""}`,
    afterRun: async (s) => {
      // A session that ends without publishing still delivers: the harness settles what is open and publishes (§6.5).
      // The summary is written again here: the calls of the last round are on record only once the run has ended.
      if (await deliverComposer(s, setup).catch(error => { console.error(JSON.stringify({ event: "artifact-deliver", ticker, accession, error: error instanceof Error ? error.message : String(error) })); return false; })) { await summarise(s, "published"); return; }
      const now = new Date().toISOString();
      await updateFiling(db, ticker, accession, { status: "failed", reason: "the session ended without a report" }, now);
      await repository.upsertAnalysisJob(job(spec, "failed", now, "the session ended without a report"));
      await summarise(s, "failed");
    },
  };
}

/** Rebuilds the session from its spec, on start and after an eviction. */
export async function filingLoader(spec: FilingSpec, env: AnalysisEnv): Promise<PiLoaded> {
  const profile = profileById(spec.profile);
  const data = await loadStageData(env, spec.ticker, { findings: false }).catch(() => null);
  const store = env as unknown as Parameters<typeof readPublishedDocument>[0];
  const document = spec.mode === "revise" && profile.id === "periodic" ? await readPublishedDocument(store, "filing-report", spec.ticker, spec.filing.accessionNumber).catch(() => null) : null;
  const base = document ? { document, work: await readWorkState<FilingWork>(store, "filing-report", spec.ticker, spec.filing.accessionNumber) } : null;
  return {
    recipe: filingRecipe(env, spec, profile, data, base), input: spec, effort: profile.reasoning, model: modelFor(env, "filing"), ledger: { kind: "filing", ticker: spec.ticker, runId: spec.sessionId },
    // A session started before artifacts has no document yet; it continues with an empty one.
    hydrate: (state: FilingState) => { state.composer ??= openState(spec); state.data ??= {}; state.web ??= {}; },
    record: entry => { void recordRunTurn(env.DB!, spec.sessionId, entry); },
  };
}
