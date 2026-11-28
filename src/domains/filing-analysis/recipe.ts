import {handoffStatement, reviewReleaseQuestions, followupSchema, type EarningsQuestion, type EarningsHandoff} from "./earnings-handoff.ts";
import { quarterBundleStatements, type QuarterBundleSpec } from "./quarter-bundle.ts";
import {openPeriodic} from "./periodic.ts";
import { isPilotMaterial } from "../filing-material/store.ts";
import type { AiModel, AiEffort } from "../../api/admin/types/ai-models-admin.ts";
import { companyResearchDependencyStatements } from "../public-research/context.ts";
import type { FrozenCompanyResearch } from "../public-research/contract.ts";
import { publicResearchTools, PUBLIC_RESEARCH_GUIDE, type ResearchContextState } from "../public-research/company/context-tools.ts";
import { z } from "zod";
import { modelFor } from "../../ai/config.ts";
import { webTools, type WebToolState } from "../../ai/compose/tools.ts";
import type { AnalysisEnv } from "../../operations.ts";
import { handPolicy, handTool, type HandResult } from "../../ai/pi/hand-tools.ts";
import type { PiLoaded } from "../../ai/pi/host.ts";
import { unpackState } from "../../ai/pi/state.ts";
import { defaultBudgetLine, type Recipe } from "../../lib/recipe.ts";
import { D1SecRepository } from "./sec/d1.ts";
import { SEC_SUMMARY_VERSION, type SecFiling, type SecFilingSummary } from "./sec/sec.ts";
import type { AnyTool } from "../../ai/tools/registry.ts";
import type { MaterialRef, MaterialSnapshot } from "../filing-material/contract.ts";
import { readMaterialSnapshot } from "../filing-material";
import { materialBlockId, readFilingMarkdown, searchFilingMarkdown, sourceText, withPreparedMaterialReadCache } from "../filing-material/read.ts";
import { FILING_SYSTEM, profileById, type FilingProfile, type ProfileId } from "./profiles.ts";
import { recordRunSummary, recordRunTurn, updateFiling } from "./store.ts";
import { filingMemoryStatements } from "./memory-source.ts";
import { composerGuide, composerTools, composerHarness, type ComposerSetup } from "../publishing/artifact/compose.ts";
import { PERIODIC_BLOCKS, periodicTools, type PeriodicState } from "./periodic.ts";
import { PERIODIC_EVIDENCE, PERIODIC_SYSTEM, EXPECTATIONS_GUIDE } from "./prompts.ts";
import { blockText, openComposer, registerSource, sentencesOf, type ComposerState } from "../publishing/artifact/document.ts";
import { readPublishedDocument, readWorkState, saveWorkState } from "../publishing/artifact/store.ts";
import type { ArtifactDocument } from "../publishing/artifact-contract.ts";
import type { FilingExpectations } from "./expectations.ts";
import { filingSemanticAudit } from "./semantic-audit.ts";
import { shadowResumeEnvironment } from "./shadow-budget.ts";
import { SHADOW_RESUME_CALLS } from "./shadow-resume.ts";
import { sha256 } from "../../lib/sha256.ts";
import { saveFilingImpact } from "./impact-publication.ts";
import type { ShadowContextExtension } from "./shadow-context.ts";

/** What the session is rebuilt from after an eviction. */
export type FilingMode = { mode?: "revise" | "rewrite" } | { mode: "resume"; checkpoint: string; checkpointHash?: string };
export type FilingReviewerCorrectionReview={sourcePhase?:"semantic";semanticReceiptHash:string}|{sourcePhase:`content:${typeof PERIODIC_BLOCKS[number]}`;contentReceiptHash:string};
export type FilingReviewerCorrection={sourceOperatorRunId:string;failedStateHash:string;correctionsHash:string;reviewCallsInherited:number}&FilingReviewerCorrectionReview;
export type FilingOperatorAuthor = {sourceRunId:string;checkpointHash:string;planHash:string;author:{model:"gpt-6.1-sol";effort:"max";runId:string;promptVersion:string};authorUsage:{status:"unavailable";tokens:null;cost:null};reviewerCorrection?:FilingReviewerCorrection};
export type FilingSpec = { copyFlow?:{releasePeriod:string|null;handoff:EarningsHandoff|null;deadline?:number}; quarterBundle?: QuarterBundleSpec; expectations?: FilingExpectations; operatorCompletion?:FilingOperatorAuthor; shadow?: boolean; shadowModel?: AiModel; shadowEffort?: AiEffort; shadowContextExtension?: ShadowContextExtension; publicResearch?: FrozenCompanyResearch; ticker: string; profile: ProfileId; filing: SecFiling; sessionId: string; jobId: string; jobVersion: string; requestedBy: "scheduled" | "manual"; material: MaterialRef } & FilingMode;
/** What a session keeps beside the published document, for the session that revises it and for a recheck. */
export type FilingWork = { material: MaterialRef; periodic?: PeriodicState; web: Record<string, string>; read: string[] };
export type FilingState = WebToolState & ResearchContextState & { copy?:{questions:EarningsQuestion[]}; composer: ComposerState; candidates: unknown[]; read?: string[]; web: Record<string, string>; category?: string; periodic?: PeriodicState };

export async function readFilingCheckpoint(env: Pick<AnalysisEnv, "SEC_FILINGS">, key: string, material: MaterialRef, expectedHash?: string): Promise<FilingState> {
  const object = await env.SEC_FILINGS.get(key);
  if (!object) throw new Error(`FILING_CHECKPOINT_MISSING:${key}`);
  const body = await object.text();
  if (expectedHash && await sha256(body) !== expectedHash) throw new Error("FILING_CHECKPOINT_HASH_MISMATCH");
  const checkpoint = z.object({ material: z.object({ ticker: z.string(), accession: z.string(), version: z.string() }), state: z.string() }).parse(JSON.parse(body));
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
export function filingSummary(filing: SecFiling, report: { headline: string; text: string; category?: string;operatorCompletion?:FilingOperatorAuthor }, at: string): SecFilingSummary {
  return { ticker: filing.ticker, form: filing.form, filingDate: filing.filingDate, accessionNumber: filing.accessionNumber, headline: report.headline, bullets: [], analystView: "", report: report.text,
    ...(report.category ? { eventCategory: report.category as SecFilingSummary["eventCategory"] } : {}), version: SEC_SUMMARY_VERSION, source: report.operatorCompletion?"external":"deepseek", generatedBy: report.operatorCompletion?"operator":"pi", ...(report.operatorCompletion?{generation:report.operatorCompletion}:{}), generatedAt: at };
}

const openState = (spec: FilingSpec): ComposerState => openComposer({ kind: "filing-report", ticker: spec.ticker, subject: spec.filing.accessionNumber, title: `${spec.ticker} ${spec.filing.form} ${spec.filing.reportDate || spec.filing.filingDate}`, lang: "en" });

function filingRecipe(env: AnalysisEnv, spec: FilingSpec, profile: FilingProfile, snapshot: MaterialSnapshot, base: { document: ArtifactDocument; work: FilingWork | null } | null, resumed: FilingState | null, priorSnapshots: MaterialSnapshot[],operator?:{onShadow:NonNullable<ComposerSetup<FilingState>["onShadow"]>}): Recipe<FilingSpec, boolean, FilingState> & {operatorStages?:ReturnType<typeof composerHarness<FilingState>>["stages"];operatorContentInput?:ReturnType<typeof composerHarness<FilingState>>["contentInput"]} {
  const db = env.DB!;
  const repository = new D1SecRepository(db);
  const { ticker, filing } = spec;
  const accession = filing.accessionNumber;
  const flow = !operator && spec.mode !== "resume" ? spec.copyFlow : undefined;
  const checklistStatement=(state:FilingState,edition:{version:number;hash:string},at:string)=>{
    const questions=state.copy?.questions;
    return flow?.releasePeriod && questions?.length ? handoffStatement(db,filing,flow.releasePeriod,snapshot.ref,edition,questions,at):null;
  };
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
  const companionAccessions = new Set(spec.quarterBundle?.companionMaterials.map(m => m.accession) ?? []);
  const periodic = periodicTools<FilingState>({ env, ticker, filing, snapshot, priorSnapshots, companionAccessions, expectations: spec.expectations, runId: spec.sessionId });
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
  if(flow?.releasePeriod) own.push(handTool<FilingState>({name:"record_earnings_questions",description:"Save source-grounded questions from this earnings release for the same-period statutory report. Supply question, disclosure to check, and original source id.",input_schema:{type:"object",properties:{questions:{type:"array",items:{type:"object",properties:{question:{type:"string"},disclosure:{type:"string"},source:{type:"string"}},required:["question","disclosure","source"]}}},required:["questions"]}},async(args,state)=>{
    const questions=z.array(followupSchema).min(1).parse(args.questions);
    const ready=await reviewReleaseQuestions(env,filing,snapshot,questions,spec.sessionId,!!spec.shadow);
    state.copy={questions:ready?.questions??[]};
    return ok(`Recorded ${state.copy.questions.length} reviewed follow-up questions.`);
  }));
  const setup: ComposerSetup<FilingState> = {
    publicationMode: spec.shadow ? "shadow" : undefined,
    ...(operator?{operatorValidation:true}:{}),
    onShadow: async (state, published) => {
      if(operator)return operator.onShadow(state,published);
      const checklist=checklistStatement(state,published,new Date().toISOString());
      if(checklist)await checklist.run();
      await saveFilingImpact(env, { spec, version: published.version, hash: published.hash, work: { material: snapshot.ref, periodic: state.periodic, web: state.web, read: state.read ?? [] } });
      await env.SEC_FILINGS.put(`research-shadow/${spec.sessionId}/validated.json`, JSON.stringify({ spec, ...published, validatedAt: new Date().toISOString(), researchUses: state.researchUses ?? [], work: { material: snapshot.ref, periodic: state.periodic, web: state.web, read: state.read ?? [] } }));
    },
    env, chart: null, ledger: { ticker, runId: spec.sessionId }, budgetTurns: profile.turns, settlement: "agent",
    research: ["read_filing_brief", "read_filing_markdown", "find_filing_tables", "read_filing_table", "grep", "filing_history", "query_facts", "fact_history", "read_transcript"],
    previewQuery: `report=${encodeURIComponent(accession)}`,
    find: terms => find(terms),
    resolve: periodic.resolve, figure: periodic.figure, ...(profile.id === "periodic" ? { required: () => PERIODIC_BLOCKS, completeInitialSubmission: !operator } : {}), precheck: state => (flow?.releasePeriod && !state.copy ? "Record the outstanding statutory-filing questions first." : periodic.precheck(state)),
    hardPrecheck: state => publicContext.precheck(state) ?? periodic.impactPrecheck(state) ?? (state.periodic?.investmentChains?.length ? null : "Record a supported investment impact chain before publishing."),
    audit: state => filingSemanticAudit({ env, snapshot, runId: spec.sessionId, required: profile.id === "periodic" ? PERIODIC_BLOCKS : ["summary"], publicResearch: spec.publicResearch, expectations: spec.expectations }, state),
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
      if (!spec.shadow && await isPilotMaterial(env, ticker, accession)) throw new Error("Material reserved for explicit shadow review; normal publication blocked");
      if (!spec.shadow) await saveFilingImpact(env, { spec, version: published.version, hash: published.hash, work: { material: snapshot.ref, periodic: state.periodic, web: state.web, read: state.read ?? [] } });
      const now = new Date().toISOString();
      const headline = state.composer.blocks.find(b => b.id === "summary")?.title || state.composer.artifact.title;
      const summary = filingSummary(filing, { headline, text: published.text, ...(state.category ? { category: state.category } : {}) }, now);
      // A periodic report is also the company memory's source: the memory job is published with the report.
      const memory = profile.id === "periodic" ? await filingMemoryStatements(env, { filing, summary, sessionId: spec.sessionId, readSectionIds: state.read ?? [], material: snapshot }) : [];
      const dependencies = await companyResearchDependencyStatements(env, { ticker, resultId: `filing-report:${ticker}:${accession}:v${published.version}`, dependencies: (state.researchUses ?? []).filter(use => use.decision === "adopted"), mappingVersions: spec.publicResearch?.mappingVersions ?? [] });
      const checklist=checklistStatement(state,published,now);
      const bundleStmts = spec.quarterBundle ? quarterBundleStatements(db, ticker, spec.quarterBundle.meta, now) : [];
      return [...(checklist?[checklist]:[]), ...bundleStmts, ...repository.summaryStatements({ ticker, accessionNumber: accession, form: filing.form }, summary, memory) as unknown as D1PreparedStatement[], ...dependencies];
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
  const harness=operator?composerHarness(setup):null;
  const compose = (harness?.tools??composerTools(setup)).map(tool=>tool.name==="finish" ? {...tool, execute:async(args,ctx)=>{await periodic.restore(ctx.state);return tool.execute(args,ctx);}} satisfies typeof tool : tool);
  const list = [...periodic.tools, ...publicContext.tools, ...own, ...(flow?[]:web), ...compose];
  return {
    ...(harness?{operatorStages:harness.stages,operatorContentInput:harness.contentInput}:{}),
    id: `filing.${spec.profile}.material.v1`,
    budget: { turns: profile.turns, wallMs: profile.wallMs },
    resultChars: 90_000,
    callsPerTurn: Infinity,
    concurrent: ["read_filing_brief", "financial_movers", "diff_prior_filing", "read_filing_markdown", "find_filing_tables", "read_filing_table", "grep", "filing_history", "query_facts", "fact_history", "read_transcript", "read_evidence", "list_leads", "read_block", "outline", "view_issue"],
    system: () => (flow ? ["You own the entire report: investigate the filing, write the HTML, build its figures, and repair the rendered layout yourself. For material trends with comparable sourced periods, call chart_facts and insert its figure beside the analytical paragraph. Use the comparison table for precise amounts and the chart for the trend.", flow.releasePeriod?"Use record_earnings_questions before finish.":"",flow.handoff?"Close each inherited question and write its evidence-backed finding or remaining gap in versus-prior.":""].join("\n")+"\n" : "") + (spec.expectations ? EXPECTATIONS_GUIDE + "\n" : "") + (profile.id === "periodic" ? `${PERIODIC_SYSTEM(ticker)}\n\n${composerGuide("agent")}\n${PERIODIC_EVIDENCE}\n${PUBLIC_RESEARCH_GUIDE}` : `${FILING_SYSTEM(ticker)}\n${profile.prompt}\n\n${composerGuide("agent")}\n${PERIODIC_EVIDENCE}\n${PUBLIC_RESEARCH_GUIDE}`),
    open: () => {
      if (resumed) {
        if (spec.shadow && spec.shadowContextExtension&&!spec.operatorCompletion) {
          resumed.publicResearchRead = false;
          delete resumed.composer.researchContext;
        }
        return resumed;
      }
      const state: FilingState = { composer: openState(spec), candidates: [], hits: [], used: { searches: 0, webReads: 0 }, web: {} };
      if (flow?.handoff || spec.quarterBundle?.companionMaterials.length) {
        const periodicState = state.periodic = openPeriodic();
        const pinnedMats = [
          ...(flow?.handoff ? [flow.handoff.material] : []),
          ...(spec.quarterBundle?.companionMaterials ?? []),
        ];
        periodicState.materials = [...new Map(pinnedMats.map(m => [`${m.accession}:${m.version}`, m])).values()];
        if (flow?.handoff) {
          periodicState.leads = flow.handoff.questions.map((q, i) => ({ id: "release-" + (i + 1), source: "earnings-release", question: q.question, why: q.disclosure, priority: "high", refs: [q.source] }));
        }
      }
      if (!base) return state;
      // The published report is the document the session opens on: its blocks stand as they were reviewed, and only
      // what the session changes is reviewed again.
      const c = state.composer;
      c.blocks = base.document.blocks.map(b => ({ ...b }));
      c.charts = Object.fromEntries(base.document.charts.map(chart => [chart.id, chart]));
      c.sources = Object.fromEntries(base.document.sources.map(({ id, ...source }) => [id, source]));
      c.passed = Object.fromEntries(c.blocks.map(b => [b.id, sentencesOf(blockText(b.html)).map(s => s.key)]));
      if (base.work) { state.web = base.work.web ?? {}; state.read = base.work.read ?? []; if (base.work.periodic) {
          const inherited=state.periodic?.leads??[];
          state.periodic={...base.work.periodic,materials:[...new Map([...base.work.periodic.materials,...(state.periodic?.materials??[])].map(m=>[m.accession+":"+m.version,m])).values()],leads:[...base.work.periodic.leads.filter(lead=>lead.source!=="earnings-release"),...inherited]};
        } }
      return state;
    },
    tools: () => list,
    policy: { allow: list.map(t => t.name), post: handPolicy([...periodic.tools, ...own]).post },
    onTurn: (s, turn) => { s.composer.turns = turn; },
    settled: s => s.composer.phase === "published",
    settle: s => s.composer.phase === "published",
    nudge: spec.mode === "resume" ? "Complete only the saved report's targeted repairs, then call finish early. Reuse saved evidence and read an original passage only to resolve a specific gap; independent reviews share the same provider allowance." : profile.id === "periodic" ? "Continue the same research: finish the sources, facts, computations and context, then submit the complete report in one write_blocks call and call finish. If the report exists, make only the needed focused corrections." : "Continue reading and writing blocks, then call finish.",
    budgetLine: (s, left) => `${defaultBudgetLine(left)}${spec.mode === "resume" && s.composer.phase !== "published" ? " Independent reviews, retries and compaction also consume the shared provider-request limit; turns left are not provider requests left." : ""}${periodic && s.composer.phase !== "published" ? periodic.standing(s) : ""}${s.composer.phase === "published" ? "" : !s.composer.blocks.length && s.composer.turns >= 45 ? profile.id === "periodic" ? " Submit the complete report in one write_blocks call now, then call finish; leave turns for focused corrections." : " Write the blocks now with write_blocks: the review at finish and its fixes need the turns that are left." : s.composer.blocks.length && s.composer.turns >= (spec.mode === "resume" ? Math.floor(profile.turns / 2) : 70) ? " Complete the remaining targeted edits and call finish now: its independent reviews and any fixes need the allowance that remains." : ""}`,
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
  if(spec.operatorCompletion)throw new Error("External operator plans execute through the deterministic task, never a Pi author session");
  env = await shadowResumeEnvironment(env, spec);
  if (!spec.shadow && await isPilotMaterial(env, spec.ticker, spec.filing.accessionNumber)) throw new Error("Material reserved for explicit shadow review; normal analysis blocked");
  const baseProfile = profileById(spec.profile);
  const profile = spec.shadow && spec.mode === "resume" ? { ...baseProfile, turns: SHADOW_RESUME_CALLS } : baseProfile;
  const store = env as unknown as Parameters<typeof readPublishedDocument>[0];
  const document = spec.mode === "revise" && profile.id === "periodic" ? await readPublishedDocument(store, "filing-report", spec.ticker, spec.filing.accessionNumber).catch(() => null) : null;
  const snapshot = await readMaterialSnapshot(env, spec.material);
  const resumed = spec.mode === "resume" ? await readFilingCheckpoint(env, spec.checkpoint, snapshot.ref, spec.checkpointHash) : null;
  const work = document ? await readWorkState<FilingWork>(store, "filing-report", spec.ticker, spec.filing.accessionNumber) : null;
  const base = document && work?.material?.version === spec.material.version ? { document, work } : null;
  const priorRefs = [...new Map([...(spec.copyFlow?.handoff ? [spec.copyFlow.handoff.material] : []), ...(spec.quarterBundle?.companionMaterials ?? []), ...(resumed?.periodic?.materials ?? []), ...(base?.work?.periodic?.materials ?? [])].map(ref => [`${ref.accession}:${ref.version}`, ref])).values()];
  const priorSnapshots = await Promise.all(priorRefs.filter(ref => ref.accession !== snapshot.ref.accession || ref.version !== snapshot.ref.version).map(ref => readMaterialSnapshot(env, ref)));
  return {
    recipe: filingRecipe(env, spec, profile, snapshot, base, resumed, priorSnapshots), input: spec, effort: spec.shadow ? spec.shadowEffort ?? profile.reasoning : profile.reasoning, model: spec.shadow ? spec.shadowModel ?? modelFor(env, "filing") : modelFor(env, "filing"), ledger: { kind: "filing", ticker: spec.ticker, runId: spec.sessionId },
    ...(spec.shadow ? { strictBudget: true as const, reserve: async () => {
      if (env.MODEL_REQUEST_GATE) {
        try { await env.MODEL_REQUEST_GATE(); return true; } catch { return false; }
      }
      const reserved = await env.DB!.prepare(`UPDATE sec_cache SET payload=json_set(payload,'$.callsReserved',COALESCE(json_extract(payload,'$.callsReserved'),0)+1)
        WHERE cache_key=? AND COALESCE(json_extract(payload,'$.callsReserved'),0)<COALESCE(json_extract(payload,'$.maxCalls'),140)
        RETURNING cache_key`).bind(`research-shadow:${spec.sessionId}`).first();
      return !!reserved;
    } } : {}),
    hydrate: (state: FilingState) => { state.composer ??= openState(spec); state.web ??= {}; },
    record: entry => { void recordRunTurn(env.DB!, spec.sessionId, entry); },
  };
}

/** Same filing tools and composer, without opening an author model or its exhausted continuation gate. */
export async function filingOperatorHarness(env:AnalysisEnv,spec:FilingSpec,state:FilingState,onShadow:NonNullable<ComposerSetup<FilingState>["onShadow"]>){
  if(!spec.shadow||!spec.operatorCompletion)throw new Error("An admitted external shadow plan is required");
  const snapshot=await readMaterialSnapshot(env,spec.material),refs=[...new Map((state.periodic?.materials??[]).map(ref=>[`${ref.accession}:${ref.version}`,ref])).values()];
  const prior=await Promise.all(refs.filter(ref=>ref.accession!==snapshot.ref.accession||ref.version!==snapshot.ref.version).map(ref=>readMaterialSnapshot(env,ref)));
  const recipe=filingRecipe(withPreparedMaterialReadCache(env,[snapshot,...prior]),spec,profileById(spec.profile),snapshot,null,state,prior,{onShadow});
  return {recipe,stages:recipe.operatorStages!,contentInput:recipe.operatorContentInput!,state:recipe.open(spec)};
}
