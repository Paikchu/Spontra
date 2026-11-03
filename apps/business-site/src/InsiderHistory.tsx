import { Button } from "@/packages/web/src/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/packages/web/src/ui/table";
import { useMemo, useState } from "react";
import type { CompanyEvent, EventsPublication } from "@/shared/analysis-contract/events";
import { insiderPersonKey } from "@/shared/analysis-runtime/insiders";
import { perShare } from "@/shared/analysis-runtime/locale";
import { getLocale, messages } from "@/packages/web/src/i18n";
import { exactShares, insiderCompactMoney } from "./event-noise";
import { insiderTotalDollars } from "./events-model";
import { CODE_LABEL, fallbackInsiders, netValueUnknown, roleLabel, useInsiderHistory, useInsiders } from "./insiders-model";

const m = messages({
  history: (name: string) => `${name}: every Form 4 transaction`, date: "Date", transaction: "Transaction", shares: "Shares", amount: "Amount", ownedAfter: "Owned after", filing: "Filing",
  netSold: (amount: string, shares: string) => `Net sold ${amount} · ${shares} shares`, netBought: (amount: string, shares: string) => `Net bought ${amount} · ${shares} shares`,
  noTrades: "No open-market trades", sales: (n: number) => `${n} ${n === 1 ? "sale" : "sales"}`, purchases: (n: number) => `${n} ${n === 1 ? "purchase" : "purchases"}`, forms: (n: number) => `Form 4 ×${n}`,
  plan: "10b5-1 plan", indirect: "Indirect", derivative: "Derivative", newTag: "New", sec: "SEC filing ↗", open: (date: string) => `Open the filing of ${date}`,
  loadMore: "Load more", loadingHistory: "Loading…", historyFailed: "Couldn't load the history", retry: "Retry",
}, {
  history: (name: string) => `${name}：全部 Form 4 交易`, date: "日期", transaction: "交易", shares: "股数", amount: "金额", ownedAfter: "交易后持股", filing: "文件",
  netSold: (amount: string, shares: string) => `净卖出 ${amount} · ${shares} 股`, netBought: (amount: string, shares: string) => `净买入 ${amount} · ${shares} 股`,
  noTrades: "无公开市场交易", sales: (n: number) => `卖出 ${n} 笔`, purchases: (n: number) => `买入 ${n} 笔`, forms: (n: number) => `Form 4 ×${n}`,
  plan: "计划内", indirect: "间接持有", derivative: "衍生品", newTag: "新", sec: "SEC 文件 ↗", open: (date: string) => `打开 ${date} 的文件`,
  loadMore: "加载更多", loadingHistory: "加载中…", historyFailed: "交易历史暂时加载失败", retry: "重试",
});

const join = (parts: Array<string | null | false>) => parts.filter(Boolean).join(" · ");

/**
 * Every Form 4 transaction of the filer, newest first, a page at a time: from Spontra Analysis's ledger, which reaches
 * back past the rail, or paged from the publication's own filings until it answers. A line of a filing in the
 * publication opens that filing; the lines of the filing on stage are lit.
 */
export function PersonHistory({ event, publication, ticker, updates, onFocusEvent }: {
  event: CompanyEvent; publication: EventsPublication; ticker: string; updates: number; onFocusEvent: (id: string) => void;
}) {
  const [now] = useState(() => new Date());
  const key = insiderPersonKey(event.insider!);
  const events = useMemo(() => publication.events.filter(e => e.insider != null), [publication.events]);
  const fallback = useMemo(() => fallbackInsiders(ticker, events, now), [ticker, events, now]);
  const insiders = useInsiders(ticker, updates, () => fallback);
  const history = useInsiderHistory(ticker, key, insiders.source, events, now);
  const person = insiders.persons.find(p => p.key === key) ?? null;
  const filed = useMemo(() => new Set(events.map(e => e.id)), [events]);
  const name = person?.name ?? event.insider!.ownerName;
  let meta = "";
  if (person) {
    const traded = person.sold.count + person.bought.count > 0;
    // A net that leaves unpriced lines out is no net value: the amount reads "—" and the shares say which way it went.
    const value = netValueUnknown(person, events) ? null : person.net.value;
    const sold = value == null ? person.net.shares < 0 : value < 0 || (value === 0 && person.net.shares < 0);
    const net = traded ? (sold ? m.netSold : m.netBought)(value == null ? "—" : insiderCompactMoney(Math.abs(value)), exactShares(Math.abs(person.net.shares))) : m.noTrades;
    meta = join([roleLabel(person.role), net, person.sold.count > 0 && `${m.sales(person.sold.count)} ${insiderTotalDollars(person.sold)}`, person.bought.count > 0 && `${m.purchases(person.bought.count)} ${insiderTotalDollars(person.bought)}`, m.forms(person.filings)]);
  }
  return <div className="lens-doc-row insider-history">
    <h3 className="lens-row-title"><span lang="en">{name}</span>{meta && <small>{meta}</small>}</h3>
    <div className="lens-doc-cell">
      <div className="insider-history-scroll">
        <Table className="lens-table" aria-label={m.history(name)}>
          <TableHeader><TableRow>
            <TableHead scope="col">{m.date}</TableHead><TableHead scope="col">{m.transaction}</TableHead><TableHead scope="col">{m.shares}</TableHead>
            <TableHead scope="col">{m.amount}</TableHead><TableHead scope="col">{m.ownedAfter}</TableHead><TableHead scope="col">{m.filing}</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {history.items.map(row => {
              const tags = join([row.planned && m.plan, row.ownership === "I" && m.indirect, row.derivative && m.derivative]);
              const here = row.accession === event.id;
              return <TableRow key={row.id} data-lit={here ? "" : undefined} data-new={row.isNew ? "" : undefined}>
                <TableHead scope="row">{!here && filed.has(row.accession)
                  ? <Button variant="unstyled" type="button" className="insider-history-open" aria-label={m.open(row.date)} onClick={() => onFocusEvent(row.accession)}><time dateTime={row.date}>{row.date}</time></Button>
                  : <time dateTime={row.date}>{row.date}</time>}{row.isNew && <i className="insider-history-new">{m.newTag}</i>}</TableHead>
                <TableCell className="insider-history-code" data-side={row.side}><b lang="en">{row.code}</b>{CODE_LABEL[row.code]}{tags && <small>{tags}</small>}</TableCell>
                <TableCell>{exactShares(row.shares)}{row.price != null && <small>{perShare(row.price, "USD", getLocale())}</small>}</TableCell>
                <TableCell>{row.value != null && row.value > 0 ? insiderCompactMoney(row.value) : "—"}</TableCell>
                <TableCell>{row.ownedAfter != null ? exactShares(row.ownedAfter) : "—"}</TableCell>
                <TableCell><a href={row.filingUrl} target="_blank" rel="noopener noreferrer">{m.sec}</a></TableCell>
              </TableRow>;
            })}
          </TableBody>
        </Table>
      </div>
      {history.phase === "loading" && <p className="insider-history-state" aria-busy="true">{m.loadingHistory}</p>}
      {history.phase === "error" && <p className="insider-history-state">{m.historyFailed} <Button variant="unstyled" type="button" onClick={history.more}>{m.retry}</Button></p>}
      {history.phase === "ready" && history.nextCursor && <Button variant="unstyled" type="button" className="insider-history-more" onClick={history.more}>{m.loadMore}</Button>}
    </div>
  </div>;
}
