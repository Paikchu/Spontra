import type { PortfolioSnapshotV1 } from "../lib/portfolio-snapshot.ts";

export type PortfolioSyncStatus = "current" | "delayed" | "uninitialized";

export interface PortfolioSyncMetadata {
  reportDate: string | null;
  syncedAt: string | null;
  syncStatus: PortfolioSyncStatus;
}

/** Public read projection. Broker configuration and capital-flow account IDs stay in the sync service. */
export type PortfolioReadSnapshot = Omit<PortfolioSnapshotV1, "capitalFlows" | "source">;

export interface PortfolioApiResponseV1 extends PortfolioSyncMetadata {
  portfolio: PortfolioReadSnapshot | null;
}

export const IBKR_SYNC_CRON = "0 6 * * TUE-SAT";

/** Most recent scheduled run whose 30-minute completion window has elapsed. */
export function portfolioSyncOverdue(syncedAt: string, now: Date): boolean {
  const deadline = new Date(now.getTime() - 30 * 60_000);
  const scheduled = new Date(deadline);
  scheduled.setUTCHours(6, 0, 0, 0);
  if (scheduled > deadline) scheduled.setUTCDate(scheduled.getUTCDate() - 1);
  while (scheduled.getUTCDay() < 2) scheduled.setUTCDate(scheduled.getUTCDate() - 1);
  return Date.parse(syncedAt) < scheduled.getTime();
}
