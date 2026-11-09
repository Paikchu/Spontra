import { modelFor } from "../ai-config.ts";
import { renderTable } from "../analyst/agent.ts";
import { composeTools, openCompose, type ComposeInput, type ComposeState } from "../compose/tools.ts";
import { librarySectionPassages } from "../filing-library/store.ts";
import type { AnalysisEnv } from "../operations.ts";
import { handPolicy, handTool, type HandResult } from "../pi/hand-tools.ts";
import type { PiLoaded } from "../pi/host.ts";
import type { Recipe } from "../recipe.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { normalizeSecSummary, SEC_SUMMARY_VERSION, type SecFiling, type SecFilingSummary } from "../sec/sec.ts";
import { loadStageData } from "../stage/data.ts";
import type { AnyTool } from "../tools/registry.ts";
import type { LibraryPassageView } from "../../../../shared/analysis-contract/filing-library.ts";
import { FILING_SYSTEM, profileById, type FilingProfile, type ProfileId } from "./profiles.ts";
import { previousSectionOf, sectionDocuments, updateFiling } from "./store.ts";

/** What the session is rebuilt from after an eviction. */
export type FilingSpec = { ticker: string; profile: ProfileId; filing: SecFiling; runId: string; sessionId: string; jobId: string; jobVersion: string; requestedBy: "scheduled" | "manual" };
export type FilingState = ComposeState & { published: boolean };

const ok = (observation: string): HandResult => ({ observation });
const fail = (observation: string): HandResult => ({ observation, error: true });
const parsed = (value: unknown): unknown => {
  if (typeof value !== "string" || !/^\s*[[{]/.test(value)) return value;
  try { return JSON.parse(value); } catch { return value; }
};
const idsOf = (value: unknown) => (Array.isArray(parsed(value)) ? parsed(value) as unknown[] : []).map(String).filter(Boolean);
const passageText = (p: LibraryPassageView) => p.table ? renderTable(p.table, []) : p.text;
const RESULT_CHARS = 60_000;
/** The company tools the session can use beside reading the filing. */
const COMPANY_TOOLS = ["company_overview", "read_series", "list_filings", "search", "read_web"];
const NO_FIGURES: ComposeInput["budget"] = { finds: 0, reads: 0, searches: 8, webReads: 8 };

function job(spec: FilingSpec, status: "complete" | "failed", at: string, errorDetail?: string) {
  return { jobId: spec.jobId, ticker: spec.ticker, accessionNumber: spec.filing.accessionNumber, analysisVersion: spec.jobVersion, attempt: 1, requestedBy: spec.requestedBy, workflowInstanceId: spec.sessionId,
    status, currentStage: status === "complete" ? "published" : "analysis", updatedAt: at, completedAt: at, ...(errorDetail ? { errorCode: "analysis_failed", errorDetail } : {}) };
}

export function filingRecipe(env: AnalysisEnv, spec: FilingSpec, profile: FilingProfile, data: ComposeInput["data"] | null): Recipe<FilingSpec, boolean, FilingState> {
  const db = env.DB!;
  const repository = new D1SecRepository(db);
  const { ticker, filing } = spec;
  const accession = filing.accessionNumber;
  const input: ComposeInput | null = data ? { env, data, locale: "en", now: new Date().toISOString(), periodEnd: filing.reportDate, budget: NO_FIGURES, earlierAvailable: false, quoteFiling: false, minEvidence: 0 } : null;
  const company = input ? composeTools(input).filter(t => COMPANY_TOOLS.includes(t.name)) as unknown as AnyTool<FilingState>[] : [];
  const read = async (sectionIds: string[]) => {
    const documents = await sectionDocuments(db, sectionIds);
    const out: string[] = [];
    for (const [sectionId, documentId] of documents) out.push(`## ${sectionId}\n${(await librarySectionPassages(db, documentId, [sectionId])).map(passageText).join("\n\n") || "(no text)"}`);
    return out.join("\n\n") || "No such section.";
  };
  const own: AnyTool<FilingState>[] = [
    handTool<FilingState>({ name: "read_sections", description: "Read sections of this filing whole, tables included, by the ids the first message lists. Send several ids at once.", input_schema: { type: "object", properties: { sectionIds: { type: "array", items: { type: "string" } } }, required: ["sectionIds"] } },
      async (args) => ok(await read(idsOf(args.sectionIds)))),
    handTool<FilingState>({ name: "read_previous", description: "Read the same sections in the earlier filing.", input_schema: { type: "object", properties: { sectionIds: { type: "array", items: { type: "string" } } }, required: ["sectionIds"] } },
      async (args) => {
        const earlier = (await Promise.all(idsOf(args.sectionIds).map(id => previousSectionOf(db, id)))).flatMap(s => s ? [s.sectionId] : []);
        return ok(earlier.length ? await read(earlier) : "The earlier filing has no such section.");
      }),
    handTool<FilingState>({ name: "publish_report", description: "Publish the report and end the session: headline, bullets [{label, detail, importance}] (at most five), analystView, report (the full report in Markdown), and eventCategory for an 8-K or 6-K.",
      input_schema: { type: "object", properties: { headline: { type: "string" }, bullets: { type: "array", items: { type: "object" } }, analystView: { type: "string" }, report: { type: "string" }, eventCategory: { type: "string" } }, required: ["headline", "report"] } },
      async (args, state) => {
        const report = String(args.report ?? "").trim();
        const now = new Date().toISOString();
        const summary: SecFilingSummary = { ...normalizeSecSummary({ ...args, bullets: parsed(args.bullets), source: "claude", version: SEC_SUMMARY_VERSION }, filing, new Date(now)), report, generatedBy: "pi" };
        if (!summary.headline || !report) return fail("headline and report are both needed.");
        await repository.setSummary({ ticker, accessionNumber: accession, form: filing.form }, summary);
        const spent = await db.prepare("SELECT SUM(input_tokens - COALESCE(cached_tokens, 0) + output_tokens) n FROM ai_usage WHERE run_id = ?").bind(spec.sessionId).first<{ n: number | null }>();
        await updateFiling(db, ticker, accession, { status: "published", reason: null, tokens: spent?.n ?? 0, publishedAt: now }, now);
        await repository.upsertAnalysisJob(job(spec, "complete", now));
        state.published = true;
        return ok("Published.");
      }),
  ];
  const list = [...own, ...company];
  const hand = handPolicy(own);
  return {
    id: `filing.${spec.profile}.v2`,
    budget: { turns: profile.turns, wallMs: profile.wallMs },
    resultChars: RESULT_CHARS,
    system: () => `${FILING_SYSTEM(ticker)}\n${profile.prompt}`,
    open: () => ({ ...(input ? openCompose(input) : { candidates: [], last: null, accepted: null, answer: null, materials: [], hits: [], used: { finds: 0, reads: 0, searches: 0, webReads: 0 }, draft: null, report: null, composed: null, rejected: 0, withheld: false }), published: false }) as FilingState,
    tools: () => list,
    policy: { allow: list.map(t => t.name), post: hand.post },
    settled: s => s.published,
    settle: s => s.published,
    nudge: "Continue reading if you need to, then call publish_report.",
    afterRun: async (s) => {
      if (s.published) return;
      const now = new Date().toISOString();
      await updateFiling(db, ticker, accession, { status: "failed", reason: "the session ended without a report", failed: true }, now);
      await repository.upsertAnalysisJob(job(spec, "failed", now, "the session ended without a report"));
    },
  };
}

/** Rebuilds the session from its spec, on start and after an eviction. */
export async function filingLoader(spec: FilingSpec, env: AnalysisEnv): Promise<PiLoaded> {
  const profile = profileById(spec.profile);
  const data = await loadStageData(env, spec.ticker, { findings: false }).catch(() => null);
  return { recipe: filingRecipe(env, spec, profile, data), input: spec, effort: profile.reasoning, model: modelFor(env, "filing"), ledger: { kind: "filing", ticker: spec.ticker, runId: spec.sessionId } };
}
