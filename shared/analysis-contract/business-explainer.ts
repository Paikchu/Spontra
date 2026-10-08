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
  /** Short verbatim source passage linking this product to this disclosed business. */
  membership?: ExplainerClaim;
  /** Null means the evidence does not establish the charging model. */
  charging: ExplainerClaim | null;
  sourceIds: string[];
};
/** What a section explains; the harness allows each kind once, except `other`. */
export const SECTION_KINDS = ["delivery", "customers", "monetization", "lifecycle", "channel", "economics", "relation", "other"] as const;
export type ExplainerSectionKind = typeof SECTION_KINDS[number];
/** `steps` is an ordered chain (sign, deploy, renew…); `list` is parallel named entries; `prose` is plain statements. */
export type ExplainerSectionLayout = "prose" | "steps" | "list";
export type ExplainerSectionItem = { label: string | null; claim: ExplainerClaim };
/** One model-chosen angle on how this business operates, e.g. a license-then-support renewal chain. */
export type ExplainerSection = { id: string; kind: ExplainerSectionKind; title: string; layout: ExplainerSectionLayout; items: ExplainerSectionItem[] };
export type BusinessExplanation = {
  /** Same id as the flow's segment or revenue node, e.g. `SoftwareLicense`. */
  nodeId: string;
  name: string;
  /** What this business is, in one or two sentences. */
  summary: ExplainerClaim;
  /** Product names as written in the cited material. */
  products: string[];
  offerings?: ProductOffering[];
  /** The angles this business is best explained from, in reading order; chosen per business, not fixed. */
  sections: ExplainerSection[];
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
