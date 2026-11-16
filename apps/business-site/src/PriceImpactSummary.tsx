import { ValuationAdjustmentSummary } from "./ValuationAdjustment";
import { messages, useLocale } from "@/packages/web/src/i18n";
import { perShare } from "@/shared/analysis-runtime/locale";
import { priceImpactOf } from "@/shared/analysis-runtime/price-impact";
import type { ValuationResponse } from "@/shared/analysis-contract/valuation";
import "./price-impact.css";

const m = messages({
  title: "Investment impact", companyReference: "Company valuation reference", quantified: "Scenario valuation available", sensitivity: "Sensitivity only", unavailable: "Not yet quantifiable",
  reference: "Frozen report reference", latest: "Updated market close", event: "Event model-value change", noEvent: "No matched before/after event model is available. The company valuation below is not this filing's incremental impact.",
  valueGap: "Base value vs frozen reference", market: "Market price change", details: "Open valuation and assumptions", asOf: (d: string) => `Research as of ${d}`,
  period: (d: string) => `Financial period ${d}`, earlier: "This valuation predates the report or uses another financial period; inclusion of this filing has not been established.",
  updating: "Research updating; new quantified conclusions are withheld.", incomplete: "A validated model, compatible share count and completed evidence review are required before price impact can be shown.",
  missing: "Inputs needed to quantify", noReference: "No usable frozen reference price", bear: "Bear", base: "Base", bull: "Bull", gap: "Vs frozen reference", scenario: "Scenario", value: "Per-share value", assumptions: "Assumptions and validation", noProbability: "Scenario points describe assumptions, not probabilities or a confidence interval.",
}, {
  title: "投资影响", companyReference: "公司估值参考", quantified: "情景估值可用", sensitivity: "仅可做敏感性", unavailable: "暂不可量化",
  reference: "报告冻结基准价", latest: "更新行情收盘价", event: "事件模型价值变化", noEvent: "尚无条件可比的事件前后模型。下方公司估值不代表本份财报带来的增量影响。",
  valueGap: "基准估值相对冻结股价", market: "市场价格变化", details: "查看估值与假设", asOf: (d: string) => `研究截至 ${d}`,
  period: (d: string) => `财务期间 ${d}`, earlier: "此估值早于本报告或采用其他财务期间，尚未确认已纳入本份文件。",
  updating: "研究更新中，暂不展示新的量化结论。", incomplete: "价格影响需要通过验证的模型、同口径股数及完成的证据复核。",
  missing: "量化所需输入", noReference: "缺少可用的冻结基准价", bear: "悲观", base: "基准", bull: "乐观", gap: "相对冻结基准价", scenario: "情景", value: "每股价值", assumptions: "假设与验证条件", noProbability: "情景点表达不同假设，不代表概率或置信区间。",
});
const pct = (n: number) => `${n > 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;

/** Both placements use the same version-bound projection; a filing does not borrow a company valuation's event attribution. */
export function PriceImpactSummary({ valuation, compact = false, reportGeneratedAt, financialPeriodEnd }: {
  valuation: ValuationResponse; compact?: boolean; reportGeneratedAt?: string; financialPeriodEnd?: string;
}) {
  const locale = useLocale();
  const report = valuation.report;
  const impact = report ? priceImpactOf(report, { latestQuote: valuation.priceGuide?.quote, outdated: valuation.outdated, dependencyStatus: valuation.researchStatus }) : null;
  const base = impact?.scenarios.find(s => s.key === "base");
  const earlier = !!impact && (!!financialPeriodEnd && financialPeriodEnd !== impact.financialPeriodEnd || !!reportGeneratedAt && impact.generatedAt < reportGeneratedAt);
  return <><ValuationAdjustmentSummary ticker={valuation.ticker} /><section className="price-impact" aria-label={m.title} data-price-impact={impact?.resultId ?? "unavailable"}>
    <header><h3>{compact ? m.title : m.companyReference}</h3><span>{impact?.quantificationStatus === "quantified" ? m.quantified : impact?.quantificationStatus === "sensitivity" ? m.sensitivity : m.unavailable}</span></header>
    {impact && <p className="price-impact-meta">{m.asOf(impact.valuationAsOf.slice(0, 10))} · {m.period(impact.financialPeriodEnd)}</p>}
    {earlier && <p className="price-impact-note">{m.earlier}</p>}
    <dl>
      <div><dt>{m.event}</dt><dd>{impact?.eventChange ? <>{perShare(impact.eventChange.absolute, impact.currency, locale)}{impact.eventChange.fraction != null && ` (${pct(impact.eventChange.fraction)})`}</> : m.unavailable}</dd></div>
      {impact?.referenceQuote && <div><dt>{m.reference}</dt><dd>{perShare(impact.referenceQuote.price, impact.currency, locale)} <small>{impact.referenceQuote.priceDate}</small></dd></div>}
      {base?.gapToReference != null && <div><dt>{m.valueGap}</dt><dd>{pct(base.gapToReference)}</dd></div>}
      {impact?.latestQuote && <div><dt>{m.latest}</dt><dd>{perShare(impact.latestQuote.price, impact.currency, locale)} <small>{impact.latestQuote.priceDate}</small></dd></div>}
      {impact?.marketChange && <div><dt>{m.market}</dt><dd>{pct(impact.marketChange.fraction)} <small>{impact.marketChange.fromDate} → {impact.marketChange.toDate}</small></dd></div>}
    </dl>
    {!impact?.eventChange && <p className="price-impact-note">{m.noEvent}</p>}
    {impact?.freshnessStatus === "updating" && <p className="price-impact-note">{m.updating}</p>}
    {(!impact || impact.quantificationStatus === "unavailable") && <p className="price-impact-note">{m.incomplete}</p>}
    {impact && !impact.referenceQuote && <p className="price-impact-note">{m.noReference}</p>}
    {!!impact?.missingInputs.length && <details><summary>{m.missing}</summary><ul>{impact.missingInputs.map((reason, i) => <li key={i}>{reason}</li>)}</ul></details>}
    {!compact && impact?.quantificationStatus === "quantified" && <>
      <div className="price-impact-table"><table><thead><tr><th>{m.scenario}</th><th>{m.value}</th><th>{m.gap}</th></tr></thead><tbody>{impact.scenarios.map(s => <tr key={s.key}><th>{m[s.key]}</th><td>{perShare(s.perShare, impact.currency, locale)}</td><td>{s.gapToReference == null ? "—" : pct(s.gapToReference)}</td></tr>)}</tbody></table></div>
      <p className="price-impact-note">{m.noProbability}</p>
    </>}
    {compact && <a href={`/companies/${encodeURIComponent(valuation.ticker)}?view=valuation${impact ? `&valuationVersion=${encodeURIComponent(impact.reportVersionId)}` : ""}`}>{m.details}</a>}
  </section></>;
}
