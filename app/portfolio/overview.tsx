"use client";

import { type CalendarEvent } from "@/lib/earnings-live";
import { useLanguage } from "@/app/language-provider";
import { CalendarDays } from "lucide-react";
import { buildEarningsReminder, type EarningsEvent } from "@/lib/earnings-calendar";
import { money, number, percent } from "@/lib/portfolio-format";
import { CountUp } from "@/components/spontra/effects";

export function PortfolioOverview({
  netLiquidation,
  totalPnl,
  totalPnlRate,
  netLiquidationWithoutOptionPnl,
  portfolioLeverage,
  netDeposits,
  cashBalance,
  netPositionsValue,
  stockMarketValue,
  optionMarketValue,
  nextEarnings,
  nextEarningsReminder,
}: {
  netLiquidation: number;
  totalPnl: number;
  totalPnlRate: number;
  netLiquidationWithoutOptionPnl: number;
  portfolioLeverage: number;
  netDeposits: number;
  cashBalance: number;
  netPositionsValue: number;
  stockMarketValue: number;
  optionMarketValue: number;
  nextEarnings?: EarningsEvent;
  nextEarningsReminder: ReturnType<typeof buildEarningsReminder> | null;
}) {
  const { t } = useLanguage();
  return (
    <section className="portfolio-overview" aria-labelledby="portfolio-title">
      <div className="hero">
        <div className="portfolio-heading">
          <div className="flex items-center gap-2"><h1 className="summary-nav-label" id="portfolio-title">{t("当前净值")}</h1></div>
          <strong className="summary-nav-value"><span className="sr-only">{money(netLiquidation)}</span><span aria-hidden="true"><CountUp value={money(netLiquidation)} /></span></strong>
          <div className="summary-footer">
            <div className="summary-return">
              <span className="summary-pnl-label">{t("累计盈亏")}</span>
              <strong className={`summary-pnl ${totalPnl < 0 ? "loss" : totalPnl > 0 ? "gain" : "muted"}`}>
                {money(totalPnl, true)} <i>{percent(totalPnlRate, true)}</i>
              </strong>
            </div>
            <div className="summary-ex-option-pnl">
              <span>{t("剔除期权浮盈亏")}</span>
              <strong>{money(netLiquidationWithoutOptionPnl)}</strong>
            </div>
          </div>
        </div>
        <div className="summary-support" aria-label={t("组合摘要")}>
          <article><span>{t("持仓净市值")}</span><strong>{money(netPositionsValue)}</strong></article>
          <article><span>{t("正股")}</span><strong>{money(stockMarketValue)}</strong></article>
          <article><span>{t("期权")}</span><strong>{money(optionMarketValue)}</strong></article>
          <article><span>{t("现金")}</span><strong>{money(cashBalance)}</strong></article>
          <article><span>{t("杠杆率")}</span><strong>{number(portfolioLeverage, 2, 2)}x</strong></article>
          <article>
            <div className="summary-metric-label">
              <span>{t("净入金")}</span>

            </div>
            <strong>{money(netDeposits)}</strong>
          </article>
        </div>
      </div>
      {nextEarnings && nextEarningsReminder && (
        <div className="header-next-earnings" aria-label={t("即将到来的事件")}>
          <CalendarDays className="size-4" aria-hidden="true" />
          <strong>{(nextEarnings as CalendarEvent).confidence === "confirmed" ? "" : "预计 "}{nextEarnings.symbol} {nextEarningsReminder.releaseDateLabel} · {nextEarningsReminder.sessionLabel}</strong>
        </div>
      )}
    </section>
  );
}
