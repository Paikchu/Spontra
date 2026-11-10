import { ARTIFACT_SCHEMA, ARTIFACT_SLOTS, type ArtifactBlock, type ArtifactChart, type ArtifactDocument, type ArtifactIssue, type ArtifactKind } from "../../../../shared/analysis-contract/artifact.ts";
import { nodeText, parseHtml, serializeHtml, type HtmlNode } from "../../../../shared/analysis-runtime/artifact/html.ts";

/** A problem held against a block until it is fixed, contested or settled by the harness. */
/** `replacement`: the review's own correction, a rewritten sentence or DELETE, that apply_fixes can put in. */
export type TrackedIssue = ArtifactIssue & { key: string; quote?: string; contested?: boolean; replacement?: string };
/** Where a block stands on its ladder (docs/analysis-html-artifact.md §6.3, §7.6). */
export type LadderStep = { level: number; attempts: number; keys: string[] };

/** Everything a composing session builds, stored with the session after every call. */
export type ComposerState = {
  artifact: { kind: ArtifactKind; ticker: string; subject: string; title: string; lang: string };
  blocks: ArtifactBlock[];
  charts: Record<string, ArtifactChart>;
  sources: Record<string, { title: string; url: string | null; kind: "sec" | "web" | "data" }>;
  /** Open issues by block. */
  open: Record<string, TrackedIssue[]>;
  /** Ladder positions by `${phase}:${block}`. */
  ladder: Record<string, LadderStep>;
  /** Blocks being rewritten from scratch: their earlier wording is not shown to the session. */
  hidden: string[];
  phase: "compose" | "content" | "render" | "published";
  turns: number;
  published: { version: number; hash: string } | null;
  /** How many times the evidence review and the rendering review have run; the content review is capped (§4.1). */
  rounds?: { content: number; render: number };
  /** The sentences of each block a review has let stand, by key: a later review of the block judges only the others (§4.1). */
  passed?: Record<string, string[]>;
  /** How many times each block has been reviewed; a block is settled by the harness after its third. */
  reviews?: Record<string, number>;
  /** Who settled the document: the session calling finish itself, or the harness delivering what it left. */
  settledBy?: "agent" | "harness";
  log: Array<{ at: string; block: string; phase: string; level: number; note: string }>;
};

export function openComposer(artifact: ComposerState["artifact"]): ComposerState {
  return { artifact, blocks: [], charts: {}, sources: {}, open: {}, ladder: {}, hidden: [], phase: "compose", turns: 0, published: null, rounds: { content: 0, render: 0 }, log: [] };
}

export const registerSource = (state: ComposerState, id: string, source: ComposerState["sources"][string]) => { state.sources[id] = source; };

export function toDocument(state: ComposerState, version: number): ArtifactDocument {
  return {
    schema: ARTIFACT_SCHEMA, kind: state.artifact.kind, ticker: state.artifact.ticker, subject: state.artifact.subject, version,
    lang: state.artifact.lang, title: state.artifact.title, blocks: state.blocks, charts: Object.values(state.charts),
    sources: Object.entries(state.sources).map(([id, s]) => ({ id, ...s })),
  };
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The document as the frame renders it: one article of sections, with the harness's charts drawn into their figures. */
export function documentHtml(doc: Pick<ArtifactDocument, "kind" | "ticker" | "subject" | "version" | "lang" | "blocks" | "charts">): string {
  const charts = new Map(doc.charts.map(c => [c.id, c]));
  const blocks = doc.blocks.map(block => {
    const html = block.html.replace(/<figure data-chart="([^"]+)"([^>]*)><\/figure>/g, (_m, id: string, rest: string) => {
      const chart = charts.get(id);
      return chart ? `<figure data-chart="${esc(id)}"${rest}>${chart.svg}${chart.title ? `<figcaption>${esc(chart.title)}</figcaption>` : ""}</figure>` : "";
    });
    return `<section data-block="${esc(block.id)}" data-state="${block.state}" data-sources="${esc(block.sources.join(" "))}">${html}</section>`;
  }).join("");
  return `<article data-artifact="${doc.kind}" data-ticker="${esc(doc.ticker)}" data-subject="${esc(doc.subject)}" data-version="${doc.version}" lang="${esc(doc.lang)}">${blocks}</article>`;
}

/** A block's plain text, for review, translation and the summaries other analyses read. */
export const blockText = (html: string) => nodeText(parseHtml(html).nodes).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

/** A block's text as sentences, each with a key that survives a change of spacing, case or punctuation. */
export function sentencesOf(text: string): Array<{ text: string; key: string }> {
  return text.split(/(?<=[.!?。])\s+|\n+/).map(s => s.trim()).filter(s => s.length > 2).map(s => ({ text: s, key: s.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, " ").trim() })).filter(s => s.key);
}

const el = (tag: string, attrs: Array<[string, string]>, children: HtmlNode[]): HtmlNode => ({ type: "element", tag, attrs, children });
const txt = (text: string): HtmlNode => ({ type: "text", text });

/**
 * Removes the sentence a match falls in from a run of sibling nodes: the text from the end of the previous sentence to
 * the end of this one, and every element inside or across that span (a figure, a link, a term).
 */
function cutSentence(nodes: HtmlNode[], match: RegExp): HtmlNode[] {
  const texts = nodes.map(n => n.type === "text" ? n.text : nodeText([n]));
  const all = texts.join("");
  const found = match.exec(all);
  if (!found) return nodes;
  const before = all.slice(0, found.index);
  const mark = Math.max(...[". ", "; ", "? ", "! ", "。"].map(m => { const at = before.lastIndexOf(m); return at < 0 ? -1 : at + m.length; }));
  const start = mark < 0 ? 0 : mark;
  // A quote that already ends its sentence ends the cut; otherwise the cut runs to the end of the sentence.
  const ended = /[.;!?。]\s*$/.test(found[0]);
  const tail = ended ? -1 : all.slice(found.index + found[0].length).search(/[.;!?。](\s|$)/);
  const end = ended ? found.index + found[0].length : tail < 0 ? all.length : found.index + found[0].length + tail + 1;
  const out: HtmlNode[] = [];
  let pos = 0;
  nodes.forEach((node, i) => {
    const from = pos, to = pos + texts[i]!.length;
    pos = to;
    if (to <= start || from >= end) { out.push(node); return; }
    if (node.type === "text") { const keep = (node.text.slice(0, Math.max(0, start - from)) + node.text.slice(Math.max(0, end - from))).replace(/ {2,}/g, " "); if (keep) out.push({ type: "text", text: keep }); }
  });
  return out;
}

/**
 * The conservative version of a block (§6.3, level 5): every sentence the review flagged is cut whole, with the
 * figures, links and terms written inside it; a flagged quotation or table row goes as a unit; a paragraph or item left
 * empty goes too. The open questions are listed under the content that stands, so the block keeps only what the
 * checks accepted and nothing is left half-cut.
 */
export function conservativeBlock(block: ArtifactBlock, issues: TrackedIssue[]): ArtifactBlock & { empty?: true } {
  const quotes = issues.flatMap(i => i.quote ? [i.quote.replace(/\s+/g, " ").trim()] : []).filter(q => q.length >= 8);
  const pattern = (q: string) => new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s*"), "i");
  const holds = (text: string, q: string) => pattern(q).test(text);
  const prune = (nodes: HtmlNode[]): HtmlNode[] => nodes.flatMap((node): HtmlNode[] => {
    if (node.type === "text" || /^h[234]$/.test(node.tag)) return [node];
    const here = quotes.filter(q => holds(nodeText([node]), q));
    if (!here.length) return [node];
    // A quotation or a table row is not cut inside; it goes as a unit.
    if (/^(blockquote|tr)$/.test(node.tag)) return [];
    // A sentence that lies inside one child is cut there; one that runs across this node's children is cut here.
    let children = prune(node.children);
    const across = here.filter(q => !node.children.some(c => c.type === "element" && holds(nodeText([c]), q)));
    for (const q of across) children = cutSentence(children, pattern(q));
    if (/^(p|li|dd)$/.test(node.tag) && nodeText(children).replace(/[\s.,;:()—–-]+/g, "").length < 12) return [];
    return [{ ...node, children }];
  });
  const kept = prune([el("div", [], parseHtml(block.html).nodes)]).flatMap(n => n.type === "element" ? n.children : [n]);
  const heading = parseHtml(block.html).nodes.find(n => n.type === "element" && /^h[23]$/.test(n.tag));
  const stands = nodeText(kept).replace(heading ? nodeText([heading]) : "", "").trim().length > 40;
  const body = stands ? kept : heading ? [heading] : [el("h2", [], [txt(block.title || block.id)])];
  // The open questions sit under the content that stands, folded away: a reader sees what is established first.
  const note = el("div", [["data-slot", "accordion"], ["class", "mt-3 text-sm text-muted-foreground"]], [
    el("div", [["data-slot", "accordion-item"]], [
      el("button", [["data-slot", "accordion-trigger"]], [txt(`Not established (${issues.length})`)]),
      el("div", [["data-slot", "accordion-content"]], [el("ul", [], issues.map(i => el("li", [], [txt(i.problem)])))]),
    ]),
  ]);
  return { ...block, html: serializeHtml([...body, note]), state: "conservative", note: issues.map(i => i.problem).join(" | ").slice(0, 2000), ...(stands ? {} : { empty: true }) };
}

/**
 * The safe layout of a block (§7.6, level 4): the same content in the frame's standard typography — classes removed,
 * tabs, accordions and carousels opened out into headed sections, tooltips written inline. Charts and tables stay.
 */
export function safeLayoutBlock(block: ArtifactBlock): ArtifactBlock {
  const slot = (n: HtmlNode) => n.type === "element" ? n.attrs.find(([k]) => k === "data-slot")?.[1] : undefined;
  const flatten = (nodes: HtmlNode[]): HtmlNode[] => nodes.flatMap(node => {
    if (node.type === "text") return [node];
    const s = slot(node);
    const attrs = node.attrs.filter(([k]) => k !== "class" && !(k === "data-slot" && s && ARTIFACT_SLOTS[s]?.interactive) && k !== "data-content" && k !== "data-value");
    if (s === "tabs") {
      const triggers = new Map<string, string>();
      const find = (ns: HtmlNode[]) => ns.forEach(n => { if (n.type === "element") { if (slot(n) === "tabs-trigger") triggers.set(n.attrs.find(([k]) => k === "data-value")?.[1] ?? "", nodeText(n.children).trim()); find(n.children); } });
      find(node.children);
      const contents: HtmlNode[] = [];
      const collect = (ns: HtmlNode[]) => ns.forEach(n => { if (n.type === "element") { if (slot(n) === "tabs-content") contents.push(el("div", [], [el("h3", [], [txt(triggers.get(n.attrs.find(([k]) => k === "data-value")?.[1] ?? "") ?? "")]), ...flatten(n.children)])); else collect(n.children); } });
      collect(node.children);
      return contents;
    }
    if (s === "tabs-list" || s === "carousel-previous" || s === "carousel-next") return [];
    if (s === "accordion-trigger" || s === "collapsible-trigger") return [el("h3", [], flatten(node.children))];
    if ((s === "tooltip" || s === "hover-card") && node.attrs.some(([k]) => k === "data-content")) {
      const content = node.attrs.find(([k]) => k === "data-content")![1];
      return [...flatten(node.children), txt(` (${content})`)];
    }
    if (node.tag === "button") return flatten(node.children);
    return [{ ...node, attrs, children: flatten(node.children) }];
  });
  return { ...block, html: serializeHtml(flatten(parseHtml(block.html).nodes)), state: "safe-layout" };
}

/** A stable key for an issue, so the same problem raised twice is recognised as no progress. */
export function issueKey(block: string, problem: string, quote?: string): string {
  const basis = (quote && quote.length >= 8 ? quote : problem).toLowerCase().replace(/[^a-z0-9一-鿿]+/g, " ").trim().split(" ").slice(0, 12).join(" ");
  return `${block}:${basis}`;
}

/** Whether two sets of issue keys share most of their words: the same problem, reworded. */
export function sameIssue(a: string, b: string): boolean {
  const wa = new Set(a.split(/[: ]/)), wb = new Set(b.split(/[: ]/));
  const shared = [...wa].filter(w => wb.has(w)).length;
  return shared / Math.max(1, Math.min(wa.size, wb.size)) >= 0.7;
}
