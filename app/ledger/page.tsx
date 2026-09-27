import { LocalizedText } from "../language-provider";
import { getD1 } from "@/db";
import { readCalendar } from "@/lib/earnings-store";
import { emptyCalendar } from "@/lib/earnings-live";
import { currentPortfolioSnapshot } from "@/lib/site-data";
import { buildPortfolioPresentation } from "@/packages/client/src/portfolio";
import { PortfolioDashboard } from "../portfolio-dashboard";
export const dynamic = "force-dynamic";
export default async function LedgerPage() {
  const snapshot = await currentPortfolioSnapshot();
  const earnings = await getD1().then(readCalendar).catch(() => emptyCalendar());
  return <><a className="skip-link" href="#main-content"><LocalizedText>跳到主要内容</LocalizedText></a>
    <main className="page-shell ledger-shell" id="main-content"><PortfolioDashboard {...buildPortfolioPresentation(snapshot, earnings)} /></main></>;
}
