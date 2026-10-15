import type { FinancialMaintenanceCompany, FinancialMaintenanceTask } from './financial-maintenance.ts';
import type { CompleteFlowPublication } from './complete-business-flow.ts';
import type { PublicBusinessFlow } from './business-flow.ts';
import type { PublicCapitalStructure } from './capital-structure.ts';
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
    source: "calculation" | "statement" | "profile" | "degraded" | null;
    afterTax: Array<{ name: string; value: string }>;
    basisChanges: string[];
    profile: { status: "verified" | "unresolved"; accession: string; attempts: number; issues: string[]; updatedAt: string } | null;
  };
};
export type BusinessMapCompanies = { companies: BusinessMapCompany[]; automaticCollection: boolean };

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
