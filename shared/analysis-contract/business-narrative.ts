import type { ExplainerClaim, ExplainerSource } from "./business-explainer.ts";
import type { FindingCompare, FindingRef, FindingSpan } from "./findings.ts";

/**
 * The company's story told business by business, hung on the same disclosed businesses the flow
 * draws. For each business: where it stands commercially, what it can do, what has been delivered
 * and what is promised, who pays and who buys, how it compares with the other ways a customer could
 * meet the same need, where it shows in the statements, and what would prove or break the thesis.
 *
 * Amounts in milestones, parties and evidence are contract terms quoted from filings and
 * announcements. A tie or a check never carries an amount: the page resolves its figure from the
 * published statements at read time and shows that, so the prose cannot go stale.
 */

/** Where a business stands commercially. A fixed vocabulary, never the model's to name. */
export const NARRATIVE_STAGES = ["concept", "pilot", "scaling", "established", "contracting"] as const;
export type NarrativeStage = (typeof NARRATIVE_STAGES)[number];
export const STAGE_LABEL: Record<NarrativeStage, string> = { concept: "概念", pilot: "示范", scaling: "规模化", established: "成熟", contracting: "收缩" };

/** How far a claim about the future has been borne out; shared by chain links, checks and milestones. */
export const NARRATIVE_STATUSES = ["confirmed", "in_progress", "unknown", "failed"] as const;
export type NarrativeStatus = (typeof NARRATIVE_STATUSES)[number];
export const STATUS_LABEL: Record<NarrativeStatus, string> = { confirmed: "已证实", in_progress: "进行中", unknown: "未知", failed: "失效" };

export const MILESTONE_STATES = ["done", "planned", "delayed"] as const;
export type MilestoneState = (typeof MILESTONE_STATES)[number];
/** A dated step in the business's commercialisation: a contract, a listing, a facility, a product generation. */
export type NarrativeMilestone = {
  id: string;
  /** `YYYY-MM-DD` or `YYYY-MM`; a planned step may name only the month or half it is expected in. */
  date: string;
  /** At most 28 characters. */
  label: string;
  state: MilestoneState;
  /** For a delayed step, the date it was first expected on. */
  originalDate?: string | null;
  claim: ExplainerClaim;
};

export const PARTY_ROLES = ["funder", "customer", "partner", "supplier"] as const;
export type PartyRole = (typeof PARTY_ROLES)[number];
export const ROLE_LABEL: Record<PartyRole, string> = { funder: "出资方", customer: "客户", partner: "合作方", supplier: "供应商" };
/** Who puts money in, who buys, who builds with the company, who it depends on. */
export type NarrativeParty = { name: string; role: PartyRole; claim: ExplainerClaim };

export const NARRATIVE_GRADES = ["better", "similar", "worse", "unknown"] as const;
export type NarrativeGrade = (typeof NARRATIVE_GRADES)[number];
export const GRADE_LABEL: Record<NarrativeGrade, string> = { better: "占优", similar: "相当", worse: "落后", unknown: "未比较" };
/** One cell of the comparison: how this option fares on one dimension, and the material that says so. */
export type NarrativeCell = { grade: NarrativeGrade; claim: ExplainerClaim };
export type NarrativeAlternative = { id: string; name: string; cells: NarrativeCell[] };
/**
 * The same customer need met different ways. `self` grades this business on each dimension;
 * each alternative is graded on the same dimensions in the same order. A cell nothing in the
 * material compares is `unknown`, shown as such rather than left out.
 */
export type NarrativeComparison = { need: string; dimensions: string[]; self: NarrativeCell[]; alternatives: NarrativeAlternative[] };

/** A statement figure and what it means for this business; the figure is resolved on the page. */
export type NarrativeTie = { ref: FindingRef; span: FindingSpan; compare?: FindingCompare; label?: string; meaning: string };

/**
 * What would prove or break a link of the thesis. Bound to a figure where one exists, so the page
 * shows the latest value beside the condition; `status` is the author's reading of it.
 */
export type NarrativeCheck = { id: string; condition: string; status: NarrativeStatus; ref?: FindingRef; span?: FindingSpan; compare?: FindingCompare; claim?: ExplainerClaim | null };

/**
 * A figure the page draws for a business or the company. The model decomposes; code renders. A
 * stack groups what the business is made of into layers from the physical or lowest to the
 * customer-facing or highest, naming each item exactly as the capability (for a business) or the
 * business (for the company) it stands for; a ladder charts operating metrics by key, pairing
 * what is in use with what is contracted or targeted. Nothing in a figure is a number.
 */
export type NarrativeFigure =
  | { type: "stack"; title: string; layers: Array<{ name: string; items: string[] }>; meaning: string }
  | { type: "ladder"; title: string; tracks: Array<{ metricKey: string; role: "actual" | "contracted" | "target" }>; meaning: string };

/**
 * What the stage leads with for a business or the company, and what sits under it. The model
 * judges whether the statement flow is the point (then the Sankey leads), or the build-out, the
 * make-up or the financing is; `reason` says why in one sentence, shown beside the choice. The
 * reader can still switch, and a panel the data cannot draw falls back to the flow.
 */
export type PanelRef = { kind: "flow" } | { kind: "cash" } | { kind: "balance" } | { kind: "revenue_trend" } | { kind: "figure"; index: number };
export type PanelPlan = { lead: PanelRef; below: PanelRef | null; reason: string };

/** One link of the thesis: the premise, how far the material bears it out, and what would break it. */
export type NarrativeLink = { id: string; premise: string; status: NarrativeStatus; evidence: ExplainerClaim[]; failure: string; checkIds: string[] };

export type BusinessNarrative = {
  /** A flow node id (segment or revenue node) when the statements split this business out; otherwise an id of its own. */
  nodeId: string;
  name: string;
  /** For a business the statements do not split out, the flow node its revenue sits inside. */
  parentNodeId?: string | null;
  stage: NarrativeStage;
  stageClaim: ExplainerClaim;
  /** One sentence, no figures: the reading of this business right now. */
  verdict: string;
  /** The figure the rail shows for this business when revenue is not split out, e.g. remaining performance obligations. */
  anchor?: { ref: FindingRef; span: FindingSpan; label: string } | null;
  capabilities: Array<{ label: string | null; claim: ExplainerClaim }>;
  milestones: NarrativeMilestone[];
  parties: NarrativeParty[];
  comparison?: NarrativeComparison | null;
  ties: NarrativeTie[];
  chain: NarrativeLink[];
  checks: NarrativeCheck[];
  figures?: NarrativeFigure[];
  layout?: PanelPlan | null;
};

export type CompanyNarrative = {
  schemaVersion: "business-narrative.v1";
  ticker: string;
  companyName: string;
  /** The report the narrative was written from; checks resolve at this period. */
  periodEnd: string;
  generatedAt: string;
  /** Model name, or "authored" for a human-written set. */
  model: string;
  fingerprint?: string;
  positioning: ExplainerClaim;
  stage: NarrativeStage;
  stageClaim: ExplainerClaim;
  verdict: string;
  /** Where the company sits in its industry: who it competes with and who it depends on. */
  industry: ExplainerClaim;
  chain: NarrativeLink[];
  checks: NarrativeCheck[];
  figures?: NarrativeFigure[];
  layout?: PanelPlan | null;
  businesses: BusinessNarrative[];
  sources: ExplainerSource[];
};

export type NarrativeResponse = {
  schemaVersion: "business-narrative-response.v1";
  status: "ready" | "preparing";
  narrative: CompanyNarrative | null;
};
