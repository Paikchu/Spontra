import { LocalizedText } from "./language-provider";
import { buildPortfolioViewModel } from "@/lib/portfolio-view-model";
import { currentPortfolioSnapshot } from "@/lib/site-data";
import { TodayDashboard } from "./today/today-dashboard";

export const dynamic = "force-dynamic";

/** Today: account summary and research reports. The full ledger lives at /ledger. */
export default async function Today() {
  const snapshot = await currentPortfolioSnapshot();
  const portfolio = buildPortfolioViewModel(snapshot);
  const grossPositionsValue = snapshot.positions.reduce((sum, position) => sum + Math.abs(position.marketValue), 0);
  const { netLiquidation, netDeposits, cashBalance } = snapshot.account;
  return (
    <>
      <a className="skip-link" href="#main-content"><LocalizedText>跳到主要内容</LocalizedText></a>
      <main className="page-shell today-shell" id="main-content">
        <TodayDashboard
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
