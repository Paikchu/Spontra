"use client";

import { useCallback, useId, useState } from "react";
import type { CompanyBusinessContent } from "@/lib/earning-report/web/company-business-content";
import { FinancialSankey } from "./FinancialSankey";
import type { BusinessFlowQuarter, BusinessSegment, FlowMetric, FlowSource, PublicBusinessFlow } from "@/shared/analysis-contract/business-flow";
import type { CompanyAnalysisOverview } from "@/shared/analysis-contract/company-analysis";
import { disclosedSegmentLabel, compareAmount, compareFlowAmounts, formatFlowValue, marginChange, numeric, previousQuarter, reconcileQuarter } from "@/lib/earning-report/web/business-flow-model";

const nodes: Array<{ key: FlowMetric; label: string; tone: string }> = [
  { key: "revenue", label: "收入", tone: "revenue" },
  { key: "cost", label: "营业成本", tone: "expense" },
  { key: "gross", label: "毛利", tone: "gross" },
  { key: "operatingExpenses", label: "运营费用", tone: "expense" },
  { key: "operating", label: "营业利润", tone: "profit" },
  { key: "other", label: "其他损益（有符号）", tone: "other" },
  { key: "pretax", label: "税前利润", tone: "profit" },
  { key: "tax", label: "所得税", tone: "expense" },
  { key: "net", label: "净利润", tone: "net" },
];

function SourceLinks({ sources, ids, compact = false }: { sources: FlowSource[]; ids?: string[]; compact?: boolean }) {
  const selected = ids ? sources.filter(s => ids.includes(s.id)) : sources;
  return <>{selected.filter(s => /^https?:\/\//.test(s.url)).map(s => <a key={s.id} href={s.url} target="_blank" rel="noopener noreferrer" title={s.title}>{compact ? "原文" : s.title}{!compact && s.publishedAt ? ` · ${s.publishedAt.slice(0, 10)}` : ""}</a>)}</>;
}

function ComparisonDetails({ quarter, previous, metric, segmentId }: { quarter: BusinessFlowQuarter; previous: BusinessFlowQuarter | null; metric: FlowMetric; segmentId?: string }) {
  const comparison = compareAmount(quarter, previous, metric, segmentId);
  return <div className="business-flow__metric-detail"><span>上季 {formatFlowValue(comparison.previous, quarter)}</span><span>增减 {comparison.delta == null ? "不可比" : `${comparison.delta > 0 ? "+" : ""}${formatFlowValue(comparison.delta, quarter)}`}</span></div>;
}

function MetricNode({ node, quarter, previous, details }: { node: typeof nodes[number]; quarter: BusinessFlowQuarter; previous: BusinessFlowQuarter | null; details: boolean }) {
  const value = numeric(quarter.figures[node.key]);
  const comparison = compareAmount(quarter, previous, node.key);
  const amount = quarter.figures[node.key];
  return <div className={`business-flow__metric business-flow__metric--${node.key}`} data-tone={value != null && value < 0 ? "negative" : node.tone} data-missing={value == null || undefined} >
    <span className="business-flow__metric-label">{node.label}</span>
    <strong>{node.key === "other" && value != null && value > 0 ? "+" : ""}{formatFlowValue(value, quarter)}</strong>
    <span className="business-flow__comparison">环比 {comparison.label}</span>
    {amount?.basis === "derived" && <small title={amount.formula}>推导值</small>}
    {details && <div className="business-flow__metric-detail"><span>上季 {formatFlowValue(comparison.previous, quarter)}</span><span>增减 {comparison.delta != null && comparison.delta > 0 ? "+" : ""}{formatFlowValue(comparison.delta, quarter)}</span><SourceLinks sources={quarter.sources} ids={amount?.sourceIds ?? []} compact /></div>}
    {node.key === "operatingExpenses" && <div className="business-flow__expense-list">{([ ["research", "研发"], ["sales", "销售营销"], ["administration", "行政"] ] as const).map(([key, label]) => <span key={key}>{label}<b>{formatFlowValue(numeric(quarter.figures[key]), quarter)}</b><small>环比 {compareAmount(quarter, previous, key).label}</small>{details && <ComparisonDetails quarter={quarter} previous={previous} metric={key} />}</span>)}</div>}
  </div>;
}

function BusinessPanel({ segment, sources, close, quarter, previous }: { segment: BusinessSegment; sources: FlowSource[]; close: () => void; quarter?:BusinessFlowQuarter; previous?:BusinessFlowQuarter|null }) {
  return <section className="business-flow__business-panel" aria-label={`${disclosedSegmentLabel(segment.name)} 业务详情`}>
    <div className="business-flow__panel-heading"><h3>{disclosedSegmentLabel(segment.name)}</h3><button type="button" onClick={close} aria-label="收起业务详情">收起 ×</button></div>
    <p>{segment.description || "业务说明未披露"}</p>
    {quarter && segment.children?.length ? <><h4>已披露收入分类</h4><ul>{segment.children.map(c=><li key={c.id}>{c.name} · {formatFlowValue(numeric(c.revenue),quarter)} {quarter.currency} 百万 · 环比 {compareAmount(quarter,previous??null,"revenue",c.id).label}</li>)}</ul></>:null}
    <h4>产品归属</h4><ul>{segment.products.length ? segment.products.map(p => <li key={p}>{p}</li>) : <li>产品映射未披露</li>}</ul>
    <p className="business-flow__boundary">产品未独立披露收入时只展示归属，不分配营收比例。</p>
    <h4>客户</h4><p>{segment.customers ?? "客户信息未披露"}</p>
    <h4>赚钱方式</h4><p>{segment.monetization ?? "赚钱方式未披露"}</p>
    <h4>披露边界</h4><p>{segment.disclosure}</p>
    <SourceLinks sources={sources} ids={segment.sourceIds} />
  </section>;
}

export function BusinessFlow({ flow, overview, notice, business, publicationLabel }: { publicationLabel?: string; business?: CompanyBusinessContent | null; flow: PublicBusinessFlow; overview?: CompanyAnalysisOverview | null; notice?: string | null }) {
  const [selectedPeriod, setSelectedPeriod] = useState<string | null>(null);
  const [expandedSegment, setExpandedSegment] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const id = useId();
  const toggleSegment = useCallback((segmentId: string) => setExpandedSegment(current => current === segmentId ? null : segmentId), []);
  const quarters = [...flow.quarters].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
  const quarter = quarters.find(q => q.id === selectedPeriod) ?? quarters[0];
  function closeBusiness() {
    const trigger = document.getElementById(`${id}-segment-${expandedSegment}`);
    setExpandedSegment(null);
    trigger?.focus();
  }
  const segments = quarter?.segments.length ? quarter.segments : business?.groups ?? [];
  const businessSources = quarter?.segments.length ? quarter.sources : business?.sources ?? [];
  const rail = <div className="business-flow__businesses" onKeyDown={event => { if (event.key === "Escape" && expandedSegment) { event.preventDefault(); closeBusiness(); } }}><h3>业务分部 / 产品归属 → 公司收入</h3>{!quarter?.segments.length && business && <p className="business-flow__business-basis">{business.basisLabel}</p>}{segments.length ? segments.map((segment, index) => <div className="business-flow__segment" key={segment.id} data-tone={`segment-${index % 3}`}>
    <button id={`${id}-segment-${segment.id}`} type="button" onClick={() => toggleSegment(segment.id)} aria-expanded={expandedSegment === segment.id} aria-controls={`${id}-business-${segment.id}`}><span>{disclosedSegmentLabel(segment.name)}</span>{quarter && segment.revenue ? <strong>{formatFlowValue(numeric(segment.revenue), quarter)}</strong> : <small>{segment.products.slice(0, 3).join(" · ").slice(0, 100) || segment.description.slice(0, 90)}</small>}<small>{quarter && segment.revenue ? `环比 ${compareAmount(quarter, previousQuarter(quarter, quarters), "revenue", segment.id).label} · ` : "定性归属 · 比例未披露 · "}{expandedSegment === segment.id ? "收起业务" : "展开业务 ↗"}</small></button>
    {expandedSegment === segment.id && <div id={`${id}-business-${segment.id}`}><BusinessPanel segment={segment} sources={businessSources} close={closeBusiness} quarter={quarter} previous={quarter?previousQuarter(quarter,quarters):null} /></div>}
  </div>) : <div className="business-flow__undisclosed"><strong>业务描述尚未发布</strong><p>当前公司没有可溯源的已发布业务资料；不会用其他公司的产品替代。</p></div>}</div>;
  if (!quarter) return <section className="business-flow business-flow--empty" aria-label="公司业务前瞻"><h2>业务前瞻</h2>{notice && <p role="status">{notice}</p>}<div className="business-flow__canvas">{rail}<div className="business-flow__undisclosed"><h3>季度财务未披露</h3><p>需要同币种、同口径的三个月数据才能绘制财务流向。业务资料保留独立披露期间，不会用示例数据替代真实财务。</p></div></div>{overview && <AnalysisReading overview={overview} publicationLabel={publicationLabel} />}</section>;
  const previous = previousQuarter(quarter, quarters);
  const reconciliation = reconcileQuarter(quarter);
  const mismatch = reconciliation.some(r => r.status === "mismatch");
  const complete = reconciliation.every(r => r.status === "balanced");
  const signedLoss = (["gross", "operating", "pretax", "net", "cost", "operatingExpenses", "tax"] as const).some(key => (numeric(quarter.figures[key]) ?? 0) < 0);
  return <section className="business-flow" aria-labelledby={`${id}-heading`}>
    <header className="business-flow__toolbar"><div><h2 id={`${id}-heading`}>业务前瞻</h2><p>业务归属 → 收入 → 成本与费用 → 净利润</p></div><div className="business-flow__controls"><label htmlFor={`${id}-quarter`}>季度<select id={`${id}-quarter`} value={quarter.id} onChange={e => { setSelectedPeriod(e.target.value); setExpandedSegment(null); }}>
      {quarters.map(q => <option key={q.id} value={q.id}>{q.label}</option>)}
    </select></label><button type="button" aria-pressed={details} aria-controls={`${id}-plot`} onClick={() => setDetails(!details)}>{details ? "收起比较" : "展开比较"}</button></div></header>
    <div className="business-flow__metadata"><span>{quarter.periodStart ? `${quarter.periodStart}—` : "截至 "}{quarter.periodEnd} · 三个月</span><span>{quarter.currency || "币种未披露"} 百万 · {quarter.basisLabel}</span><span>{flow.fetchedAt ? `数据时间 ${flow.fetchedAt.slice(0, 10)}` : "数据时间未提供"}</span></div>
    {notice && <p className="business-flow__notice" role="status">{notice}</p>}
    <div className="business-flow__quality" role="status" data-status={mismatch ? "mismatch" : complete ? "balanced" : "missing"}>{mismatch ? "对账不平：只绘制局部已对平路径，完整金额保留在明细。" : complete ? signedLoss ? `${reconciliation.length} 项会计等式已核对 · 有符号损益保留原值` : `${reconciliation.length} 项会计等式已核对 · 线宽表示本季金额` : "披露不完整：未披露不等于零，只绘制已对平的可用路径。"}<span>环比基准：{previous?.label ?? "没有连续上季"} · 费用增加不代表利好</span></div>
    <div id={`${id}-plot`} className="business-flow__plot" data-details={details || undefined} aria-label="公司收入到净利润流向图" onKeyDown={event => { if (event.key === "Escape" && expandedSegment) { event.preventDefault(); closeBusiness(); } }}>
      <div className="business-flow__canvas">{rail}<div className="business-flow__financial"><FinancialSankey quarter={quarter} previous={previous} onSegment={toggleSegment} /></div></div>
      <details className="business-flow__ledger" open={details}><summary>财务金额明细 · 未披露及有符号损益</summary><div className="business-flow__ledger-grid">{nodes.filter(node=>quarter.incomeModel!=="direct_operating"||!["cost","gross"].includes(node.key)).map(node => <MetricNode key={node.key} node={node} quarter={quarter} previous={previous} details={details} />)}</div>{quarter.incomeModel==="direct_operating"&&<div className="business-flow__ledger-grid">{[...(quarter.expenseComponents??[]),...(quarter.otherComponents??[])].map(c=>{const prior=[...(previous?.expenseComponents??[]),...(previous?.otherComponents??[])].find(p=>p.id===c.id);const cmp=compareFlowAmounts(quarter,previous,c.id,c.amount,prior?.amount);return <div className="business-flow__metric" key={c.id}><span>{c.name}</span><strong>{formatFlowValue(numeric(c.amount),quarter)}</strong><span>环比 {cmp.label}</span>{details&&<><small>上季 {formatFlowValue(cmp.previous,quarter)} · 增减 {formatFlowValue(cmp.delta,quarter)}</small><SourceLinks sources={quarter.sources} ids={c.amount.sourceIds} compact /></>}</div>;})}</div>}</details>
    </div>
    <div className="business-flow__margins">{(["gross", "operating", "net"] as const).filter(key=>quarter.incomeModel!=="direct_operating"||key!=="gross").map(key => <span key={key}>{({gross:"毛利",operating:"营业",net:"净利"}[key])} · {marginChange(quarter, previous, key)}</span>)}</div>
    <details className="business-flow__audit"><summary>会计核对与披露来源{mismatch ? " · 存在差异" : ""}</summary><ul>{reconciliation.map(r => <li key={r.label}><span>{r.label}</span><b>{r.status === "balanced" ? "已对平" : r.status === "missing" ? "未披露，待核对" : `差额 ${formatFlowValue(r.difference, quarter)}`}</b></li>)}</ul><p>{quarter.basisLabel} · 披露日期 {quarter.reportedAt ?? "未提供"}。只使用已披露三个月值；此页面不自行从累计报表拆出季度。分部归属变化或重列口径未知时不显示增长率。</p><SourceLinks sources={quarter.sources} />{!quarter.sources.length && <p>原文链接尚未提供。</p>}</details>
    {overview && <AnalysisReading overview={overview} publicationLabel={publicationLabel} />}
  </section>;
}

function AnalysisReading({ overview, publicationLabel }: { publicationLabel?: string; overview: CompanyAnalysisOverview }) {
  const report = overview.deepDive;
  return <details className="business-flow__reading" open><summary>业务解读 · {report?.headline ?? overview.headline}</summary>{publicationLabel && <p className="business-flow__metadata">{publicationLabel}</p>}<p>{report?.introduction ?? overview.introduction}</p>{report ? <>{report.sections.map(section => <section key={section.key}><h3>{section.title}</h3>{section.paragraphs.map((p, index) => <p key={index}>{p.text} <SourceLinks sources={report.sources} ids={p.sourceIds} /></p>)}</section>)}{report.limitations.length > 0 && <section><h3>尚待核实</h3><ul>{report.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></section>}</> : overview.highlights.map(highlight => <section key={highlight.ordinal}><h3>{highlight.title}</h3><p>{highlight.body}</p></section>)}</details>;
}
