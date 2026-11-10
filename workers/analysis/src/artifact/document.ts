import { ARTIFACT_SCHEMA, ARTIFACT_SLOTS, type ArtifactBlock, type ArtifactChart, type ArtifactDocument, type ArtifactIssue, type ArtifactKind } from "../../../../shared/analysis-contract/artifact.ts";
import { nodeText, parseHtml, serializeHtml, type HtmlNode } from "../../../../shared/analysis-runtime/artifact/html.ts";

/** A problem held against a block until it is fixed, contested or settled by the harness. */
export type TrackedIssue = ArtifactIssue & { key: string; quote?: string; contested?: boolean };
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
  log: Array<{ at: string; block: string; phase: string; level: number; note: string }>;
};

export function openComposer(artifact: ComposerState["artifact"]): ComposerState {
  return { artifact, blocks: [], charts: {}, sources: {}, open: {}, ladder: {}, hidden: [], phase: "compose", turns: 0, published: null, log: [] };
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

const el = (tag: string, attrs: Array<[string, string]>, children: HtmlNode[]): HtmlNode => ({ type: "element", tag, attrs, children });
const txt = (text: string): HtmlNode => ({ type: "text", text });

/**
 * The conservative version of a block (§6.3, level 5): every paragraph, list item or cell that holds a sentence the
 * review flagged is removed, and the open questions are listed under the content that stands. What remains was not
 * flagged, so the block keeps only what the checks accepted.
 */
export function conservativeBlock(block: ArtifactBlock, issues: TrackedIssue[]): ArtifactBlock {
  const quotes = issues.flatMap(i => i.quote ? [i.quote.replace(/\s+/g, " ").trim().toLowerCase()] : []).filter(q => q.length >= 8);
  const flagged = (node: HtmlNode) => quotes.some(q => nodeText([node]).replace(/\s+/g, " ").toLowerCase().includes(q));
  const prune = (nodes: HtmlNode[]): HtmlNode[] => nodes.flatMap((node): HtmlNode[] => {
    if (node.type === "text") return [node];
    if (/^(p|li|blockquote|dd|tr)$/.test(node.tag) && flagged(node)) return [];
    return [{ ...node, children: prune(node.children) }];
  });
  const kept = quotes.length ? prune(parseHtml(block.html).nodes) : [];
  const heading = parseHtml(block.html).nodes.find(n => n.type === "element" && /^h[23]$/.test(n.tag));
  const body = kept.length && nodeText(kept).replace(heading ? nodeText([heading]) : "", "").trim().length > 40 ? kept : heading ? [heading] : [el("h2", [], [txt(block.title || block.id)])];
  const note = el("div", [["data-slot", "alert"], ["class", "mt-4"]], [
    el("div", [["data-slot", "alert-title"]], [txt("Unverified")]),
    el("div", [["data-slot", "alert-description"]], [el("ul", [["class", "list-disc pl-5"]], issues.map(i => el("li", [], [txt(i.problem)])))]),
  ]);
  return { ...block, html: serializeHtml([...body, note]), state: "conservative", note: issues.map(i => i.problem).join(" | ").slice(0, 2000) };
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
