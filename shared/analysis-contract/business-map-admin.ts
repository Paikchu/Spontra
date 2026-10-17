import type { FinancialMaintenanceCompany, FinancialMaintenanceTask } from './financial-maintenance.ts';
import type { CompleteFlowPublication } from './complete-business-flow.ts';
import type { PublicBusinessFlow } from './business-flow.ts';
import type { PublicCapitalStructure } from './capital-structure.ts';
import type { Feature } from './business-features.ts';
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
   * (generated and shown; off stops generating and hides) and when the newest publication was written (null for none).
   */
  features: Record<Feature, { on: boolean; publishedAt: string | null;
    /** The feature's work in flight for this company: a run executing, a run waiting its turn, or the last run failed with nothing newer published. */
    run: "running" | "queued" | "failed" | null }>;
};
/** `generation`: whether each feature is generated at all (the admin's global switches over the deployment flags). */
export type BusinessMapCompanies = { companies: BusinessMapCompany[]; automaticCollection: boolean; generation: Record<Feature, boolean> };

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
