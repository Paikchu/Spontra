import { ARTIFACT_ATTRIBUTES, ARTIFACT_CLASS_RULES, ARTIFACT_ELEMENTS, ARTIFACT_MAX_BLOCK_CHARS, ARTIFACT_SLOTS, ARTIFACT_VOID_ELEMENTS } from "../../analysis-contract/artifact.ts";

/**
 * A strict parser for artifact blocks (docs/analysis-html-artifact.md §4): elements, double- or single-quoted
 * attributes, text and a few character references. Anything else — comments, doctype, unquoted attributes, a tag left
 * open — is an error, never repaired, so what the model wrote is exactly what is stored and rendered.
 */
export type HtmlNode = { type: "text"; text: string } | { type: "element"; tag: string; attrs: Array<[string, string]>; children: HtmlNode[] };

const VOID = new Set<string>(ARTIFACT_VOID_ELEMENTS);
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", times: "×", middot: "·", deg: "°", plusmn: "±", minus: "−" };

function decode(text: string, errors: string[]): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);?/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1]?.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code < 0x110000) return String.fromCodePoint(code);
    } else if (NAMED[body.toLowerCase()] !== undefined) return NAMED[body.toLowerCase()]!;
    errors.push(`unknown character reference ${whole}`);
    return whole;
  });
}

export function parseHtml(source: string): { nodes: HtmlNode[]; errors: string[] } {
  const errors: string[] = [];
  const root: HtmlNode = { type: "element", tag: "#root", attrs: [], children: [] };
  const stack: Array<Extract<HtmlNode, { type: "element" }>> = [root as Extract<HtmlNode, { type: "element" }>];
  let i = 0;
  const text = (end: number) => {
    if (end > i) {
      const raw = source.slice(i, end);
      if (raw.includes(">")) { /* a stray ">" in text is harmless; it is escaped on output */ }
      stack.at(-1)!.children.push({ type: "text", text: decode(raw, errors) });
    }
  };
  while (i < source.length && errors.length < 20) {
    const lt = source.indexOf("<", i);
    if (lt < 0) { text(source.length); break; }
    text(lt);
    i = lt;
    if (source.startsWith("<!--", i) || source.startsWith("<!", i) || source.startsWith("<?", i)) { errors.push("comments, doctype and processing instructions are not allowed"); break; }
    const close = /^<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>/.exec(source.slice(i));
    if (close) {
      const tag = close[1]!.toLowerCase();
      const top = stack.at(-1)!;
      if (top.tag !== tag) { errors.push(`</${tag}> closes <${top.tag === "#root" ? "nothing" : top.tag}>; every element must be closed in order`); break; }
      stack.pop();
      i += close[0].length;
      continue;
    }
    const open = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(source.slice(i));
    if (!open) { errors.push(`"<" must start a tag; write &lt; for a literal "<"`); break; }
    const tag = open[1]!.toLowerCase();
    i += open[0].length;
    const attrs: Array<[string, string]> = [];
    let selfClosed = false;
    for (;;) {
      const space = /^\s*/.exec(source.slice(i))![0];
      i += space.length;
      if (source.startsWith("/>", i)) { selfClosed = true; i += 2; break; }
      if (source[i] === ">") { i += 1; break; }
      const attr = /^([a-zA-Z_:@][a-zA-Z0-9_:.@-]*)(\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/.exec(source.slice(i));
      if (!attr || !space) { errors.push(`<${tag}>: attributes must be written name="value", separated by spaces`); break; }
      if (attr[5] !== undefined) { errors.push(`<${tag} ${attr[1]}>: attribute values must be quoted`); break; }
      attrs.push([attr[1]!.toLowerCase(), attr[2] === undefined ? "" : decode(attr[3] ?? attr[4] ?? "", errors)]);
      i += attr[0].length;
    }
    if (errors.length) break;
    const node: Extract<HtmlNode, { type: "element" }> = { type: "element", tag, attrs, children: [] };
    stack.at(-1)!.children.push(node);
    if (!VOID.has(tag) && !selfClosed) stack.push(node);
  }
  if (!errors.length && stack.length > 1) errors.push(`<${stack.at(-1)!.tag}> is never closed`);
  return { nodes: root.type === "element" ? root.children : [], errors };
}

const escText = (s: string) => s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
const escAttr = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function serializeHtml(nodes: HtmlNode[]): string {
  return nodes.map(node => {
    if (node.type === "text") return escText(node.text);
    const attrs = node.attrs.map(([k, v]) => v === "" && k !== "value" ? ` ${k}` : ` ${k}="${escAttr(v)}"`).join("");
    return VOID.has(node.tag) ? `<${node.tag}${attrs}>` : `<${node.tag}${attrs}>${serializeHtml(node.children)}</${node.tag}>`;
  }).join("");
}

export const nodeText = (nodes: HtmlNode[]): string => nodes.map(n => n.type === "text" ? n.text : (n.tag === "br" ? "\n" : nodeText(n.children) + (/^(p|li|h[234]|tr|div|dt|dd|blockquote|figcaption)$/.test(n.tag) ? "\n" : " "))).join("");
const attr = (node: Extract<HtmlNode, { type: "element" }>, name: string) => node.attrs.find(([k]) => k === name)?.[1];

/** What a block check needs from the run: what was read and registered, so every citation, figure and quote can be checked. */
export type BlockContext = {
  /** A registered source's URL, or null for a source without one; undefined when the id was never registered. */
  sourceUrl(id: string): string | null | undefined;
  /** Charts compiled in this run, by id. */
  charts: ReadonlySet<string>;
};

/** A figure or quote the block makes, for the harness to check against the cited source's text. */
export type BlockClaim = { kind: "figure"; ref: string; value: number; shown: string } | { kind: "quote"; source: string; text: string };
export type BlockCheck = { html: string; classes: string[]; sources: string[]; claims: BlockClaim[]; errors: string[]; text: string; title: string };

const ELEMENTS = new Set<string>(ARTIFACT_ELEMENTS);
const PALETTE = /^(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|mauve|olive|mist|taupe|black|white)(-\d{2,3})?$/;
const COLOR_UTILITY = /^-?(bg|text|border(?:-[xytrbl])?|ring|ring-offset|fill|stroke|outline|decoration|divide|from|via|to|accent|caret|placeholder|shadow|inset-shadow)-(.+)$/;
const THEME_COLORS = new Set<string>(ARTIFACT_CLASS_RULES.colors);
const VARIANTS = new Set<string>(ARTIFACT_CLASS_RULES.variants);
const ROOTS = new Set<string>(ARTIFACT_CLASS_RULES.roots);

/** The class rules that need no compiler: variants, forbidden roots, arbitrary values and colours outside the theme. */
export function classProblems(cls: string): string | null {
  if (/[[\]{}()<>'"\\]/.test(cls)) return `${cls}: arbitrary values are not allowed; use the theme's scale`;
  if (cls.includes("!")) return `${cls}: !important is not allowed`;
  const parts = cls.split(":");
  const utility = parts.pop()!;
  for (const variant of parts) {
    if (!VARIANTS.has(variant)) return `${cls}: the "${variant}:" variant is not allowed${/^(sm|md|lg|xl|2xl)$/.test(variant) ? `; the stage is narrower than the window, use the container variant "@${variant}:"` : variant === "dark" ? "; colours follow the theme in both schemes" : ""}`;
  }
  const bare = utility.replace(/^-/, "");
  const root = bare.split("-")[0]!;
  if (ROOTS.has(bare) || ROOTS.has(root)) return `${cls}: "${root}" is not allowed in an artifact`;
  const color = COLOR_UTILITY.exec(utility);
  if (color) {
    const value = color[2]!.replace(/\/\d{1,3}$/, "");
    if (PALETTE.test(value)) return `${cls}: Tailwind's palette is not the site's; use a theme colour (${[...THEME_COLORS].slice(0, 12).join(", ")}…)`;
    if (/^(sidebar|popover)/.test(value) && !THEME_COLORS.has(value)) return `${cls}: "${value}" is not a theme colour for artifacts`;
  }
  return null;
}

/**
 * Checks one block's inner HTML against the specification and the run's materials, and returns it in canonical form:
 * links get their registered URL, charts are placeholders the harness fills, and every class is listed for the
 * compiler. Errors name the element and say what to write instead.
 */
export function checkBlock(source: string, ctx: BlockContext): BlockCheck {
  const errors: string[] = [];
  if (source.length > ARTIFACT_MAX_BLOCK_CHARS) errors.push(`the block is ${source.length} characters; keep it under ${ARTIFACT_MAX_BLOCK_CHARS}`);
  const parsed = parseHtml(source.trim());
  errors.push(...parsed.errors);
  const classes = new Set<string>(), sources = new Set<string>();
  const claims: BlockClaim[] = [];
  let title = "";
  const tabs: Array<{ triggers: string[]; contents: string[] }> = [];
  const walk = (nodes: HtmlNode[], slots: string[]) => {
    for (const node of nodes) {
      if (node.type === "text") continue;
      const { tag } = node;
      if (!ELEMENTS.has(tag)) { errors.push(`<${tag}> is not allowed${tag === "svg" || tag === "img" ? "; charts come from add_chart and are placed with <figure data-chart=\"id\"></figure>" : tag === "script" || tag === "style" ? "; interaction and styling come from the components and classes" : ""}`); continue; }
      const allowed = new Set([...(ARTIFACT_ATTRIBUTES["*"] ?? []), ...(ARTIFACT_ATTRIBUTES[tag] ?? [])]);
      for (const [name, value] of node.attrs) {
        if (!allowed.has(name)) { errors.push(`<${tag} ${name}>: attribute not allowed${name === "style" ? "; use classes" : name.startsWith("on") ? "" : name.startsWith("aria-") ? "; the component script sets ARIA attributes" : ""}`); continue; }
        if (name === "class") for (const cls of value.split(/\s+/).filter(Boolean)) { const problem = classProblems(cls); if (problem) errors.push(problem); else classes.add(cls); }
      }
      const slot = attr(node, "data-slot");
      if (slot !== undefined) {
        const spec = ARTIFACT_SLOTS[slot];
        if (!spec) errors.push(`data-slot="${slot}" is not an artifact component`);
        else if (spec.parent && !slots.includes(spec.parent)) errors.push(`data-slot="${slot}" must sit inside data-slot="${spec.parent}"`);
      }
      if (tag === "a") {
        const ref = attr(node, "data-source");
        if (!ref) errors.push(`<a> needs data-source="<source id>"; the link is filled from the registered source`);
        else {
          const url = ctx.sourceUrl(ref);
          if (url === undefined) errors.push(`<a data-source="${ref}">: no such source in this run`);
          else if (url === null) errors.push(`<a data-source="${ref}">: this source has no public link; cite it without <a>`);
          else { node.attrs = node.attrs.filter(([k]) => k !== "href"); node.attrs.unshift(["href", url]); sources.add(ref); }
        }
      }
      for (const key of ["data-source"] as const) {
        const ref = attr(node, key);
        if (ref && tag !== "a") { if (ctx.sourceUrl(ref) === undefined) errors.push(`<${tag} data-source="${ref}">: no such source in this run`); else sources.add(ref); }
      }
      if (tag === "data") {
        const raw = attr(node, "value"), ref = attr(node, "data-ref");
        const value = raw === undefined ? NaN : Number(raw);
        if (!Number.isFinite(value)) errors.push(`<data> needs a numeric value="…"`);
        else if (!ref) errors.push(`<data value="${raw}"> needs data-ref naming the figure or source it was read from`);
        else if (ctx.sourceUrl(ref) === undefined) errors.push(`<data data-ref="${ref}">: no such source in this run`);
        else { sources.add(ref); claims.push({ kind: "figure", ref, value, shown: nodeText(node.children).trim() }); }
      }
      if (tag === "blockquote") {
        const ref = attr(node, "data-source");
        if (!ref) errors.push(`<blockquote> needs data-source; a quote is checked against its source`);
        else claims.push({ kind: "quote", source: ref, text: nodeText(node.children).replace(/\s+/g, " ").trim() });
      }
      if (tag === "figure" && attr(node, "data-chart") !== undefined) {
        const id = attr(node, "data-chart")!;
        if (!ctx.charts.has(id)) errors.push(`<figure data-chart="${id}">: no chart with this id; call add_chart first`);
        if (node.children.some(c => c.type === "element" || c.text.trim())) errors.push(`<figure data-chart="${id}"> stays empty; the harness draws the chart into it`);
        node.attrs = node.attrs.filter(([k]) => k !== "data-slot"); node.attrs.push(["data-slot", "chart"]);
      }
      if ((tag === "span" || tag === "abbr") && attr(node, "data-content") !== undefined && slot !== "tooltip" && slot !== "hover-card") errors.push(`<${tag} data-content> is a tooltip only with data-slot="tooltip"`);
      if (!title && (tag === "h2" || tag === "h3")) title = nodeText(node.children).trim().slice(0, 120);
      if (slot === "tabs") tabs.push({ triggers: [], contents: [] });
      if (slot === "tabs-trigger") tabs.at(-1)?.triggers.push(attr(node, "data-value") ?? "");
      if (slot === "tabs-content") tabs.at(-1)?.contents.push(attr(node, "data-value") ?? "");
      walk(node.children, slot ? [...slots, slot] : slots);
    }
  };
  walk(parsed.nodes, []);
  for (const t of tabs) {
    if (!t.triggers.length || t.triggers.some(v => !v) || t.contents.some(v => !v)) errors.push(`tabs: every tabs-trigger and tabs-content needs data-value`);
    else if (t.triggers.join() !== t.contents.join()) errors.push(`tabs: triggers (${t.triggers.join(", ")}) and contents (${t.contents.join(", ")}) must match one to one, in order`);
  }
  return { html: serializeHtml(parsed.nodes), classes: [...classes], sources: [...sources], claims, errors: [...new Set(errors)].slice(0, 20), text: nodeText(parsed.nodes).replace(/\n{3,}/g, "\n\n").trim(), title };
}

/** Whether a figure appears in a text: the same digits, or the same amount in thousands, millions or billions. */
export function figureInText(value: number, text: string): boolean {
  const numbers = (text.match(/-?\(?\d[\d,]*(?:\.\d+)?\)?/g) ?? []).map(s => Number(s.replace(/[(),]/g, "")) * (s.startsWith("(") ? -1 : 1)).filter(Number.isFinite);
  const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 5e-4);
  return numbers.some(n => [1, 1e3, 1e6, 1e9, 1e-3, 1e-6, 1e-9].some(scale => close(Math.abs(value), Math.abs(n) * scale)));
}

/** Whether a quote appears in a text once both are folded to single spaces and plain quotes. */
export function quoteInText(quote: string, text: string): boolean {
  const fold = (s: string) => s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
  const q = fold(quote);
  return q.length >= 12 && fold(text).includes(q);
}
