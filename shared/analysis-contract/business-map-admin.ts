import type { FinancialMaintenanceCompany, FinancialMaintenanceTask } from './financial-maintenance.ts';
import type { CompleteFlowPublication } from './complete-business-flow.ts';
import type { PublicBusinessFlow } from './business-flow.ts';
import type { PublicCapitalStructure } from './capital-structure.ts';
import type { Feature } from './business-features.ts';
import type { AiRunKind, AiRunStep } from './ai-runs-admin.ts';
/**
 * How far one run in flight got: a report job's stage (`report`, no step log), or the steps a model run entered,
 * oldest first, as the run names them.
 */
export type FeatureRunProgress = { kind: AiRunKind | "report"; status: string; stage: string | null; steps: AiRunStep[]; startedAt: string; updatedAt: string };
export type BusinessMapCompany = FinancialMaintenanceCompany & {
  task: FinancialMaintenanceTask | null;
  collection: { status: string; reasons: string[]; updatedAt: string; completed: number; total: number } | null;
  history: { completed: number; total: number } | null;
  publication: { status: string; outdated: boolean; reasons: string[]; periods: string[]; revenueCoverage?: Array<{period:string;status:"verified"|"single_segment"|"unverified";segments:number;adjustments:number}> };
  /**
   * How the newest published quarter runs from operating income to net income (docs/statement-bridge-design.md): the
   * source of that arithmetic, the lines after taxes, the lines a later filing restated, and the model judgement kept
   * for the issuer when neither the calculation nor the statement rows balanced.
   */
  presentation?: {
    /** The newest quarter's income statement model; financial and insurance statements are read without this bridge. */
    model?: "standard" | "direct_operating" | "financial" | "insurance" | "unknown" | null;
    source: "calculation" | "statement" | "profile" | "degraded" | null;
    afterTax: Array<{ name: string; value: string }>;
    basisChanges: string[];
    profile: { status: "verified" | "unresolved"; accession: string; attempts: number; issues: string[]; updatedAt: string } | null;
  };
  /**
   * The feature switches as they apply now (docs/whitelist-feature-switches-design.md): whether the company's switch is on
   * (generated and shown; off stops generating and hides, except after a failed run, which stops generation only) and when the newest publication was written (null for none).
   */
  features: Record<Feature, { on: boolean; publishedAt: string | null;
    /** The feature's work in flight for this company: a run executing or a run waiting its turn. */
    run: "running" | "queued" | null;
    /** The feature's runs executing now, with the step each has reached. */
    progress: FeatureRunProgress[];
    /** The failed run that switched the feature off (messages.ts); null once it is switched on again. */
    failure: { at: string; detail: string | null } | null }>;
};
/** `generation`: whether each feature is generated at all (the admin's global switches over the deployment flags). */
export type BusinessMapCompanies = { companies: BusinessMapCompany[]; automaticCollection: boolean; generation: Record<Feature, boolean> };
/** One issuer of EDGAR's exchange directory, as the whitelist's ticker field suggests them. */
export type IssuerSuggestion = { ticker: string; name: string; exchange: string };

/**
 * The data behind BusinessView's three charts for one company: the profit view's quarters (published pair plus the
 * archived report quarters) and the capital structure the cash-flow and balance-sheet views draw from.
 */
export type BusinessMapCharts = {
  ticker: string;
  status: CompleteFlowPublication["status"];
  reasons: CompleteFlowPublication["reasons"];
  profit: PublicBusinessFlow | null;
  capital: PublicCapitalStructure | null;
};

/**
 * One company's analysis as the pipeline runs it (docs/analysis-events.md), for the admin's flow graph: the tasks of the
 * financial map and its features, the events that carry information between them, and where each task stands now.
 */
export type FlowNodeState = "running" | "queued" | "done" | "failed" | "idle";
export type FlowNode = {
  /** A task name from the event registry, or a source (`sec-discovery`, `admin`). */
  id: string;
  source: boolean;
  /** The column: the longest chain of tasks before this one. */
  depth: number;
  state: FlowNodeState;
  /** When the state began: the last run's end, or when a waiting run was requested. */
  at: string | null;
  /** The node and event that started the current or last run, when the pipeline log still has them. */
  via: { from: string; event: string } | null;
  /** A model run in flight: its steps so far. */
  progress: FeatureRunProgress | null;
};
export type FlowEdge = { from: string; to: string; events: string[] };
export type BusinessMapFlow = { ticker: string; nodes: FlowNode[]; edges: FlowEdge[] };
