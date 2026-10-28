import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/packages/web/src/ui/button";
import { getLocale, labels, messages, useLocale } from "@/packages/web/src/i18n";
import { SourceLanguage, langOf } from "@/packages/web/src/i18n/SourceLanguage";
import { compactMoney, compactShares, perShare } from "@/shared/analysis-runtime/locale";
import { DIMENSION_WEIGHTS, VALUATION_DIMENSIONS, type ValuationDimension, type ValuationDimensionKey, type ValuationEvidence, type ValuationPublication, type ValuationResponse } from "@/shared/analysis-contract/valuation";
import { fetchValuationVersion } from "./company-data";
import { track } from "./track";
import "./valuation.css";

/**
 * The valuation assessment on the company stage (docs/valuation-assessment-implementation.md §9): the verdict and score, the
 * five dimensions as a radar and a list, the three-scenario range against the reference close, the model's inputs and
 * sensitivities, the written case, and the sources, each opening the snapshot the report was written from. Every number
 * shown was calculated or read by Spontra Analysis; the page only lays them out.
 */
const m = messages({
  title: "Valuation assessment", 
  score: "Composite score", unscored: "Not scored", confidence: "Confidence", 
  researchDate: "Research date", financialBase: "Statements to", version: "Version", current: "Current", generated: (date: string) => `Generated ${date}`,
  preparing: "The assessment is being prepared", preparingNote: "Research runs over the filings, figures and calls on file; the report appears here once it is written and checked.",
  failed: "The last assessment did not complete", failedNote: "A new attempt starts when the company's material changes or the assessment is requested again.",
  insufficient: "Not enough material for a complete assessment", insufficientNote: "The parts that could be established are shown; the gaps below say what is missing.",
  updating: "A newer assessment is in progress", updateFailed: "The latest attempt did not complete; this report stands",
  dimensions: "Five dimensions", weight: (value: string) => `Weight ${value}`, radarNote: "The radar needs all five scores",
  
  range: "Value per share", bear: "Bear", base: "Base", bull: "Bull", expected: "Expected", price: "Reference close", priceDate: (date: string) => `Close of ${date}`,
  marginOfSafety: "Margin of safety", baseUpside: "To base value", expectedUpside: "To expected value", downside: "Bear case vs. price", noQuote: "No usable reference close",
  model: "Model", 
  discountRate: "Discount rate", wacc: "WACC", costOfEquity: "Cost of equity", shares: "Economic shares", dilution: (value: string) => ` (incl. dilution reserve ${value})`, rateBasis: (basis: string) => ` (${basis})`, bridge: "Equity bridge", nonOperating: "Non-operating assets", claims: "Debt and other claims",
  scenarios: "Scenarios", probability: "Probability", perShareValue: "Per share", terminalShare: "Terminal value share", growth: "Revenue growth", margin: "Operating margin", drivers: "Average over five years",
  sensitivities: "Sensitivity of the base value", implied: "What the price implies", impliedText: (implied: string, base: string) => `A constant revenue growth of ${implied} a year reproduces the reference close; the base case averages ${base}.`, impliedNotConverged: "The reference close lies outside what the model's growth range can reproduce.",
  limitations: "Model limitations", inputs: "Model inputs", triggers: "Triggers", invalidation: "Invalidation", showModel: "Show model inputs", hideModel: "Hide model inputs",
  summary: "Summary", thesis: "Thesis", expectationsGap: "Expectations gap", catalysts: "Catalysts", counterEvidence: "Counter-evidence", nextChecks: "Next checks", modelNotes: "Model notes",
  evidence: "Supporting evidence", counter: "Against", gaps: "Gaps", nextCheck: "Next check", diagnostics: "Diagnostics", sources: "Sources", source: "Source", openSource: "Open the filing", snapshot: "As read when the report was written", close: "Close",
  history: "History of each factor", years: (n: number) => `${n} years`, median: "Median", rangeLabel: "Range",
  
}, {
  title: "估值评估",
  score: "综合分", unscored: "未评分", confidence: "置信度",
  researchDate: "研究日期", financialBase: "财务基期", version: "版本", current: "当前", generated: (date: string) => `生成于 ${date}`,
  preparing: "评估正在准备", preparingNote: "研究基于已归档的申报、财务数据与电话会；报告写成并核验后会显示在这里。",
  failed: "上一次评估未完成", failedNote: "公司材料更新或再次请求评估时会开始新的尝试。",
  insufficient: "材料不足，评估尚不完整", insufficientNote: "已能确认的部分照常展示；下方缺口说明还缺什么。",
  updating: "新的评估正在进行", updateFailed: "最近一次尝试未完成，当前报告继续有效",
  dimensions: "五个维度", weight: (value: string) => `权重 ${value}`, radarNote: "五维齐全时才绘制雷达图",
 
  range: "每股价值", bear: "悲观", base: "基准", bull: "乐观", expected: "期望", price: "参考收盘价", priceDate: (date: string) => `${date} 收盘`,
  marginOfSafety: "安全边际", baseUpside: "至基准价值", expectedUpside: "至期望价值", downside: "悲观情景相对现价", noQuote: "无可用参考收盘价",
  model: "模型",
  discountRate: "折现率", wacc: "加权平均资本成本", costOfEquity: "权益成本", shares: "经济股数", dilution: (value: string) => `（含稀释储备 ${value}）`, rateBasis: (basis: string) => `（${basis}）`, bridge: "股权桥接", nonOperating: "非经营资产", claims: "债务及其他索偿",
  scenarios: "情景", probability: "概率", perShareValue: "每股", terminalShare: "终值占比", growth: "收入增长", margin: "营业利润率", drivers: "五年平均",
  sensitivities: "基准价值的敏感性", implied: "现价隐含的预期", impliedText: (implied: string, base: string) => `收入每年恒定增长 ${implied} 即可复现参考收盘价；基准情景平均为 ${base}。`, impliedNotConverged: "参考收盘价超出模型增长区间能复现的范围。",
  limitations: "模型局限", inputs: "模型输入", triggers: "触发信号", invalidation: "失效条件", showModel: "展开模型输入", hideModel: "收起模型输入",
  summary: "结论", thesis: "论证", expectationsGap: "预期差", catalysts: "催化", counterEvidence: "反证", nextChecks: "下一验证点", modelNotes: "模型说明",
  evidence: "支持证据", counter: "反证", gaps: "缺口", nextCheck: "下一验证点", diagnostics: "诊断指标", sources: "来源", source: "来源", openSource: "打开申报原文", snapshot: "报告写成时读取的快照", close: "关闭",
  history: "各因子历史", years: (n: number) => `${n} 年`, median: "中位数", rangeLabel: "区间",
 
});
const VERDICT = labels({ supported: "Evidence supports mispricing", not_supported: "Mispricing not supported", pending: "Pending verification" }, { supported: "有证据支持错杀", not_supported: "不支持错杀", pending: "待验证" });
const CONF = labels({ high: "High", medium: "Medium", low: "Low" }, { high: "高", medium: "中", low: "低" });
const DIM = labels({ businessQuality: "Business quality", growthExecution: "Growth delivery", valuationSafety: "Valuation safety", mispricingCatalysts: "Mispricing and catalysts", financialResilience: "Financial resilience" }, { businessQuality: "生意质量", growthExecution: "增长兑现", valuationSafety: "估值安全", mispricingCatalysts: "错杀与催化", financialResilience: "财务韧性" });
const MODEL_TYPE = labels({ fcff: "Free cash flow to the firm (driver-based)", fcfe: "Free cash flow to equity", revenue_fcfe: "Revenue-driven equity cash flow", residual_income: "Residual income", earnings_multiple: "Guided earnings multiple", reported_earnings_multiple: "Reported earnings multiple", proforma_earnings_multiple: "Pro forma earnings multiple", asset_nav: "Net asset value", affo_multiple: "AFFO multiple", affo_dcf: "AFFO discounted cash flow" }, { fcff: "企业自由现金流（驱动因子）", fcfe: "股权自由现金流", revenue_fcfe: "收入驱动股权现金流", residual_income: "剩余收益", earnings_multiple: "指引盈利倍数", reported_earnings_multiple: "已报盈利倍数", proforma_earnings_multiple: "备考盈利倍数", asset_nav: "资产净值", affo_multiple: "AFFO 倍数", affo_dcf: "AFFO 现金流折现" });
const FACTOR = labels({ revenueGrowth: "Revenue growth", operatingMargin: "Operating margin", netMargin: "Net margin", fcfMargin: "Free cash flow margin", capexToRevenue: "Capex to revenue", sbcToRevenue: "Stock compensation to revenue", returnOnEquity: "Return on equity", discountRate: "Discount rate", salesToCapital: "Sales to capital", terminalGrowth: "Terminal growth", terminalRoic: "Terminal ROIC", roe: "Return on equity", terminalRoe: "Terminal ROE", multiple: "Multiple", assetPrices: "Asset prices", afterSbcEquityCashMargin: "Equity cash margin" }, { revenueGrowth: "收入增长", operatingMargin: "营业利润率", netMargin: "净利率", fcfMargin: "自由现金流率", capexToRevenue: "资本开支占收入", sbcToRevenue: "股权激励占收入", returnOnEquity: "净资产收益率", discountRate: "折现率", salesToCapital: "销售资本比", terminalGrowth: "终值增长", terminalRoic: "终期 ROIC", roe: "净资产收益率", terminalRoe: "终期 ROE", multiple: "倍数", assetPrices: "资产价格", afterSbcEquityCashMargin: "权益现金利润率" });
const DIAG = labels({ revenueGrowthTtm: "Revenue growth (TTM)", roic: "ROIC", accrualRatio: "Accrual ratio", fcfConversion: "FCF conversion", sbcToRevenue: "SBC / revenue", capexToDa: "Capex / D&A", netDebtToEbitda: "Net debt / EBITDA", interestCoverage: "Interest coverage", dilutionCagr: "Share count change", cashRunwayYears: "Cash runway", debtDueCoverage: "Cash / debt due" },
  { revenueGrowthTtm: "收入增长（近四季）", roic: "投入资本回报率", accrualRatio: "应计比率", fcfConversion: "自由现金流转化", sbcToRevenue: "股权激励占收入", capexToDa: "资本开支 / 折旧摊销", netDebtToEbitda: "净债务 / EBITDA", interestCoverage: "利息覆盖倍数", dilutionCagr: "股数年化变化", cashRunwayYears: "现金跑道", debtDueCoverage: "现金 / 一年内到期债务" });

const pct = (v: number | null | undefined, digits = 1) => v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "" : "−"}${(Math.abs(v) * 100).toFixed(digits)}%`;
const signedPct = (v: number | null | undefined) => v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${(Math.abs(v) * 100).toFixed(1)}%`;
const day = (iso: string) => iso.slice(0, 10);
const CITE = /\[(e[0-9a-f]{10})\]/g;
const verdictTone = { supported: "up", not_supported: "loss", pending: "neutral" } as const;

/** Generated prose with its evidence citations turned into source chips. */
function Prose({ text, onCite, as: Tag = "p" }: { text: string; onCite: (id: string) => void; as?: "p" | "li" }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(CITE)) {
    const at = match.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    const id = match[1]!;
    parts.push(<Button key={`${id}-${at}`} variant="unstyled" type="button" className="val-cite" onClick={() => onCite(id)} aria-label={`${m.source} ${id}`}>{id.slice(1, 5)}</Button>);
    last = at + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <Tag lang={langOf(text)}>{parts}</Tag>;
}

function Radar({ dimensions }: { dimensions: ValuationDimension[] }) {
  const complete = dimensions.every(d => d.score != null);
  const n = VALUATION_DIMENSIONS.length, size = 220, c = size / 2, r = 84;
  const point = (i: number, value: number) => { const a = -Math.PI / 2 + i * 2 * Math.PI / n; return [c + Math.cos(a) * r * value, c + Math.sin(a) * r * value] as const; };
  const ring = (value: number) => VALUATION_DIMENSIONS.map((_, i) => point(i, value).join(",")).join(" ");
  const shape = complete ? VALUATION_DIMENSIONS.map((key, i) => point(i, (dimensions.find(d => d.key === key)!.score ?? 0) / 10).join(",")).join(" ") : null;
  return <figure className="val-radar" aria-label={m.dimensions}>
    <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-hidden={!complete}>
      {[0.25, 0.5, 0.75, 1].map(v => <polygon key={v} className="val-radar-ring" points={ring(v)} />)}
      {VALUATION_DIMENSIONS.map((_, i) => { const [x, y] = point(i, 1); return <line key={i} className="val-radar-axis" x1={c} y1={c} x2={x} y2={y} />; })}
      {shape && <polygon className="val-radar-shape" points={shape} />}
      {shape && VALUATION_DIMENSIONS.map((key, i) => { const [x, y] = point(i, (dimensions.find(d => d.key === key)!.score ?? 0) / 10); return <circle key={key} className="val-radar-dot" cx={x} cy={y} r={3} />; })}
      {VALUATION_DIMENSIONS.map((key, i) => { const [x, y] = point(i, 1.22); return <text key={key} className="val-radar-label" x={x} y={y} textAnchor={Math.abs(x - c) < 12 ? "middle" : x < c ? "end" : "start"} dominantBaseline="middle">{DIM[key]}</text>; })}
    </svg>
    {!complete && <figcaption>{m.radarNote}</figcaption>}
  </figure>;
}

function RangeBar({ report }: { report: ValuationPublication }) {
  const locale = useLocale();
  const model = report.model;
  if (!model) return null;
  const { range } = model;
  const values = [range.low, range.base, range.high, range.expected ?? range.base, range.price ?? range.base].filter(v => Number.isFinite(v));
  const lo = Math.min(...values, 0), hi = Math.max(...values) * 1.08 || 1;
  const x = (v: number) => `${((v - lo) / (hi - lo) * 100).toFixed(2)}%`;
  const money = (v: number) => perShare(v, model.currency, locale);
  const marks: Array<[string, number, string]> = [[m.bear, range.low, "bear"], [m.base, range.base, "base"], [m.bull, range.high, "bull"]];
  if (range.expected != null) marks.push([m.expected, range.expected, "expected"]);
  return <div className="val-range" role="img" aria-label={[m.range, ...marks.map(([label, v]) => `${label} ${money(v)}`), ...(range.price != null ? [`${m.price} ${money(range.price)}`] : [])].join(" · ")}>
    <div className="val-range-track">
      <span className="val-range-band" style={{ left: x(range.low), width: `calc(${x(range.high)} - ${x(range.low)})` }} />
      {marks.map(([label, v, kind]) => <span key={kind} className="val-range-mark" data-kind={kind} style={{ left: x(v) }}><i /><b>{money(v)}</b><small>{label}</small></span>)}
      {range.price != null && <span className="val-range-mark val-range-price" style={{ left: x(range.price) }}><i /><b>{money(range.price)}</b><small>{m.price}</small></span>}
    </div>
  </div>;
}

function Sensitivities({ report }: { report: ValuationPublication }) {
  const locale = useLocale();
  const model = report.model;
  if (!model?.sensitivities.length) return null;
  const max = Math.max(...model.sensitivities.map(s => Math.abs(s.changePercent)), 1);
  return <ol className="val-sens" aria-label={m.sensitivities}>
    {model.sensitivities.map(s => <li key={s.factor}>
      <span className="val-sens-label">{FACTOR[s.factor as keyof typeof FACTOR] ?? s.factor} <small>{s.step}</small></span>
      <span className="val-sens-bar"><i data-sign={s.changePercent >= 0 ? "up" : "down"} style={{ width: `${Math.abs(s.changePercent) / max * 100}%` }} /></span>
      <b>{s.changePercent >= 0 ? "+" : "−"}{Math.abs(s.changePercent).toFixed(1)}% · {perShare(s.perShare, model.currency, locale)}</b>
    </li>)}
  </ol>;
}

const avg = (list: number[]) => list.reduce((a, b) => a + b, 0) / Math.max(list.length, 1);

function Model({ report, onCite }: { report: ValuationPublication; onCite: (id: string) => void }) {
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const model = report.model;
  if (!model) return null;
  const rate = model.discountRate;
  return <section className="val-block">
    <h3>{m.model}</h3>
    <p className="val-model-line">{MODEL_TYPE[model.modelType]} · {m.discountRate} {pct(rate.value)}{m.rateBasis(rate.basis === "wacc" ? m.wacc : m.costOfEquity)} · {m.shares} {compactShares(model.shares.economic, locale)}{model.shares.dilutionReserve ? m.dilution(compactShares(model.shares.dilutionReserve, locale)) : ""}</p>
    <table className="val-table"><thead><tr><th>{m.scenarios}</th><th>{m.perShareValue}</th><th>{m.probability}</th><th>{m.growth}</th><th>{m.margin}</th><th>{m.terminalShare}</th></tr></thead><tbody>
      {(["bear", "base", "bull"] as const).map(key => { const s = model.scenarios[key]; const d = s.drivers as { path?: { revenueGrowth?: number[]; operatingMargin?: number[] } };
        return <tr key={key}><th>{m[key]}</th><td>{perShare(s.result.perShare, model.currency, locale)}</td><td>{s.probability != null ? pct(s.probability, 0) : "—"}</td><td>{d.path?.revenueGrowth ? pct(avg(d.path.revenueGrowth)) : "—"}</td><td>{d.path?.operatingMargin ? pct(avg(d.path.operatingMargin)) : "—"}</td><td>{s.result.terminalShare != null ? pct(s.result.terminalShare, 0) : "—"}</td></tr>; })}
    </tbody></table>
    {model.implied && <p className="val-implied"><b>{m.implied}</b> {model.implied.converged ? m.impliedText(pct(model.implied.implied), pct(model.implied.baseAverage)) : m.impliedNotConverged}</p>}
    <h4>{m.sensitivities}</h4>
    <Sensitivities report={report} />
    <Button variant="unstyled" type="button" className="val-toggle" aria-expanded={open} onClick={() => setOpen(v => !v)}>{open ? m.hideModel : m.showModel}</Button>
    {open && <div className="val-model-detail">
      {(["bear", "base", "bull"] as const).map(key => { const s = model.scenarios[key]; return <div key={key} className="val-scenario">
        <h5>{m[key]}</h5>
        <Prose text={s.narrative} onCite={onCite} />
        {s.triggers.length > 0 && <p className="val-list-line"><b>{m.triggers}</b> {s.triggers.map((t, i) => <span key={i} lang={langOf(t)}>{t}{i < s.triggers.length - 1 ? "; " : ""}</span>)}</p>}
        {s.invalidation.length > 0 && <p className="val-list-line"><b>{m.invalidation}</b> {s.invalidation.map((t, i) => <span key={i} lang={langOf(t)}>{t}{i < s.invalidation.length - 1 ? "; " : ""}</span>)}</p>}
      </div>; })}
      <p className="val-list-line"><b>{m.bridge}</b> {m.nonOperating} {compactMoney(model.bridge.nonOperatingAssets, model.currency, locale)} · {m.claims} {compactMoney(model.bridge.debtAndClaims, model.currency, locale)}</p>
      <p className="val-list-line" lang={langOf(rate.rationale)}><b>{m.discountRate}</b> {rate.rationale}</p>
      {model.limitations.length > 0 && <p className="val-list-line"><b>{m.limitations}</b> {model.limitations.map((t, i) => <span key={i} lang={langOf(t)}>{t} </span>)}</p>}
      <table className="val-table val-table--facts"><thead><tr><th>{m.inputs}</th><th></th><th></th></tr></thead><tbody>
        {report.facts.map(f => <tr key={f.id}><th lang="en">{f.label}</th><td>{f.unit === "ratio" ? pct(f.value) : f.unit === "shares" ? compactShares(f.value, locale) : compactMoney(f.value, f.currency, locale)}</td><td><small>{f.periodEnd ?? ""} · {f.basis}</small></td></tr>)}
      </tbody></table>
    </div>}
  </section>;
}

function Dimensions({ report, onCite }: { report: ValuationPublication; onCite: (id: string) => void }) {
  return <section className="val-block">
    <h3>{m.dimensions}</h3>
    {report.dimensions.map(d => <article key={d.key} className="val-dim">
      <header><h4>{DIM[d.key]}</h4><span className="val-dim-score">{d.score != null ? d.score.toFixed(1) : m.unscored}</span><small>{m.confidence} {CONF[d.confidence]} · {m.weight(pct(DIMENSION_WEIGHTS[d.key], 0))}</small></header>
      <Prose text={d.rationale} onCite={onCite} />
      <p className="val-chips">
        {d.supportingEvidenceIds.length > 0 && <span><b>{m.evidence}</b> {d.supportingEvidenceIds.map(id => <Button key={id} variant="unstyled" type="button" className="val-cite" onClick={() => onCite(id)}>{id.slice(1, 5)}</Button>)}</span>}
        {d.counterEvidenceIds.length > 0 && <span><b>{m.counter}</b> {d.counterEvidenceIds.map(id => <Button key={id} variant="unstyled" type="button" className="val-cite val-cite--counter" onClick={() => onCite(id)}>{id.slice(1, 5)}</Button>)}</span>}
      </p>
      {d.gaps.length > 0 && <p className="val-list-line"><b>{m.gaps}</b> {d.gaps.map((g, i) => <span key={i} lang={langOf(g)}>{g}{i < d.gaps.length - 1 ? "; " : ""}</span>)}</p>}
      <p className="val-list-line"><b>{m.nextCheck}</b> <span lang={langOf(d.nextCheck)}>{d.nextCheck}</span></p>
    </article>)}
  </section>;
}

function Sources({ report, open, onOpen, onClose }: { report: ValuationPublication; open: string | null; onOpen: (id: string) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const shown = report.evidence.find(e => e.evidenceId === open) ?? null;
  useEffect(() => { const d = dialog.current; if (!d) return; if (shown && !d.open) d.showModal(); else if (!shown && d.open) d.close(); }, [shown]);
  return <section className="val-block">
    <h3>{m.sources}</h3>
    <ol className="val-sources">
      {report.evidence.map(e => <li key={e.evidenceId}><Button variant="unstyled" type="button" className="val-source" onClick={() => onOpen(e.evidenceId)}><code>{e.evidenceId.slice(1, 5)}</code><span lang="en">{e.title}{e.path ? ` › ${e.path}` : ""}</span><small>{e.publishedAt ? day(e.publishedAt) : ""}</small></Button></li>)}
    </ol>
    <dialog ref={dialog} className="val-dialog" onClose={onClose} aria-label={m.source}>
      {shown && <div className="val-dialog-body">
        <header><h3 lang="en">{shown.title}</h3><Button variant="unstyled" type="button" className="icon-button" aria-label={m.close} onClick={onClose}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" /></svg></Button></header>
        <p className="val-dialog-meta">{shown.path && <span lang="en">{shown.path}</span>}{shown.publishedAt && <span>{day(shown.publishedAt)}</span>}<span>{m.snapshot}</span></p>
        <blockquote lang="en">{shown.excerpt}</blockquote>
        {shown.url && <a href={shown.url} target="_blank" rel="noreferrer noopener" onClick={() => track("source_click", { ticker: report.ticker })}>{m.openSource}</a>}
      </div>}
    </dialog>
  </section>;
}

function Status({ valuation }: { valuation: ValuationResponse }) {
  const attempt = valuation.latestAttempt;
  if (valuation.report && valuation.outdated) return <p className="val-banner" data-tone={attempt?.status === "failed" ? "warn" : "info"}>{attempt?.status === "failed" ? m.updateFailed : m.updating}</p>;
  if (valuation.report?.reportStatus === "insufficient") return <p className="val-banner" data-tone="warn"><b>{m.insufficient}</b> {m.insufficientNote}</p>;
  return null;
}

export function ValuationPanel({ ticker, valuation }: { ticker: string; valuation: ValuationResponse }) {
  const locale = useLocale();
  const [versionId, setVersionId] = useState<string | null>(null);
  const [version, setVersion] = useState<ValuationPublication | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { setVersionId(null); setVersion(null); setOpen(null); }, [ticker]);
  useEffect(() => {
    if (!versionId || versionId === valuation.report?.versionId) { setVersion(null); return; }
    const c = new AbortController();
    void fetchValuationVersion(ticker, versionId, c.signal).then(r => { if (!c.signal.aborted) setVersion(r); }).catch(() => {});
    return () => c.abort();
  }, [ticker, versionId, valuation.report?.versionId]);
  const report = versionId && version ? version : valuation.report;
  const gaps = useMemo(() => report ? [...new Map(report.gaps.map(g => [g.code + (g.field ?? ""), g])).values()] : [], [report]);
  if (!report) {
    const failed = valuation.availability === "failed";
    return <section className="lens val-panel val-panel--empty" aria-label={m.title}>
      <div className="lens-empty val-empty"><h2>{failed ? m.failed : m.preparing}</h2><p>{failed ? m.failedNote : m.preparingNote}</p>{!failed && <i className="lens-loading" />}</div>
    </section>;
  }
  const range = report.model?.range ?? null;
  return <section className="lens val-panel" aria-label={m.title}>
    <div className="lens-doc val-doc">
      <header className="val-head">
        <div className="val-verdict" data-tone={verdictTone[report.verdict]}>
          <span className="val-verdict-pill">{VERDICT[report.verdict]}</span>
          <strong className="val-score">{report.weightedScore != null ? report.weightedScore.toFixed(1) : "—"}<small>/10</small></strong>
          <span className="val-score-label">{report.weightedScore != null ? m.score : m.unscored} · {m.confidence} {CONF[report.confidence]}</span>
        </div>
        <dl className="val-dates">
          <div><dt>{m.researchDate}</dt><dd>{day(report.researchAsOf)}</dd></div>
          <div><dt>{m.financialBase}</dt><dd>{report.financialPeriodEnd}</dd></div>
          {valuation.versions.length > 1 && <div><dt>{m.version}</dt><dd><select className="val-select" value={versionId ?? valuation.report?.versionId ?? ""} onChange={e => setVersionId(e.target.value)} aria-label={m.version}>
            {valuation.versions.map(v => <option key={v.versionId} value={v.versionId}>{day(v.generatedAt)}{v.versionId === valuation.report?.versionId ? ` · ${m.current}` : ""}</option>)}
          </select></dd></div>}
        </dl>
      </header>
      <Status valuation={valuation} />
      <div className="val-grid">
        <Radar dimensions={report.dimensions} />
        <ol className="val-dim-list">
          {report.dimensions.map(d => <li key={d.key}><span>{DIM[d.key]}</span><i className="val-dim-bar"><b style={{ width: `${(d.score ?? 0) * 10}%` }} /></i><strong>{d.score != null ? d.score.toFixed(1) : "—"}</strong><small>{CONF[d.confidence]}</small></li>)}
        </ol>
      </div>
      {report.model && <section className="val-block">
        <h3>{m.range}</h3>
        <RangeBar report={report} />
        <dl className="val-stats">
          <div><dt>{m.price}</dt><dd>{report.quote ? <>{perShare(report.quote.price, report.quote.currency, locale)}<small>{m.priceDate(report.quote.priceDate)}</small></> : m.noQuote}</dd></div>
          <div><dt>{m.marginOfSafety}</dt><dd data-sign={range && range.marginOfSafety != null ? (range.marginOfSafety >= 0 ? "up" : "down") : undefined}>{pct(range?.marginOfSafety)}</dd></div>
          <div><dt>{m.baseUpside}</dt><dd>{signedPct(range?.baseUpside)}</dd></div>
          <div><dt>{m.expectedUpside}</dt><dd>{signedPct(range?.expectedUpside)}</dd></div>
          <div><dt>{m.downside}</dt><dd>{signedPct(range?.downsideCoverage)}</dd></div>
        </dl>
      </section>}
      {gaps.length > 0 && <section className="val-block val-gaps"><h3>{m.gaps}</h3><ul>{gaps.map(g => <li key={g.code + (g.field ?? "")}><code>{g.code}</code> <span lang={langOf(g.message)}>{g.message}</span></li>)}</ul></section>}
      <section className="val-block val-sections">
        <h3>{m.summary}<SourceLanguage of={[report.sections.summary, report.sections.thesis]} /></h3>
        <Prose text={report.sections.summary} onCite={setOpen} />
        {report.sections.thesis && <><h4>{m.thesis}</h4><Prose text={report.sections.thesis} onCite={setOpen} /></>}
        {report.sections.expectationsGap && <><h4>{m.expectationsGap}</h4><Prose text={report.sections.expectationsGap} onCite={setOpen} /></>}
        {report.sections.catalysts.length > 0 && <><h4>{m.catalysts}</h4><ul>{report.sections.catalysts.map((t, i) => <Prose key={i} as="li" text={t} onCite={setOpen} />)}</ul></>}
        {report.sections.counterEvidence.length > 0 && <><h4>{m.counterEvidence}</h4><ul>{report.sections.counterEvidence.map((t, i) => <Prose key={i} as="li" text={t} onCite={setOpen} />)}</ul></>}
        {report.sections.nextChecks.length > 0 && <><h4>{m.nextChecks}</h4><ul>{report.sections.nextChecks.map((t, i) => <Prose key={i} as="li" text={t} onCite={setOpen} />)}</ul></>}
        {report.sections.modelNotes && <><h4>{m.modelNotes}</h4><Prose text={report.sections.modelNotes} onCite={setOpen} /></>}
      </section>
      <Model report={report} onCite={setOpen} />
      <Dimensions report={report} onCite={setOpen} />
      {report.diagnostics.some(d => d.value != null) && <section className="val-block">
        <h3>{m.diagnostics}</h3>
        <dl className="val-stats val-stats--diag">
          {report.diagnostics.filter(d => d.value != null).map(d => <div key={d.key}><dt>{DIAG[d.key as keyof typeof DIAG] ?? d.label}</dt><dd>{d.unit === "percent" ? pct(d.value) : d.unit === "x" ? `${d.value!.toFixed(2)}×` : d.unit === "years" ? d.value!.toFixed(1) : d.value!.toFixed(2)}</dd></div>)}
        </dl>
      </section>}
      {report.distributions.length > 0 && <section className="val-block">
        <h3>{m.history}</h3>
        <table className="val-table"><thead><tr><th></th><th>{m.median}</th><th>{m.rangeLabel}</th><th></th></tr></thead><tbody>
          {report.distributions.map(d => <tr key={d.factor}><th>{FACTOR[d.factor as keyof typeof FACTOR] ?? d.factor}</th><td>{pct(d.median)}</td><td>{pct(d.min)} – {pct(d.max)}</td><td><small>{m.years(d.periods.length)}</small></td></tr>)}
        </tbody></table>
      </section>}
      <Sources report={report} open={open} onOpen={setOpen} onClose={() => setOpen(null)} />
      <p className="val-foot">{m.generated(day(report.generatedAt))} · {report.methodVersion} · {report.calculatorVersion}{getLocale() === "zh-CN" && report.sections.summary && langOf(report.sections.summary) === "en" ? "" : ""}</p>
    </div>
  </section>;
}
