import { LocalizedText } from "./language-provider";
import { getD1 } from "@/db";
import { readCalendar } from "@/lib/earnings-store";
import { emptyCalendar } from "@/lib/earnings-live";
import { buildPortfolioViewModel } from "@/lib/portfolio-view-model";
import { currentPortfolioSnapshot } from "@/lib/site-data";
import { TodayDashboard, type TodayHolding } from "./today/today-dashboard";

export const dynamic = "force-dynamic";

/** Today: the one-screen summary. The full ledger lives at /ledger. */
export default async function Today() {
  const snapshot = await currentPortfolioSnapshot();
  const earnings = await getD1().then(readCalendar).catch(() => emptyCalendar());
  const portfolio = buildPortfolioViewModel(snapshot);
  const grossPositionsValue = snapshot.positions.reduce((sum, position) => sum + Math.abs(position.marketValue), 0);
  const { netLiquidation, netDeposits, cashBalance } = snapshot.account;
  const holdings: TodayHolding[] = portfolio.positionGroups.map((group) => ({ symbol: group.symbol, name: group.name, weight: group.weight }));
  return (
    <>
      <a className="skip-link" href="#main-content"><LocalizedText>跳到主要内容</LocalizedText></a>
      <main className="page-shell today-shell" id="main-content">
        <TodayDashboard
          now={new Date().toISOString()}
          netLiquidation={netLiquidation}
          netDeposits={netDeposits}
          cashBalance={cashBalance}
          netPositionsValue={portfolio.netPositionsValue}
          portfolioLeverage={netLiquidation === 0 ? 0 : grossPositionsValue / netLiquidation}
          holdings={holdings}
          earningsCalendar={earnings}
        />
      </main>
    </>
  );
}
