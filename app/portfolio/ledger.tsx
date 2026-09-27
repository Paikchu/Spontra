"use client";

import { useLanguage } from "@/app/language-provider";
import { Empty, EmptyHeader, EmptyDescription } from "@/components/ui/empty";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChevronUp, ChevronDown, CalendarDays } from "lucide-react";
import { Fragment, useMemo, useState, type CSSProperties } from "react";
import Link from "@/packages/ui/src/navigation";
import { sortPositionGroups, type PositionSortKey, type SortDirection } from "@/lib/portfolio-dashboard";
import { buildEarningsReminder, type EarningsEvent } from "@/lib/earnings-calendar";
import { money, number, percent } from "@/lib/portfolio-format";
import { heatmapThemeColor } from "@/lib/portfolio-heatmap";
import type { HistoricalPositionGroupView, PositionGroupView } from "@/lib/portfolio-view-model";
import { CompanyLogo } from "../company-logo";
import { OptionContractLabel } from "./option-contract-label";
import { type QuoteLoadStatus } from "../use-market-quotes";
import type { MarketQuoteMap } from "@/lib/yahoo-quotes";

import { Pnl } from "./pnl";

function PositionReminder({ event, asOf }: { event?: EarningsEvent; asOf: string }) {
  const { t } = useLanguage();
  if (!event) return null;

  const reminder = buildEarningsReminder(event, asOf);
  return (
    <span
      className="position-reminder"
      title={`美股 ${reminder.releaseDateLabel}${reminder.sessionLabel}发布；北京 ${reminder.viewDateLabel}${reminder.viewTimeLabel}查看`}
    >
      <strong>{reminder.releaseDateLabel} · {reminder.sessionLabel}</strong>
      <small>{t("北京")}{reminder.viewDateLabel}{reminder.viewTimeLabel} · {reminder.countdownLabel}</small>
    </span>
  );
}

type LedgerSortKey = PositionSortKey | "price" | "changePercent" | "actualCost";
const ledgerColumns: Array<{ key: LedgerSortKey; label: string }> = [
  { key: "symbol", label: "标的" },
  { key: "price", label: "现价" },
  { key: "changePercent", label: "日涨跌" },
  { key: "value", label: "净市值" },
  { key: "weight", label: "净权重" },
  { key: "actualCost", label: "摊薄成本" },
  { key: "cost", label: "持仓成本" },
  { key: "unrealized", label: "未实现盈亏" },
  { key: "realized", label: "年内已实现" },
  { key: "netPnl", label: "年内净盈亏" },
];

export function PositionLedger({
  groups,
  activeSymbol,
  onActiveSymbolChange,
  quotes,
  quoteStatus,
  earningsBySymbol,
  earningsUpdatedAt,
}: {
  groups: PositionGroupView[];
  activeSymbol: string | null;
  onActiveSymbolChange: (symbol: string | null) => void;
  quotes: MarketQuoteMap;
  quoteStatus: QuoteLoadStatus;
  earningsBySymbol: Map<string, EarningsEvent>;
  earningsUpdatedAt: string;
}) {
  const { t } = useLanguage();
  const [collapsedOptions, setCollapsedOptions] = useState<ReadonlySet<string>>(() => new Set());
  const [sortKey, setSortKey] = useState<LedgerSortKey>("weight");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const sortedGroups = useMemo(() => {
    if (sortKey !== "price" && sortKey !== "changePercent" && sortKey !== "actualCost") {
      return sortPositionGroups(groups, sortKey, sortDirection);
    }
    const value = (group: PositionGroupView) => sortKey === "actualCost"
      ? group.stock?.actualCost : quotes[group.symbol]?.[sortKey];
    return [...groups].sort((left, right) => {
      const a = value(left), b = value(right);
      if (a == null) return b == null ? 0 : 1;
      if (b == null) return -1;
      return (a - b) * (sortDirection === "asc" ? 1 : -1);
    });
  }, [groups, quotes, sortDirection, sortKey]);

  return (
    <div className="position-scroll" aria-label={t("按 Ticker 分类的持仓")}>
      <Table className="ledger-table" aria-label={t("投资账本")}>
        <TableHeader>
          <TableRow>
            {ledgerColumns.map((column) => (
              <TableHead key={column.key} scope="col" aria-sort={sortKey === column.key ? (sortDirection === "desc" ? "descending" : "ascending") : "none"}>
                <Button variant="ghost" size="sm" type="button"
                  aria-label={`${t(column.label)}，点击${sortKey === column.key && sortDirection === "desc" ? t("升序") : t("降序")}`}
                  onClick={() => {
                    setSortDirection(sortKey === column.key && sortDirection === "desc" ? "asc" : "desc");
                    setSortKey(column.key);
                  }}>
                  {t(column.label)}
                  <span className="ledger-sort-arrows" aria-hidden="true">
                    <ChevronUp data-active={sortKey === column.key && sortDirection === "asc"} />
                    <ChevronDown data-active={sortKey === column.key && sortDirection === "desc"} />
                  </span>
                </Button>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedGroups.map((group) => (
            <Fragment key={group.symbol}>
              <TableRow className="ledger-data-row" data-state={activeSymbol === group.symbol ? "selected" : undefined}
                style={{ "--holding-color": heatmapThemeColor(group.symbol) } as CSSProperties}
                onFocus={() => onActiveSymbolChange(group.symbol)}
                onBlur={() => onActiveSymbolChange(null)}
                onMouseEnter={() => onActiveSymbolChange(group.symbol)}
                onMouseLeave={() => onActiveSymbolChange(null)}>
                <TableCell>
                  <div className="ledger-identity">
                    <Link href={`/positions/${encodeURIComponent(group.symbol)}`} className="ledger-symbol">
                      <i className="holding-mark" aria-hidden="true" />
                      <CompanyLogo symbol={group.symbol} />
                      <strong>{group.symbol}</strong><span className="sr-only">{t("，查看持仓详情")}</span>
                    </Link>
                    {earningsBySymbol.has(group.symbol) && <TooltipProvider><Tooltip><TooltipTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`${group.symbol} 财报提醒`}><CalendarDays /></Button>
                    </TooltipTrigger><TooltipContent><PositionReminder event={earningsBySymbol.get(group.symbol)} asOf={earningsUpdatedAt} /></TooltipContent></Tooltip></TooltipProvider>}
                    {group.options.length > 0 && (
                      <Button variant="ghost" size="sm" type="button" className="ledger-option-toggle"
                        aria-expanded={!collapsedOptions.has(group.symbol)}
                        aria-controls={group.options.map((_, index) => `ledger-option-${group.symbol}-${index}`).join(" ")}
                        aria-label={`${collapsedOptions.has(group.symbol) ? t("展开") : t("收起")} ${group.symbol} ${t("期权")}`}
                        onClick={() => setCollapsedOptions((current) => {
                          const next = new Set(current);
                          if (!next.delete(group.symbol)) next.add(group.symbol);
                          return next;
                        })}>
                        <ChevronDown aria-hidden="true" /><small>{group.options.length}</small>
                      </Button>
                    )}
                  </div>
                </TableCell>
                <TableCell>{quotes[group.symbol] ? money(quotes[group.symbol].price) : <span className="quote-muted">{quoteStatus === "loading" ? t("读取中") : "—"}</span>}</TableCell>
                <TableCell><span className="daily-change-value" data-direction={quotes[group.symbol]?.changePercent < 0 ? "loss" : quotes[group.symbol]?.changePercent > 0 ? "gain" : "neutral"}>{quotes[group.symbol] ? percent(quotes[group.symbol].changePercent, true) : "—"}</span></TableCell>
                <TableCell>{money(group.value)}</TableCell>
                <TableCell>{percent(group.weight)}</TableCell>
                <TableCell>{group.stock ? money(group.stock.actualCost) : <span className="quote-muted">—</span>}</TableCell>
                <TableCell>{money(group.cost)}</TableCell>
                <TableCell><Pnl value={group.unrealized} /></TableCell>
                <TableCell><Pnl value={group.realized} /></TableCell>
                <TableCell><Pnl value={group.netPnl} /></TableCell>
              </TableRow>
              {!collapsedOptions.has(group.symbol) && group.options.map((option, index) => (
                <TableRow className="ledger-option-row" key={option.contract}
                  id={`ledger-option-${group.symbol}-${index}`}
                  aria-label={`${group.symbol} ${t("期权")}`}
                  data-state={activeSymbol === group.symbol ? "selected" : undefined}
                  onMouseEnter={() => onActiveSymbolChange(group.symbol)}
                  onMouseLeave={() => onActiveSymbolChange(null)}>
                  <TableCell>
                    <OptionContractLabel contract={option.contract} quantity={option.quantity}
                      underlyingPrice={quotes[group.symbol]?.price} asOf={earningsUpdatedAt} />
                  </TableCell>
                  <TableCell>{money(option.price)}</TableCell>
                  <TableCell><span className="quote-muted">—</span></TableCell>
                  <TableCell>{money(option.marketValue)}</TableCell>
                  <TableCell>{percent(option.weight)}</TableCell>
                  <TableCell title={t("平均权利金")}>{money(option.averageCost)}</TableCell>
                  <TableCell>{money(option.cost)}</TableCell>
                  <TableCell><Pnl value={option.unrealized} /></TableCell>
                  <TableCell><span className="quote-muted">—</span></TableCell>
                  <TableCell><span className="quote-muted">—</span></TableCell>
                </TableRow>
              ))}
            </Fragment>
          ))}
          {sortedGroups.length === 0 && <TableRow><TableCell colSpan={ledgerColumns.length}><Empty><EmptyHeader><EmptyDescription>{t("当前快照没有持仓。")}</EmptyDescription></EmptyHeader></Empty></TableCell></TableRow>}
        </TableBody>
      </Table>
    </div>
  );
}

type HistoricalSortKey = keyof Pick<HistoricalPositionGroupView,
  "symbol" | "firstTradeDate" | "lastTradeDate" | "stockTrades" | "optionTrades" | "realized"
>;

const historicalLedgerColumns: Array<{ key: HistoricalSortKey; label: string }> = [
  { key: "symbol", label: "标的" },
  { key: "firstTradeDate", label: "首次交易" },
  { key: "lastTradeDate", label: "最近交易" },
  { key: "stockTrades", label: "正股成交" },
  { key: "optionTrades", label: "期权成交" },
  { key: "realized", label: "累计已实现盈亏" },
];

export function HistoricalPositionLedger({ groups }: { groups: HistoricalPositionGroupView[] }) {
  const { t } = useLanguage();
  const [sortKey, setSortKey] = useState<HistoricalSortKey>("lastTradeDate");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const sortedGroups = useMemo(() => [...groups].sort((left, right) => {
    const a = left[sortKey];
    const b = right[sortKey];
    const comparison = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
    return comparison * (sortDirection === "asc" ? 1 : -1);
  }), [groups, sortDirection, sortKey]);

  return (
    <div className="position-scroll" aria-label={t("按 Ticker 分类的历史持仓")}>
      <Table className="ledger-table historical-ledger-table" aria-label={t("历史投资账本")}>
        <TableHeader>
          <TableRow>
            {historicalLedgerColumns.map((column) => (
              <TableHead key={column.key} scope="col" aria-sort={sortKey === column.key ? (sortDirection === "desc" ? "descending" : "ascending") : "none"}>
                <Button variant="ghost" size="sm" type="button"
                  aria-label={`${t(column.label)}，点击${sortKey === column.key && sortDirection === "desc" ? t("升序") : t("降序")}`}
                  onClick={() => {
                    setSortDirection(sortKey === column.key && sortDirection === "desc" ? "asc" : "desc");
                    setSortKey(column.key);
                  }}>
                  {t(column.label)}
                  <span className="ledger-sort-arrows" aria-hidden="true">
                    <ChevronUp data-active={sortKey === column.key && sortDirection === "asc"} />
                    <ChevronDown data-active={sortKey === column.key && sortDirection === "desc"} />
                  </span>
                </Button>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedGroups.map((group) => (
            <TableRow className="ledger-data-row" key={group.symbol}
              style={{ "--holding-color": heatmapThemeColor(group.symbol) } as CSSProperties}>
              <TableCell>
                <Link href={`/positions/${encodeURIComponent(group.symbol)}`} className="ledger-symbol">
                  <i className="holding-mark" aria-hidden="true" />
                  <CompanyLogo symbol={group.symbol} />
                  <strong>{group.symbol}</strong>
                </Link>
              </TableCell>
              <TableCell>{group.firstTradeDate}</TableCell>
              <TableCell>{group.lastTradeDate}</TableCell>
              <TableCell>{number(group.stockTrades, 0, 0)}{t(" 笔")}</TableCell>
              <TableCell>{number(group.optionTrades, 0, 0)}{t(" 笔")}</TableCell>
              <TableCell><Pnl value={group.realized} /></TableCell>
            </TableRow>
          ))}
          {sortedGroups.length === 0 && <TableRow><TableCell colSpan={historicalLedgerColumns.length}><Empty><EmptyHeader><EmptyDescription>{t("Flex 成交记录中还没有已清仓标的。")}</EmptyDescription></EmptyHeader></Empty></TableCell></TableRow>}
        </TableBody>
      </Table>
    </div>
  );
}
