import { loadPortfolio, PortfolioUnavailableError } from "@/lib/portfolio-client";
import { PortfolioUnavailable } from "@/components/portfolio-sync-note";
import { LocalizedText } from "./language-provider";
import { buildPortfolioViewModel } from "@/lib/portfolio-view-model";

import { TodayDashboard } from "./today/today-dashboard";

export const dynamic = "force-dynamic";

/** Today: account summary and research reports. The full ledger lives at /ledger. */
export default async function Today() {
  let data;
  try { data = await loadPortfolio(); }
  catch (error) {
    if (!(error instanceof PortfolioUnavailableError)) throw error;
    return <PortfolioUnavailable reason={error.reason} />;
  }
  const { snapshot, sync } = data;
  const portfolio = buildPortfolioViewModel(snapshot, sync.reportDate);
  const grossPositionsValue = snapshot.positions.reduce((sum, position) => sum + Math.abs(position.marketValue), 0);
  const { netLiquidation, netDeposits, cashBalance } = snapshot.account;
  return (
    <>
      <a className="skip-link" href="#main-content"><LocalizedText>跳到主要内容</LocalizedText></a>
      <main className="page-shell today-shell" id="main-content">
        <TodayDashboard
          portfolioSync={sync}
          netLiquidation={netLiquidation}
          netDeposits={netDeposits}
          cashBalance={cashBalance}
          netPositionsValue={portfolio.netPositionsValue}
          portfolioLeverage={netLiquidation === 0 ? 0 : grossPositionsValue / netLiquidation}
        />
      </main>
    </>
  );
}
