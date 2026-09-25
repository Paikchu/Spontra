"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAppNavigation } from "@/app/app-navigation";
import { CompanyLogo } from "@/app/company-logo";
import { useMarketQuotes } from "@/app/use-market-quotes";
import { SiteHeader } from "@/app/analysis/site-header";
import { BusinessOutlook } from "@/app/analysis/stocks/[ticker]/BusinessOutlook";
import { SecFilingsSection } from "@/app/analysis/stocks/[ticker]/SecFilingsSection";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { money, number, percent } from "@/lib/portfolio-format";
import type { HoldingPlanRecord } from "@/lib/holding-plan-store";
import type { PositionGroupView } from "@/lib/portfolio-view-model";
import type { PortfolioTrade } from "@/lib/portfolio-snapshot";
import type { PublicSecFiling } from "@/shared/analysis-contract/filings";
import { PositionHoldings } from "./PositionHoldings";
import type { PositionPlanStatus } from "./PlanEditor";
import { PlanEditor } from "./PlanEditor";
import { FinancialMetrics } from "./FinancialMetrics";

const sections = [
  ["outlook", "业务拆解"], ["financials", "财务指标"], ["technical", "技术面指标"],
  ["holdings", "持仓构成"], ["plan", "持仓计划"], ["sec-filings", "财报与事件"],
] as const;

function tabFromHash(path: string) {
  const hash = path.split("#")[1] ?? "";
  if (hash === "position-structure") return "holdings";
  if (hash === "plan-editor") return "plan";
  return sections.some(([key]) => key === hash) ? hash : "outlook";
}

export function StockDetail({ ticker, companyName, exchange, position, trades, plan, planStatus, embedded = false }: {
  ticker: string; companyName: string; exchange: string; position?: PositionGroupView; embedded?: boolean;
  trades: PortfolioTrade[]; plan: HoldingPlanRecord | null; planStatus: PositionPlanStatus;
}) {
  const main = useRef<HTMLElement>(null);
  const tabBar = useRef<HTMLDivElement>(null);
  const indicator = useRef<HTMLSpanElement>(null);
  const resetPanelScroll = useRef(false);
  const { path, navigate } = useAppNavigation();
  const [activeTab, setActiveTab] = useState("outlook");
  const [visited, setVisited] = useState(() => new Set(["outlook"]));
  const { quotes, status } = useMarketQuotes(ticker);
  const quote = quotes[ticker];
  const stock = position?.stock;
  const rsi = quote?.rsi14;
  const rsiLabel = rsi == null ? "" : rsi >= 70 ? "超买" : rsi <= 30 ? "超卖" : rsi >= 60 ? "偏强" : "中性";

  useEffect(() => {
    if (embedded) return;
    const restore = () => {
      const value = tabFromHash(path);
      setActiveTab(value);
      setVisited((current) => new Set([...current, value]));
    };
    restore();
    window.addEventListener("hashchange", restore);
    return () => window.removeEventListener("hashchange", restore);
  }, [embedded, path]);

  useLayoutEffect(() => {
    const root = main.current;
    const search = embedded
      ? root?.closest(".analysis-workspace")?.querySelector<HTMLElement>(":scope > .analysis-toolbar")
      : root?.querySelector<HTMLElement>(".stock-detail-search");
    if (!root || !search) return;
    const update = () => root.style.setProperty("--stock-search-height", `${search.getBoundingClientRect().height}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(search, { box: "border-box" });
    return () => observer.disconnect();
  }, [embedded]);

  useLayoutEffect(() => {
    const bar = tabBar.current;
    if (!bar) return;
    const update = () => {
      const selected = bar.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      const line = indicator.current;
      if (!selected || !line || selected.offsetWidth === 0) return;
      line.style.transform = `translateX(${selected.offsetLeft}px) scaleX(${selected.offsetWidth})`;
      line.style.opacity = "1";
    };
    update();
    const selected = bar.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (selected) {
      const left = selected.offsetLeft;
      const right = left + selected.offsetWidth;
      if (left < bar.scrollLeft) bar.scrollLeft = left;
      else if (right > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = right - bar.clientWidth;
    }
    // A tab change starts the new panel below the sticky navigation, even after
    // reading far down a longer panel. The tabs root retains its flow position.
    const tabsTop = bar.parentElement!.getBoundingClientRect().top;
    const searchHeight = parseFloat(getComputedStyle(main.current!).getPropertyValue("--stock-search-height")) || 0;
    if (resetPanelScroll.current || tabsTop < searchHeight) {
      resetPanelScroll.current = false;
      const target = window.scrollY + tabsTop - searchHeight;
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      // Short panels cannot reach the sticky position; show the company header
      // completely instead of letting the browser clamp it halfway underneath.
      window.scrollTo({ top: target <= maxScroll ? target : 0, behavior: "instant" });
    }
    const observer = new ResizeObserver(update);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [activeTab]);

  function selectTab(value: string) {
    if (value !== activeTab && tabBar.current) {
      const searchHeight = parseFloat(getComputedStyle(main.current!).getPropertyValue("--stock-search-height")) || 0;
      resetPanelScroll.current = tabBar.current.parentElement!.getBoundingClientRect().top < searchHeight;
    }
    setActiveTab(value);
    setVisited((current) => new Set([...current, value]));
    if (!embedded) navigate(`#${value}`, { scroll: false });
  }

  return (
    <main ref={main} className="earning-report unified-stock">
      {!embedded && <div className="stock-detail-search"><SiteHeader compact /></div>}
      <header className="stock-detail-identity">
        <div className="stock-detail-company">
          <CompanyLogo symbol={ticker} size="lg" />
          <div className="stock-detail-company-text"><h1>{ticker}</h1><p>{companyName}{exchange && ` · ${exchange}`}</p></div>
        </div>
        <div className="stock-detail-price" aria-live="polite">
          {quote ? <><strong>{money(quote.price)}</strong><span className={quote.changePercent < 0 ? "loss" : "gain"}>{percent(quote.changePercent, true)}</span></>
            : status === "loading" ? <Skeleton className="h-9 w-40" aria-label="行情读取中" /> : <span className="text-muted-foreground">行情暂不可用</span>}
        </div>
      </header>
      <Tabs value={activeTab} onValueChange={selectTab} className="stock-detail-tabs">
        <div ref={tabBar} className="stock-detail-tab-bar"><TabsList variant="line" aria-label="个股详情">
          {sections.map(([key, label]) => <TabsTrigger value={key} key={key}>{label}</TabsTrigger>)}
        </TabsList><span ref={indicator} aria-hidden="true" className="stock-tab-indicator" /></div>
        <TabsContent value="outlook" forceMount hidden={activeTab !== "outlook"}>
          <div className="stock-detail-overview">
            <BusinessOutlook ticker={ticker} />
            <aside className="stock-detail-aside">
              <section aria-labelledby="holding-summary-heading">
                <h2 id="holding-summary-heading">我的持仓摘要</h2>
                {stock ? <dl>
                  <div><dt>数量</dt><dd>{number(stock.quantity, 0, 4)}</dd></div>
                  <div><dt>平均成本</dt><dd>{money(stock.averageCost)}</dd></div>
                  <div><dt>实际成本</dt><dd>{money(stock.actualCost)}</dd></div>
                  <div><dt>浮盈比例</dt><dd className={stock.unrealized < 0 ? "loss" : "gain"}>{stock.cost !== 0 ? percent(stock.unrealized / Math.abs(stock.cost) * 100, true) : "—"}</dd></div>
                </dl> : <p className="text-muted-foreground">{position ? "当前仅持有期权" : "当前未持有该股票"}</p>}
                <Button variant="outline" className="w-full" onClick={() => selectTab("holdings")}>查看持仓构成</Button>
              </section>
              <RecentDisclosures ticker={ticker} onViewAll={() => selectTab("sec-filings")} />
            </aside>
          </div>
        </TabsContent>
        <TabsContent value="financials" forceMount hidden={activeTab !== "financials"}>
          {visited.has("financials") && <FinancialMetrics ticker={ticker} />}
        </TabsContent>
        <TabsContent value="technical" forceMount hidden={activeTab !== "technical"}>
          <section className="stock-detail-technical" aria-label="技术面指标">{quote && <div className="stock-detail-section-title"><span>日线 · {new Date(quote.marketTime).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</span></div>}
            {rsi != null ? <div className="stock-detail-rsi"><div><span>RSI 14</span><span><strong>{number(rsi, 1, 1)}</strong> {rsiLabel}</span></div>
              <div className="stock-detail-rsi-track" role="meter" aria-label="RSI 14" aria-valuenow={rsi} aria-valuemin={0} aria-valuemax={100}><i style={{ left: `${Math.max(0, Math.min(100, rsi))}%` }} /></div>
              <div className="stock-detail-rsi-scale"><span>0 超卖</span><span>30</span><span>70</span><span>100 超买</span></div>
            </div> : <Empty><EmptyHeader><EmptyDescription>{status === "loading" ? "正在读取技术指标…" : "RSI 数据暂不可用。"}</EmptyDescription></EmptyHeader></Empty>}
            <p className="text-muted-foreground">其余技术指标尚未接入。</p>
          </section>
        </TabsContent>
        <TabsContent value="holdings" forceMount hidden={activeTab !== "holdings"}>
          <PositionHoldings ticker={ticker} position={position} />
          <section className="stock-detail-trades"><h2>交易记录</h2>
            {trades.length ? <Table aria-label={`${ticker} 交易记录`}><TableHeader><TableRow><TableHead>日期</TableHead><TableHead>资产 / 合约</TableHead><TableHead>方向</TableHead><TableHead>数量</TableHead><TableHead>成交价</TableHead><TableHead>佣金</TableHead><TableHead>已实现盈亏</TableHead></TableRow></TableHeader><TableBody>
              {trades.map((trade) => <TableRow key={trade.tradeId}><TableCell>{trade.tradeDate ?? trade.tradeTime.slice(0, 10)}</TableCell><TableCell>{trade.contractDescription}</TableCell><TableCell>{/^(BUY|BOT)$/i.test(trade.side) ? "买入" : /^(SELL|SLD)$/i.test(trade.side) ? "卖出" : trade.side}</TableCell><TableCell>{number(trade.size, 0, 4)}</TableCell><TableCell>{money(trade.price)}</TableCell><TableCell>{money(trade.commission)}</TableCell><TableCell className={trade.realizedPnl < 0 ? "loss" : "gain"}>{money(trade.realizedPnl)}</TableCell></TableRow>)}
            </TableBody></Table> : <Empty><EmptyHeader><EmptyTitle>暂无交易记录</EmptyTitle><EmptyDescription>当前同步数据中没有该股票的交易。</EmptyDescription></EmptyHeader></Empty>}
          </section>
        </TabsContent>
        <TabsContent value="plan" forceMount hidden={activeTab !== "plan"}>
          {visited.has("plan") && (planStatus === "loading" ? <Skeleton className="h-36 w-full" aria-label="正在读取计划" /> : <PlanEditor key={ticker} ticker={ticker} initialPlan={plan} unavailable={planStatus === "unavailable"} />)}
        </TabsContent>
        <TabsContent value="sec-filings" forceMount hidden={activeTab !== "sec-filings"}>
          {visited.has("sec-filings") && <div className="stock-analysis-filings stock-detail-timeline"><SecFilingsSection ticker={ticker} /></div>}
        </TabsContent>
      </Tabs>
    </main>
  );
}

function RecentDisclosures({ ticker, onViewAll }: { ticker: string; onViewAll: () => void }) {
  const [filings, setFilings] = useState<PublicSecFiling[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/analysis/v1/companies/${encodeURIComponent(ticker)}/filings?limit=2`, { signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error("unavailable"); return response.json() as Promise<{ filings: PublicSecFiling[] }>; })
      .then((page: { filings: PublicSecFiling[] }) => { if (!controller.signal.aborted) setFilings(page.filings); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [ticker]);
  return <section aria-labelledby="recent-disclosures-heading"><h2 id="recent-disclosures-heading">最近披露</h2>
    {failed ? <p className="text-muted-foreground">披露暂时无法读取</p> : filings === null ? <Skeleton className="h-16 w-full" /> : filings.length ? <ul className="stock-detail-recent">{filings.map((filing) => <li key={filing.accessionNumber}><Badge variant={/10-K|10-Q|20-F/.test(filing.form) ? "default" : "secondary"}>{filing.earningsGroup ? "财报" : filing.form}</Badge><span>{filing.earningsGroup?.earningsDate ?? filing.filingDate} · {filing.earningsGroup ? `报告期 ${filing.earningsGroup.periodEnd}` : /10-K|20-F/.test(filing.form) ? "年度报告" : /10-Q/.test(filing.form) ? "季度报告" : "重大事项报告"}</span></li>)}</ul> : <p className="text-muted-foreground">暂无披露</p>}
    <Button variant="outline" className="w-full" onClick={onViewAll}>全部披露</Button>
  </section>;
}
