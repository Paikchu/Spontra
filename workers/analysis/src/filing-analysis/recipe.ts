import { modelFor } from "../ai-config.ts";
import { renderTable } from "../analyst/agent.ts";
import { COMPOSE_CONTRACT, composeTools, openCompose, type ComposeInput, type ComposeState } from "../compose/tools.ts";
import { librarySectionPassages } from "../filing-library/store.ts";
import { itemFacts } from "../items/workflow.ts";
import { ITEM_POLICY, itemRecipe, itemPeriodEnd, type ItemInput, type ItemSubject } from "../items/recipe.ts";
import { callWorkerSecModel, type AnalysisEnv } from "../operations.ts";
import { handPolicy, handTool, type HandResult } from "../pi/hand-tools.ts";
import type { PiLoaded } from "../pi/host.ts";
import type { Recipe } from "../recipe.ts";
import type { SecModelCall } from "../sec/pipeline.ts";
import { readReportInputs, REPORT_RULES, reportSettled, reportWritingTools, restoredReportState, type ReportState, type Restored } from "../sec/report-agent.ts";
import { hasOnlyEventMetadataBullets, normalizeSecSummary, SEC_SUMMARY_VERSION, type SecFiling, type SecFilingSummary } from "../sec/sec.ts";
import type { StageData } from "../stage/data.ts";
import type { AnyTool } from "../tools/registry.ts";
import type { PreparedFilingReference } from "../workflow-core.ts";
import { FILING_SYSTEM, profileById, type FilingProfile, type ProfileId } from "./profiles.ts";
import { previousSectionOf, readSectionNotes } from "./store.ts";
import { missingQuotes, readNotes, type SectionNote, type WorkEntry } from "./worklist.ts";
import type { ComposedAnalysis } from "../../../../shared/analysis-contract/findings.ts";
import type { LibraryPassageView } from "../../../../shared/analysis-contract/filing-library.ts";

/** One session of the path, in either stage or kind of analysis; what it is rebuilt from after an eviction. */
export type SectionSpec = { stage: "section"; ticker: string; profile: ProfileId; entries: WorkEntry[]; runId: string };
export type ItemSpec = { stage: "item"; ticker: string; profile: ProfileId; subject: ItemSubject; now: string; prepared: Pick<ItemInput, "documents" | "earlierAvailable" | "seed">; filing: SecFiling | null; runId: string };
export type ComposeSpec = { stage: "compose"; ticker: string; profile: ProfileId; reference: PreparedFilingReference; restored: Restored; now: string; periodEnd: string; earlierAvailable: boolean; workflowInstanceId: string; runId: string };
export type FilingSessionSpec = SectionSpec | ItemSpec | ComposeSpec;

const ok = (observation: unknown): HandResult => ({ observation: typeof observation === "string" ? observation : JSON.stringify(observation) });
const fail = (observation: string): HandResult => ({ observation, error: true });
const parsed = (value: unknown): unknown => {
  if (typeof value !== "string" || !/^\s*[[{]/.test(value)) return value;
  try { return JSON.parse(value); } catch { return value; }
};
const passageText = (p: LibraryPassageView) => p.table ? renderTable(p.table, []) : p.text;

// --- The section pass ----------------------------------------------------------------------------------------------

export type SectionState = { notes: SectionNote[] | null; failures: number };
const SAVE_FAILURES = 3;

export function sectionRecipe(env: AnalysisEnv, spec: SectionSpec, profile: FilingProfile): Recipe<SectionSpec, SectionNote[] | null, SectionState> {
  const db = env.DB!;
  const entries = new Map(spec.entries.map(e => [e.sectionId, e]));
  const readable = async (sectionId: string, previous: boolean) => {
    const entry = entries.get(sectionId);
    if (!entry) return null;
    const target = previous ? await previousSectionOf(db, sectionId) : { sectionId, documentId: entry.documentId };
    return target ? librarySectionPassages(db, target.documentId, [target.sectionId]) : [];
  };
  const list: AnyTool<SectionState>[] = [
    handTool<SectionState>({ name: "read_section", description: "Read one section of this batch whole, tables included.", input_schema: { type: "object", properties: { sectionId: { type: "string" } }, required: ["sectionId"] } }, async (args) => {
      const passages = await readable(String(args.sectionId ?? ""), false);
      return passages ? ok(passages.map(passageText).join("\n\n") || "This section has no text.") : fail("Not a section of this batch.");
    }),
    handTool<SectionState>({ name: "read_previous", description: "Read the same section in the earlier filing.", input_schema: { type: "object", properties: { sectionId: { type: "string" } }, required: ["sectionId"] } }, async (args) => {
      const passages = await readable(String(args.sectionId ?? ""), true);
      if (!passages) return fail("Not a section of this batch.");
      return ok(passages.map(passageText).join("\n\n") || "The earlier filing has no such section.");
    }),
    handTool<SectionState>({ name: "save_note", description: "Save this batch's result and end the session: notes [{sectionId, summary, changes [{label, detail, importance}], watch [string], quotes [exact words]}], one per section.", input_schema: { type: "object", properties: { notes: { type: "array", items: { type: "object" } } }, required: ["notes"] } }, async (args, state) => {
      const read = readNotes(parsed(args.notes), spec.entries.map(e => e.sectionId));
      if ("error" in read) { state.failures += 1; return fail(read.error); }
      const texts = new Map<string, string[]>();
      await Promise.all(spec.entries.map(async e => {
        const [now, before] = await Promise.all([readable(e.sectionId, false), readable(e.sectionId, true)]);
        texts.set(e.sectionId, [...(now ?? []), ...(before ?? [])].map(passageText));
      }));
      const wrong = read.notes.flatMap(n => missingQuotes(n.quotes, texts.get(n.sectionId) ?? []).map(q => `${n.sectionId}: "${q.slice(0, 120)}"`));
      if (wrong.length) { state.failures += 1; return fail(`These quotes are not word for word in their section or the earlier one. Correct or remove them, and send all notes again:\n${wrong.join("\n")}`); }
      state.notes = read.notes;
      return ok("Saved.");
    }),
  ];
  return {
    id: "filing.section.v1",
    budget: profile.sectionPass!.session,
    system: () => `${FILING_SYSTEM(spec.ticker)}\nThe code walks every section of the filing; this session handles one batch. For each section write what it says that matters to a holder and what changed against the earlier filing. The first message gives each section's changed passages and the earlier conclusion when there is one: update that conclusion rather than starting again. read_section and read_previous give more when you need it. A section with nothing of substance still gets a one-line summary. Quote only exact words. Finish with save_note.`,
    open: () => ({ notes: null, failures: 0 }),
    tools: () => list,
    policy: handPolicy(list),
    settled: s => s.notes != null || s.failures >= SAVE_FAILURES,
    settle: s => s.notes,
    nudge: "Call save_note with one note per section.",
  };
}

/** The opening of a section session: each section's changed passages and the earlier conclusion. */
export async function sectionOpening(env: AnalysisEnv, spec: SectionSpec): Promise<string> {
  const db = env.DB!;
  const earlier = await readSectionNotes(db, spec.entries.flatMap(e => e.previousSectionId ? [e.previousSectionId] : []));
  const sections = await Promise.all(spec.entries.map(async e => {
    const passages = await librarySectionPassages(db, e.documentId, [e.sectionId]);
    const whole = e.change !== "changed";
    const shown = whole ? passages : passages.filter(p => p.change !== "unchanged");
    return { sectionId: e.sectionId, path: e.path.join(" › "), change: e.change, earlierConclusion: e.previousSectionId ? earlier.get(e.previousSectionId) ?? null : null, unchangedPassages: passages.length - shown.length, text: (shown.length ? shown : passages).map(passageText).join("\n\n") };
  }));
  return JSON.stringify({ ticker: spec.ticker, sections });
}

// --- A filing analysed whole ---------------------------------------------------------------------------------------

export type ItemOutcome = { composed: ComposedAnalysis | null; digest: SecFilingSummary | null; withheld: boolean; errors: string[] };
export type ItemState = ComposeState & { digest: SecFilingSummary | null };
const CATEGORIES = ["earnings_update", "guidance", "m&a", "executive", "legal", "other"];

export function filingItemInput(env: AnalysisEnv, spec: ItemSpec, profile: FilingProfile, data: StageData): ItemInput {
  return { env, data, subject: spec.subject, periodEnd: itemPeriodEnd(spec.subject, data), now: spec.now, ...spec.prepared, prompt: profile.compose.prompt,
    limits: { turns: profile.compose.turns, wallMs: profile.compose.wallMs, webReads: profile.compose.webReads, searches: profile.compose.searches },
    checks: { minEvidence: profile.checks.minEvidence, quoteFiling: profile.checks.quoteFiling } };
}

export function filingItemRecipe(input: ItemInput, spec: ItemSpec, profile: FilingProfile): Recipe<ItemInput, ItemOutcome, ItemState> {
  const base = itemRecipe(input);
  const digest = profile.output.digest && spec.filing ? spec.filing : null;
  const write = handTool<ItemState>({ name: "write_digest", description: "Write this filing's entry for the filings list: headline, bullets [{label, detail, importance}], analystView, eventCategory (earnings_update|guidance|m&a|executive|legal|other), report (a short paragraph).",
    input_schema: { type: "object", properties: { headline: { type: "string" }, bullets: { type: "array", items: { type: "object" } }, analystView: { type: "string" }, eventCategory: { type: "string", enum: CATEGORIES }, report: { type: "string" } }, required: ["headline", "bullets", "analystView", "eventCategory"] } }, (args, state) => {
    const summary = normalizeSecSummary({ ...args, bullets: parsed(args.bullets), source: "claude", version: SEC_SUMMARY_VERSION }, digest!, new Date(input.now));
    if (!summary.headline || !summary.bullets.length || !summary.analystView || !summary.eventCategory) return fail("headline, at least one bullet, analystView and eventCategory are all required.");
    if (hasOnlyEventMetadataBullets(summary.bullets)) return fail("The bullets only restate filing metadata; say what the filing discloses.");
    state.digest = digest!.earningsGroup ? { ...summary, earningsGroup: digest!.earningsGroup } : summary;
    return ok("Saved.");
  });
  return {
    ...base, id: `filing-${spec.profile}-${spec.subject.id}`,
    open: () => ({ ...base.open(input), digest: null }),
    tools: state => digest ? [...base.tools(state) as AnyTool<ItemState>[], write] : base.tools(state) as AnyTool<ItemState>[],
    policy: { ...ITEM_POLICY, allow: [...ITEM_POLICY.allow, ...(digest ? ["write_digest"] : [])], post: handPolicy([write]).post },
    settled: s => s.withheld || (s.composed != null && (!digest || s.digest != null)),
    settle: s => ({ composed: s.composed, digest: s.digest, withheld: s.withheld, errors: s.withheld ? s.draft?.errors ?? [] : [] }),
    nudge: digest ? "Continue: read what the filing needs, compose the analysis, call write_digest, then finish." : base.nudge,
  };
}

// --- The report and analysis of a periodic filing --------------------------------------------------------------------

export type ComposeOutcome = { written: Pick<ReportState, "plan" | "nodes" | "review" | "coverageRounds" | "passed" | "issues">; composed: ComposedAnalysis | null; withheld: boolean };
export type PeriodicState = ComposeState & { written: ReportState };

export function periodicComposeRecipe(env: AnalysisEnv, spec: ComposeSpec, profile: FilingProfile, data: StageData, ctx: Parameters<typeof reportWritingTools>[0]): Recipe<ComposeSpec, ComposeOutcome, PeriodicState> {
  const input: ComposeInput = { env, data, locale: "en", now: spec.now, periodEnd: spec.periodEnd, budget: { finds: 4, reads: 6, searches: profile.compose.searches, webReads: profile.compose.webReads }, earlierAvailable: profile.checks.quotePrevious && spec.earlierAvailable, quoteFiling: profile.checks.quoteFiling, minEvidence: profile.checks.minEvidence };
  const writing = reportWritingTools(ctx).map((t): AnyTool<PeriodicState> => ({ ...t, execute: (args: never, c: { state: PeriodicState }) => t.execute(args, { ...c, state: c.state.written } as never) } as unknown as AnyTool<PeriodicState>));
  const analysis = composeTools(input) as unknown as AnyTool<PeriodicState>[];
  const list = [...writing, ...analysis];
  const hand = handPolicy(writing);
  return {
    id: "filing.periodic.v1",
    budget: { turns: profile.compose.turns, wallMs: profile.compose.wallMs },
    ...(profile.compose.resultChars ? { resultChars: profile.compose.resultChars } : {}),
    system: () => [FILING_SYSTEM(spec.ticker), profile.compose.prompt, "Report rules (submit_report.draft is the report JSON). The draft is kept: every later correction is revise_report with only what changes.", REPORT_RULES(), "Analysis rules:", COMPOSE_CONTRACT].join("\n"),
    open: () => ({ ...openCompose(input), written: restoredReportState(spec.restored) }),
    tools: () => list,
    policy: { allow: [...hand.allow, ...ITEM_POLICY.allow], post: hand.post },
    settled: s => !s.written.passed ? reportSettled(s.written) : s.composed != null || s.withheld,
    settle: s => ({ written: { plan: s.written.plan, nodes: s.written.nodes, review: s.written.review, coverageRounds: s.written.coverageRounds, passed: s.written.passed, issues: s.written.issues }, composed: s.composed, withheld: s.withheld }),
    nudge: "Call a tool: finish the report (submit_report, revise_report), then compose the analysis and finish.",
  };
}

const JUDGE_BUDGET_MS = 12 * 60_000;

/** Rebuilds a session of the path from its spec, on start and after an eviction. */
export async function filingLoader(spec: FilingSessionSpec, env: AnalysisEnv): Promise<PiLoaded> {
  const profile = profileById(spec.profile);
  const common = { model: modelFor(env, "filing"), ledger: { kind: "filing", ticker: spec.ticker, runId: spec.runId } };
  if (spec.stage === "section") return { recipe: sectionRecipe(env, spec, profile), input: spec, effort: "medium", ...common };
  const data = await itemFacts(env, spec.ticker);
  if (!data) throw new Error(`filing-analysis: no stage data for ${spec.ticker}`);
  if (spec.stage === "item") {
    const input = filingItemInput(env, spec, profile, data);
    return { recipe: filingItemRecipe(input, spec, profile), input, effort: profile.compose.reasoning, ...common };
  }
  const { prepared, brief, context } = await readReportInputs(env, spec.reference);
  const judge: SecModelCall = (stage, system, payload) => callWorkerSecModel(env, fetch, stage, system, payload, modelFor(env, "filing"), JUDGE_BUDGET_MS, { reasoning: "medium", ticker: spec.ticker, runId: spec.runId, kind: "filing" });
  const report = { env, spec: { reference: spec.reference, workflowInstanceId: spec.workflowInstanceId, restored: spec.restored, runId: spec.runId }, prepared, brief, context, judge };
  return { recipe: periodicComposeRecipe(env, spec, profile, data, report), input: spec, effort: profile.compose.reasoning, ...common };
}
