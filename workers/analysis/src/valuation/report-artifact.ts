import { z } from "zod";
import type { ValuationSections } from "../../../../shared/analysis-contract/valuation.ts";
import { nodeText, parseHtml, type HtmlNode } from "../../../../shared/analysis-runtime/artifact/html.ts";
import { modelFor, reasoningFor } from "../ai-config.ts";
import { COMPOSER_GUIDE, composerTools, deliverComposer, type ComposerSetup } from "../artifact/compose.ts";
import { blockText, openComposer, registerSource, type ComposerState } from "../artifact/document.ts";
import { requireDb } from "../core.ts";
import type { AnalysisEnv } from "../operations.ts";
import type { PiLoaded } from "../pi/host.ts";
import { unpackState } from "../pi/state.ts";
import type { Recipe } from "../recipe.ts";
import type { AnyTool } from "../tools/registry.ts";
import { ValuationStore } from "./store.ts";
import { CITATION, factLine, valuationTools, type ValuationState } from "./tools.ts";

/**
 * The valuation's written report as an artifact (docs/analysis-html-artifact.md, P4): after the model is calculated and
 * the counter-evidence reviewed, one session writes the report block by block through the shared composer, citing the
 * registered evidence and the calculated figures; every block is checked, reviewed, rendered and reviewed for design
 * before it is published. The sections the publication carries are read back from the published blocks.
 */
export type ValuationReportSpec = { state: string; opening: string; generation: number; runId: string | null };
export type ReportState = ValuationState & {
  composer: ComposerState;
  judgement: { coreLogicFailed: boolean; decisiveCounterEvidence: boolean } | null;
};

export const reportSubject = (generation: number) => `g${generation}`;
const TURNS = 24;
const BLOCKS: Record<string, keyof ValuationSections> = { summary: "summary", thesis: "thesis", "expectations-gap": "expectationsGap", catalysts: "catalysts", "counter-evidence": "counterEvidence", "next-checks": "nextChecks", "model-notes": "modelNotes" };

export const REPORT_SYSTEM = `You write the valuation report from the recorded research, the calculated model, its cross-check and gates, and the counter-evidence review. Use only figures from the facts or the calculation, exactly as given; negative modelled equity is a shortfall after senior claims, not a tradable negative share price, and a non-positive normal band cannot support a price-position conclusion.
The page shows above the report the five dimension scores with the rationale recorded for each, the three scenario values with their probabilities, the reference close against the normal band and the expected value, and, beside the report, the recorded reasons for each method's weight, each scenario's probability, the base path's assumptions, management's targets and the consensus. The report does not restate those reasons; it argues from them. It says what the figures cannot: why the value sits where it does, what the price is paying for, what would break the case, and what to watch. State each fact once in the whole report; a number already shown appears in the prose only where the argument turns on it.
Sources: every registered evidence passage is a source under its id (e…); "model" is the calculation as the first message gives it and "facts" the validated financial facts. Cite a passage with <a data-source="e…">, quote it with <blockquote data-source="e…">, and write a figure from the calculation as <data value data-ref="model">. read_valuation_evidence re-reads full excerpts.
Blocks, each with an h2 title that states its point:
summary (required; three or four sentences): the position of the reference close against the normal band with its date; the one reason the value is where it is; the one thing that would break it. No list of scenarios, gates or assumptions. If the normal range is unavailable, say the price position cannot be established and name the gap; never substitute the bear/bull range or the football field. Every value in the model is the equity's value twelve months after the research date (the present-value model rolled forward at its discount rate), so the reference close is compared with where the value is expected to stand in twelve months; say so once. It is not a price prediction, a confidence interval or a judgement derived from the research score.
thesis: four parts, each with an h3: public facts (the statements, stated once), management guidance (the company's targets, not your forecast), research assumptions (yours, and how they differ from guidance) and where the value comes from, the longest part: how the value is built, from the operating path through each method to the band and the expected value, which method or scenario carries the value and why, where the methods disagree and what that means, and what the band would be if the weakest assumption failed.
expectations-gap: what the price is paying for, in terms of the market-implied path against the base; a base more than 50% from the consensus or the price is decomposed. Say plainly when the market-implied path already matches the base case.
catalysts, next-checks, counter-evidence: each a list of at most four items. Catalysts are dated events with their window and the figure they settle; next checks the observable that would confirm or break each key assumption, none already a catalyst; counter-evidence the strongest arguments against the case, with the evidence.
model-notes: only what the recorded rationales do not say: what each flagged gate means for the value, and any judgement the figures hide.
Before finish, call set_judgement: coreLogicFailed only when the evidence shows the long-term thesis has failed; decisiveCounterEvidence when a counter-argument remains unanswered.`;

function reportRecipe(env: AnalysisEnv, spec: ValuationReportSpec, start: ValuationState): Recipe<string, ReportState, ReportState> {
  const facts = start.input.facts.map(factLine).join("\n");
  const setup: ComposerSetup<ReportState> = {
    env, chart: null, ledger: { ticker: start.input.ticker, ...(spec.runId ? { runId: spec.runId } : {}) }, budgetTurns: TURNS,
    research: ["read_valuation_evidence"], previewQuery: "view=valuation",
    read: async (id, s) => {
      if (id === "model") return { title: "The calculated model", text: spec.opening };
      if (id === "facts") return { title: "The validated financial facts", text: facts };
      const e = s.evidence.get(id);
      return e ? { title: e.title, text: e.excerpt } : null;
    },
    onPublish: async () => [],
    precheck: s => s.judgement ? null : "call set_judgement first: whether the long-term thesis has failed and whether a counter-argument remains unanswered.",
  };
  const judgement: AnyTool<ReportState> = {
    name: "set_judgement", description: "Record whether the evidence shows the long-term thesis has failed, and whether decisive counter-evidence remains unanswered.", strict: false,
    schema: { name: "set_judgement", description: "Record the report's two judgements.", input_schema: { type: "object", properties: { coreLogicFailed: { type: "boolean" }, decisiveCounterEvidence: { type: "boolean" } }, required: ["coreLogicFailed", "decisiveCounterEvidence"] } },
    parameters: z.object({ coreLogicFailed: z.boolean(), decisiveCounterEvidence: z.boolean() }),
    execute: (args: { coreLogicFailed: boolean; decisiveCounterEvidence: boolean }, ctx: { state: ReportState }) => { ctx.state.judgement = args; return "Recorded."; },
    observe: (_a: unknown, v: string) => v,
  } as unknown as AnyTool<ReportState>;
  const evidence = valuationTools(env).filter(t => t.name === "read_valuation_evidence") as unknown as AnyTool<ReportState>[];
  const tools = [...evidence, judgement, ...composerTools(setup)];
  return {
    id: "valuation-report", budget: { turns: TURNS, wallMs: 45 * 60_000 }, resultChars: 40_000, callsPerTurn: Infinity,
    system: () => `${REPORT_SYSTEM}\n\n${COMPOSER_GUIDE}`,
    open: () => {
      const composer = openComposer({ kind: "valuation-report", ticker: start.input.ticker, subject: reportSubject(spec.generation), title: `${start.input.companyName}: valuation`, lang: "en" });
      registerSource(composer, "model", { title: "The calculated model", url: null, kind: "data" });
      registerSource(composer, "facts", { title: "The validated financial facts", url: null, kind: "data" });
      for (const e of start.evidence.values()) registerSource(composer, e.evidenceId, { title: `${e.title}${e.path ? ` › ${e.path}` : ""}`.slice(0, 300), url: e.url && /^https:\/\//.test(e.url) ? e.url : null, kind: e.kind === "web" ? "web" : "sec" });
      return { ...start, composer, judgement: null };
    },
    tools: () => tools,
    policy: { allow: tools.map(t => t.name) },
    onTurn: (s, turn) => { s.composer.turns = turn; },
    settled: s => s.composer.phase === "published" || s.cancelled,
    settle: s => s,
    nudge: "Continue writing the blocks, then call set_judgement and finish.",
    afterRun: async (s) => { if (!s.cancelled) await deliverComposer(s, setup).catch(error => console.error(JSON.stringify({ event: "artifact-deliver", ticker: start.input.ticker, error: error instanceof Error ? error.message : String(error) }))); },
  };
}

/** Rebuilds the report session; each call first checks that the run still holds its generation. */
export async function valuationReportLoader(spec: ValuationReportSpec, env: AnalysisEnv): Promise<PiLoaded<ReportState>> {
  const start = unpackState<ValuationState>(spec.state);
  const store = new ValuationStore(requireDb(env));
  return {
    recipe: reportRecipe(env, spec, start), input: "", model: modelFor(env, "valuation"), effort: reasoningFor(env, "valuation"),
    ledger: { kind: "valuation", ticker: start.input.ticker, ...(spec.runId ? { runId: spec.runId } : {}) },
    reserve: async state => {
      const ok = (await store.current(state.input.ticker))?.request_generation === spec.generation;
      if (!ok) state.cancelled = true;
      return ok;
    },
  };
}

const items = (html: string): string[] => {
  const out: string[] = [];
  const walk = (nodes: HtmlNode[]) => { for (const n of nodes) if (n.type === "element") { if (n.tag === "li") out.push(nodeText(n.children).replace(/\s+/g, " ").trim()); else walk(n.children); } };
  walk(parseHtml(html).nodes);
  return out.filter(Boolean);
};

/**
 * The publication's sections read back from the published blocks: the text of each block (lists item by item), with the
 * evidence it cites in brackets so the publication lists every source the report rests on.
 */
export function sectionsFromReport(composer: ComposerState): ValuationSections {
  const sections: ValuationSections = { summary: "", thesis: "", expectationsGap: "", catalysts: [], counterEvidence: [], nextChecks: [], modelNotes: "" };
  for (const block of composer.blocks) {
    const key = BLOCKS[block.id];
    if (!key) continue;
    const cites = block.sources.filter(id => new RegExp(`^${CITATION.source}$`).test(id)).map(id => `[${id}]`).join("");
    const text = blockText(block.html).replace(block.title, "").trim();
    if (key === "catalysts" || key === "counterEvidence" || key === "nextChecks") {
      const list = items(block.html);
      sections[key] = (list.length ? list : text.split(/\n{2,}/).filter(Boolean)).slice(0, 4).map((t, i) => i === 0 && cites ? `${t} ${cites}` : t);
    } else sections[key] = cites ? `${text} ${cites}` : text;
  }
  return sections;
}
