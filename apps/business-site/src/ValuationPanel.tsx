import { priceImpactOf } from "@/shared/analysis-runtime/price-impact";
import { priceGuideOf } from "@/shared/analysis-runtime/valuation/price-guide";
import { readValuationPublication } from "@/shared/analysis-runtime/valuation/read";
import { companyRequest } from "./company-request";
import { FilingImpactDetail } from "./FilingImpactSummary";
import { filingImpactSelection } from "@/shared/analysis-runtime/filing-impact";
import { Fragment, createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { markContent } from "./vitals";
import { Button } from "@/packages/web/src/ui/button";
import { labels, messages, useLocale } from "@/packages/web/src/i18n";
import { langOf } from "@/packages/web/src/i18n/SourceLanguage";
import { perShare, range as formatRange } from "@/shared/analysis-runtime/locale";
import { DIMENSION_WEIGHTS, VALUATION_DIMENSIONS, VALUATION_METHODS, type NormalCaseResult, type ScenarioEntry, type ValuationDimensionKey, type ValuationEvidence, type ValuationPublication, type ValuationResponse } from "@/shared/analysis-contract/valuation";
import type { ValuationPriceGuide } from "@/shared/analysis-contract/price-guide";
import { modelAtReferencePrice } from "@/shared/analysis-runtime/valuation/current-price";
import { track } from "./track";
import { citationOrder, pathLeaf, proseParts } from "./valuation-prose";
import { DualSpectrum, Radar, YearlyTrajectory } from "./ValuationCharts";
import "./valuation.css";

/**
 * Valuation stage panel (refined Case 2 workbench): three clearly delimited sections with medium headings —
 * core valuation range & radiating price forecast, interactive scenario path inspector, and auto-rotating
 * click-to-pause 5-dimension radar scorecard.
 */
const m = messages({
  title: "Valuation assessment",
  compositeScore: "Composite score", outOfTen: "/ 10",
  valuationRangeSection: "Valuation range & price projection",
  scores: "Five-dimension research score", partialResearch: "Research so far",
  preparing: "The assessment is being prepared", preparingNote: "Research runs over the filings, figures and calls on file; the report appears here once it is written and checked.",
  failed: "The last assessment did not complete", failedNote: "A new attempt starts when the company's material changes or the assessment is requested again.",
  insufficient: "Assessment incomplete", insufficientNote: "The available research is shown below; scores are withheld until the assessment is complete.",
  updating: "A newer assessment is in progress", attemptNotPublished: (date: string) => `The assessment of ${date} was not published.`, attemptFailed: "The latest assessment could not be completed.", attemptCounterEvidence: "Its review left decisive counter-evidence unanswered, so its assumptions need another look.", attemptIncomplete: "The latest assessment is incomplete.", attemptReview: "Its review did not complete.", attemptInsufficient: "It did not establish enough to replace the current report.", retained: (date: string) => `The report researched on ${date} stays in force.`,
  dimensions: "Five dimensions", confidence: "Confidence", researchDate: "Research date", financialBase: "Statements to", citedAs: (n: string) => `Source ${n}`,
  bear: "Bear", base: "Base", bull: "Bull", latestQuote: "Current close", noQuote: "No usable reference close",
  normalLower: "Normal lower", normalUpper: "Normal upper",
  marginOfSafety: "Margin of safety", discountToBase: "Discount to base", baseUpside: "To base value", expectedValue: "Scenario-weighted value",
  scenarios: "Scenarios", probability: "Probability", terminalShare: "Terminal value share",
  impliedGrowthShort: "Implied revenue growth", baseGrowthAvg: "Base avg", impliedNotConverged: "The reference close lies outside what the model's growth range can reproduce.",
  triggers: "Triggers", invalidation: "Invalidation",
  gaps: "Gaps", nextCheck: "Next check", source: "Source", openSource: "Open the filing", snapshot: "As read when the report was written", close: "Close",
  dcfValue: "Cash-flow value", weightedValue: "Weighted value", management: "Management",
  revenuePath: "Revenue path", marginPath: "Margin path", capexPath: "Capex path",
  fairRange: "12-month fair value range", centralValue: "Base value",
  below: "Below normal operating range", within: "Within normal operating range", above: "Above normal operating range", unable: "Unable to assess",
  lowConfidence: "Low confidence",
  noPositiveRange: "The model does not support a positive equity value range.", noRange: "A supported fair value range is not available.", noQuoteGuide: "A reference quote is not available.", unusableQuote: "The reference quote cannot be used for this comparison.", staleQuote: "The reference quote is out of date.", currencyMismatch: "The quote and valuation use different currencies.", incompleteResearch: "The research is not complete enough to assess fair value.", unresolvedEvidence: "Key valuation assumptions still need supporting evidence.", reportUpdating: "The current assessment needs updating.",
  scenarioInspector: "Scenario & operating path inspector",
  horizonShort: (months: number) => `Normal operating band · ${months} months forward`,
}, {
  title: "估值评估",
  compositeScore: "综合评分", outOfTen: "/ 10",
  valuationRangeSection: "核心估值与价格区间",
  scores: "五维研究评分", partialResearch: "已获取的研究信息",
  preparing: "评估正在准备", preparingNote: "研究基于已归档的申报、财务数据与电话会；报告写成并核验后会显示在这里。",
  failed: "上一次评估未完成", failedNote: "公司材料更新或再次请求评估时会开始新的尝试。",
  insufficient: "评估尚未完成", insufficientNote: "下方保留已有研究信息；评估完成前不展示评分。",
  updating: "新的评估正在进行", attemptNotPublished: (date: string) => `${date} 的评估未发布。`, attemptFailed: "本次评估未能完成。", attemptCounterEvidence: "复核发现决定性的反方证据未被回应，假设需要重新审视。", attemptIncomplete: "本次评估尚未完成。", attemptReview: "复核未完成。", attemptInsufficient: "结论不足以替换当前报告。", retained: (date: string) => `沿用 ${date} 研究的报告。`,
  dimensions: "五个维度", confidence: "置信度", researchDate: "研究日期", financialBase: "财务基期", citedAs: (n: string) => `来源 ${n}`,
  bear: "悲观", base: "基准", bull: "乐观", latestQuote: "最新参考价", noQuote: "无可用参考收盘价",
  normalLower: "正常下限", normalUpper: "正常上限",
  marginOfSafety: "安全边际", discountToBase: "相对基准折价", baseUpside: "至基准价值", expectedValue: "情景加权值",
  scenarios: "情景", probability: "概率", terminalShare: "终值占比",
  impliedGrowthShort: "现价隐含营收增长", baseGrowthAvg: "基准均值", impliedNotConverged: "参考收盘价超出模型增长区间能复现的范围。",
  triggers: "触发信号", invalidation: "失效条件",
  gaps: "缺口", nextCheck: "下一验证点", source: "来源", openSource: "打开申报原文", snapshot: "报告写成时读取的快照", close: "关闭",
  dcfValue: "现金流折现值", weightedValue: "加权价值", management: "管理层",
  revenuePath: "营收路径", marginPath: "利润率路径", capexPath: "资本开支路径",
  fairRange: "12 个月合理价值区间", centralValue: "基准价值",
  below: "低于正常经营区间", within: "处于正常经营区间", above: "高于正常经营区间", unable: "暂无法判断",
  lowConfidence: "置信度低",
  noPositiveRange: "模型尚不能支持正的股权价值区间。", noRange: "尚无有证据支持的合理价值区间。", noQuoteGuide: "暂无参考报价。", unusableQuote: "参考报价暂不适用于本次比较。", staleQuote: "参考报价已过期。", currencyMismatch: "报价与估值的币种不一致。", incompleteResearch: "研究材料尚不足以判断合理价值。", unresolvedEvidence: "关键估值假设仍缺少支持证据。", reportUpdating: "当前估值需要重新评估。",
  scenarioInspector: "情景与经营路径检视",
  horizonShort: (months: number) => `正常经营区间 · 未来 ${months} 个月`,
});

const METHOD = labels({ dcf: "Discounted cash flow", ev_ebitda_forward: "EV/EBITDA, forward", pe_forward: "P/E, forward" }, { dcf: "现金流折现", ev_ebitda_forward: "远期 EV/EBITDA", pe_forward: "远期 P/E" });

function guideReason(reason: Extract<ValuationPriceGuide, { status: "unavailable" }>["reason"]): string {
  switch (reason) {
    case "no_range": return m.noRange;
    case "non_positive_range": return m.noPositiveRange;
    case "no_quote": return m.noQuoteGuide;
    case "unusable_quote": return m.unusableQuote;
    case "stale_quote": return m.staleQuote;
    case "currency_mismatch": return m.currencyMismatch;
    case "incomplete_research": return m.incompleteResearch;
    case "unresolved_evidence": return m.unresolvedEvidence;
    case "report_updating": return m.reportUpdating;
  }
}
const CONF = labels({ high: "High", medium: "Medium", low: "Low" }, { high: "高", medium: "中", low: "低" });
const DIM = labels({ businessQuality: "Business quality", growthExecution: "Growth delivery", valuationSafety: "Valuation safety", mispricingCatalysts: "Mispricing and catalysts", financialResilience: "Financial resilience" }, { businessQuality: "生意质量", growthExecution: "增长兑现", valuationSafety: "估值安全", mispricingCatalysts: "错杀与催化", financialResilience: "财务韧性" });

const pct = (v: number | null | undefined, digits = 1) => v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "" : "−"}${(Math.abs(v) * 100).toFixed(digits)}%`;
const signedPct = (v: number | null | undefined) => v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${(Math.abs(v) * 100).toFixed(1)}%`;
const day = (iso: string) => iso.slice(0, 10);
const has = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);
const isEvidenceId = (id: string) => /^e[0-9a-f]{10}$/.test(id);

type Footnotes = { order: Map<string, number>; names: Map<string, string> };
const FootnotesContext = createContext<Footnotes>({ order: new Map(), names: new Map() });

function sourceName(e: ValuationEvidence): string {
  const leaf = pathLeaf(e.path);
  return leaf && leaf !== e.title ? `${e.title} · ${leaf}` : e.title;
}

function Cites({ ids, onCite }: { ids: string[]; onCite: (id: string) => void }) {
  const { order, names } = useContext(FootnotesContext);
  if (!ids.length) return null;
  return <sup className="val-refs">
    {ids.map((id, i) => {
      const n = order.get(id);
      return <Fragment key={`${id}-${i}`}>{i > 0 && ","}<Button variant="unstyled" type="button" className="val-ref" title={names.get(id)} aria-label={m.citedAs(String(n ?? "?"))} onClick={() => onCite(id)}>{n ?? "?"}</Button></Fragment>;
    })}
  </sup>;
}

function stripFactKeyLists(text: string): string {
  const isEvidence = (token: string) => /^e[0-9a-f]{10}$/.test(token);
  const isFactKey = (token: string) => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(token);
  const clean = (full: string, open: string, inner: string, close: string) => {
    const items = inner.split(",").map(s => s.trim()).filter(Boolean);
    if (!items.length || !items.some(isFactKey) || !items.every(t => isEvidence(t) || isFactKey(t))) return full;
    const kept = items.filter(isEvidence);
    const lead = full.slice(0, full.indexOf(open));
    return kept.length ? `${lead}${open}${kept.join(", ")}${close}` : "";
  };
  return text
    .replace(/\s*\[([^\]]+)\]/g, (full, inner: string) => clean(full, "[", inner, "]"))
    .replace(/\s*\(([^)]+)\)/g, (full, inner: string) => clean(full, "(", inner, ")"));
}

function readerText(text: string): string {
  const zh = /[\u3400-\u9fff]/.test(text);
  return stripFactKeyLists(text)
    .replace(/\bdebtDueCoverage\b/g, zh ? "短期到期债务覆盖倍数" : "short-term debt coverage")
    .replace(/\bcashRunway(?:Years|Months)?\b/g, key => zh ? `现金可支撑时长${key.endsWith("Years") ? "（年）" : key.endsWith("Months") ? "（月）" : ""}` : `cash runway${key.endsWith("Years") ? " (years)" : key.endsWith("Months") ? " (months)" : ""}`)
    .replace(/事实集中/g, "现有财务资料中").replace(/验证集中/g, "已核实资料中")
    .replace(/研究阶段在该维度记录之前结束[。.]?/g, "该项评估尚未完成。")
    .replace(/Not assessed: the research phase ended before this dimension was recorded\./g, "This part of the assessment is not yet complete.");
}

const hasCompleteScores = (report: ValuationPublication) => report.reportStatus === "ready"
  && report.weightedScore != null && Number.isFinite(report.weightedScore)
  && VALUATION_DIMENSIONS.every(key => report.dimensions.some(d => d.key === key && d.score != null && Number.isFinite(d.score)));

function baseMethods(report: ValuationPublication) {
  const valuation = report.model?.scenarios.base.valuation;
  return valuation ? VALUATION_METHODS.flatMap(key => {
    const value = valuation.methods[key], weight = valuation.weights[key];
    return value != null && weight > 0 ? [{ key, value, weight }] : [];
  }) : [];
}

function Prose({ text, onCite, as: Tag = "p" }: { text: string; onCite: (id: string) => void; as?: "p" | "li" | "span" }) {
  return <Tag lang={langOf(text)}>{proseParts(readerText(text)).map((part, i) => part.kind === "text" ? part.text : <Cites key={i} ids={part.ids} onCite={onCite} />)}</Tag>;
}

function KeyMetricsStrip({ report, guide }: { report: ValuationPublication; guide: ValuationPriceGuide }) {
  const locale = useLocale();
  const model = report.model;
  const fair = model?.fairValueRange;
  const normalOk = fair?.status === "available" && (guide.status === "available" || guide.reason === "no_quote" || guide.reason === "unusable_quote" || guide.reason === "stale_quote" || guide.reason === "currency_mismatch");
  const range = model?.range;
  const methods = baseMethods(report);
  const priceGap = guide.status === "available" ? guide.discountToBase : range?.marginOfSafety ?? null;
  const priceUpside = guide.status === "available" ? guide.gapToBase : range?.baseUpside ?? null;

  return (
    <dl className="val-kpis">
      <div className="val-kpi">
        <dt>{m.fairRange}</dt>
        <dd className="val-kpi-display">
          {normalOk ? formatRange(perShare(fair.low, report.currency, locale), perShare(fair.high, report.currency, locale), locale) : "—"}
        </dd>
        <dd className="val-kpi-sub">
          {normalOk ? m.horizonShort(model?.forward?.months ?? 12) : guide.status === "unavailable" ? guideReason(guide.reason) : ""}
        </dd>
      </div>
      <div className="val-kpi">
        <dt>{m.centralValue}</dt>
        <dd>{normalOk ? perShare(fair.base, report.currency, locale) : range ? perShare(range.base, report.currency, locale) : "—"}</dd>
        <dd className="val-kpi-sub">
          {methods.length > 0 && methods.map((item, idx) => `${idx > 0 ? " + " : ""}${METHOD[item.key]} ${pct(item.weight, 0)}`).join("")}
        </dd>
      </div>
      <div className="val-kpi">
        <dt>{guide.status === "available" ? m.discountToBase : m.marginOfSafety}</dt>
        <dd data-sign={priceGap != null ? (priceGap > 0 ? "up" : priceGap < 0 ? "down" : undefined) : undefined}>
          {priceGap != null ? pct(priceGap) : "—"}
        </dd>
        <dd className="val-kpi-sub">
          {priceUpside != null ? `${m.baseUpside} ${signedPct(priceUpside)}` : has(range?.expected) ? `${m.expectedValue} ${perShare(range!.expected!, report.currency, locale)}` : ""}
        </dd>
      </div>
      <div className="val-kpi">
        <dt>{m.impliedGrowthShort}</dt>
        <dd>{model?.implied?.converged ? pct(model.implied.implied) : "—"}</dd>
        <dd className="val-kpi-sub">
          {model?.implied?.converged ? `${m.baseGrowthAvg} ${pct(model.implied.baseAverage)}` : model?.implied ? m.impliedNotConverged : ""}
        </dd>
      </div>
    </dl>
  );
}

function Scores({ report, onCite }: { report: ValuationPublication; onCite: (id: string) => void }) {
  const complete = hasCompleteScores(report);
  const [selectedDim, setSelectedDim] = useState<ValuationDimensionKey>("businessQuality");
  const [autoPlay, setAutoPlay] = useState(true);
  const activeDim = report.dimensions.find(d => d.key === selectedDim) ?? report.dimensions[0] ?? null;

  useEffect(() => {
    if (!autoPlay || !complete || report.dimensions.length < 2) return;
    const timer = window.setInterval(() => {
      setSelectedDim(prev => {
        const keys = report.dimensions.map(d => d.key);
        const idx = keys.indexOf(prev);
        return keys[(idx + 1) % keys.length]!;
      });
    }, 3800);
    return () => window.clearInterval(timer);
  }, [autoPlay, complete, report.dimensions]);

  const selectDimension = (key: ValuationDimensionKey) => {
    setAutoPlay(false);
    setSelectedDim(key);
  };

  return (
    <section className="val-block val-section val-scores" data-incomplete={!complete || undefined} aria-label={complete ? m.scores : m.partialResearch}>
      <div className="val-section-head">
        <h3 className="val-section-title">{complete ? m.scores : m.partialResearch}</h3>
      </div>
      {complete && (
        <div className="val-score-side">
          <Radar report={report} label={key => DIM[key]} compact selectedKey={activeDim?.key} onSelect={selectDimension} />
        </div>
      )}
      <div className="val-score-rows">
        {!complete && (
          <div className="val-dim-tabs" role="tablist" aria-label={m.dimensions}>
            {report.dimensions.map(d => {
              const active = activeDim?.key === d.key;
              return (
                <Button
                  key={d.key}
                  variant="unstyled"
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className="val-dim-tab"
                  onClick={() => selectDimension(d.key)}
                >
                  <span>{DIM[d.key]}</span>
                </Button>
              );
            })}
          </div>
        )}
        <div className="val-dim-stage">
          {report.dimensions.map(dim => {
            const active = activeDim?.key === dim.key;
            return (
              <article
                key={dim.key}
                className="val-dim-card"
                role={!complete ? "tabpanel" : undefined}
                aria-label={DIM[dim.key]}
                aria-hidden={!active || undefined}
                data-active={active || undefined}
                inert={!active ? true : undefined}
              >
                <header className="val-dim-card-head">
                  <span className="val-dim-name">
                    {DIM[dim.key]}
                    {complete && <small>{pct(DIMENSION_WEIGHTS[dim.key], 0)}</small>}
                    {dim.confidence !== "medium" && <small>{m.confidence} {CONF[dim.confidence]}</small>}
                  </span>
                  {complete && dim.score != null && (
                    <span className="val-dim-score">{dim.score.toFixed(1)}<small>/10</small></span>
                  )}
                </header>
                <div className="val-dim-judgement">
                  <Prose text={dim.rationale} onCite={onCite} />
                  {dim.gaps.length > 0 && (
                    <p className="val-note">
                      <b>{m.gaps}</b>{" "}
                      {dim.gaps.map((g, i) => (
                        <span key={i} lang={langOf(g)}>
                          {readerText(g)}{i < dim.gaps.length - 1 ? "；" : ""}
                        </span>
                      ))}
                    </p>
                  )}
                  {dim.nextCheck && (
                    <p className="val-note">
                      <b>{m.nextCheck}</b>{" "}
                      <span lang={langOf(dim.nextCheck)}>{readerText(dim.nextCheck)}</span>
                    </p>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function Sources({ report, open, onClose }: { report: ValuationPublication; open: string | null; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const shown = report.evidence.find(e => e.evidenceId === open) ?? null;
  useEffect(() => { const d = dialog.current; if (!d) return; if (shown && !d.open) d.showModal(); else if (!shown && d.open) d.close(); }, [shown]);
  return (
    <dialog ref={dialog} className="val-dialog" onClose={onClose} aria-label={m.source}>
      {shown && (
        <div className="val-dialog-body">
          <header>
            <h3 lang="en">{shown.title}</h3>
            <Button variant="unstyled" type="button" className="icon-button" aria-label={m.close} onClick={onClose}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" /></svg>
            </Button>
          </header>
          <p className="val-dialog-meta">{shown.path && <span lang="en">{shown.path}</span>}{shown.publishedAt && <span>{day(shown.publishedAt)}</span>}<span>{m.snapshot}</span></p>
          <blockquote lang="en">{shown.excerpt}</blockquote>
          {shown.url && <a href={shown.url} target="_blank" rel="noreferrer noopener" onClick={() => track("source_click", { ticker: report.ticker })}>{m.openSource}</a>}
        </div>
      )}
    </dialog>
  );
}

function Status({ valuation }: { valuation: ValuationResponse }) {
  const attempt = valuation.latestAttempt, report = valuation.report;
  if (report && valuation.outdated) return <p className="val-banner" data-tone="info">{m.updating}</p>;
  if (report && attempt && attempt.updatedAt > report.generatedAt && ["failed", "empty", "superseded", "cancelled"].includes(attempt.status)) {
    const codes = new Set(attempt.gaps.map(g => g.code));
    const reason = attempt.status === "failed" ? m.attemptFailed : codes.has("unresolved_counter_evidence") ? m.attemptCounterEvidence : codes.has("research_budget_exhausted") ? m.attemptIncomplete : codes.has("review_incomplete") ? m.attemptReview : m.attemptInsufficient;
    return <p className="val-banner" data-tone="warn"><b>{m.attemptNotPublished(day(attempt.updatedAt))}</b> {reason} {m.retained(day(report.researchAsOf))}</p>;
  }
  if (report?.reportStatus === "insufficient") return <p className="val-banner" data-tone="warn"><b>{m.insufficient}</b> {m.insufficientNote}</p>;
  return null;
}

/* ==================== WORKBENCH VIEW ==================== */

type CaseKey = "bear" | "lower" | "base" | "upper" | "bull" | "management";

function WorkbenchView({ report, guide, onCite }: { report: ValuationPublication; guide: ValuationPriceGuide; onCite: (id: string) => void }) {
  const locale = useLocale();
  const model = report.model;
  const fair = model?.fairValueRange;

  const inspectorCases = useMemo(() => {
    if (!model) return [] as Array<{ key: CaseKey; label: string; value: number; entry: ScenarioEntry | NormalCaseResult }>;
    const list: Array<{ key: CaseKey; label: string; value: number; entry: ScenarioEntry | NormalCaseResult }> = [
      { key: "bear", label: m.bear, value: model.scenarios.bear.valuation?.perShare ?? model.scenarios.bear.result.perShare, entry: model.scenarios.bear },
    ];
    if (fair?.status === "available") {
      list.push({ key: "lower", label: m.normalLower, value: fair.low, entry: fair.lower });
    }
    list.push({ key: "base", label: m.base, value: model.scenarios.base.valuation?.perShare ?? model.scenarios.base.result.perShare, entry: model.scenarios.base });
    if (fair?.status === "available") {
      list.push({ key: "upper", label: m.normalUpper, value: fair.high, entry: fair.upper });
    }
    list.push({ key: "bull", label: m.bull, value: model.scenarios.bull.valuation?.perShare ?? model.scenarios.bull.result.perShare, entry: model.scenarios.bull });
    if (model.managementScenario) {
      list.push({ key: "management", label: m.management, value: model.managementScenario.valuation?.perShare ?? model.managementScenario.result.perShare, entry: model.managementScenario });
    }
    return list;
  }, [model, fair]);

  const [pickedCase, setPickedCase] = useState<CaseKey>("base");
  const activeCase = inspectorCases.find(c => c.key === pickedCase) ?? inspectorCases.find(c => c.key === "base") ?? inspectorCases[0] ?? null;

  return (
    <>
      <Scores key={report.versionId} report={report} onCite={onCite} />

      <section className="val-block val-section val-wb-top" aria-label={m.valuationRangeSection}>
        <div className="val-section-head">
          <h3 className="val-section-title">{m.valuationRangeSection}</h3>
        </div>
        <KeyMetricsStrip report={report} guide={guide} />
        {model && <DualSpectrum report={report} guide={guide} />}
      </section>

      {model && activeCase && (
        <section className="val-block val-section val-wb-inspector" aria-label={m.scenarioInspector}>
          <div className="val-wb-inspector-head">
            <h3 className="val-section-title">{m.scenarioInspector}</h3>
            <div className="val-wb-tabs" role="tablist" aria-label={m.scenarios}>
              {inspectorCases.map(c => (
                <Button
                  key={c.key}
                  variant="unstyled"
                  type="button"
                  role="tab"
                  aria-selected={activeCase.key === c.key}
                  className="val-wb-tab"
                  onClick={() => setPickedCase(c.key)}
                >
                  <span>{c.label}</span>
                  <b>{perShare(c.value, model.currency, locale)}</b>
                </Button>
              ))}
            </div>
          </div>

          <div className="val-wb-case-body">
            <div className="val-wb-case-summary">
              <div className="val-wb-case-metrics">
                <div><span>{m.weightedValue}</span><b>{perShare(activeCase.value, model.currency, locale)}</b></div>
                <div><span>{m.dcfValue}</span><b>{perShare(activeCase.entry.result.perShare, model.currency, locale)}</b></div>
                <div><span>{m.terminalShare}</span><b>{activeCase.entry.result.terminalShare != null ? pct(activeCase.entry.result.terminalShare, 0) : "—"}</b></div>
                {"probability" in activeCase.entry && activeCase.entry.probability != null && (
                  <div><span>{m.probability}</span><b>{pct(activeCase.entry.probability, 0)}</b></div>
                )}
              </div>
              <Prose text={activeCase.entry.narrative} onCite={onCite} />
              {activeCase.entry.assumptions && (
                <dl className="val-wb-paths">
                  <div><dt>{m.revenuePath}</dt><dd><Prose as="span" text={activeCase.entry.assumptions.revenue.rationale} onCite={onCite} /><Cites ids={activeCase.entry.assumptions.revenue.evidenceIds.filter(isEvidenceId)} onCite={onCite} /></dd></div>
                  <div><dt>{m.marginPath}</dt><dd><Prose as="span" text={activeCase.entry.assumptions.margin.rationale} onCite={onCite} /><Cites ids={activeCase.entry.assumptions.margin.evidenceIds.filter(isEvidenceId)} onCite={onCite} /></dd></div>
                  <div><dt>{m.capexPath}</dt><dd><Prose as="span" text={activeCase.entry.assumptions.capex.rationale} onCite={onCite} /><Cites ids={activeCase.entry.assumptions.capex.evidenceIds.filter(isEvidenceId)} onCite={onCite} /></dd></div>
                </dl>
              )}
              {(activeCase.entry.triggers.length > 0 || activeCase.entry.invalidation.length > 0) && (
                <div className="val-wb-conditions">
                  {activeCase.entry.triggers.length > 0 && (
                    <div>
                      <h5>{m.triggers}</h5>
                      <ul className="val-list">{activeCase.entry.triggers.map((t, i) => <li key={i} lang={langOf(t)}>{t}</li>)}</ul>
                    </div>
                  )}
                  {activeCase.entry.invalidation.length > 0 && (
                    <div>
                      <h5>{m.invalidation}</h5>
                      <ul className="val-list">{activeCase.entry.invalidation.map((t, i) => <li key={i} lang={langOf(t)}>{t}</li>)}</ul>
                    </div>
                  )}
                </div>
              )}
            </div>

            {activeCase.entry.drivers.modelType === "fcff" && activeCase.entry.result.yearly.length > 0 && (
              <YearlyTrajectory
                yearly={activeCase.entry.result.yearly}
                currency={report.currency}
                explicitCapital={!!activeCase.entry.drivers.path.capitalPlan}
                normalization={activeCase.entry.drivers.path.normalization}
              />
            )}
          </div>
        </section>
      )}
    </>
  );
}

/* ==================== FOOTNOTES & DOCUMENT SHELL ==================== */

function activeModelTexts(model: ValuationPublication["model"]): string[] {
  if (!model) return [];
  const ids = (list: string[]) => list.filter(isEvidenceId).map(id => `[${id}]`).join("");
  const fair = model.fairValueRange;
  const entries: Array<ScenarioEntry | NormalCaseResult> = [
    model.scenarios.bear,
    model.scenarios.base,
    model.scenarios.bull,
    ...(model.managementScenario ? [model.managementScenario] : []),
    ...(fair?.status === "available" ? [fair.lower, fair.upper] : []),
  ];
  return entries.flatMap(entry => [
    entry.narrative,
    ...(entry.assumptions
      ? [entry.assumptions.revenue, entry.assumptions.margin, entry.assumptions.capex].map(x => `${x.rationale} ${ids(x.evidenceIds)}`)
      : []),
  ]).filter(Boolean);
}

function footnotesOf(report: ValuationPublication): Footnotes {
  const fair = report.model?.fairValueRange;
  const texts = [
    fair?.status === "unavailable" ? fair.reason : "",
    ...report.dimensions.flatMap(d => [d.rationale, ...d.supportingEvidenceIds, ...d.counterEvidenceIds]),
    ...activeModelTexts(report.model),
  ].filter(Boolean);
  return { order: citationOrder(texts, report.evidence.map(e => e.evidenceId)), names: new Map(report.evidence.map(e => [e.evidenceId, sourceName(e)])) };
}

function ValuationDocument({ ticker, valuation }: { ticker: string; valuation: ValuationResponse }) {
  useEffect(() => { markContent("company"); }, []);
  const [open, setOpen] = useState<string | null>(null);
  const [shownTicker, setShownTicker] = useState(ticker);
  if (shownTicker !== ticker) { setShownTicker(ticker); setOpen(null); }

  const storedReport = valuation.report;
  const guide: ValuationPriceGuide = valuation.priceGuide && valuation.priceGuide.reportVersionId === storedReport?.versionId ? valuation.priceGuide : { status: "unavailable", reportVersionId: storedReport?.versionId ?? null, quote: null, reason: storedReport?.model?.fairValueRange?.status === "available" ? "no_quote" : "no_range" };
  const impact = storedReport ? priceImpactOf(storedReport, { outdated: valuation.outdated, dependencyStatus: valuation.researchStatus }) : null;
  const frozenQuote = impact?.referenceQuote ?? null;
  const price = frozenQuote?.price ?? null;
  const storedModel = impact?.quantificationStatus === "unavailable" ? undefined : storedReport?.model;
  const model = storedModel ? modelAtReferencePrice(storedModel, price) : null;
  const report = storedReport ? { ...storedReport, quote: frozenQuote, model } : null;
  const footnotes = useMemo(() => storedReport ? footnotesOf(storedReport) : null, [storedReport]);

  if (!report || !footnotes) {
    const failed = valuation.availability === "failed";
    return (
      <section className="lens val-panel val-panel--empty" aria-label={m.title}>
        <div className="lens-empty val-empty">
          <h2>{failed ? m.failed : m.preparing}</h2>
          <p>{failed ? m.failedNote : m.preparingNote}</p>
          {!failed && <i className="lens-loading" />}
        </div>
      </section>
    );
  }

  return (
    <FootnotesContext.Provider value={footnotes}>
      <section className="lens val-panel" aria-label={m.title} data-design-case="workbench">
        <div className="lens-doc val-doc" tabIndex={0}>
          <Status valuation={valuation} />
          <WorkbenchView report={report} guide={guide} onCite={setOpen} />
          <Sources report={report} open={open} onClose={() => setOpen(null)} />
        </div>
      </section>
    </FootnotesContext.Provider>
  );
}

const versionMessages = messages({ loading: "Loading the saved valuation…", failed: "This saved valuation could not be loaded.", current: "Current valuation", saved: "Saved valuation", versions: "Research versions" }, { loading: "正在读取历史估值…", failed: "无法读取此历史估值。", current: "当前估值", saved: "历史估值", versions: "研究版本" });

function CompanyValuationPanel({ ticker, valuation }: { ticker: string; valuation: ValuationResponse }) {
  const locale = useLocale();
  const [version, setVersion] = useState(() => typeof location === "undefined" ? null : new URLSearchParams(location.search).get("valuationVersion"));
  const [saved, setSaved] = useState<{ key: string; report: ValuationPublication | null; researchStatus?: ValuationResponse["researchStatus"] } | null>(null);
  const key = `${ticker}:${version}:${locale}`;
  useEffect(() => {
    const changed = () => setVersion(new URLSearchParams(location.search).get("valuationVersion"));
    window.addEventListener("popstate", changed);
    return () => window.removeEventListener("popstate", changed);
  }, []);
  useEffect(() => {
    if (!version || !/^[0-9a-f]{8,64}$/.test(version)) return;
    const abort = new AbortController();
    const url = `/api/business/v1/companies/${encodeURIComponent(ticker)}/valuation/versions/${version}?lang=${encodeURIComponent(locale)}`;
    companyRequest(url, abort.signal).then(async response => {
      if (!response.ok) throw new Error("version unavailable");
      const body = await response.json() as { report?: unknown; researchStatus?: ValuationResponse["researchStatus"] };
      const report = readValuationPublication(body.report, ticker);
      if (!abort.signal.aborted) setSaved({ key, report: report?.versionId === version ? report : null, researchStatus: body.researchStatus });
    }).catch(() => { if (!abort.signal.aborted) setSaved({ key, report: null }); });
    return () => abort.abort();
  }, [ticker, version, locale, key]);
  if (version && (!/^[0-9a-f]{8,64}$/.test(version) || saved?.key === key && !saved.report)) return <section className="lens val-panel val-panel--empty"><p role="alert">{versionMessages.failed}</p><a href={`/companies/${encodeURIComponent(ticker)}?view=valuation`}>{versionMessages.current}</a></section>;
  if (version && saved?.key !== key) return <section className="lens val-panel val-panel--empty"><p role="status">{versionMessages.loading}</p></section>;
  const historical = version && saved?.report ? saved.report : null;
  const shown: ValuationResponse = historical ? { ...valuation, report: historical, availability: historical.reportStatus === "ready" ? "ready" : "insufficient", outdated: false, latestAttempt: null, researchStatus: saved?.researchStatus, priceImpact: priceImpactOf(historical, { dependencyStatus: saved?.researchStatus }), priceGuide: priceGuideOf({ report: historical, quote: valuation.priceGuide?.quote ?? null, asOf: new Date().toISOString(), outdated: !!saved?.researchStatus && saved.researchStatus !== "valid" }) } : valuation;
  return <>
    {version && <p className="val-banner">{versionMessages.saved} · {historical?.researchAsOf.slice(0, 10)} · <a href={`/companies/${encodeURIComponent(ticker)}?view=valuation`}>{versionMessages.current}</a></p>}
    <ValuationDocument ticker={ticker} valuation={shown} />
  </>;
}

export function ValuationPanel(props: { ticker: string; valuation: ValuationResponse }) {
  const [selection, setSelection] = useState(() => filingImpactSelection(new URLSearchParams(location.search)));
  useEffect(() => {
    const changed = () => setSelection(filingImpactSelection(new URLSearchParams(location.search)));
    window.addEventListener("popstate", changed);
    return () => window.removeEventListener("popstate", changed);
  }, []);
  return selection ? <FilingImpactDetail {...props} selection={selection} /> : <CompanyValuationPanel {...props} />;
}
