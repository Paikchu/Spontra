import { loadPortfolio, PortfolioUnavailableError } from "@/lib/portfolio-client";
import { PortfolioUnavailable } from "@/components/portfolio-sync-note";
import { LocalizedText } from "../language-provider";
import { getD1 } from "@/db";
import { readCalendar } from "@/lib/earnings-store";
import { emptyCalendar } from "@/lib/earnings-live";

import { buildPortfolioPresentation } from "@/packages/client/src/portfolio";
import { PortfolioDashboard } from "../portfolio-dashboard";
export const dynamic = "force-dynamic";
export default async function LedgerPage() {
  let data;
  try { data = await loadPortfolio(); }
  catch (error) {
    if (!(error instanceof PortfolioUnavailableError)) throw error;
    return <PortfolioUnavailable reason={error.reason} />;
  }
  const { snapshot, sync } = data;
  const earnings = await getD1().then(readCalendar).catch(() => emptyCalendar());
  return <><a className="skip-link" href="#main-content"><LocalizedText>跳到主要内容</LocalizedText></a>
    <main className="page-shell ledger-shell" id="main-content"><PortfolioDashboard {...buildPortfolioPresentation(snapshot, earnings, sync)} /></main></>;
}
