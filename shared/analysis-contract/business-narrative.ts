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
 * How the stage is composed for a business, the company or a finding: an ordered list of panels
 * from a fixed catalog, the first on the main slot and the rest stacked beneath. The model judges
 * what the subject needs: the statement flow when revenue and its cost structure are the point, a
 * figure when the build-out or the make-up is, a section of the dossier when the story is in the
 * milestones, the backers, the comparison or the checks. `reason` says why in one sentence and is
 * shown beside the composition. The reader can still switch; a panel the data cannot draw is skipped.
 */
export type PanelRef =
  | { kind: "dossier" }
  | { kind: "flow" } | { kind: "cash" } | { kind: "balance" }
  | { kind: "revenue_trend" } | { kind: "metric"; key: string }
  | { kind: "figure"; index: number }
  | { kind: "timeline" } | { kind: "parties" } | { kind: "comparison" } | { kind: "checks" } | { kind: "chain" };
/**
 * The stage is a two-column grid on wide screens (one column on phones). A panel spans one column
 * (half the width) or both; the plan reads left to right, top to bottom. `dossier` is the subject's
 * own text (positioning, verdict, tabs) and is placed like any other panel; a plan that omits it
 * gets it beside the first panel.
 */
export type PanelSpan = 1 | 2;
export type PlacedPanel = PanelRef & { span?: PanelSpan };
export type PanelPlan = { panels: PlacedPanel[]; reason: string };

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
