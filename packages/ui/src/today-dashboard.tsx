"use client";

import Link from "@/packages/web/src/navigation";
import type { CSSProperties } from "react";
import { useLanguage } from "@/app/language-provider";
import { CountUp } from "@/components/spontra/effects";
import { Delta, NodeArrow } from "@/components/spontra/primitives";
import { money, number } from "@/lib/portfolio-format";
import { ResearchFeed } from "./research-feed";
import { InstructionLauncher } from "./instruction-launcher";
import { PortfolioSyncNote } from "@/components/portfolio-sync-note";
import type { PortfolioSyncMetadata } from "@/shared/portfolio-contract";

/** Today: the account summary sits above the report list; the open report fills the rest of the page. */
export function TodayDashboard({
  portfolioSync,
  netLiquidation,
  netDeposits,
  cashBalance,
  netPositionsValue,
  portfolioLeverage,
}: {
  portfolioSync?: PortfolioSyncMetadata;
  netLiquidation: number;
  netDeposits: number;
  cashBalance: number;
  netPositionsValue: number;
  portfolioLeverage: number;
}) {
  const { t } = useLanguage();
  const totalPnl = netLiquidation - netDeposits;
  const totalPnlRate = netDeposits === 0 ? 0 : totalPnl / netDeposits * 100;

  const summary = (
    <section className="sp-card sp-card-accent sp-lit is-glow sp-reveal today-hero" style={{ "--i": 0 } as CSSProperties} aria-labelledby="today-nav-label">
      <header className="sp-card-head">
        <div className="sp-card-heading">
          <p className="sp-kicker" aria-hidden="true">{t("当前净值")}</p>
          <h2 className="sr-only" id="today-nav-label">{t("当前净值")}</h2>
        </div>
        <Link href="/ledger" aria-label={t("打开投资账本")} className="sp-btn sp-btn-sm is-circle sp-btn-inverse">
          <span className="sp-btn-trail"><NodeArrow dir="diag" /></span>
        </Link>
      </header>
      <div className="today-hero-body">
        <PortfolioSyncNote sync={portfolioSync} />
        <div className="sp-stat sp-stat-hero">
          <strong className="sp-stat-value"><span className="sr-only">{money(netLiquidation)}</span><span aria-hidden="true"><CountUp value={money(netLiquidation)} /></span></strong>
          <span className="sp-stat-delta">
            <span className="sp-stat-dlabel">{t("累计盈亏")}</span>
            <Delta value={totalPnl} />
            <Delta value={totalPnlRate} kind="percent" />
          </span>
        </div>
        <dl className="sp-stat-row is-compact today-hero-stats">
          <div className="sp-stat"><dt className="sp-stat-label">{t("持仓净市值")}</dt><dd className="sp-stat-value">{money(netPositionsValue)}</dd></div>
          <div className="sp-stat"><dt className="sp-stat-label">{t("现金")}</dt><dd className="sp-stat-value">{money(cashBalance)}</dd></div>
          <div className="sp-stat"><dt className="sp-stat-label">{t("杠杆率")}</dt><dd className="sp-stat-value">{number(portfolioLeverage, 2, 2)}x</dd></div>
        </dl>
      </div>
    </section>
  );

  return (
    <div className="today">
      <div className="today-ambient" aria-hidden="true" />
      <h1 className="sr-only" id="today-title">{t("今日")}</h1>
      <ResearchFeed summary={summary} />
      <InstructionLauncher />
    </div>
  );
}
