/**
 * Plain-language explanation of each disclosed business, written by a model from sources fetched
 * in the same run. It never carries amounts: revenue and its changes stay in the SEC flow.
 */
export type ExplainerSource = { id: string; title: string; url: string; kind: "sec" | "web"; publishedAt: string | null };
/** One statement and the fetched sources that support it. */
export type ExplainerClaim = { text: string; sourceIds: string[] };
export type ProductOffering = {
  id: string; name: string; line: string | null;
  description: ExplainerClaim;
  /** Null means the evidence does not establish the charging model. */
  charging: ExplainerClaim | null;
  sourceIds: string[];
};
export type BusinessExplanation = {
  /** Same id as the flow's segment or revenue node, e.g. `SoftwareLicense`. */
  nodeId: string;
  name: string;
  /** What this business is, in one or two sentences. */
  summary: ExplainerClaim;
  /** What is actually delivered and how it works for the customer. */
  howItWorks: ExplainerClaim | null;
  /** Product names as written in the cited material. */
  products: string[];
  offerings?: ProductOffering[];
  customers: ExplainerClaim | null;
  monetization: ExplainerClaim | null;
  /** How it relates to its parent or sibling businesses. */
  relation: ExplainerClaim | null;
};
export type BusinessExplainer = {
  schemaVersion: "business-explainer.v1";
  ticker: string;
  companyName: string;
  generatedAt: string;
  model: string;
  /** Hash of the business list and prompt version the explanations were written for. */
  fingerprint: string;
  businesses: BusinessExplanation[];
  sources: ExplainerSource[];
};
export type BusinessExplainerResponse = {
  schemaVersion: "business-explainer-response.v1";
  status: "ready" | "preparing";
  explainer: BusinessExplainer | null;
};
