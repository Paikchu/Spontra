"use client";
import { useDataRevision } from "@/packages/client/src/refresh";
import { PortfolioSyncNote } from "@/components/portfolio-sync-note";
import type { PortfolioSyncMetadata } from "@/shared/portfolio-contract";

import { apiFetch } from "@/packages/client/src/platform";

import { emptyCalendar, withinReminderWindow, type CalendarEvent, type CalendarState } from "@/lib/earnings-live";
import { useLanguage } from "@/app/language-provider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useEffect, useMemo, useState } from "react";
import { buildEarningsReminder, type EarningsEvent } from "@/lib/earnings-calendar";
import { type HeatmapHolding } from "@/lib/portfolio-heatmap";
import type { HistoricalPositionGroupView, PositionGroupView } from "@/lib/portfolio-view-model";
import { HoldingPlansPanel } from "./HoldingPlansPanel";
import { PortfolioHeatmap } from "./portfolio-heatmap";
import { useMarketQuotes } from "./use-market-quotes";

import { PortfolioOverview } from "./portfolio/overview";
import { AllocationPanel } from "./portfolio/allocation";
import { PositionLedger, HistoricalPositionLedger } from "./portfolio/ledger";

export function PortfolioDashboard({
  portfolioSync,
  heatmapHoldings,
  positionGroups,
  historicalPositionGroups,
  stockMarketValue,
  optionMarketValue,
  netPositionsValue,
  earningsEvents: initialEarningsEvents,
  earningsCalendar,
  netLiquidation,
  netLiquidationWithoutOptionPnl,
  portfolioLeverage,
  netDeposits,
  cashBalance,
}: {
  portfolioSync?: PortfolioSyncMetadata;
  heatmapHoldings: HeatmapHolding[];
  positionGroups: PositionGroupView[];
  historicalPositionGroups: HistoricalPositionGroupView[];
  stockMarketValue: number;
  optionMarketValue: number;
  netPositionsValue: number;
  earningsEvents: EarningsEvent[];
  earningsCalendar?: CalendarState;
  netLiquidation: number;
  netLiquidationWithoutOptionPnl: number;
  portfolioLeverage: number;
  netDeposits: number;
  cashBalance: number;
}) {
  const revision = useDataRevision();
  const { t } = useLanguage();
  const [activeSymbol, setActiveSymbol] = useState<string | null>(null);
  const [earningsAsOf, setEarningsAsOf] = useState(() => new Date().toISOString());
  const [calendar, setCalendar] = useState(() => (earningsCalendar ?? {...emptyCalendar(), events: initialEarningsEvents as CalendarEvent[]}));
  const earningsEvents = calendar.events;
  useEffect(() => {
    const controller = new AbortController();
    const update = async () => {
      setEarningsAsOf(new Date().toISOString());
      try {
        const response = await apiFetch('/api/earnings', {signal: controller.signal, cache: 'no-store'});
        if (!response.ok) throw new Error('Calendar unavailable');
        const fresh = await response.json() as CalendarState;
        if (!controller.signal.aborted) setCalendar(fresh);
      } catch { if (!controller.signal.aborted) setCalendar(previous => ({...previous, status:'unavailable'})); }
    };
    void update();
    const timer = window.setInterval(update, 5 * 60_000);
    return () => {controller.abort(); window.clearInterval(timer);};
  }, [revision]);
  const positionSymbols = useMemo(() => new Set(positionGroups.map((group) => group.symbol)), [positionGroups]);
  const quoteSymbols = useMemo(() => positionGroups.map((group) => group.symbol).join(","), [positionGroups]);
  const quoteState = useMarketQuotes(quoteSymbols);
  const earningsBySymbol = useMemo(() => {
    const events = new Map<string, EarningsEvent>();
    for (const event of earningsEvents) {
      if (
        positionSymbols.has(event.symbol) &&
        withinReminderWindow(event, new Date(earningsAsOf)) &&
        !events.has(event.symbol)
      ) events.set(event.symbol, event);
    }
    return events;
  }, [earningsAsOf, earningsEvents, positionSymbols]);

  const nextEarnings = earningsEvents.find((event) => (
    positionSymbols.has(event.symbol) && withinReminderWindow(event, new Date(earningsAsOf))
  ));
  const nextEarningsReminder = nextEarnings ? buildEarningsReminder(nextEarnings, earningsAsOf) : null;
  const configuredTotalPnl = netLiquidation - netDeposits;
  const configuredTotalPnlRate = netDeposits === 0 ? 0 : configuredTotalPnl / netDeposits * 100;

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    if (searchParams.has("settings") || searchParams.has("view")) {
      searchParams.delete("view");
      searchParams.delete("settings");
      const query = searchParams.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
    }
  }, []);

  return (
    <>
      <div id="portfolio-panel" role="region" aria-labelledby="portfolio-title">
        <PortfolioSyncNote sync={portfolioSync} />
        <PortfolioOverview
          netLiquidation={netLiquidation}
          totalPnl={configuredTotalPnl}
          totalPnlRate={configuredTotalPnlRate}
          netLiquidationWithoutOptionPnl={netLiquidationWithoutOptionPnl}
          portfolioLeverage={portfolioLeverage}
          netDeposits={netDeposits}
          cashBalance={cashBalance}
          netPositionsValue={netPositionsValue}
          stockMarketValue={stockMarketValue}
          optionMarketValue={optionMarketValue}
          nextEarnings={nextEarnings}
          nextEarningsReminder={nextEarningsReminder}
        />
      </div>

      <div className="lower-grid portfolio-workspace">
        <section className="ledger-panel ledger-page" aria-labelledby="ledger-title">
          <Tabs defaultValue="current" className="ledger-tabs gap-0">
            <div className="ledger-heading">
              <h2 id="ledger-title">{t("投资账本")}</h2>
              <div className="ledger-heading-actions">
                <TabsList aria-label={t("账本持仓范围")}>
                  <TabsTrigger value="current">{t("当前持仓 ")}<small>{positionGroups.length}</small></TabsTrigger>
                  <TabsTrigger value="historical">{t("历史持仓 ")}<small>{historicalPositionGroups.length}</small></TabsTrigger>
                  <TabsTrigger value="plans">{t("持仓计划")}</TabsTrigger>
                  <TabsTrigger value="allocation">{t("仓位构成")}</TabsTrigger>
                </TabsList>
              </div>
            </div>
            <div className="section-divider" aria-hidden="true" />
            <TabsContent value="current" className="ledger-content">
              <PositionLedger
                groups={positionGroups}
                activeSymbol={activeSymbol}
                onActiveSymbolChange={setActiveSymbol}
                quotes={quoteState.quotes}
                quoteStatus={quoteState.status}
                earningsBySymbol={earningsBySymbol}
                earningsUpdatedAt={earningsAsOf}
              />
            </TabsContent>
            <TabsContent value="historical" className="ledger-content">
              <HistoricalPositionLedger groups={historicalPositionGroups} />
            </TabsContent>
            <TabsContent value="plans" forceMount className="ledger-content">
              <HoldingPlansPanel />
            </TabsContent>
            <TabsContent value="allocation" forceMount className="ledger-content">
              <div className="portfolio-analysis-stack">
                <section className="allocation-panel" id="allocation-panel" aria-label={t("仓位构成")}>
                  <AllocationPanel groups={positionGroups} activeSymbol={activeSymbol} onActiveSymbolChange={setActiveSymbol} />
                </section>
                <PortfolioHeatmap quotes={quoteState.quotes} holdings={heatmapHoldings} activeSymbol={activeSymbol} onActiveSymbolChange={setActiveSymbol} />
              </div>
            </TabsContent>
          </Tabs>
        </section>
      </div>
    </>
  );
}
