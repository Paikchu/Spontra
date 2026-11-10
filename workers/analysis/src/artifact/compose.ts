import { z } from "zod";
import { ARTIFACT_BLOCK_ID, ARTIFACT_MAX_BLOCKS, ARTIFACT_REQUIRED_BLOCKS, type ArtifactBlock } from "../../../../shared/analysis-contract/artifact.ts";
import type { LensChart } from "../../../../shared/analysis-contract/lens.ts";
import { checkBlock, figureInText, quoteInText, shownMatches } from "../../../../shared/analysis-runtime/artifact/html.ts";
import { chartHeight, compileChart } from "../../../../shared/analysis-runtime/lens/compile.ts";
import { renderChartSvg } from "../../../../shared/analysis-runtime/lens/render.ts";
import type { FindingData } from "../../../../shared/analysis-runtime/findings.ts";
import type { AnalysisEnv } from "../operations.ts";
import type { AnyTool } from "../tools/registry.ts";
import { blockText, conservativeBlock, safeLayoutBlock, sentencesOf, toDocument, type ComposerState, type LadderStep, type TrackedIssue, sameIssue } from "./document.ts";
import { arbitrate, reviewBlock, type SourceReader } from "./review.ts";
import { reviewRendering, visualPasses } from "./qa.ts";
import { compileArtifactCss, unknownClasses } from "./theme.ts";
import { previewToken, publishStatements, recordCheck, saveVersion } from "./store.ts";
import { judge, AnthropicUnavailable } from "./anthropic.ts";

/**
 * The composing tools every analysis shares (docs/analysis-html-artifact.md §5) and the harness behind `finish`: the
 * content ladder (§6.3), the visual review and its ladder (§7.6), and publishing. The session's state carries the
 * document; the producer supplies what only it knows: how to read a source back, chart data, what publishing also
 * writes, and the URL that opens a draft in the real stage.
 */
export type ComposerSetup<S extends { composer: ComposerState }> = {
  env: AnalysisEnv;
  /** A cited source's text read back, for the figure, quote and evidence checks. */
  read: (id: string, state: S) => Promise<{ title: string; text: string } | null>;
  chart?: { data: FindingData; periodEnd: string } | null;
  ledger: { ticker: string; runId?: string };
  /** The session's turn budget; with fewer than six turns left the harness settles what is left. */
  budgetTurns: number;
  /** The producer's research tools, named in the instruction to find more material. */
  research: string[];
  /** The stage query that opens this artifact (e.g. "report=0001…" for a filing report), joined with the preview token. */
  previewQuery: string;
  /** Statements committed with the publication (a summary row, an event), and anything to do after it. */
  onPublish(state: S, published: { version: number; hash: string; text: string; degraded: string[] }): Promise<D1PreparedStatement[]>;
  /** Runs once the publication has committed. */
  afterPublish?(state: S): Promise<void>;
  /** A rule of the producer's own the document must meet before review (e.g. quoting an earlier report); the reason when it does not. */
  precheck?(state: S): string | null;
  /** Registers a source the document cites but the session has not read by name (a fact, a computed figure); false when there is none. */
  resolve?(id: string, state: S): Promise<boolean>;
  /** The exact numbers a cited source stands for (a fact's value), when it is one figure and not a text; a cited figure must be one of them. */
  figure?(id: string, state: S): Promise<number[] | null>;
  /** The blocks this producer's document must hold beyond the kind's own, checked at finish. */
  required?(state: S): readonly string[];
  /** Finds passages in the producer's material for names and figures a block uses that its cited sources do not hold, for the review. */
  find?(terms: string[], state: S): Promise<Array<{ id: string; title: string; text: string }>>;
};

/** A block is reviewed at most this many times; what is still open in it after the last is settled by the harness (§4.1). */
const CONTENT_ROUNDS = 3;
/** However the blocks are rewritten, a session's reviews end: after this many rounds every open block is settled. */
const CONTENT_ROUNDS_ALL = 6;

const ok = (observation: string) => ({ observation });
const fail = (observation: string) => ({ observation, error: true });
type Result = { observation: string; error?: boolean };

function tool<S>(name: string, description: string, properties: Record<string, unknown>, required: string[], run: (args: Record<string, unknown>, state: S) => Promise<Result> | Result, timeoutMs = 60_000): AnyTool<S> {
  return {
    name, description, strict: false, timeoutMs,
    schema: { name, description, input_schema: { type: "object", properties, required } },
    parameters: z.record(z.string(), z.unknown()),
    execute: (args: Record<string, unknown>, ctx: { state: S }) => run(args, ctx.state),
    observe: (_args: unknown, value: Result) => value.observation,
  };
}
const str = (v: unknown) => typeof v === "string" ? v : "";
const parsed = (v: unknown): unknown => { if (typeof v !== "string" || !/^\s*[[{]/.test(v)) return v; try { return JSON.parse(v); } catch { return v; } };

/** How a block's ladder moves (§6.4): the same problem raised again, or two tries at one level, climbs a level. */
function climb(state: ComposerState, key: string, issues: TrackedIssue[]): LadderStep {
  const step = state.ladder[key] ??= { level: 1, attempts: 0, keys: [] };
  const repeated = issues.some(i => step.keys.some(k => sameIssue(k, i.key)));
  step.attempts += 1;
  if (step.attempts > 1 && (repeated || step.attempts > 2)) { step.level += 1; step.attempts = 1; }
  step.keys = issues.map(i => i.key);
  return step;
}
const log = (state: ComposerState, block: string, phase: string, level: number, note: string) => { state.log.push({ at: new Date().toISOString(), block, phase, level, note: note.slice(0, 400) }); if (state.log.length > 200) state.log.splice(0, state.log.length - 200); };

const CONTENT_STEP = (level: number, research: string[]) => [
  "",
  "Correct these points in the block.",
  `The material read so far does not support this. ${research.length ? `Read more with ${research.join(", ")} and rewrite it, or narrow` : "Narrow"} the statement to what the material supports, and say plainly what is not disclosed or not yet known.`,
  "Rewrite this block from scratch: its earlier wording is withdrawn and read_block shows only its title. Write only what the material supports.",
  "If you are sure the material supports what you wrote, contest_issue with quotations from the sources; a ruling is final. Otherwise rewrite the block so it no longer makes the claim.",
][Math.min(level, 4)]!;
const RENDER_STEP = (level: number) => [
  "",
  "Fix the layout of this block; keep its words and figures unchanged.",
  "Lay this block out again from scratch with other components or arrangement; keep its words and figures unchanged.",
  "If a design remark (not a measured problem) is mistaken, contest_issue with your reason; otherwise change the layout.",
][Math.min(level, 3)]!;

export function composerTools<S extends { composer: ComposerState }>(setup: ComposerSetup<S>): AnyTool<S>[] {
  const requiredOf = (state: S) => [...new Set([...ARTIFACT_REQUIRED_BLOCKS[state.composer.artifact.kind], ...setup.required?.(state) ?? []])];
  const block = (state: S, id: string) => state.composer.blocks.find(b => b.id === id);
  const ledger = (state: S) => ({ ticker: state.composer.artifact.ticker, kind: "artifact-review", ...(setup.ledger.runId ? { runId: setup.ledger.runId } : {}) });

  async function verify(state: S, id: string, html: string): Promise<{ block?: ArtifactBlock; errors: string[] }> {
    const c = state.composer;
    // A source cited by an id the session never read by name (a fact, a computed figure) is looked up before the check.
    if (setup.resolve) for (const m of html.matchAll(/data-(?:ref|source)="([^"]{1,80})"/g)) if (c.sources[m[1]!] === undefined) await setup.resolve(m[1]!, state).catch(() => false);
    const check = checkBlock(html, { sourceUrl: ref => c.sources[ref] === undefined ? undefined : c.sources[ref]!.url, charts: new Set(Object.keys(c.charts)) });
    const errors = [...check.errors, ...await unknownClasses(check.classes)];
    for (const claim of check.claims) {
      const source = await setup.read(claim.kind === "figure" ? claim.ref : claim.source, state);
      if (!source) { errors.push(`${claim.kind === "figure" ? claim.ref : claim.source}: the source's text cannot be read back`); continue; }
      if (claim.kind === "figure") {
        const exact = await setup.figure?.(claim.ref, state) ?? null;
        if (exact) {
          if (!figureInText(claim.value, exact.map(String).join(" "))) errors.push(`<data value="${claim.value}" data-ref="${claim.ref}">: ${claim.ref} is ${source.text.slice(0, 200)} — ${claim.value} is not that number in units, thousands, millions or billions. Cite the fact that holds this figure, or compute it`);
          else if (claim.shown && !shownMatches(claim.value, claim.shown)) errors.push(`<data value="${claim.value}">: the shown text "${claim.shown}" is not this number, even rounded`);
        }
        else if (!figureInText(claim.value, source.text)) errors.push(`<data value="${claim.value}" data-ref="${claim.ref}">: ${claim.value} does not appear in ${source.title}. Cite the source that states this figure; a rate or ratio worked out from figures cites the figures source (d…) that states it, or is written as plain text without <data>`);
        else if (claim.shown && !shownMatches(claim.value, claim.shown)) errors.push(`<data value="${claim.value}">: the shown text "${claim.shown}" is not this number, even rounded`);
      } else if (!quoteInText(claim.text, source.text)) errors.push(`<blockquote data-source="${claim.source}">: the quotation is not in ${source.title} word for word`);
    }
    if (errors.length) return { errors: [...new Set(errors)].slice(0, 20) };
    return { block: { id, title: check.title || id, sources: check.sources, html: check.html, state: "draft" }, errors: [] };
  }

  async function renderUrl(state: S, version: number) {
    const c = state.composer;
    const token = await previewToken(setup.env, c.artifact.kind, c.artifact.ticker, c.artifact.subject, version);
    const origin = (setup.env.BUSINESS_SITE_ORIGIN ?? "").replace(/\/$/, "");
    return `${origin}/companies/${encodeURIComponent(c.artifact.ticker)}?${setup.previewQuery}&artifact-preview=${encodeURIComponent(token)}`;
  }

  async function publish(state: S): Promise<Result> {
    const c = state.composer;
    const classes = c.blocks.flatMap(b => checkBlock(b.html, { sourceUrl: ref => c.sources[ref]?.url ?? null, charts: new Set(Object.keys(c.charts)) }).classes);
    const css = await compileArtifactCss(classes);
    const doc = toDocument(c, 0);
    const saved = await saveVersion(setup.env, doc, css, "published", setup.ledger.runId ?? null);
    const degraded = c.blocks.filter(b => b.state === "conservative" || b.state === "safe-layout").map(b => b.id);
    const at = new Date().toISOString();
    const text = c.blocks.map(b => `## ${b.title}\n${blockTextOf(b.html)}`).join("\n\n");
    const extra = await setup.onPublish(state, { version: saved.version, hash: saved.hash, text, degraded });
    await setup.env.DB!.batch([...publishStatements(setup.env, c.artifact.kind, c.artifact.ticker, c.artifact.subject, saved.version, saved.hash, degraded, at), ...extra]);
    c.published = { version: saved.version, hash: saved.hash };
    c.phase = "published";
    await setup.afterPublish?.(state);
    return ok(`Published version ${saved.version}.${degraded.length ? ` Settled by the harness: ${degraded.join(", ")}.` : ""}`);
  }

  /** Reviews the blocks written since their last review and moves each open block up its ladder; true when content is settled. */
  async function settleContent(state: S, force: boolean): Promise<string[]> {
    const c = state.composer;
    const written = c.blocks.filter(b => b.state === "draft");
    const advice: string[] = [];
    const reader: SourceReader = id => setup.read(id, state);
    const rounds = c.rounds ??= { content: 0, render: 0 };
    const passed = c.passed ??= {}, reviews = c.reviews ??= {};
    const openIn = (b: ArtifactBlock) => { const kept = new Set(passed[b.id] ?? []); return sentencesOf(blockText(b.html)).filter(s => !kept.has(s.key)); };
    // A block whose every sentence an earlier review let stand needs no second one: its words were only moved or laid out again.
    const drafts = written.filter(b => { if (openIn(b).length) return true; b.state = "passed"; delete c.open[b.id]; return false; });
    if (drafts.length) rounds.content += 1;
    for (const b of drafts) reviews[b.id] = (reviews[b.id] ?? 0) + 1;
    const last = (b: ArtifactBlock) => force || (reviews[b.id] ?? 0) >= CONTENT_ROUNDS || rounds.content >= CONTENT_ROUNDS_ALL;
    // What the other blocks already hold, checked by code at their write: a block that restates it needs no second proof.
    const claims = new Map(c.blocks.map(b => [b.id, checkBlock(b.html, { sourceUrl: ref => c.sources[ref]?.url ?? null, charts: new Set(Object.keys(c.charts)) }).claims.map(claim =>
      claim.kind === "figure" ? `[${b.id}] ${claim.shown || claim.value} (value ${claim.value}, source ${claim.ref})` : `[${b.id}] "${claim.text.slice(0, 300)}" (source ${claim.source})`)]));
    const context = (b: ArtifactBlock) => ({
      passed: new Set(passed[b.id] ?? []),
      established: c.blocks.filter(x => x.id !== b.id).flatMap(x => claims.get(x.id) ?? []),
      ...(setup.find ? { find: (terms: string[]) => setup.find!(terms, state) } : {}),
    });
    const reviewed = await pool(drafts, 8, b => reviewBlock(setup.env, b, reader, ledger(state), context(b)).catch(() => null));
    drafts.forEach((b, i) => {
      // A review that could not run leaves the block as written: the write checks already held its figures and quotes.
      // Only major problems hold a block back; minor ones are passed on once as advice and the block stands.
      const issues = reviewed[i] ?? [];
      // The sentences this review judged and did not fault stand from now on; a fault without a quote faults the whole block.
      if (reviewed[i] && issues.every(x => x.quote)) {
        const fold = (s: string) => s.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, " ").trim();
        const faulted = issues.map(x => fold(x.quote!));
        passed[b.id] = [...new Set([...passed[b.id] ?? [], ...openIn(b).filter(s => !faulted.some(q => s.key.includes(q.slice(0, 80)) || q.includes(s.key))).map(s => s.key)])];
      }
      const major = issues.filter(x => x.severity !== "minor");
      const minor = issues.filter(x => x.severity === "minor");
      if (minor.length) advice.push(`Block "${b.id}" stands; minor points you may still fix: ${minor.map(x => `${x.quote ? `"${x.quote}" — ` : ""}${x.problem}`).join(" | ")}`);
      if (!major.length) { b.state = "passed"; delete c.open[b.id]; }
      else c.open[b.id] = major;
    });
    await recordCheck(setup.env, c.artifact.kind, c.artifact.ticker, c.artifact.subject, 0, "content", c.log.length, drafts.map((b, i) => ({ block: b.id, issues: reviewed[i] })));
    const notes: string[] = [];
    for (const b of c.blocks) {
      const issues = (c.open[b.id] ?? []).filter(i => i.kind === "content");
      if (!issues.length) continue;
      const step = climb(c, `content:${b.id}`, issues);
      if (last(b) || step.level >= 5) {
        const { empty, ...settled } = conservativeBlock(b, issues);
        delete c.open[b.id];
        c.hidden = c.hidden.filter(h => h !== b.id);
        // A section with nothing established is left out, unless the document cannot stand without it: a headline over
        // a list of what could not be shown tells the reader nothing the other sections do not.
        if (empty && !requiredOf(state).includes(b.id)) {
          c.blocks = c.blocks.filter(x => x !== b);
          log(c, b.id, "content", 5, `left out, nothing established: ${settled.note ?? ""}`);
          continue;
        }
        Object.assign(b, settled);
        log(c, b.id, "content", 5, `conservative version: ${settled.note ?? ""}`);
        continue;
      }
      if (step.level === 3 && !c.hidden.includes(b.id)) c.hidden.push(b.id);
      log(c, b.id, "content", step.level, issues.map(i => i.problem).join(" | "));
      notes.push(`Block "${b.id}" (step ${step.level}): ${CONTENT_STEP(step.level, setup.research)}\n${issues.map((i, n) => `  ${n + 1}. ${i.quote ? `"${i.quote}" — ` : ""}${i.problem}${i.suggestion ? ` Suggestion: ${i.suggestion}` : ""}`).join("\n")}`);
    }
    return notes.length ? [...notes, ...advice] : [];
  }

  async function settleRendering(state: S, force: boolean): Promise<string[]> {
    const c = state.composer;
    for (let pass = 0; pass < 3; pass++) {
      (c.rounds ??= { content: 0, render: 0 }).render += 1;
      const draft = await saveVersion(setup.env, toDocument(c, 0), await compileArtifactCss(c.blocks.flatMap(b => checkBlock(b.html, { sourceUrl: ref => c.sources[ref]?.url ?? null, charts: new Set(Object.keys(c.charts)) }).classes)), "draft", setup.ledger.runId ?? null);
      const qa = await reviewRendering(setup.env, await renderUrl(state, draft.version), c.blocks.map(b => b.id), setup.ledger);
      await recordCheck(setup.env, c.artifact.kind, c.artifact.ticker, c.artifact.subject, draft.version, "render", pass, { scores: qa.scores, unavailable: qa.unavailable, shots: qa.shots, issues: qa.issues });
      if (qa.unavailable) {
        // Without a rendering to look at, every block takes the layout that is known to pass (§6.5).
        for (const b of c.blocks) if (b.state !== "safe-layout") { Object.assign(b, safeLayoutBlock(b)); log(c, b.id, "render", 4, `safe layout: review unavailable (${qa.unavailable})`); }
        return [];
      }
      const visualOk = qa.scores === null || visualPasses(qa.scores);
      // What was measured holds a block back every time. The design review's remarks do so once, on the first rendering:
      // after that they are on record, and a score alone does not strip a block's layout.
      const remarks = !visualOk && (c.rounds?.render ?? 1) <= 1;
      const counted = qa.issues.filter(i => i.severity === "blocker" || i.kind === "interaction" || (remarks && i.kind === "visual" && i.severity === "major") || (i.kind === "render" && i.severity === "major"));
      // A safe-layout block is held to the measured checks alone.
      const byBlock = new Map<string, TrackedIssue[]>();
      for (const i of counted) {
        const b = block(state, i.block);
        if (!b || (b.state === "safe-layout" && i.kind === "visual")) continue;
        byBlock.set(i.block, [...byBlock.get(i.block) ?? [], i]);
      }
      if (!byBlock.size) return [];
      const notes: string[] = [];
      let settled = false;
      for (const [id, issues] of byBlock) {
        const b = block(state, id)!;
        const step = climb(c, `render:${id}`, issues);
        if (force || step.level >= 4 || b.state === "safe-layout") {
          if (b.state !== "safe-layout") { Object.assign(b, safeLayoutBlock(b)); settled = true; }
          delete c.open[id];
          log(c, id, "render", 4, `safe layout: ${issues.map(i => i.problem).join(" | ")}`);
          continue;
        }
        c.open[id] = [...(c.open[id] ?? []).filter(i => i.kind === "content"), ...issues];
        log(c, id, "render", step.level, issues.map(i => i.problem).join(" | "));
        notes.push(`Block "${id}" (layout step ${step.level}): ${RENDER_STEP(step.level)}\n${issues.map((i, n) => `  ${n + 1}. [${i.kind}${i.viewport ? `, ${i.viewport}` : ""}] ${i.problem}${i.suggestion ? ` Suggestion: ${i.suggestion}` : ""}`).join("\n")}${qa.scores ? `\n  Design scores: ${Object.entries(qa.scores).map(([k, v]) => `${k} ${v}`).join(", ")}` : ""}`);
      }
      if (notes.length) return notes;
      if (!settled) return [];
      // Blocks just moved to the safe layout are rendered again before publishing, so what is published was looked at.
    }
    return [];
  }

  // The harness settles what is left only when too few turns remain for another round of fixes (§6.4).
  const lowBudget = (state: S) => state.composer.turns >= setup.budgetTurns - 6;

  async function finish(state: S): Promise<Result> {
    const c = state.composer;
    if (c.phase === "published") return ok("Already published.");
    c.settledBy ??= "agent";
    const missing = requiredOf(state).filter(id => !block(state, id));
    if (missing.length && !lowBudget(state)) return fail(`Write the required blocks first: ${missing.join(", ")}.`);
    const unmet = lowBudget(state) ? null : setup.precheck?.(state) ?? null;
    if (unmet) return fail(`Not published yet: ${unmet}`);
    for (const id of missing) { const { empty: _, ...placeholder } = conservativeBlock({ id, title: id, sources: [], html: `<h2>${id}</h2>`, state: "draft" }, [{ block: id, kind: "content", severity: "major", problem: "This section was not written within the session's budget.", key: id }]); void _; c.blocks.push(placeholder); }
    c.phase = "content";
    const content = await settleContent(state, lowBudget(state));
    if (content.length) return fail(`Not published yet. The evidence review found problems. A block is reviewed ${CONTENT_ROUNDS} times at most, and after its last review the harness removes the sentences still open; sentences the review let stand are not judged again, so change only what is faulted:\n\n${content.join("\n\n")}\n\nFix them with write_block, then call finish again.`);
    c.phase = "render";
    const rendering = await settleRendering(state, lowBudget(state));
    if (rendering.length) return fail(`Not published yet. The rendered report has problems:\n\n${rendering.join("\n\n")}\n\nUse view_issue for details, fix the blocks with write_block, then call finish again.`);
    return publish(state);
  }

  return [
    tool<S>("outline", "List the document's blocks: id, title, state, length and open problems, and the required blocks still missing.", {}, [], (_a, state) => {
      const c = state.composer;
      const rows = c.blocks.map(b => `- ${b.id} "${b.title}" [${b.state}] ${b.html.length} chars${c.open[b.id]?.length ? `, ${c.open[b.id]!.length} open problem(s)` : ""}`);
      const missing = requiredOf(state).filter(id => !block(state, id));
      return ok(`${rows.join("\n") || "No blocks yet."}${missing.length ? `\nRequired blocks still missing: ${missing.join(", ")}` : ""}\nSources: ${Object.keys(c.sources).length}; charts: ${Object.keys(c.charts).join(", ") || "none"}`);
    }),
    tool<S>("read_block", "Read one block's current HTML.", { id: { type: "string" } }, ["id"], (a, state) => {
      const b = block(state, str(a.id));
      if (!b) return fail(`No block "${str(a.id)}".`);
      if (state.composer.hidden.includes(b.id)) return ok(`Block "${b.id}" ("${b.title}") is being rewritten from scratch; its earlier wording is withdrawn.`);
      return ok(b.html);
    }),
    tool<S>("write_block", "Create or replace one block: its id (lowercase slug) and inner HTML. The HTML is checked against the component rules, the theme's classes and the sources before it is saved; the reply lists every problem.", {
      id: { type: "string" }, html: { type: "string" }, after: { type: "string", description: "Place the new block after this block id; omit to keep its place or append." },
    }, ["id", "html"], async (a, state) => {
      const c = state.composer;
      const id = str(a.id).trim();
      if (!ARTIFACT_BLOCK_ID.test(id)) return fail(`Block ids are lowercase slugs such as "revenue" or "risks-2".`);
      if (c.phase === "published") return fail("The document is published.");
      if (!block(state, id) && c.blocks.length >= ARTIFACT_MAX_BLOCKS) return fail(`A document holds at most ${ARTIFACT_MAX_BLOCKS} blocks.`);
      const { block: written, errors } = await verify(state, id, str(a.html));
      if (!written) return fail(`Not saved. Fix and write again:\n${errors.map(e => `- ${e}`).join("\n")}`);
      const at = c.blocks.findIndex(b => b.id === id);
      // The same words laid out again keep the standing the review gave them (§4.2): only a change of text is reviewed.
      const before = at >= 0 ? c.blocks[at]! : null;
      const sameWords = !!before && blockText(before.html) === blockText(written.html);
      if (sameWords && before!.state === "conservative") Object.assign(written, { state: "conservative", ...(before!.note ? { note: before!.note } : {}) });
      else if (sameWords && before!.state !== "draft") written.state = "passed";
      if (at >= 0) c.blocks[at] = written;
      else {
        const after = c.blocks.findIndex(b => b.id === str(a.after));
        c.blocks.splice(after >= 0 ? after + 1 : c.blocks.length, 0, written);
      }
      c.hidden = c.hidden.filter(h => h !== id);
      if (sameWords && c.open[id]) c.open[id] = c.open[id]!.filter(i => i.kind === "content"); else delete c.open[id];
      if (c.open[id] && !c.open[id]!.length) delete c.open[id];
      return ok(`Saved "${id}" (${written.html.length} chars).${sameWords ? " The words are unchanged, so the evidence review is not repeated." : ""}`);
    }),
    tool<S>("remove_block", "Remove a block that is not required, with the reason.", { id: { type: "string" }, reason: { type: "string" } }, ["id", "reason"], (a, state) => {
      const c = state.composer, id = str(a.id);
      if (requiredOf(state).includes(id)) return fail(`"${id}" is required and cannot be removed; rewrite it instead.`);
      if (!block(state, id)) return fail(`No block "${id}".`);
      c.blocks = c.blocks.filter(b => b.id !== id);
      delete c.open[id];
      log(c, id, "compose", 0, `removed: ${str(a.reason)}`);
      return ok(`Removed "${id}".`);
    }),
    tool<S>("move_block", "Move a block after another block (or to the top with after \"\").", { id: { type: "string" }, after: { type: "string" } }, ["id", "after"], (a, state) => {
      const c = state.composer, b = block(state, str(a.id));
      if (!b) return fail(`No block "${str(a.id)}".`);
      c.blocks = c.blocks.filter(x => x !== b);
      const after = c.blocks.findIndex(x => x.id === str(a.after));
      c.blocks.splice(after + 1, 0, b);
      return ok(`Order: ${c.blocks.map(x => x.id).join(", ")}`);
    }),
    ...(setup.chart ? [tool<S>("add_chart", "Compile a chart from series the data holds (the lens chart grammar: id, title, aspect, span, series refs, marks). On success, place it in a block with <figure data-chart=\"id\"></figure>.", {
      chart: { type: "object", description: "A chart spec: {id, title, aspect: wide|square|tall, span: quarter|fiscal_year (required), series:[{id, ref, transform?}], marks:[{type, series:[…]}]}; refs are the ones company_overview and read_series list" },
    }, ["chart"], (a, state) => {
      const spec = parsed(a.chart) as LensChart;
      if (!spec || typeof spec !== "object" || typeof spec.id !== "string" || !ARTIFACT_BLOCK_ID.test(spec.id)) return fail("A chart needs an id (lowercase slug) and the chart grammar's fields.");
      const result = compileChart(spec, setup.chart!.data, setup.chart!.periodEnd);
      if (!result.chart) return fail(`The chart did not compile:\n${result.errors.map(e => `- ${e}`).join("\n")}`);
      const width = 720, svg = renderChartSvg(result.chart, { width, height: chartHeight(width, result.chart.aspect) }, { still: true });
      state.composer.charts[spec.id] = { id: spec.id, title: result.chart.title ?? spec.title ?? "", svg, points: [] };
      return ok(`Chart "${spec.id}" compiled${result.notes.length ? ` (${result.notes.join("; ")})` : ""}. Place it with <figure data-chart="${spec.id}"></figure>.`);
    })] : []),
    tool<S>("view_issue", "Show the open problems of one block, with the viewport and design scores where they came from the rendering.", { id: { type: "string" } }, ["id"], (a, state) => {
      const issues = state.composer.open[str(a.id)] ?? [];
      return ok(issues.length ? issues.map((i, n) => `${n + 1}. [${i.kind}, ${i.severity}${i.viewport ? `, ${i.viewport}` : ""}] ${i.quote ? `"${i.quote}" — ` : ""}${i.problem}${i.suggestion ? ` Suggestion: ${i.suggestion}` : ""}`).join("\n") : "No open problems.");
    }),
    tool<S>("contest_issue", "Contest one open problem of a block (its number from view_issue) with your argument and quotations from the sources. An independent arbiter rules, and the ruling is final. Measured rendering problems cannot be contested.", {
      id: { type: "string" }, number: { type: "number" }, argument: { type: "string" },
      quotes: { type: "array", items: { type: "object", properties: { source: { type: "string" }, text: { type: "string" } }, required: ["source", "text"] } },
    }, ["id", "number", "argument"], async (a, state) => {
      const c = state.composer, id = str(a.id), b = block(state, id);
      const issues = c.open[id] ?? [];
      const issue = issues[Number(a.number) - 1];
      if (!b || !issue) return fail("No such open problem; see view_issue.");
      if (issue.contested) return fail("This problem was already ruled on.");
      if (issue.kind === "render" || issue.kind === "interaction") return fail("Measured rendering problems cannot be contested; change the layout.");
      issue.contested = true;
      const quotes = (Array.isArray(parsed(a.quotes)) ? parsed(a.quotes) as Array<Record<string, unknown>> : []).map(q => ({ source: str(q.source), text: str(q.text) }));
      let ruling: { issueStands: boolean; reason: string } | null;
      if (issue.kind === "content") ruling = await arbitrate(setup.env, issue, b, str(a.argument), quotes, ref => setup.read(ref, state), ledger(state));
      else {
        try {
          ruling = await judge<{ issueStands: boolean; reason: string }>(setup.env, {
            stage: `artifact-arbiter-${id}`, effort: "high", ledger: { kind: "artifact-arbiter", ticker: c.artifact.ticker, ...(setup.ledger.runId ? { runId: setup.ledger.runId } : {}) },
            system: "You arbitrate one design remark about a research report block. The remark stands unless the author's reason shows it is mistaken for this block as written. Judge only this remark.",
            schema: { type: "object", additionalProperties: false, required: ["issueStands", "reason"], properties: { issueStands: { type: "boolean" }, reason: { type: "string" } } },
            text: JSON.stringify({ remark: { problem: issue.problem, suggestion: issue.suggestion ?? null, viewport: issue.viewport ?? null }, block: b.html.slice(0, 20_000), argument: str(a.argument).slice(0, 3000) }),
          });
        } catch (error) { if (!(error instanceof AnthropicUnavailable)) throw error; ruling = null; }
      }
      log(c, id, issue.kind, 4, `contested: ${ruling ? (ruling.issueStands ? "stands" : "withdrawn") : "no ruling"} ${ruling?.reason ?? ""}`);
      if (!ruling) return ok("No ruling could be had; the problem stands. Change the block.");
      if (ruling.issueStands) return ok(`The problem stands: ${ruling.reason}`);
      c.open[id] = issues.filter(i => i !== issue);
      if (!c.open[id]!.length) { delete c.open[id]; if (issue.kind === "content" && b.state === "draft") b.state = "passed"; }
      return ok(`Withdrawn: ${ruling.reason}`);
    }, 6 * 60_000),
    tool<S>("finish", "Finish the document: the harness reviews every block against its sources, renders the report in the real page and reviews its design, then publishes or returns the problems to fix.", {}, [], (_a, state) => finish(state), 14 * 60_000),
  ];
}

/** When a session ends without publishing, the harness delivers: open problems are settled by code and the result is published. */
export async function deliverComposer<S extends { composer: ComposerState }>(state: S, setup: ComposerSetup<S>): Promise<boolean> {
  if (state.composer.phase === "published" || !state.composer.blocks.length) return state.composer.phase === "published";
  state.composer.turns = Number.MAX_SAFE_INTEGER;
  state.composer.settledBy = "harness";
  const finish = composerTools(setup).find(t => t.name === "finish")!;
  const result = await finish.execute({}, { state, signal: new AbortController().signal, recipe: "artifact", stage: (_n: string, work: () => Promise<unknown>) => work() } as never) as Result;
  return (state.composer.phase as string) === "published" && !result.error;
}

async function pool<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await work(items[i]!); } }));
  return out;
}
const blockTextOf = (html: string) => checkBlock(html, { sourceUrl: () => null, charts: new Set() }).text;

/** What the composing session is told about the document it builds (docs/analysis-html-artifact.md §4). */
export const COMPOSER_GUIDE = `You build the report as an HTML document of blocks, one block per section, with the tools outline, read_block, write_block, remove_block, move_block, view_issue, contest_issue and finish.
Markup: shadcn/ui data-display components, written as their HTML with data-slot and Tailwind classes. Use whatever makes the point clearest: headings (h2 for the block title, h3 inside), paragraphs, lists, tables (<div data-slot="table-container"><table data-slot="table"><thead data-slot="table-header"><tr data-slot="table-row"><th data-slot="table-head">…), charts (<figure data-chart="id"></figure> after add_chart), tabs (<div data-slot="tabs"><div data-slot="tabs-list"><button data-slot="tabs-trigger" data-value="a">…</button></div><div data-slot="tabs-content" data-value="a">…</div></div>), accordions (accordion, accordion-item, accordion-trigger as a button, accordion-content), collapsible, tooltip (<span data-slot="tooltip" data-content="plain text">term</span>), progress (<div data-slot="progress" data-value="62" data-max="100"></div>), badge, alert, item, card, separator.
Classes: Tailwind utilities from the site theme only. Colours are theme names (foreground, muted-foreground, primary, border, card, muted, chart-1…chart-5, gain, loss, caution, brand, highlight); no palette colours and no arbitrary values in brackets. For responsive layout use container variants (@md:grid-cols-2), never sm:/md:/lg:; no dark: variants, no style attribute, no scripts.
House style: a research report, not a dashboard, read in one column at most 760px wide and on phones. Tables are for figures and short labels; a comparison made in sentences reads better as a list or short headed paragraphs. Separate sections with headings, text, thin rules and space; use tables, charts, tabs and other components freely where they carry the content; avoid wrapping content in many rounded bordered boxes, decorative badges, gradients and colour fills; use the highlight colour sparingly and gain/loss only for direction.
Evidence: every block cites the sources it rests on. Write figures as <data value="2876.8" data-ref="SOURCE_ID">$2,876.8m</data>, quotes as <blockquote data-source="SOURCE_ID">exact words</blockquote>, links as <a data-source="SOURCE_ID">text</a>. Write only what the material supports; where it does not settle a question, say what is not disclosed and what to look for next — that is part of the analysis.
Plan the document before writing: a periodic report reads best in four to eight blocks. Write each block once, carefully, from material you have read in this session; when you are no longer sure of a figure or a name, read it again before writing it. Call finish as soon as every block is written, leaving turns for the fixes it may ask for: finish reviews all the blocks at once against their sources, which no tool does before it, and returns the problems that would mislead a reader, block by block. Fix only the sentences it faults and call finish again: a block is reviewed ${CONTENT_ROUNDS} times at most, after which the harness removes the sentences still open, and sentences the review let stand are not judged again. When finish asks for a change of layout, keep the words exactly: the same words laid out again are not reviewed a second time.`;
