"use client";
import { useLanguage } from "@/app/language-provider";
import { money, number, percent } from "@/lib/portfolio-format";
import type { PositionGroupView } from "@/lib/portfolio-view-model";
import { Badge } from "@/components/ui/badge";
import { OptionContractLabel } from "@/app/portfolio/option-contract-label";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";

export function PositionHoldings({ ticker, position }: { ticker: string; position?: PositionGroupView }) {
  const { t } = useLanguage();
  return (<>
{position ? (
        <>
          <section className="position-summary" aria-label={`${ticker} 持仓摘要`}>
            <article><span>{t("净市值")}</span><strong>{money(position.value)}</strong></article>
            <article><span>{t("净权重")}</span><strong>{percent(position.weight)}</strong></article>
            <article><span>{t("持仓成本")}</span><strong>{money(position.cost)}</strong></article>
            <article><span>{t("未实现盈亏")}</span><strong className={position.unrealized < 0 ? "loss" : "gain"}>{money(position.unrealized)}</strong></article>
            <article><span>{t("年内净盈亏")}</span><strong className={position.netPnl < 0 ? "loss" : "gain"}>{money(position.netPnl)}</strong></article>
          </section>

          <section className="instrument-section" id="position-structure" aria-label={t("持仓构成")}>
            <div className="table-wrap">
              <Table className="instrument-table" aria-label={`${ticker} 正股与期权明细`}>
                <TableHeader><TableRow><TableHead>{t("类型")}</TableHead><TableHead>{t("资产 / 合约")}</TableHead><TableHead>{t("数量")}</TableHead><TableHead>{t("现价")}</TableHead><TableHead>{t("平均成本")}</TableHead><TableHead>{t("实际成本")}</TableHead><TableHead>{t("持仓成本")}</TableHead><TableHead>{t("市值")}</TableHead><TableHead>{t("权重")}</TableHead><TableHead>{t("未实现盈亏")}</TableHead></TableRow></TableHeader>
                <TableBody>
                  {position.stock && <TableRow><TableCell className="instrument-type" data-label={t("类型")}><Badge variant="secondary">{t("正股")}</Badge></TableCell><TableCell className="instrument-name" data-label={t("资产 / 合约")}><strong>{position.stock.name}</strong></TableCell><TableCell data-label={t("数量")}>{number(position.stock.quantity, 0, 4)}</TableCell><TableCell data-label={t("现价")}>{money(position.stock.price)}</TableCell><TableCell data-label={t("平均成本")}>{money(position.stock.averageCost)}</TableCell><TableCell data-label={t("实际成本")}>{money(position.stock.actualCost)}</TableCell><TableCell data-label={t("持仓成本")}>{money(position.stock.cost)}</TableCell><TableCell data-label={t("市值")}>{money(position.stock.value)}</TableCell><TableCell data-label={t("权重")}>{percent(position.stock.weight)}</TableCell><TableCell data-label={t("未实现盈亏")} className={position.stock.unrealized < 0 ? "loss" : "gain"}>{money(position.stock.unrealized)}</TableCell></TableRow>}
                  {position.options.map((option) => <TableRow key={option.contract}><TableCell className="instrument-type" data-label={t("类型")}><Badge variant="outline">{t("期权")}</Badge></TableCell><TableCell className="instrument-name" data-label={t("资产 / 合约")}><OptionContractLabel contract={option.contract} underlyingPrice={position.stock?.price} /></TableCell><TableCell data-label={t("数量")}>{number(option.quantity, 0, 4)}</TableCell><TableCell data-label={t("现价")}>{money(option.price)}</TableCell><TableCell data-label={t("平均成本")}>{money(option.averageCost)}</TableCell><TableCell className="muted" data-label={t("实际成本")}>—</TableCell><TableCell data-label={t("持仓成本")}>{money(option.cost)}</TableCell><TableCell data-label={t("市值")}>{money(option.marketValue)}</TableCell><TableCell data-label={t("权重")}>{percent(option.weight)}</TableCell><TableCell data-label={t("未实现盈亏")} className={option.unrealized < 0 ? "loss" : "gain"}>{money(option.unrealized)}</TableCell></TableRow>)}
                </TableBody>
              </Table>
            </div>
          </section>
        </>
      ) : (
        <section id="position-structure" className="mt-6"><Empty><EmptyHeader><EmptyTitle>{t("暂无持仓数据")}</EmptyTitle><EmptyDescription>{t("这份计划不会写入 IBKR 账本；建立持仓后，快照数据会自动出现在这里。")}</EmptyDescription></EmptyHeader></Empty></section>
      )}
  </>);
}
