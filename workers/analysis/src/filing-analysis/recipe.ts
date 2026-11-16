import type { AiModel, AiEffort } from "../../../../shared/analysis-contract/ai-models-admin.ts";
import { companyResearchDependencyStatements } from "../public-research/context.ts";
import type { FrozenCompanyResearch } from "../../../../shared/analysis-contract/public-research.ts";
import { publicResearchTools, PUBLIC_RESEARCH_GUIDE, type ResearchContextState } from "../company-research/context-tools.ts";
import { z } from "zod";
import { modelFor } from "../ai-config.ts";
import { webTools, type WebToolState } from "../compose/tools.ts";
import type { AnalysisEnv } from "../operations.ts";
import { handPolicy, handTool, type HandResult } from "../pi/hand-tools.ts";
import type { PiLoaded } from "../pi/host.ts";
import { unpackState } from "../pi/state.ts";
import { defaultBudgetLine, type Recipe } from "../recipe.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { SEC_SUMMARY_VERSION, type SecFiling, type SecFilingSummary } from "../sec/sec.ts";
import type { AnyTool } from "../tools/registry.ts";
import type { MaterialRef, MaterialSnapshot } from "../../../../shared/analysis-contract/filing-material.ts";
import { readMaterialSnapshot } from "../filing-material/index.ts";
import { materialBlockId, readFilingMarkdown, searchFilingMarkdown, sourceText } from "../filing-material/read.ts";
import { FILING_SYSTEM, profileById, type FilingProfile, type ProfileId } from "./profiles.ts";
import { recordRunSummary, recordRunTurn, updateFiling } from "./store.ts";
import { filingMemoryStatements } from "./memory-source.ts";
import { composerGuide, composerTools, type ComposerSetup } from "../artifact/compose.ts";
import { PERIODIC_BLOCKS, periodicTools, type PeriodicState } from "./periodic.ts";
import { PERIODIC_EVIDENCE, PERIODIC_SYSTEM } from "./prompts.ts";
import { blockText, openComposer, registerSource, sentencesOf, type ComposerState } from "../artifact/document.ts";
import { readPublishedDocument, readWorkState, saveWorkState } from "../artifact/store.ts";
import type { ArtifactDocument } from "../../../../shared/analysis-contract/artifact.ts";
import { filingSemanticAudit } from "./semantic-audit.ts";

/** What the session is rebuilt from after an eviction. */
export type FilingMode = { mode?: "revise" | "rewrite" } | { mode: "resume"; checkpoint: string };
export type FilingSpec = { shadow?: boolean; shadowModel?: AiModel; shadowEffort?: AiEffort; publicResearch?: FrozenCompanyResearch; ticker: string; profile: ProfileId; filing: SecFiling; sessionId: string; jobId: string; jobVersion: string; requestedBy: "scheduled" | "manual"; material: MaterialRef } & FilingMode;
/** What a session keeps beside the published document, for the session that revises it and for a recheck. */
export type FilingWork = { material: MaterialRef; periodic?: PeriodicState; web: Record<string, string>; read: string[] };
type FilingState = WebToolState & ResearchContextState & { composer: ComposerState; candidates: unknown[]; read?: string[]; web: Record<string, string>; category?: string; periodic?: PeriodicState };

export async function readFilingCheckpoint(env: Pick<AnalysisEnv, "SEC_FILINGS">, key: string, material: MaterialRef): Promise<FilingState> {
  const object = await env.SEC_FILINGS.get(key);
  if (!object) throw new Error(`FILING_CHECKPOINT_MISSING:${key}`);
  const checkpoint = z.object({ material: z.object({ ticker: z.string(), accession: z.string(), version: z.string() }), state: z.string() }).parse(JSON.parse(await object.text()));
  if (checkpoint.material.ticker !== material.ticker || checkpoint.material.accession !== material.accession || checkpoint.material.version !== material.version) throw new Error("FILING_CHECKPOINT_MATERIAL_MISMATCH");
  return unpackState<FilingState>(checkpoint.state);
}

const ok = (observation: string): HandResult => ({ observation });
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

function filingRecipe(env: AnalysisEnv, spec: FilingSpec, profile: FilingProfile, snapshot: MaterialSnapshot, base: { document: ArtifactDocument; work: FilingWork | null } | null, resumed: FilingState | null): Recipe<FilingSpec, boolean, FilingState> {
  const db = env.DB!;
  const repository = new D1SecRepository(db);
  const { ticker, filing } = spec;
  const accession = filing.accessionNumber;
  const web = webTools<FilingState>({ env, ticker, now: new Date().toISOString(), periodEnd: filing.reportDate, budget: { searches: 8, webReads: 8 }, register: (state, passage) => {
    const id = `w${state.used.webReads}`;
    state.web[id] = passage.text.slice(0, 30_000);
    registerSource(state.composer, id, { title: passage.title, url: /^https:\/\//.test(passage.url) ? passage.url : null, kind: "web" });
    return id;
  } });
  const find = async (terms: string[]) => {
    const matches = new Map<string, { id: string; title: string; text: string }>();
    for (const term of terms) {
      const found = await searchFilingMarkdown(env, snapshot, { query: term, limit: 3 });
      for (const match of found.matches) {
        const page = await readFilingMarkdown(env, snapshot, { anchor: match.anchor, maxChars: 12_000 });
        for (const id of page.blockIds.filter(id => materialBlockId(id) === match.anchor)) {
          const source = await sourceText(env, snapshot, id);
          if (source) matches.set(id, { id, title: `${filing.form} ${filing.reportDate || filing.filingDate}, ${source.title}`, text: source.text });
        }
      }
    }
    return [...matches.values()];
  };
  const publicContext = publicResearchTools<FilingState>(spec.publicResearch, env.BUSINESS_SITE_ORIGIN);
  const periodic = periodicTools<FilingState>({ env, ticker, filing, snapshot, runId: spec.sessionId });
  const summarise = (state: FilingState, status: "published" | "failed") => recordRunSummary(db, {
    runId: spec.sessionId, ticker, accession, profile: profile.id, status, settledBy: state.composer.settledBy ?? null,
    reviewRounds: state.composer.rounds?.content ?? 0, renderRounds: state.composer.rounds?.render ?? 0, sectionsRead: state.read ?? [],
    charsRead: (state.read ?? []).reduce((sum, id) => sum + (state.periodic?.texts[id]?.length ?? 0), 0),
    blocks: state.composer.blocks.length, degraded: state.composer.blocks.filter(b => b.state === "conservative" || b.state === "safe-layout").map(b => b.id),
    detail: { ...(periodic ? periodic.detail(state) : {}), mode: spec.mode === "resume" ? "resume" : base ? "revise" : "rewrite", ...(state.composer.changes ? { changes: state.composer.changes } : {}), edits: state.composer.log.filter(l => l.phase === "edit").length },
  }).catch(error => console.error(JSON.stringify({ event: "filing-run-summary", ticker, accession, error: error instanceof Error ? error.message : String(error) })));
  const own: AnyTool<FilingState>[] = [
    ...(profile.id === "current" ? [handTool<FilingState>({ name: "set_category", description: `What kind of current report this is: ${CATEGORIES.join(", ")}.`, input_schema: { type: "object", properties: { category: { type: "string", enum: [...CATEGORIES] } }, required: ["category"] } },
      (args, state) => { state.category = CATEGORIES.includes(args.category as never) ? String(args.category) : "other"; return ok(`Category: ${state.category}.`); })] : []),
  ];
  const setup: ComposerSetup<FilingState> = {
    publicationMode: spec.shadow ? "shadow" : undefined,
    onShadow: async (state, published) => {
      await env.SEC_FILINGS.put(`research-shadow/${spec.sessionId}/validated.json`, JSON.stringify({ spec, ...published, validatedAt: new Date().toISOString(), researchUses: state.researchUses ?? [], work: { material: snapshot.ref, periodic: state.periodic, web: state.web, read: state.read ?? [] } }));
    },
    env, chart: null, ledger: { ticker, runId: spec.sessionId }, budgetTurns: profile.turns, settlement: "agent",
    research: ["read_filing_markdown", "find_filing_tables", "read_filing_table", "grep", "filing_history", "query_facts", "fact_history", "read_transcript"],
    previewQuery: `report=${encodeURIComponent(accession)}`,
    find: terms => find(terms),
    resolve: periodic.resolve, figure: periodic.figure, ...(profile.id === "periodic" ? { required: () => PERIODIC_BLOCKS } : {}), precheck: periodic.precheck,
    hardPrecheck: state => publicContext.precheck(state) ?? (state.periodic?.investmentChains?.length ? null : "Record a supported investment impact chain before publishing."),
    audit: state => filingSemanticAudit({ env, snapshot, runId: spec.sessionId, required: profile.id === "periodic" ? PERIODIC_BLOCKS : ["summary"] }, state),
    read: async (id, state) => {
      const publicSource = publicContext.read(id);
      if (publicSource) return publicSource;
      // A fact or paragraph named by a report opened for revision is read again the first time it is needed.
      const held = periodic?.read(id, state) ?? (periodic && await periodic.resolve(id, state).catch(() => false) ? periodic.read(id, state) : null);
      if (held) return held;
      if (state.web[id] !== undefined) return { title: state.composer.sources[id]?.title ?? id, text: state.web[id]! };
      return null;
    },
    onPublish: async (state, published) => {
      const now = new Date().toISOString();
      const headline = state.composer.blocks.find(b => b.id === "summary")?.title || state.composer.artifact.title;
      const summary = filingSummary(filing, { headline, text: published.text, ...(state.category ? { category: state.category } : {}) }, now);
      // A periodic report is also the company memory's source: the memory job is published with the report.
      const memory = profile.id === "periodic" ? await filingMemoryStatements(env, { filing, summary, sessionId: spec.sessionId, readSectionIds: state.read ?? [], material: snapshot }) : [];
      const dependencies = await companyResearchDependencyStatements(env, { ticker, resultId: `filing-report:${ticker}:${accession}:v${published.version}`, dependencies: (state.researchUses ?? []).filter(use => use.decision === "adopted"), mappingVersions: spec.publicResearch?.mappingVersions ?? [] });
      return [...repository.summaryStatements({ ticker, accessionNumber: accession, form: filing.form }, summary, memory) as unknown as D1PreparedStatement[], ...dependencies];
    },
    afterPublish: async (state) => {
      const now = new Date().toISOString();
      const spent = await db.prepare("SELECT SUM(input_tokens - COALESCE(cached_tokens, 0) + output_tokens) n FROM ai_usage WHERE run_id = ?").bind(spec.sessionId).first<{ n: number | null }>();
      await updateFiling(db, ticker, accession, { status: "published", reason: null, tokens: spent?.n ?? 0, publishedAt: now }, now);
      await repository.upsertAnalysisJob(job(spec, "complete", now));
      await saveWorkState(env, "filing-report", ticker, accession, { material: snapshot.ref, ...(state.periodic ? { periodic: state.periodic } : {}), web: state.web, read: state.read ?? [] } satisfies FilingWork)
        .catch(error => console.error(JSON.stringify({ event: "filing-work-state", ticker, accession, error: error instanceof Error ? error.message : String(error) })));
      await summarise(state, "published");
    },
  };
  const compose = composerTools(setup);
  const list = [...periodic.tools, ...publicContext.tools, ...own, ...web, ...compose];
  return {
    id: `filing.${spec.profile}.material.v1`,
    budget: { turns: profile.turns, wallMs: profile.wallMs },
    resultChars: 90_000,
    callsPerTurn: Infinity,
    concurrent: ["read_filing_markdown", "find_filing_tables", "read_filing_table", "grep", "filing_history", "query_facts", "fact_history", "read_transcript", "read_evidence", "list_leads", "read_block", "outline", "view_issue"],
    system: () => profile.id === "periodic" ? `${PERIODIC_SYSTEM(ticker)}\n\n${composerGuide("agent")}\n${PERIODIC_EVIDENCE}\n${PUBLIC_RESEARCH_GUIDE}` : `${FILING_SYSTEM(ticker)}\n${profile.prompt}\n\n${composerGuide("agent")}\n${PERIODIC_EVIDENCE}\n${PUBLIC_RESEARCH_GUIDE}`,
    open: () => {
      if (resumed) return resumed;
      const state: FilingState = { composer: openState(spec), candidates: [], hits: [], used: { searches: 0, webReads: 0 }, web: {} };
      if (!base) return state;
      // The published report is the document the session opens on: its blocks stand as they were reviewed, and only
      // what the session changes is reviewed again.
      const c = state.composer;
      c.blocks = base.document.blocks.map(b => ({ ...b }));
      c.charts = Object.fromEntries(base.document.charts.map(chart => [chart.id, chart]));
      c.sources = Object.fromEntries(base.document.sources.map(({ id, ...source }) => [id, source]));
      c.passed = Object.fromEntries(c.blocks.map(b => [b.id, sentencesOf(blockText(b.html)).map(s => s.key)]));
      if (base.work) { state.web = base.work.web ?? {}; state.read = base.work.read ?? []; if (base.work.periodic) state.periodic = base.work.periodic; }
      return state;
    },
    tools: () => list,
    policy: { allow: list.map(t => t.name), post: handPolicy([...periodic.tools, ...own]).post },
    onTurn: (s, turn) => { s.composer.turns = turn; },
    settled: s => s.composer.phase === "published",
    settle: s => s.composer.phase === "published",
    nudge: periodic ? "Continue: work the leads, record what you confirm, write the blocks, then call finish." : "Continue reading and writing blocks, then call finish.",
    budgetLine: (s, left) => `${defaultBudgetLine(left)}${periodic && s.composer.phase !== "published" ? periodic.standing(s) : ""}${s.composer.phase === "published" ? "" : !s.composer.blocks.length && s.composer.turns >= 45 ? " Write the blocks now with write_blocks: the review at finish and its fixes need the turns that are left." : s.composer.blocks.length && s.composer.turns >= 70 ? " Call finish now: its review may ask for fixes, and they need turns." : ""}`,
    afterRun: async (s) => {
      if (spec.shadow) {
        if (s.composer.phase !== "published") await env.SEC_FILINGS.put(`research-shadow/${spec.sessionId}/failed.json`, JSON.stringify({ status: "failed", reason: "Session ended without a validated shadow", at: new Date().toISOString() }));
        return;
      }
      if (s.composer.phase === "published") { await summarise(s, "published"); return; }
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
  const store = env as unknown as Parameters<typeof readPublishedDocument>[0];
  const document = spec.mode === "revise" && profile.id === "periodic" ? await readPublishedDocument(store, "filing-report", spec.ticker, spec.filing.accessionNumber).catch(() => null) : null;
  const snapshot = await readMaterialSnapshot(env, spec.material);
  const resumed = spec.mode === "resume" ? await readFilingCheckpoint(env, spec.checkpoint, snapshot.ref) : null;
  const work = document ? await readWorkState<FilingWork>(store, "filing-report", spec.ticker, spec.filing.accessionNumber) : null;
  const base = document && work?.material?.version === spec.material.version ? { document, work } : null;
  return {
    recipe: filingRecipe(env, spec, profile, snapshot, base, resumed), input: spec, effort: spec.shadow ? spec.shadowEffort ?? profile.reasoning : profile.reasoning, model: spec.shadow ? spec.shadowModel ?? modelFor(env, "filing") : modelFor(env, "filing"), ledger: { kind: "filing", ticker: spec.ticker, runId: spec.sessionId },
    ...(spec.shadow ? { strictBudget: true as const, reserve: async () => {
      const reserved = await env.DB!.prepare(`UPDATE sec_cache SET payload=json_set(payload,'$.callsReserved',COALESCE(json_extract(payload,'$.callsReserved'),0)+1)
        WHERE cache_key=? AND COALESCE(json_extract(payload,'$.callsReserved'),0)<COALESCE(json_extract(payload,'$.maxCalls'),140)
        RETURNING cache_key`).bind(`research-shadow:${spec.sessionId}`).first();
      return !!reserved;
    } } : {}),
    hydrate: (state: FilingState) => { state.composer ??= openState(spec); state.web ??= {}; },
    record: entry => { void recordRunTurn(env.DB!, spec.sessionId, entry); },
  };
}
