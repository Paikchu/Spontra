/**
 * A company's businesses broken down from the statement's own segments: each disclosed business
 * into the product lines and products it sells, and each of those into how it earns money. A ReAct
 * agent researches one business at a time (search, read, add, revise) from pages fetched in the
 * same run. Every node is anchored by a verbatim passage that names it together with its parent, so
 * a product cannot be hung under a business the material does not put it in. No amounts: revenue
 * and its changes stay in the SEC flow the tree is attached to.
 */
export type TreeSource = { id: string; title: string; url: string; kind: "sec" | "web"; publishedAt: string | null };
/** One statement and the fetched sources that support it. */
export type TreeClaim = { text: string; sourceIds: string[] };
export const REVENUE_MODEL_TYPES = ["subscription", "consumption", "license", "transaction", "advertising", "hardware", "services", "other"] as const;
export type RevenueModelType = typeof REVENUE_MODEL_TYPES[number];
/** How a line or product earns money: a short label for the map (e.g. 按用量计费) and one cited sentence. */
export type TreeRevenueModel = { type: RevenueModelType; label: string; text: string; sourceIds: string[] };
export type TreeNode = {
  id: string;
  /** As the material writes it, e.g. `Azure`, `Microsoft 365 Copilot`. */
  name: string;
  /** A few Chinese words saying what it is, e.g. 公有云平台. */
  gloss: string | null;
  kind: "line" | "product";
  /** The flow node this line is, when the statement itself discloses it; the map attaches the branch there. */
  flowNodeId: string | null;
  summary: TreeClaim | null;
  /** Verbatim passage naming this node together with its parent or another ancestor; null only for a node the statement discloses. */
  anchor: TreeClaim | null;
  revenue: TreeRevenueModel[];
  children: TreeNode[];
};
/** One disclosed business, as the flow names it, and what it breaks down into. */
export type TreeBranch = { flowNodeId: string; name: string; summary: TreeClaim | null; children: TreeNode[] };
/** One turn of the agent: what it thought, what it did, and what the harness answered. */
export type TreeStep = { thought: string; action: string; input: string; observation: string };
export type BusinessTree = {
  schemaVersion: "business-tree.v1";
  ticker: string;
  companyName: string;
  generatedAt: string;
  model: string;
  /** Hash of the business list and prompt version the tree was researched for. */
  fingerprint: string;
  /** The quarter whose disclosed businesses the branches are. */
  periodEnd: string;
  branches: TreeBranch[];
  sources: TreeSource[];
  /** The agent's turns per branch, for the operator; the public map strips them. */
  research?: Array<{ flowNodeId: string; steps: TreeStep[] }>;
};
export type BusinessTreeResponse = {
  schemaVersion: "business-tree-response.v1";
  status: "ready" | "preparing";
  tree: BusinessTree | null;
};
