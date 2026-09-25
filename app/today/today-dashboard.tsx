"use client";

import Link from "next/link";
import { useMemo, type CSSProperties, type ReactNode } from "react";
import { CalendarDays } from "lucide-react";
import { useLanguage } from "@/app/language-provider";
import { useMarketQuotes } from "@/app/use-market-quotes";
import { CompanyLogo } from "@/app/company-logo";
import { CountUp } from "@/components/spontra/effects";
import { Delta, NodeArrow } from "@/components/spontra/primitives";
import { buildEarningsReminder } from "@/lib/earnings-calendar";
import { withinReminderWindow, type CalendarEvent, type CalendarState } from "@/lib/earnings-live";
import { money, number, percent } from "@/lib/portfolio-format";
import { ResearchFeed } from "./research-feed";

export type TodayHolding = { symbol: string; name: string; weight: number };

const reveal = (index: number) => ({ "--i": index }) as CSSProperties;

function OpenLink({ href, label, inverse = false }: { href: string; label: string; inverse?: boolean }) {
  return (
    <Link href={href} aria-label={label} className={`sp-btn sp-btn-sm is-circle ${inverse ? "sp-btn-inverse" : "sp-btn-secondary"}`}>
      <span className="sp-btn-trail"><NodeArrow dir="diag" /></span>
    </Link>
  );
}

function CardHead({ kicker, title, action }: { kicker: string; title?: ReactNode; action?: ReactNode }) {
  return (
    <header className="sp-card-head">
      <div className="sp-card-heading">
        <p className="sp-kicker">{kicker}</p>
        {title && <h2 className="sp-card-title">{title}</h2>}
      </div>
      {action}
    </header>
  );
}

export function TodayDashboard({
  now,
  netLiquidation,
  netDeposits,
  cashBalance,
  netPositionsValue,
  portfolioLeverage,
  holdings,
  earningsCalendar,
}: {
  now: string;
  netLiquidation: number;
  netDeposits: number;
  cashBalance: number;
  netPositionsValue: number;
  portfolioLeverage: number;
  holdings: TodayHolding[];
  earningsCalendar: CalendarState;
}) {
  const { t, language } = useLanguage();
  const totalPnl = netLiquidation - netDeposits;
  const totalPnlRate = netDeposits === 0 ? 0 : totalPnl / netDeposits * 100;

  const heldSymbols = useMemo(() => new Set(holdings.map((holding) => holding.symbol)), [holdings]);
  const upcoming = useMemo(() => {
    const seen = new Set<string>();
    return earningsCalendar.events.filter((event) => {
      if (!heldSymbols.has(event.symbol) || seen.has(event.symbol) || !withinReminderWindow(event, new Date(now))) return false;
      seen.add(event.symbol);
      return true;
    }).slice(0, 3);
  }, [earningsCalendar.events, heldSymbols, now]);

  const quoteSymbols = useMemo(() => holdings.map((holding) => holding.symbol).join(","), [holdings]);
  const { quotes, status } = useMarketQuotes(quoteSymbols);
  const movers = useMemo(() => holdings
    .flatMap((holding) => {
      const quote = quotes[holding.symbol];
      return quote && Number.isFinite(quote.changePercent) ? [{ ...holding, change: quote.changePercent }] : [];
    })
    .sort((left, right) => Math.abs(right.change) - Math.abs(left.change))
    .slice(0, 3), [holdings, quotes]);

  return (
    <div className="today">
      <div className="today-ambient" aria-hidden="true" />
      <h1 className="sr-only" id="today-title">{t("今日")}</h1>

      <div className="today-grid">
        <section className="sp-card sp-card-accent sp-lit is-glow sp-reveal today-hero" style={reveal(0)} aria-labelledby="today-nav-label">
          <CardHead kicker={t("当前净值")} action={<OpenLink href="/ledger" label={t("打开投资账本")} inverse />} />
          <h2 className="sr-only" id="today-nav-label">{t("当前净值")}</h2>
          <div className="today-hero-body">
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

        <section className="sp-card sp-lit sp-reveal today-movers" style={reveal(1)} aria-labelledby="today-movers-title">
          <CardHead kicker={t("今日涨跌")} title={<span id="today-movers-title">{t("波动最大的持仓")}</span>} />
          {movers.length > 0 ? (
            <ul className="today-movers-list">
              {movers.map((mover) => (
                <li key={mover.symbol}>
                  <Link href={`/positions/${encodeURIComponent(mover.symbol)}`}>
                    <CompanyLogo symbol={mover.symbol} />
                    <span className="today-mover-name"><span className="sp-ticker-sym">{mover.symbol}</span><small>{t("权重")} {percent(mover.weight)}</small></span>
                    <Delta value={mover.change} kind="percent" pill />
                  </Link>
                </li>
              ))}
            </ul>
          ) : status === "unavailable" ? (
            <p className="today-card-note" role="status">{t("行情暂不可用")}</p>
          ) : (
            <div className="today-movers-loading" role="status" aria-label={t("行情读取中")}>
              {[0, 1, 2].map((index) => <span key={index} />)}
            </div>
          )}
        </section>

        <section className="sp-card sp-card-brand sp-lit is-glow sp-reveal today-earnings" style={reveal(2)} aria-labelledby="today-earnings-title">
          <CardHead kicker={t("本月财报")} title={<span id="today-earnings-title">{upcoming.length ? t("持仓公司即将发布财报") : earningsCalendar.status === "unavailable" ? t("财报日历暂不可用") : t("本月没有持仓财报")}</span>} />
          {upcoming.length > 0 ? (
            <ul className="today-earnings-list">
              {upcoming.map((event) => {
                const reminder = buildEarningsReminder(event, now);
                return (
                  <li key={event.symbol}>
                    <Link href={`/positions/${encodeURIComponent(event.symbol)}`}>
                      <span className="sp-ticker-sym">{event.symbol}</span>
                      <span>{(event as CalendarEvent).confidence === "confirmed" ? "" : `${t("预计")} `}{reminder.releaseDateLabel} · {t(reminder.sessionLabel)}</span>
                      <strong>{language === "en" ? reminder.countdownLabel.replace(/^(\d+)天后$/, "in $1 days").replace(/^今天$/, "Today").replace(/^明天$/, "Tomorrow").replace(/^已发布$/, "Released") : reminder.countdownLabel}</strong>
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="today-card-note">{earningsCalendar.status === "unavailable" ? t("暂时读不到财报日历，稍后刷新再看。") : t("财报日历会在持仓公司确认日期后出现在这里。")}</p>
          )}
          <p className="today-card-foot"><CalendarDays aria-hidden="true" />{t("上海时间")}</p>
        </section>
      </div>

      <ResearchFeed />
    </div>
  );
}
