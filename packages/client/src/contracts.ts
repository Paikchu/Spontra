import type { PortfolioSyncMetadata } from "@/shared/portfolio-contract";
import type { PortfolioSnapshotV1 } from "@/lib/portfolio-snapshot";
import type { PositionGroupView } from "@/lib/portfolio-view-model";
import type { buildPortfolioPresentation } from "./portfolio";
export interface StockContext extends Partial<PortfolioSyncMetadata> {
  source?: "live" | "fallback";
  asOf?: string;
  ticker: string;
  companyName: string;
  exchange: string;
  position?: PositionGroupView;
  trades: PortfolioSnapshotV1["trades"];
}
export interface PortfolioData extends PortfolioSyncMetadata {
  source: "live" | "fallback";
  asOf: string;
  presentation: ReturnType<typeof buildPortfolioPresentation>;
}
