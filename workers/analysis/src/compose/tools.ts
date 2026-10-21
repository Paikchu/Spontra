import { z } from "zod";
import type { ExplainerSource } from "../../../../shared/analysis-contract/business-explainer.ts";
import type { AnalysisFinding, ComposedAnalysis, FindingEvidence, FindingMaterial, FindingPassage, FindingsPublication } from "../../../../shared/analysis-contract/findings.ts";
import type { LensDocument } from "../../../../shared/analysis-contract/lens.ts";
import { earlierMaterial } from "../../../../shared/analysis-runtime/checkup-notes.ts";
import { findingRefSchema, lensDocumentIssues, readLensDocument, verifyFindings, type FindingData } from "../../../../shared/analysis-runtime/findings.ts";
import { describeDocument } from "../../../../shared/analysis-runtime/lens/describe.ts";
import { compileDocument, verifyLensDocument } from "../../../../shared/analysis-runtime/lens/verify.ts";
import type { Locale } from "../../../../shared/analysis-runtime/locale.ts";
import { EXCLUDED_HOSTS, PAGE_CACHE_MS, WEB_SCOPE, hostOf, readWebPage } from "../analyst/web.ts";
import { renderTable } from "../analyst/agent.ts";
import { libraryFindAcross, libraryRead } from "../filing-library/tool.ts";
import { libraryPassages, readLibraryDocument } from "../filing-library/store.ts";
import type { AnalysisEnv } from "../operations.ts";
import type { StageData } from "../stage/data.ts";
import { stageTools, type StageInput, type StageTurn } from "../stage/recipe.ts";
import { defineTool, type AnyTool } from "../tools/registry.ts";
import type { SearchHit } from "../web-search/types.ts";
import { researchSearch, researchSearchConfigured } from "../web-search/research-search.ts";

/**
 * The tools every agent that writes an analysis composes it with (docs/stage-agent-design.md §6): the stage's reads of
 * the company's figures and findings, the filing library, the web when a recipe allows it, and `compose`, which holds the
 * analysis to the finding page's own verifiers — every number in the judgment produced by its evidence, every quote
 * found in the passage it names, at least one quote from a filing, and one from an earlier filing when there is one. A
 * recipe chooses the prompt, the budget and the materials the run starts from; the tools and the rules are the same.
 */
export type ComposeBudget = { finds: number; reads: number; searches: number; webReads: number };
export type ComposeInput = {
  env: AnalysisEnv;
  data: StageData;
  locale: Locale;
  now: string;
  /** The report the evidence and charts are read at. */
  periodEnd: string;
  budget: ComposeBudget;
  /** Whether the library holds a filing earlier than `periodEnd` the analysis must also quote. */
  earlierAvailable: boolean;
  /** Passages the run starts with, registered as materials m1… before any read: the subject filing's own words. */
  seed?: FindingPassage[];
  /** Whether a quote from a filing is required; a Form 4 with nothing written in it has nothing to quote. */
  quoteFiling: boolean;
  /** At least this many pieces of evidence; an analysis of a filing with no figures may have none and then states no number. */
  minEvidence: number;
  /** A recipe's own conditions on a composed analysis, as error lines. */
  check?: (finding: AnalysisFinding) => string[];
};
export type Material = FindingMaterial & { passage: FindingPassage };
export type ComposeState = Omit<StageTurn, "report"> & { report: StageTurn["report"];
  materials: Material[];
  hits: SearchHit[];
  used: { finds: number; reads: number; searches: number; webReads: number };
  draft: { finding: AnalysisFinding; errors: string[] } | null;
  composed: ComposedAnalysis | null;
};

const tool = defineTool<ComposeState>();
const untrusted = (host: string, text: string) => `<untrusted source="${host}">\n${text}\n</untrusted>`;

function register(state: ComposeState, passage: FindingPassage, kind: "sec" | "web", publishedAt: string | null): string {
  const seen = state.materials.find(m => m.passageId === passage.passageId);
  if (seen) return seen.id;
  const id = kind === "sec" ? `m${state.materials.filter(m => m.kind === "sec").length + 1}` : passage.passageId;
  state.materials.push({ id, kind, title: passage.title, url: passage.url, publishedAt: kind === "sec" ? passage.filedAt : publishedAt, passageId: passage.passageId, ...(passage.documentId ? { documentId: passage.documentId } : {}), ...(passage.form ? { form: passage.form } : {}), path: passage.path, passage });
  return id;
}

/** A run's state with its seed passages already registered, in order, as m1… */
export function openCompose(input: ComposeInput): ComposeState {
  const state: ComposeState = { candidates: [], last: null, accepted: null, answer: null, materials: [], hits: [], used: { finds: 0, reads: 0, searches: 0, webReads: 0 }, draft: null, report: null, composed: null };
  for (const passage of input.seed ?? []) register(state, passage, "sec", null);
  return state;
}

/** The seeded materials as the opening message lists them: id, where it sits, and its text. */
export const seedMaterials = (state: ComposeState, chars = 2400) => state.materials.map(m => ({ id: m.id, title: m.title, path: m.passage.path.join(" › "), text: m.passage.table ? renderTable(m.passage.table, []) : m.passage.text.slice(0, chars) }));

export function composeTools(input: ComposeInput): AnyTool<ComposeState>[] {
  const { env, data, budget } = input;
  const db = env.DB!;
  const ticker = data.ticker;
  const search = researchSearchConfigured(env) ? researchSearch(env) : null;
  const yearBefore = input.periodEnd.replace(/^(\d{4})/, (_, y: string) => String(Number(y) - 1));
  // The stage's own reads, answered against the same data the analysis is verified on.
  const stageInput: StageInput = { data, locale: input.locale, scene: [], view: null };
  const reads = stageTools(stageInput).filter(t => ["company_overview", "findings", "read_series"].includes(t.name)) as unknown as AnyTool<ComposeState>[];
  const draftSchema = composeDraft(input.minEvidence);
  const compose = (state: ComposeState, value: unknown): string => {
    const parsed = draftSchema.safeParse(value);
    if (!parsed.success) return `The analysis does not match the contract:\n  ${parsed.error.issues.slice(0, 8).map(i => `${i.path.join(".") || "analysis"}: ${i.message}`).join("\n  ")}`;
    const document = readLensDocument(parsed.data.document);
    if (!document) return `The document does not match the lens grammar:\n  ${lensDocumentIssues(parsed.data.document).join("\n  ")}`;
    const finding: AnalysisFinding = {
      id: "analysis", kind: parsed.data.kind, severity: 2, title: parsed.data.title,
      judgment: { text: parsed.data.judgment, sourceIds: sources(state).map(s => s.id).slice(0, 6).concat(sources(state).length ? [] : ["sec"]) },
      evidence: parsed.data.evidence as FindingEvidence[],
      anchors: { view: "profit", nodeIds: [], metrics: [], capital: [] },
      lens: { type: "document", document },
    };
    const facts: FindingData = { ...data.data, passages: [...(data.data.passages ?? []), ...state.materials.map(m => m.passage)] };
    const publication: FindingsPublication = { schemaVersion: "findings.v1", ticker, periodEnd: input.periodEnd, generatedAt: input.now, model: "compose", findings: [finding], sources: sources(state) };
    const { verified, withheld } = verifyFindings(publication, facts, input.locale);
    const errors: string[] = withheld.flatMap(w => w.reasons.map(r => `judgment: ${r}`));
    const resolved = verified[0]?.resolved ?? [];
    const lens = verified[0] ? verifyLensDocument(document, finding, resolved, facts, input.periodEnd, { locale: input.locale }, { ticker, materials: state.materials }) : null;
    if (verified[0] && !lens) errors.push("document: nothing verifies; it needs its judgment block and blocks whose references resolve");
    for (const reason of lens?.reasons ?? []) errors.push(`document: ${reason}`);
    const quotes = document.rows.flatMap(r => r.cells.flat()).flatMap(b => b.kind === "quote" ? [state.materials.find(m => m.id === b.materialId)] : []);
    if (input.quoteFiling && !quotes.some(m => m?.kind === "sec")) errors.push("document: quote at least one filing material (m<n>) word for word");
    if (input.earlierAvailable && !quotes.some(m => m?.kind === "sec" && earlierMaterial(m, input.periodEnd))) errors.push("document: quote an earlier filing too (read_section with previous: true)");
    for (const line of input.check?.(finding) ?? []) errors.push(line);
    state.draft = { finding, errors };
    const described = lens ? describeDocument(lens.document, compileDocument(lens.document, facts, input.periodEnd), []) : "";
    return `${described}\n${errors.length ? `errors (${errors.length}):\n  ${errors.join("\n  ")}\nFix them and compose again.` : "The analysis is accepted as written; call finish."}`;
  };
  return [
    ...reads,
    tool({ name: "find_sections", description: "Find sections of the company's filings by topic, keywords or a question.", parameters: z.object({ topic: z.string().max(120).optional(), keywords: z.string().max(200).optional(), question: z.string().max(300).optional() }), concurrencySafe: true,
      execute: async (args, ctx) => {
        if (ctx.state.used.finds >= budget.finds) throw new Error("no finds left; read what you found or compose");
        ctx.state.used.finds++;
        const found = await ctx.stage("find", () => libraryFindAcross(env, { tickers: [ticker], ...args, limit: 8 }));
        return found.found.map(s => `${s.form} ${s.filedAt} · documentId ${s.documentId} · sectionId ${s.sectionId} · ${s.path.join(" › ")}${s.gist ? ` · ${s.gist}` : ""}`).join("\n") || "No sections found; try other keywords.";
      }, observe: (_a, v) => v }),
    tool({ name: "read_section", description: "Read a section of a filing; previous: true reads the same section in the earlier filing. Each passage read becomes a material m<n> a quote may cite.", parameters: z.object({ documentId: z.string().max(80), sectionId: z.string().max(80).optional(), focus: z.array(z.string().max(60)).max(8).optional(), previous: z.boolean().optional() }),
      execute: async (args, ctx) => {
        if (ctx.state.used.reads >= budget.reads) throw new Error("no reads left; compose with the materials you have");
        ctx.state.used.reads++;
        const read = await ctx.stage("read", async () => {
          let target = args.documentId;
          if (args.previous) target = (await readLibraryDocument(db, args.documentId))?.previousDocumentId ?? args.documentId;
          const document = await readLibraryDocument(db, target);
          if (!document || document.ticker !== ticker) return null;
          const read = await libraryRead(db, { documentId: target, sectionId: args.sectionId, focus: args.focus, maxChars: 7000 });
          const full = await libraryPassages(db, read.passages.map(p => p.passageId));
          return { document, passages: read.passages.map(p => { const row = full.find(f => f.passageId === p.passageId); return { passageId: p.passageId, documentId: target, title: `${document.ticker} ${document.form} ${document.reportDate}`, form: document.form, filedAt: document.filedAt, url: document.documentUrl, path: p.path.split(" › "), text: p.text,
            table: row?.table ? { unit: row.table.unit, columns: row.table.columns, rows: row.table.rows.map(r => ({ label: r.label, cells: r.cells.map(c => ({ text: c.text, value: c.value })) })) } : null } satisfies FindingPassage; }), omitted: read.omitted };
        });
        if (!read) throw new Error(`no filing ${args.documentId} of ${ticker}`);
        return read.passages.map(p => { const id = register(ctx.state, p, "sec", null); return `[${id}] ${p.title} › ${p.path.join(" › ")}\n${p.table ? renderTable(p.table, args.focus ?? []) : p.text.slice(0, 2400)}`; }).join("\n\n") + (read.omitted ? `\n(${read.omitted} passages omitted; narrow with focus)` : "");
      }, observe: (_a, v) => v }),
    tool({ name: "search", description: "Search the web; results are hits h<n> that read_web can open.", parameters: z.object({ query: z.string().min(2).max(300) }),
      execute: async ({ query }, ctx) => {
        if (!search) throw new Error("web search is not configured; use the filings");
        if (ctx.state.used.searches >= budget.searches) throw new Error("no searches left");
        ctx.state.used.searches++;
        const found = await ctx.stage("search", () => search.search({ query, maxResults: 6, depth: "advanced", topic: "general", startDate: yearBefore, excludeDomains: EXCLUDED_HOSTS }, WEB_SCOPE(ticker)).then(r => r.data.results).catch(() => [] as SearchHit[]));
        for (const h of found) if (!ctx.state.hits.some(x => x.url === h.url)) ctx.state.hits.push(h);
        return found.map(h => `[h${ctx.state.hits.findIndex(x => x.url === h.url) + 1}] ${h.title.slice(0, 160)} (${hostOf(h.url)} · ${h.publishedAt?.slice(0, 10) ?? "undated"})\n${untrusted(hostOf(h.url), h.snippet.replace(/\s+/g, " ").slice(0, 300))}`).join("\n") || `Search "${query}" returned nothing.`;
      }, observe: (_a, v) => v }),
    tool({ name: "read_web", description: "Read one page from this run's search hits, by its hit id (h2). The page becomes a material a quote may cite.", parameters: z.object({ hit: z.string().regex(/^h\d{1,2}$/), focus: z.array(z.string().max(60)).max(8).optional() }),
      execute: async ({ hit, focus }, ctx) => {
        if (!search) throw new Error("web reading is not configured");
        if (ctx.state.used.webReads >= budget.webReads) throw new Error("no web reads left");
        const target = ctx.state.hits[Number(hit.slice(1)) - 1];
        if (!target) throw new Error("read_web needs a hit id from this run's searches");
        ctx.state.used.webReads++;
        const read = await ctx.stage("web", () => readWebPage(env, ticker, target, (focus ?? []).map(f => f.toLowerCase()), input.now, url => search.fetchContent({ url, depth: "advanced" }, { ...WEB_SCOPE(ticker), maxAgeMs: PAGE_CACHE_MS }).then(r => ({ text: r.data.text }))));
        if (!read) throw new Error(`${hostOf(target.url)} could not be read`);
        const id = register(ctx.state, read.passage, "web", read.record.publishedAt);
        return `[${id}] ${read.record.title} (${hostOf(target.url)} · ${read.record.publishedAt ?? "undated"})\n${untrusted(hostOf(target.url), read.passage.text.slice(0, 3000))}`;
      }, observe: (_a, v) => v }),
    tool({ name: "compose", description: "Check the whole analysis: its judgment against its evidence, its document against the data and the materials read.", parameters: z.object({ report: z.unknown() }), strict: false,
      execute: ({ report }, ctx) => compose(ctx.state, report), observe: (_a, v) => v }),
    tool({ name: "finish", description: "Publish the last composed analysis; only one with no errors is accepted.", parameters: z.object({}),
      execute: (_a, ctx) => {
        const draft = ctx.state.draft;
        if (!draft) throw new Error("nothing composed yet; call compose first");
        if (draft.errors.length) throw new Error(`the last analysis has ${draft.errors.length} error(s); fix them and compose again`);
        const used = new Set((draft.finding.lens.type === "document" ? draft.finding.lens.document : { rows: [] } as LensDocument).rows.flatMap(r => r.cells.flat()).flatMap(b => b.kind === "quote" ? [b.materialId] : []));
        const materials = ctx.state.materials.filter(m => used.has(m.id));
        ctx.state.composed = { finding: draft.finding, materials: materials.map(({ passage: _p, ...m }) => { void _p; return m; }), passages: materials.map(m => m.passage), sources: sources(ctx.state) };
        return "Published.";
      }, observe: (_a, v) => v }),
  ];
}

const span = z.preprocess(v => typeof v === "string" ? (/^q/i.test(v.trim()) ? "quarter" : /^(fy|fiscal|annual|year)/i.test(v.trim()) ? "fiscal_year" : v) : v, z.enum(["quarter", "fiscal_year"]));
const composeDraft = (minEvidence: number) => z.object({
  title: z.string().trim().min(4).max(160),
  kind: z.enum(["risk", "strength", "shift", "watch"]).default("shift"),
  judgment: z.string().trim().min(40).max(1400),
  evidence: z.array(z.object({ ref: findingRefSchema, periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), span, compare: z.enum(["yoy", "qoq"]).optional() })).min(minEvidence).max(6),
  document: z.unknown(),
});

/** The filings the analysis's figures come from, as the citations its judgment and prose point at. */
function sources(state: ComposeState): ExplainerSource[] {
  const out = new Map<string, ExplainerSource>();
  for (const m of state.materials) if (!out.has(m.url)) out.set(m.url, { id: `s${out.size + 1}`, title: m.title, url: m.url, kind: m.kind === "sec" ? "sec" : "web", publishedAt: m.publishedAt ?? null });
  return [...out.values()];
}

/** The analysis contract and lens blocks, as every composing recipe's prompt states them. */
export const COMPOSE_CONTRACT = `An analysis: {"title": "...", "kind": "risk|strength|shift|watch", "judgment": "80–180 words", "evidence": [{"ref": <ref>, "periodEnd": "YYYY-MM-DD", "span": "quarter|fiscal_year", "compare": "yoy|qoq" optional}], "document": {"rows": [{"title": "optional, no digits", "cells": [[block, ...], [block, ...]]}]}}.
- Every number in the title and judgment must be one its evidence produces, written as the evidence writes it. A ref is copied exactly from company_overview's catalogue, a finding's evidence, or the refs the first message lists.
- The document uses the lens blocks: {"kind":"judgment"} exactly once, in the first row; {"kind":"figures"}; {"kind":"chart","chart":{...}} (lens chart grammar, at most three); {"kind":"prose","paragraphs":[{"text":"...","sourceIds":[]}]}; {"kind":"quote","materialId":"m1","text":"exact words from that material"}; {"kind":"table","table":{...}}; {"kind":"sources"}.`;
