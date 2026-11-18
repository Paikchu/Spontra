import { useEffect, useState } from "react";
import { messages, useLocale, type Locale } from "@/packages/web/src/i18n";
import type { PublishedArtifact } from "@/shared/analysis-contract/artifact";
import type { FilingImpactPublication, FilingInvestmentChain } from "@/shared/analysis-contract/filing-impact";
import type { ValuationResponse } from "@/shared/analysis-contract/valuation";
import type { ValuationAdjustmentRead } from "@/shared/analysis-contract/valuation-adjustment";
import { filingImpactOf, filingImpactLink, validFilingImpactSelection, type FilingImpactSelection } from "@/shared/analysis-runtime/filing-impact";
import { impactResultValues, impactUnit } from "@/shared/analysis-runtime/price-impact";
import { compactShares, currencyName, multiple } from "@/shared/analysis-runtime/locale";
import { langOf, localize, type TranslationTable } from "@/shared/analysis-runtime/translation";
import releasedTranslations from "./filing-impact-translations.json";
import { useFilingEditions } from "./artifact-reads";
import { COMPANY_READ_SCHEMA } from "./company-opening";
import { PriceImpactSummary } from "./PriceImpactSummary";
import { ArtifactResearchContext } from "./ArtifactResearchContext";
import "./price-impact.css";

const m = messages({
  title: "This filing's investment impact", details: "Open financial bridge and valuation limits", company: "Company valuation reference · separate research", companyDetails: "Open company valuation", accession: "Source accession", edition: "Report edition", material: "Source material version",
  unavailable: "This edition has no saved structured investment bridge. The company valuation is separate research.", loading: "Loading this filing's saved investment bridge…", failed: "This exact filing edition is unavailable. No current or other report was substituted.",
  event: "Per-share event impact", notQuantifiable: "Not yet quantifiable", sensitivity_only: "Financial sensitivity", quantifiable: "Financial effect calculated", not_quantifiable: "Inputs missing",
  preview: "Unpublished preview · technical checks do not constitute human approval", stale: "Adopted research needs review. Derived financial and valuation outputs are suspended; the saved research and sources remain available.", staleChain: "Investment assumption requires dependency review", reviewPending: "Needs review",
  period: (d: string) => `Financial period ${d}`, asOf: (d: string) => `Research as of ${d}`, earlier: "Prior assumption / initial baseline", evidence: "New evidence", assumption: "Revised assumption", financial: "Financial transmission", valuation: "Per-share valuation limits", counter: "Counter-evidence", check: "Verification and window", missing: "Inputs needed", calculations: "Calculations and input units", sources: "Sources and exact edition", back: "Read filing", source: (n: number) => `Source ${n}`, stored: "Saved result", arithmetic: "Financial arithmetic; no event price is inferred", original: "Source excerpts retain their original language.", input: "Input", printed: "Source / printed units", normalized: "Calculation / base units",
  pretaxInterestChange: "Pre-tax interest change", newShares: "New shares", postFinancingShares: "Post-financing shares", postFinancingEquityValue: "Post-financing equity value", postFinancingPerShare: "Post-financing value per share", availableCash: "Available cash", fundingGap: "Funding gap", annualDepreciationChange: "Annual accounting depreciation change", verifiedCashOutflow: "Verified refund cash flow", revenueChange: "Revenue sensitivity", annualRevenuePerMw: "Annual revenue per MW", impliedGpuHourPrice: "Implied GPU-hour price", ratio: "Comparable-period ratio", eventValueChange: "Model-value change", eventValueChangeFraction: "Model-value change fraction", gapToReference: "Model vs frozen reference", marketChangeFraction: "Market price change",
}, {
  title: "本份财报的投资影响", details: "查看财务传导与估值缺口", company: "公司估值参考 · 独立研究", companyDetails: "查看公司估值", accession: "来源文件编号", edition: "报告版本", material: "来源材料版本",
  unavailable: "本稿尚无已保存的结构化投资影响。公司估值属于独立研究。", loading: "正在读取本稿已保存的投资影响…", failed: "无法读取此精确财报版本，未替换为当前或其他报告。",
  event: "事件对每股价值的影响", notQuantifiable: "暂不可量化", sensitivity_only: "财务敏感性", quantifiable: "财务影响已计算", not_quantifiable: "输入尚缺",
  preview: "未发布预览，技术校验不代表人工批准", stale: "采用的公共研究需要复核，暂停展示派生财务及估值结果；保留已保存的研究与来源。", staleChain: "投资假设需要复核引用依赖", reviewPending: "待复核",
  period: (d: string) => `财务期间 ${d}`, asOf: (d: string) => `研究截至 ${d}`, earlier: "原假设／首次基线", evidence: "新增证据", assumption: "修订假设", financial: "财务传导", valuation: "每股估值的边界", counter: "反证", check: "验证条件与时间", missing: "量化所需输入", calculations: "计算与输入单位", sources: "来源与精确版本", back: "阅读财报", source: (n: number) => `来源 ${n}`, stored: "保存结果", arithmetic: "财务算术，不据此推断事件股价", original: "出处中的引文保留原文语言。", input: "输入", printed: "原文／披露单位", normalized: "计算／基础单位",
  pretaxInterestChange: "税前利息变化", newShares: "新增股数", postFinancingShares: "融资后股数", postFinancingEquityValue: "融资后股权价值", postFinancingPerShare: "融资后每股价值", availableCash: "可用现金", fundingGap: "资金缺口", annualDepreciationChange: "年度会计折旧变化", verifiedCashOutflow: "已核实退款现金流", revenueChange: "收入敏感性", annualRevenuePerMw: "每兆瓦年收入", impliedGpuHourPrice: "隐含 GPU 小时单价", ratio: "可比期间比率", eventValueChange: "模型价值变化", eventValueChangeFraction: "模型价值变化比例", gapToReference: "估值相对冻结价", marketChangeFraction: "市场价格变化",
});

const valueNames = ["pretaxInterestChange", "newShares", "postFinancingShares", "postFinancingEquityValue", "postFinancingPerShare", "availableCash", "fundingGap", "annualDepreciationChange", "verifiedCashOutflow", "revenueChange", "annualRevenuePerMw", "impliedGpuHourPrice", "ratio", "eventValueChange", "eventValueChangeFraction", "gapToReference", "marketChangeFraction"] as const;
const valueLabel = (key: string) => valueNames.includes(key as typeof valueNames[number]) ? m[key as typeof valueNames[number]] : key;
const reviewedTranslations: Readonly<Record<string, TranslationTable>> = releasedTranslations;
const currencies = new Set(Intl.supportedValuesOf("currency"));
const percentUnits = new Set(["ratio", "decimal", "fraction", "ratedecimal", "percent", "ratepercent", "%"]);

function displayedValue(value: number, unit: string, locale: Locale): string {
  const parsed = impactUnit(unit);
  const base = value * (parsed?.scale ?? 1);
  const normalizedUnit = unit.toLowerCase().replace(/[\s_()]/g, "");
  if (percentUnits.has(normalizedUnit)) return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 }).format(base);
  if (parsed?.dimension === "shares") return compactShares(base, locale);
  if (parsed && currencies.has(parsed.dimension)) {
    const currency = parsed.dimension;
    const options: Intl.NumberFormatOptions = { maximumFractionDigits: 2, notation: Math.abs(base) >= 1e6 ? "compact" : "standard" };
    return locale === "zh-CN" ? new Intl.NumberFormat(locale, options).format(base) + currencyName(currency, locale)
      : new Intl.NumberFormat(locale, { ...options, style: "currency", currency }).format(base);
  }
  const amount = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
  return normalizedUnit === "x" ? multiple(amount, locale) : `${amount} ${unit}`;
}

function Amount({ value, unit, locale }: { value: number; unit: string; locale: Locale }) {
  return <strong><data value={value} data-unit={unit} title={`${value} ${unit}`}>{displayedValue(value, unit, locale)}</data></strong>;
}
function inputValue(calculation: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((value, part) => value && typeof value === "object" ? Reflect.get(value, part) : undefined, calculation);
}

function Calculation({ impact, id, locale, compact = false }: { impact: FilingImpactPublication; id: string; locale: Locale; compact?: boolean }) {
  const calculation = impact.calculations[id];
  if (!calculation) {
    const arithmetic = impact.arithmetic[id];
    return arithmetic ? <p className="filing-impact-calculation"><span lang={langOf(arithmetic.label)}>{arithmetic.label}</span>{" "}<Amount value={arithmetic.value} unit={arithmetic.unit} locale={locale} />{!compact && <><br /><small>{arithmetic.value} {arithmetic.unit} · {arithmetic.formula} · {m.arithmetic}</small></>}</p> : null;
  }
  const units = impactResultValues(calculation) ?? [];
  return <div className="filing-impact-calculation">
    {Object.entries(calculation.values).slice(0, compact ? 1 : undefined).map(([name, value], index) => <p key={name}>{valueLabel(name)}{" "}<Amount value={value} unit={units[index]?.unit ?? calculation.currency} locale={locale} />{!compact && <><br /><small>{calculation.formulas[name]}</small></>}</p>)}
    {!compact && <><ul>{[...calculation.missingInputs, ...calculation.limitations].map((text, index) => <li key={index} lang={langOf(text)}>{text}</li>)}</ul><details><summary>{m.calculations}</summary>
      <div className="price-impact-table"><table><thead><tr><th>{m.input}</th><th>{m.printed}</th><th>{m.normalized}</th></tr></thead><tbody>{calculation.provenance?.inputs.map(input => {
        const source = impact.sources.find(source => source.id === input.sourceId);
        const value = inputValue(calculation.provenance!.calculation, input.path);
        return <tr key={input.path}><th>{input.path}<small>{input.basis}</small></th><td>{source?.value == null ? input.rationale : `${source.shown ?? source.value} ${source.unit ?? ""}`}</td><td>{typeof value === "number" ? `${new Intl.NumberFormat(locale, { maximumFractionDigits: 8 }).format(value)} ${input.unit}` : "—"}</td></tr>;
      })}</tbody></table></div>
    </details></>}
  </div>;
}

function Chain({ chain, impact, compact, suspended, locale }: { chain: FilingInvestmentChain; impact: FilingImpactPublication; compact: boolean; suspended: boolean; locale: Locale }) {
  if (compact) return <article className="filing-impact-chain filing-impact-chain--compact" data-investment-chain={chain.id}>
    <details><summary><span lang={suspended ? undefined : langOf(chain.revisedAssumption)} className="filing-impact-preview">{suspended ? m.staleChain : chain.revisedAssumption}</span><small>{suspended ? m.reviewPending : m[chain.quantificationStatus]}{chain.missingInputs.length > 0 && <> · {m.missing} ({chain.missingInputs.length})</>}</small></summary>
      {!suspended && <><p lang={langOf(chain.financialEffect)}>{chain.financialEffect}</p><p lang={langOf(chain.valuationEffect)}>{chain.valuationEffect}</p></>}
      {!!chain.missingInputs.length && <ul>{chain.missingInputs.map((text, index) => <li key={index} lang={langOf(text)}>{text}</li>)}</ul>}
    </details>
    {!suspended && chain.computationRefs.slice(0, 1).map(id => <Calculation key={id} id={id} impact={impact} locale={locale} compact />)}
  </article>;
  return <article className="filing-impact-chain" data-investment-chain={chain.id}>
    <p lang={suspended ? undefined : langOf(chain.revisedAssumption)} className="filing-impact-assumption">{suspended ? m.staleChain : chain.revisedAssumption}</p>
    <small>{suspended ? m.reviewPending : m[chain.quantificationStatus]}</small>
    {!suspended && <p lang={langOf(chain.financialEffect)}>{chain.financialEffect}</p>}
    {!!chain.missingInputs.length && <ul className="price-impact-note">{chain.missingInputs.map((text, index) => <li key={index} lang={langOf(text)}>{text}</li>)}</ul>}
    <dl>
      <div><dt>{m.earlier}</dt><dd lang={langOf(chain.priorAssumption)}>{chain.priorAssumption}</dd></div>
      <div><dt>{m.evidence}</dt><dd lang={langOf(chain.newEvidence)}>{chain.newEvidence}</dd></div>
      {!suspended && <div><dt>{m.valuation}</dt><dd lang={langOf(chain.valuationEffect)}>{chain.valuationEffect}</dd></div>}
      <div><dt>{m.counter}</dt><dd lang={langOf(chain.counterEvidence)}>{chain.counterEvidence}</dd></div>
      <div><dt>{m.check}</dt><dd lang={langOf(chain.verification)}>{chain.verification} · {chain.window}</dd></div>
    </dl>{!suspended && chain.computationRefs.map(id => <Calculation key={id} id={id} impact={impact} locale={locale} />)}
  </article>;
}

/** Both placements read this exact frozen publication, with no company model or price substituted. */
export function FilingImpactSummary({ artifact, compact = false }: { artifact: PublishedArtifact | null; compact?: boolean }) {
  useLocale();
  const locale = artifact?.lang ?? "en";
  const saved = filingImpactOf(artifact);
  const impact = saved && locale === "zh-CN" ? localize("filing-impact", saved, {
    ...artifact?.filingImpactTranslations, ...reviewedTranslations[saved.resultId],
  }) : saved;
  const preview = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("artifact-preview");
  const suspended = !!artifact?.researchFreshness && artifact.researchFreshness !== "valid";
  return <section className="price-impact filing-impact" aria-label={m.title} data-filing-impact={impact?.resultId ?? "unavailable"} data-compact={compact}>
    <header><h3>{m.title}</h3><span>{m.notQuantifiable}</span></header>
    {!impact ? <p className="price-impact-note">{m.unavailable}</p> : <>
      <p className="price-impact-meta">{!compact && <>{m.period(impact.financialPeriodEnd)} · </>}{m.asOf(impact.researchAsOf.slice(0, 10))}</p>
      {artifact?.filingImpactState === "preview" && <p role="status">{m.preview}</p>}
      {suspended && <p role="status" className="price-impact-note">{m.stale}</p>}
      {!compact && <p>{m.event}: {m.notQuantifiable}</p>}
      {impact.chains.slice(0, compact ? 2 : undefined).map(chain => <Chain key={chain.id} chain={chain} impact={impact} compact={compact} suspended={suspended} locale={locale} />)}
      {!compact && <details><summary>{m.missing}</summary><ul>{impact.priceEffect.missingInputs.map((text, index) => <li key={index} lang={langOf(text)}>{text}</li>)}</ul></details>}
      {!compact && <details className="filing-impact-sources"><summary>{m.sources}</summary>
        <p className="price-impact-note">{m.original}</p>
        <dl><div><dt>{m.stored}</dt><dd>{impact.resultId}</dd></div><div><dt>{m.accession}</dt><dd>{impact.artifact.accession}</dd></div><div><dt>{m.edition}</dt><dd>v{impact.artifact.version} · {impact.artifact.hash}</dd></div><div><dt>{m.material}</dt><dd>{impact.material.version}</dd></div></dl>
        <ol>{impact.sources.map((source, index) => <li key={source.id}>{source.url ? <a href={source.url} target="_blank" rel="noreferrer">{source.title === source.id ? m.source(index + 1) : source.title}</a> : <span>{source.title === source.id ? m.source(index + 1) : source.title}</span>}{source.text && <details><summary>{m.evidence}</summary><blockquote lang={langOf(source.text)}>{source.text}</blockquote></details>}</li>)}</ol>
      </details>}
      {compact && artifact && <a href={filingImpactLink(artifact, locale, artifact.filingImpactState === "preview" ? preview : null)}>{m.details}</a>}
    </>}
  </section>;
}

export function CompanyValuationReference({ valuation }: { valuation: ValuationResponse | null | undefined }) {
  const id = new URLSearchParams(location.search).get("valuationAdjustment");
  const ticker = valuation?.ticker;
  const [saved, setSaved] = useState<{ id: string; ticker: string; value: ValuationAdjustmentRead | null } | null>(null);
  useEffect(() => {
    if (!ticker || !id || !/^[0-9a-f]{32}$/.test(id)) return;
    const abort = new AbortController();
    fetch(`/agents/valuation-adjustments/${id}`, { signal: abort.signal }).then(async response => response.ok ? response.json() as Promise<ValuationAdjustmentRead> : null).then(value => { if (!abort.signal.aborted) setSaved({ id, ticker, value }); }).catch(() => { if (!abort.signal.aborted) setSaved({ id, ticker, value: null }); });
    return () => abort.abort();
  }, [id, ticker]);
  if (!valuation) return null;
  const result = saved?.id === id && saved.ticker === valuation.ticker && saved.value?.status === "available" ? saved.value.result : null;
  const compatible = result && result.id === id && result.ticker === valuation.ticker && result.baseVersionId === result.input.baseVersionId && /^[0-9a-f]{8,64}$/.test(result.baseVersionId);
  const query = new URLSearchParams({ view: "valuation" });
  const version = compatible ? result.baseVersionId : valuation.report?.versionId;
  if (version) query.set("valuationVersion", version);
  if (compatible) query.set("valuationAdjustment", result.id);
  const pending = !!id && /^[0-9a-f]{32}$/.test(id) && (saved?.id !== id || saved.ticker !== valuation.ticker);
  return <details className="filing-company-reference"><summary>{m.company}</summary><PriceImpactSummary valuation={valuation} />{pending ? <p role="status">{m.loading}</p> : <a href={`/companies/${encodeURIComponent(valuation.ticker)}?${query}`}>{m.companyDetails}</a>}</details>;
}

/** A detail request retains either the signed preview or the published exact edition, never falls back to the current report. */
export function FilingImpactDetail({ ticker, selection, valuation }: { ticker: string; selection: FilingImpactSelection; valuation: ValuationResponse }) {
  const locale = useLocale();
  const validSelection = validFilingImpactSelection(selection);
  const params = new URLSearchParams({ artifactVersion: selection.version, artifactHash: selection.hash, schema: COMPANY_READ_SCHEMA });
  const url = selection.preview !== null ? `/api/business/v1/artifact-preview/${encodeURIComponent(selection.preview)}` : `/api/business/v1/companies/${encodeURIComponent(ticker)}/filings/${selection.accession}?${params}`;
  const editions = useFilingEditions<{ artifact?: PublishedArtifact | null }>(validSelection ? url : null, selection.preview === null);
  const loaded = editions[selection.preview === null ? locale : "en"];
  const artifact = loaded?.artifact;
  const valid = artifact && artifact.kind === "filing-report" && artifact.ticker === ticker && artifact.subject === selection.accession && artifact.version === Number(selection.version) && (artifact.sourceHash ?? artifact.hash) === selection.hash;
  return <section className="lens val-panel filing-impact-panel" aria-label={m.title}><div className="lens-doc val-doc" tabIndex={0}>
    {!validSelection || loaded !== undefined && !valid ? <p role="alert">{m.failed}</p> : !valid ? <p role="status">{m.loading}</p> : <>
      <h2 lang={artifact.lang}>{artifact.title}</h2><FilingImpactSummary artifact={artifact} />
      <ArtifactResearchContext artifact={artifact} />
      <a href={`/companies/${encodeURIComponent(ticker)}?report=${selection.accession}&artifactVersion=${selection.version}&artifactHash=${selection.hash}&lang=${locale}${selection.preview ? `&artifact-preview=${encodeURIComponent(selection.preview)}` : ""}`}>{m.back}</a>
      <CompanyValuationReference valuation={valuation} />
    </>}
  </div></section>;
}
