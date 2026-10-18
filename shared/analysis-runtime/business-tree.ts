import { z } from "zod";
import { REVENUE_MODEL_TYPES, type BusinessTree, type TreeBranch, type TreeClaim, type TreeNode, type TreeRevenueModel } from "../analysis-contract/business-tree.ts";
import { completeProductName, FIGURE } from "./business-explainer.ts";
import type { Locale } from "./locale.ts";

/**
 * Caps shared by the agent's harness and the reader, so a stored tree always reads back as it was written.
 * Text caps are characters of English prose: `gloss` and `label` are a few words, the rest a sentence or two.
 */
export const TREE_LIMITS = { branches: 8, children: 10, nodes: 40, depth: 3, revenue: 3, name: 80, gloss: 40, summary: 400, label: 32, revenueText: 240, anchor: 600 } as const;
export const REVENUE_LABEL: Record<TreeRevenueModel["type"], string> = {
  subscription: "Subscription", consumption: "Usage-based", license: "License", transaction: "Transaction fees", advertising: "Advertising", hardware: "Hardware sales", services: "Service fees", other: "Other revenue",
};
const REVENUE_LABEL_ZH: Record<TreeRevenueModel["type"], string> = {
  subscription: "订阅", consumption: "按用量计费", license: "授权许可", transaction: "交易费", advertising: "广告", hardware: "硬件销售", services: "服务费", other: "其他收入",
};
/** A revenue model's type as the reader's locale names it; English is `REVENUE_LABEL`. */
export const revenueLabel = (type: TreeRevenueModel["type"], locale: Locale = "en") => (locale === "zh-CN" ? REVENUE_LABEL_ZH : REVENUE_LABEL)[type];

/** Letters and digits only, with `&` read as `and`, so `Compute & Networking` and `ComputeAndNetworking` are one name. */
export const compactName = (value: string) => value.normalize("NFKC").toLowerCase().replace(/&/g, "and").replace(/[^\p{L}\p{N}]+/gu, "");
const length = (value: string) => [...value].length;

/** Readable English words for a disclosed business: `msft:IntelligentCloudMember` → `Intelligent Cloud`. */
export function businessHint(id: string, name: string): string {
  const raw = /\s/.test(name.trim()) ? name.trim() : (/^[A-Za-z0-9&]+$/.test(name) ? name : id.replace(/^[^:]*:/, ""));
  const words = raw.replace(/(Segment)?Member$/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return words || name;
}

/**
 * The membership rule every node passes, when the agent adds it and whenever the tree is read: its
 * anchor passage names the node in full and names its parent or another ancestor. A passage that only
 * proves the product exists does not put it in this business. `issuer` lists the company's names when
 * the passage comes from the company's own filing, which is about the company throughout: there "Our
 * SASE platform" puts the line in the company, which is the business when it discloses only one.
 */
export function anchors(name: string, ancestors: string[], passage: string, issuer: string[] = []): boolean {
  return namedIn(name, passage) && namesAncestor(name, ancestors, passage, issuer);
}

/** Whether the passage names the node's parent or another ancestor, as `anchors` reads it. */
export function namesAncestor(name: string, ancestors: string[], passage: string, issuer: string[] = []): boolean {
  const quote = compactName(passage), own = compactName(name);
  return ancestors.some(a => { const key = compactName(a); return key.length >= 2 && key !== own && (quote.includes(key) || issuer.includes(a)); });
}

/**
 * Whether a passage names `name` in full: as written, or as one member of a phrase whose members share their last word,
 * as filings list lines ("online and physical stores" names Online stores; "advertising and subscription services" names
 * Advertising services; "compute, storage, and database services" names Storage services).
 */
export function namedIn(name: string, passage: string): boolean {
  if (completeProductName(name, passage)) return true;
  const words = name.normalize("NFKC").toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lead = words.slice(0, -1).map(escape).join("\\s+"), head = escape(words.at(-1)!);
  const member = "[\\p{L}\\p{N}'-]+(?:\\s+[\\p{L}\\p{N}'-]+){0,2}";
  const edge = "(?<![\\p{L}\\p{N}])", end = "(?![\\p{L}\\p{N}])";
  // The node's own words open a list (or sit inside one) whose last member carries the shared word.
  const listed = new RegExp(`${edge}${lead}(?:\\s*,\\s*${member})*\\s*,?\\s+(?:and|or)\\s+${member}\\s+${head}${end}`, "u");
  return listed.test(passage.normalize("NFKC").toLowerCase().replace(/\s+/g, " "));
}

const GENERIC_HEAD = /\s+(?:services|solutions|products|offerings|businesses|business|platforms|platform)$/i;
/**
 * The words a product's passage may use for a line the agent named after a category: "advertising" for Advertising
 * services, either side of "Artificial intelligence and machine learning". A business the filing discloses keeps its
 * full name, and a line whose last word carries the meaning ("Online stores") has no shorter form.
 */
export function lineAliases(name: string): string[] {
  const core = name.replace(GENERIC_HEAD, "").trim();
  const parts = [core, ...core.split(/\s*(?:,|&|\band\b)\s*/i)].map(p => p.trim()).filter(p => compactName(p).length >= 4 && compactName(p) !== compactName(name));
  return [...new Set(parts)];
}

/** A product is named as the company sells it, with a capital or a digit (Sponsored Products, iPhone, S3); "sponsored ads" describes one. */
export const properName = (name: string) => /[\p{Lu}\p{N}]/u.test(name);

/** An anchor may join up to three verbatim fragments of one passage with an ellipsis, e.g. a segment's heading and one item of the list under it. */
export const ANCHOR_FRAGMENTS = 3;
const ELLIPSIS = /\s*(?:…|\.{3})\s*/;

/** A Markdown table row, as the filing library and page extracts write tables. */
const TABLE_ROW = /\|.*\|/;

/**
 * Whether a quote stands in a source: every fragment verbatim (letters and digits compared), in order, the whole quote
 * within `span` characters of the source, so fragments of one passage join and fragments of different pages do not.
 * Joined fragments stand for one passage of prose: a table (a company-wide revenue table, say) cannot supply one, since a
 * row of it says nothing about which segment the line sits in.
 */
export function quotedIn(quote: string, source: string, span = 2_400): boolean {
  return quoteProblem(quote, source, span) === null;
}

/** Why a quote does not stand in a source, in words the agent can act on; null when it does. */
export function quoteProblem(quote: string, source: string, span = 2_400): string | null {
  const parts = quote.split(ELLIPSIS).map(p => p.trim()).filter(p => compactName(p));
  const fragments = parts.map(compactName);
  if (!fragments.length) return "the quote is empty";
  if (fragments.length > ANCHOR_FRAGMENTS) return `it joins more than ${ANCHOR_FRAGMENTS} fragments`;
  if (fragments.length > 1 && fragments.some(f => f.length < 10)) return "a joined fragment is too short to place in the source";
  const text = compactName(fragments.length > 1 ? source.split("\n").filter(line => !TABLE_ROW.test(line)).join("\n") : source);
  const missing = parts.findIndex((_, i) => !text.includes(fragments[i]!));
  if (missing >= 0) return `"${parts[missing]!.slice(0, 80)}" is not in the source word for word${fragments.length > 1 ? " (outside its tables)" : ""}`;
  for (let start = text.indexOf(fragments[0]!); start >= 0; start = text.indexOf(fragments[0]!, start + 1)) {
    let end = start + fragments[0]!.length, ok = true;
    for (const fragment of fragments.slice(1)) {
      const at = text.indexOf(fragment, end);
      if (at < 0 || at + fragment.length - start > span) { ok = false; break; }
      end = at + fragment.length;
    }
    if (ok) return null;
  }
  return "its fragments are not one passage: they must appear in this order, close together";
}

/** Source ids a model wrote into prose ("(Source: s1, s6)", "[b1-s2]") belong in sourceIds, not in the text a reader sees. */
export function withoutCitations(text: string): string {
  return text
    .replace(/\s*[(（[]?\s*(?:sources?|cited|来源)\s*[:：]?\s*(?:b\d+-)?s\d+(?:\s*(?:[,，、;；]|and)\s*(?:b\d+-)?s\d+)*\s*[)）\]]?/gi, "")
    .replace(/\s*[[(（]\s*(?:b\d+-)?s\d+(?:\s*[,，、]\s*(?:b\d+-)?s\d+)*\s*[\])）]/g, "")
    .replace(/\s+([.,;:。，；：])/g, "$1").replace(/([.。])[.。]+/g, "$1").replace(/\s{2,}/g, " ").trim();
}

/** A short line of prose a reader sees on the map: no amounts or shares, within its cap. */
export const plainText = (value: string, max: number) => length(value) <= max && !FIGURE.test(value);

const https = z.string().max(2000).refine(v => { try { const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password; } catch { return false; } });
const text = (max: number) => z.string().trim().min(1).max(max);
const claim = z.object({ text: text(600), sourceIds: z.array(z.string().max(40)).min(1).max(6) });
const revenue = z.object({ type: z.enum(REVENUE_MODEL_TYPES), label: text(TREE_LIMITS.label * 2), text: text(TREE_LIMITS.revenueText * 2), sourceIds: z.array(z.string().max(40)).min(1).max(6) });
const nodeShape = z.object({
  id: text(60), name: text(TREE_LIMITS.name), gloss: z.string().trim().max(TREE_LIMITS.gloss * 2).nullable(), kind: z.enum(["line", "product"]),
  flowNodeId: z.string().max(200).nullable(), summary: claim.nullable(), anchor: claim.nullable(),
  revenue: z.array(revenue).max(6), children: z.array(z.unknown()).max(TREE_LIMITS.children * 2),
});
const step = z.object({ thought: z.string().max(2000), action: z.string().max(40), input: z.string().max(2000), observation: z.string().max(4000) });
const treeShape = z.object({
  schemaVersion: z.literal("business-tree.v1"),
  ticker: z.string().regex(/^[A-Z][A-Z0-9.-]{0,11}$/),
  companyName: text(200), generatedAt: z.string().max(40), model: text(80), fingerprint: text(128), periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  branches: z.array(z.object({ flowNodeId: text(200), name: text(200), summary: claim.nullable(), children: z.array(z.unknown()).max(TREE_LIMITS.children * 2) })).min(1).max(TREE_LIMITS.branches),
  sources: z.array(z.object({ id: text(40), title: text(300), url: https, kind: z.enum(["sec", "web"]), publishedAt: z.string().max(40).nullable(), own: z.boolean().optional() })).min(1).max(120),
  research: z.array(z.object({ flowNodeId: text(200), steps: z.array(step).max(60) })).max(TREE_LIMITS.branches).optional(),
});

/** Names a node may cite as its parent: the chain up to the business, and the company when it discloses only one business. */
export type AncestorChain = string[];
/** The company's names, and the sources that are its own filings, whose passages name it throughout. */
export type Issuer = { names: string[]; sources: Set<string> };

/**
 * Keeps what a node may show: cited prose without figures, revenue models with a known type, and the
 * anchor rule. A node that fails is removed with everything under it; one that passes keeps only
 * children that pass. Ids stay unique and the per-branch node cap holds.
 */
export function harnessNode(raw: unknown, ancestors: AncestorChain, depth: number, sourceIds: Set<string>, budget: { nodes: number; ids: Set<string> }, issuer: Issuer = { names: [], sources: new Set() }): TreeNode | null {
  const parsed = nodeShape.safeParse(raw);
  if (!parsed.success || depth > TREE_LIMITS.depth || budget.nodes <= 0 || budget.ids.has(parsed.data.id)) return null;
  const node = parsed.data;
  const cited = (c: TreeClaim | null) => c && c.sourceIds.every(id => sourceIds.has(id)) ? { text: c.text, sourceIds: [...new Set(c.sourceIds)] } : null;
  const prose = (c: TreeClaim | null) => c && withoutCitations(c.text) ? { ...c, text: withoutCitations(c.text) } : null;
  const anchor = cited(node.anchor);
  if (!node.flowNodeId && !(anchor && length(anchor.text) <= TREE_LIMITS.anchor && anchors(node.name, ancestors, anchor.text, anchor.sourceIds.some(id => issuer.sources.has(id)) ? issuer.names : []))) return null;
  if (!node.flowNodeId && node.kind === "product" && !properName(node.name)) return null;
  budget.nodes--; budget.ids.add(node.id);
  const summary = prose(cited(node.summary));
  const seen = new Set<string>();
  const models = node.revenue.filter(r => r.sourceIds.every(id => sourceIds.has(id)) && plainText(r.label, TREE_LIMITS.label) && plainText(r.text, TREE_LIMITS.revenueText) && !seen.has(r.type + r.label) && seen.add(r.type + r.label))
    .slice(0, TREE_LIMITS.revenue).map(r => ({ type: r.type, label: r.label, text: withoutCitations(r.text) || r.text, sourceIds: [...new Set(r.sourceIds)] }));
  const names = new Set<string>();
  const children = node.children.flatMap(child => {
    const kept = harnessNode(child, [node.name, ...(node.flowNodeId ? [] : lineAliases(node.name)), ...ancestors], depth + 1, sourceIds, budget, issuer);
    if (!kept || names.has(compactName(kept.name))) return [];
    names.add(compactName(kept.name));
    return [kept];
  }).slice(0, TREE_LIMITS.children);
  return {
    id: node.id, name: node.name, kind: node.kind, flowNodeId: node.flowNodeId,
    gloss: node.gloss && plainText(node.gloss, TREE_LIMITS.gloss) ? node.gloss : null,
    summary: summary && plainText(summary.text, TREE_LIMITS.summary) ? summary : null,
    anchor: node.flowNodeId ? null : anchor, revenue: models, children,
  };
}

/** The names a branch's top-level nodes may cite as their parent. */
export function branchAncestors(branch: { flowNodeId: string; name: string }, companyName: string, single: boolean): AncestorChain {
  return [...new Set([branch.name, businessHint(branch.flowNodeId, branch.name), ...(single ? issuerNames(companyName) : [])])];
}

const SHARE_CLASS = /\s*(?:[-–—,]\s*)?(?:Class [A-Z]\b.*|(?:New )?(?:Common|Ordinary|Capital) (?:Stock|Shares)\b.*|American Depositary.*)$/i;
const LEGAL_FORM = /[,\s&]+(?:Inc|Incorporated|Corp|Corporation|Ltd|Limited|Holdings|Co|Company|PLC|N\.?V|S\.?A|AG|SE|LLC|L\.?P|Group)\.?$/i;
/**
 * The names filings use for the issuer, from its listing title: `Cloudflare, Inc. Class A Common Stock` gives
 * `Cloudflare, Inc.` and `Cloudflare`. A listing title itself never appears in a filing's prose.
 */
export function issuerNames(listing: string): string[] {
  const issuer = listing.replace(SHARE_CLASS, "").trim() || listing.trim();
  const names = [issuer];
  for (let name = issuer, previous = ""; name !== previous;) {
    previous = name;
    name = name.replace(LEGAL_FORM, "").replace(/[,\s&]+$/, "").trim();
    if (name && compactName(name).length >= 2 && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Parses a tree for one ticker. Every node is re-checked by the same harness the agent's writes passed;
 * a branch with nothing left is dropped, and a tree with no branch left is rejected rather than shown empty.
 * `research` is the operator's trace and is kept only when asked for.
 */
export function readBusinessTree(value: unknown, ticker: string, options: { research?: boolean } = {}): BusinessTree | null {
  const parsed = treeShape.safeParse(value);
  if (!parsed.success || parsed.data.ticker !== ticker) return null;
  const tree = parsed.data;
  const ids = new Set(tree.sources.map(s => s.id));
  const issuer: Issuer = { names: issuerNames(tree.companyName), sources: new Set(tree.sources.filter(s => s.own).map(s => s.id)) };
  const single = tree.branches.length === 1;
  const branches: TreeBranch[] = tree.branches.flatMap(branch => {
    const budget = { nodes: TREE_LIMITS.nodes, ids: new Set<string>() };
    const ancestors = branchAncestors(branch, tree.companyName, single);
    const names = new Set<string>();
    const children = branch.children.flatMap(child => {
      const kept = harnessNode(child, ancestors, 1, ids, budget, issuer);
      if (!kept || names.has(compactName(kept.name))) return [];
      names.add(compactName(kept.name));
      return [kept];
    }).slice(0, TREE_LIMITS.children);
    const text = branch.summary ? withoutCitations(branch.summary.text) : "";
    const summary = branch.summary && text && branch.summary.sourceIds.every(id => ids.has(id)) && plainText(text, TREE_LIMITS.summary) ? { ...branch.summary, text } : null;
    return children.some(hasContent) ? [{ flowNodeId: branch.flowNodeId, name: branch.name, summary, children }] : [];
  });
  if (!branches.length) return null;
  const { research, ...rest } = tree;
  return { ...rest, branches, ...(options.research && research ? { research } : {}) };
}

/** A node the statement discloses carries no research of its own until something is found under it. */
export const hasContent = (node: TreeNode): boolean => !node.flowNodeId || node.revenue.length > 0 || node.summary != null || node.children.some(hasContent);

/** The node a flow business is in the tree: a branch's root or a disclosed line under it. */
export function treeNodeFor(tree: BusinessTree, flowNodeId: string): { name: string; summary: TreeClaim | null; revenue: TreeRevenueModel[]; children: TreeNode[] } | null {
  for (const branch of tree.branches) {
    if (branch.flowNodeId === flowNodeId) return { name: branch.name, summary: branch.summary, revenue: [], children: branch.children };
    const stack = [...branch.children];
    while (stack.length) {
      const node = stack.shift()!;
      if (node.flowNodeId === flowNodeId) return node;
      stack.push(...node.children);
    }
  }
  return null;
}
