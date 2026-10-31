import { getLocale, messages } from "@/packages/web/src/i18n";
import { compactMoney, shortPeriod } from "@/shared/analysis-runtime/locale";
import { buybacksAgainstStockPay, type ReturnWindow, type ShareholderReturns as Returns } from "./shareholder-returns";

const m = messages({
  title: "Shareholder returns", ttm: "Last 4 quarters", to: (period: string) => `to ${period}`, fy: (year: number) => `FY${year}`,
  buybacks: "Buybacks", dividends: "Dividends", total: "Total returned", ofFcf: "of free cash flow", yield: "Shareholder yield", yieldTip: "Buybacks plus dividends over market value",
  undisclosed: "Not disclosed", fcfNegative: "FCF not positive",
  more: (buybacks: string, sbc: string, x: string) => `Buybacks of ${buybacks} over the last four quarters were ${x}× stock-based compensation (${sbc}), more than offsetting the dilution it brings.`,
  less: (buybacks: string, sbc: string, pct: string) => `Buybacks of ${buybacks} over the last four quarters were ${pct} of stock-based compensation (${sbc}), short of offsetting its dilution.`,
  source: "Source", quarters: "By quarter",
}, {
  title: "股东回报", ttm: "近 4 季", to: (period: string) => `截至 ${period}`, fy: (year: number) => `${year} 财年`,
  buybacks: "回购", dividends: "分红", total: "合计", ofFcf: "占自由现金流", yield: "股东回报率", yieldTip: "回购与分红之和 ÷ 市值",
  undisclosed: "未披露", fcfNegative: "自由现金流非正",
  more: (buybacks: string, sbc: string, x: string) => `近 4 季回购 ${buybacks}，是同期股权激励 ${sbc} 的 ${x} 倍，足以抵消其带来的稀释。`,
  less: (buybacks: string, sbc: string, pct: string) => `近 4 季回购 ${buybacks}，仅为同期股权激励 ${sbc} 的 ${pct}，不足以抵消其带来的稀释。`,
  source: "来源", quarters: "分季",
});

const pct = (v: number) => `${(v * 100).toFixed(v >= 0.995 || v < 0.1 ? 1 : 0)}%`;

/**
 * The cash-flow view's shareholder-returns card: the last four quarters and the last three fiscal years, each with
 * buybacks, dividends, their total against free cash flow and, for the four quarters, against market value when one
 * is held. A figure the filings do not tag says so. One column on phones.
 */
export function ShareholderReturns({ returns }: { returns: Returns }) {
  const locale = getLocale();
  const money = (v: number | null) => v == null ? null : compactMoney(v, returns.currency, locale);
  const against = buybacksAgainstStockPay(returns);
  const note = against ? (against.ratio >= 1
    ? m.more(money(against.buybacks)!, money(against.stockCompensation)!, against.ratio.toFixed(1))
    : m.less(money(against.buybacks)!, money(against.stockCompensation)!, pct(against.ratio))) : null;
  const cell = (w: ReturnWindow) => {
    const title = w.kind === "ttm" ? m.ttm : m.fy(w.fiscalYear!);
    const sub = w.kind === "ttm" ? m.to(shortPeriod(w.periodEnd)) : `${w.periodStart ? shortPeriod(w.periodStart) : ""}–${shortPeriod(w.periodEnd)}`;
    const share = w.ofFreeCashFlow != null ? `${pct(w.ofFreeCashFlow)} ${m.ofFcf}` : w.total != null && w.freeCashFlow != null ? m.fcfNegative : null;
    return <article className="returns-cell" data-kind={w.kind} key={`${w.kind}:${w.periodEnd}`}>
      <h3>{title}<small>{sub}</small></h3>
      <dl>
        <div><dt>{m.buybacks}</dt><dd data-missing={w.buybacks == null || undefined}>{money(w.buybacks) ?? m.undisclosed}</dd></div>
        <div><dt>{m.dividends}</dt><dd data-missing={w.dividends == null || undefined}>{money(w.dividends) ?? m.undisclosed}</dd></div>
        <div className="returns-total"><dt>{m.total}</dt><dd data-missing={w.total == null || undefined}>{money(w.total) ?? m.undisclosed}{share && <small>{share}</small>}</dd></div>
        {w.kind === "ttm" && returns.yield != null && <div><dt title={m.yieldTip}>{m.yield}</dt><dd>{pct(returns.yield)}</dd></div>}
      </dl>
      {w.kind === "ttm" && <ol className="returns-quarters" aria-label={m.quarters}><li className="returns-quarters-head" aria-hidden="true"><span>{m.quarters}</span><span>{m.buybacks}</span><span>{m.dividends}</span></li>{returns.quarters.map(q => <li key={q.periodEnd}>
        <span>{shortPeriod(q.periodEnd)}</span>
        <span data-missing={q.buybacks == null || undefined}>{money(q.buybacks) ?? m.undisclosed}</span>
        <span data-missing={q.dividends == null || undefined}>{money(q.dividends) ?? m.undisclosed}</span>
      </li>)}</ol>}
    </article>;
  };
  return <section className="returns" aria-label={m.title}>
    <header className="returns-head"><h2>{m.title}</h2>{note && <p className="returns-note">{note}</p>}</header>
    <div className="returns-grid">{[returns.ttm, ...returns.years].map(cell)}</div>
    <p className="returns-source">{m.source} · SEC XBRL <code>PaymentsForRepurchaseOfCommonStock</code> <code>PaymentsOfDividends</code></p>
  </section>;
}
