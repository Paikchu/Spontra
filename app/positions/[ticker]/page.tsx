import { loadPortfolio, PortfolioUnavailableError } from "@/lib/portfolio-client";
import { PortfolioUnavailable } from "@/components/portfolio-sync-note";
import { getD1 } from "@/db";
import { getHoldingPlan, type HoldingPlanRecord } from "@/lib/holding-plan-store";
import { buildPortfolioViewModel } from "@/lib/portfolio-view-model";
import { findSecurity } from "@/lib/site-data";
import { normalizeTicker } from "@/lib/symbol-directory";
import { notFound } from "next/navigation";
import { StockDetail } from "./StockDetail";
import { canonicalUnderlying } from "@/lib/portfolio-snapshot";
import "@/app/analysis/earning-report.css";

export const dynamic = "force-dynamic";

export default async function PositionPage({ params }: { params: Promise<{ ticker: string }> }) {
  const ticker = normalizeTicker((await params).ticker);
  let data;
  try { data = await loadPortfolio(); }
  catch (error) {
    if (!(error instanceof PortfolioUnavailableError)) throw error;
    return <PortfolioUnavailable reason={error.reason} />;
  }
  const { snapshot } = data;
  const portfolioViewModel = buildPortfolioViewModel(snapshot);
  const security = findSecurity(ticker, portfolioViewModel);
  if (!security) notFound();
  const position = portfolioViewModel.positionGroups.find((group) => group.symbol === ticker);
  let plan: HoldingPlanRecord | null = null;
  let planUnavailable = false;
  try {
    plan = await getHoldingPlan(await getD1(), ticker);
  } catch {
    planUnavailable = true;
  }

  return (
    <StockDetail
      key={ticker}
      companyName={security.name}
      exchange={security.exchange}
      plan={plan}
      planStatus={planUnavailable ? "unavailable" : "ready"}
      position={position}
      ticker={ticker}
      trades={snapshot.trades.filter((trade) => canonicalUnderlying(trade.symbol) === ticker).sort((a, b) => b.tradeTime.localeCompare(a.tradeTime))}
    />
  );
}
