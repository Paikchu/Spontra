import type { FinancialMaintenanceCompany, FinancialMaintenanceTask } from './financial-maintenance.ts';
export type BusinessMapCompany = FinancialMaintenanceCompany & {
  task: FinancialMaintenanceTask | null;
  collection: { status: string; reasons: string[]; updatedAt: string; completed: number; total: number } | null;
  history: { completed: number; total: number } | null;
  publication: { status: string; outdated: boolean; reasons: string[]; periods: string[]; revenueCoverage?: Array<{period:string;status:"verified"|"single_segment"|"unverified";segments:number;adjustments:number}> };
};
export type BusinessMapCompanies = { companies: BusinessMapCompany[]; automaticCollection: boolean };
