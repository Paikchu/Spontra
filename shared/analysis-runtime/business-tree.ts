import { z } from "zod";
import { REVENUE_MODEL_TYPES, type BusinessTree, type TreeBranch, type TreeClaim, type TreeNode, type TreeRevenueModel } from "../analysis-contract/business-tree.ts";
import { completeProductName, FIGURE } from "./business-explainer.ts";

/** Caps shared by the agent's harness and the reader, so a stored tree always reads back as it was written. */
export const TREE_LIMITS = { branches: 8, children: 10, nodes: 40, depth: 3, revenue: 3, name: 80, gloss: 14, summary: 160, label: 10, revenueText: 100, anchor: 600 } as const;
export const REVENUE_LABEL: Record<TreeRevenueModel["type"], string> = {
  subscription: "订阅", consumption: "按用量计费", license: "授权许可", transaction: "交易抽成", advertising: "广告", hardware: "硬件销售", services: "服务收费", other: "其他收入",
};

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
 * proves the product exists does not put it in this business.
 */
export function anchors(name: string, ancestors: string[], passage: string): boolean {
  if (!completeProductName(name, passage)) return false;
  const quote = compactName(passage), own = compactName(name);
  return ancestors.some(a => { const key = compactName(a); return key.length >= 2 && key !== own && quote.includes(key); });
}

/** A short line of prose a reader sees on the map: no amounts or shares, within its cap. */
export const plainText = (value: string, max: number) => length(value) <= max && !FIGURE.test(value);

const https = z.string().max(2000).refine(v => { try { const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password; } catch { return false; } });
const text = (max: number) => z.string().trim().min(1).max(max);
const claim = z.object({ text: text(600), sourceIds: z.array(z.string().max(40)).min(1).max(6) });
const revenue = z.object({ type: z.enum(REVENUE_MODEL_TYPES), label: text(40), text: text(300), sourceIds: z.array(z.string().max(40)).min(1).max(6) });
const nodeShape = z.object({
  id: text(60), name: text(TREE_LIMITS.name), gloss: z.string().trim().max(40).nullable(), kind: z.enum(["line", "product"]),
  flowNodeId: z.string().max(200).nullable(), summary: claim.nullable(), anchor: claim.nullable(),
  revenue: z.array(revenue).max(6), children: z.array(z.unknown()).max(TREE_LIMITS.children * 2),
});
const step = z.object({ thought: z.string().max(2000), action: z.string().max(40), input: z.string().max(2000), observation: z.string().max(4000) });
const treeShape = z.object({
  schemaVersion: z.literal("business-tree.v1"),
  ticker: z.string().regex(/^[A-Z][A-Z0-9.-]{0,11}$/),
  companyName: text(200), generatedAt: z.string().max(40), model: text(80), fingerprint: text(128), periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  branches: z.array(z.object({ flowNodeId: text(200), name: text(200), summary: claim.nullable(), children: z.array(z.unknown()).max(TREE_LIMITS.children * 2) })).min(1).max(TREE_LIMITS.branches),
  sources: z.array(z.object({ id: text(40), title: text(300), url: https, kind: z.enum(["sec", "web"]), publishedAt: z.string().max(40).nullable() })).min(1).max(120),
  research: z.array(z.object({ flowNodeId: text(200), steps: z.array(step).max(60) })).max(TREE_LIMITS.branches).optional(),
});

/** Names a node may cite as its parent: the chain up to the business, and the company when it discloses only one business. */
export type AncestorChain = string[];

/**
 * Keeps what a node may show: cited prose without figures, revenue models with a known type, and the
 * anchor rule. A node that fails is removed with everything under it; one that passes keeps only
 * children that pass. Ids stay unique and the per-branch node cap holds.
 */
export function harnessNode(raw: unknown, ancestors: AncestorChain, depth: number, sourceIds: Set<string>, budget: { nodes: number; ids: Set<string> }): TreeNode | null {
  const parsed = nodeShape.safeParse(raw);
  if (!parsed.success || depth > TREE_LIMITS.depth || budget.nodes <= 0 || budget.ids.has(parsed.data.id)) return null;
  const node = parsed.data;
  const cited = (c: TreeClaim | null) => c && c.sourceIds.every(id => sourceIds.has(id)) ? { text: c.text, sourceIds: [...new Set(c.sourceIds)] } : null;
  const anchor = cited(node.anchor);
  if (!node.flowNodeId && !(anchor && length(anchor.text) <= TREE_LIMITS.anchor && anchors(node.name, ancestors, anchor.text))) return null;
  budget.nodes--; budget.ids.add(node.id);
  const summary = cited(node.summary);
  const seen = new Set<string>();
  const models = node.revenue.filter(r => r.sourceIds.every(id => sourceIds.has(id)) && plainText(r.label, TREE_LIMITS.label) && plainText(r.text, TREE_LIMITS.revenueText) && !seen.has(r.type + r.label) && seen.add(r.type + r.label))
    .slice(0, TREE_LIMITS.revenue).map(r => ({ type: r.type, label: r.label, text: r.text, sourceIds: [...new Set(r.sourceIds)] }));
  const names = new Set<string>();
  const children = node.children.flatMap(child => {
    const kept = harnessNode(child, [node.name, ...ancestors], depth + 1, sourceIds, budget);
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
  return [...new Set([branch.name, businessHint(branch.flowNodeId, branch.name), ...(single ? [companyName, companyName.replace(/\b(Inc|Corp|Corporation|Ltd|Holdings|Co|Company|PLC|N\.V)\.?$/i, "").trim()] : [])])];
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
  const single = tree.branches.length === 1;
  const branches: TreeBranch[] = tree.branches.flatMap(branch => {
    const budget = { nodes: TREE_LIMITS.nodes, ids: new Set<string>() };
    const ancestors = branchAncestors(branch, tree.companyName, single);
    const names = new Set<string>();
    const children = branch.children.flatMap(child => {
      const kept = harnessNode(child, ancestors, 1, ids, budget);
      if (!kept || names.has(compactName(kept.name))) return [];
      names.add(compactName(kept.name));
      return [kept];
    }).slice(0, TREE_LIMITS.children);
    const summary = branch.summary && branch.summary.sourceIds.every(id => ids.has(id)) && plainText(branch.summary.text, TREE_LIMITS.summary) ? branch.summary : null;
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
