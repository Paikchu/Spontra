import { useEffect, useRef, useState, type FormEvent } from "react";
import { ExternalLink, LoaderCircle } from "lucide-react";
import type { DisclosureAuditPage, DisclosureAuditSummary } from "@/shared/analysis-contract/disclosure-audit";
import type { DisclosureFact } from "@/shared/analysis-runtime/financial-data/disclosure-extraction";
import { adminApi, AdminApiError } from "./admin-api";
import { displayFinancialValue, safeEvidenceUrl } from "./financial-maintenance-state";

const coverageLabels: Record<string, string> = { retained: "已保留", partial: "部分覆盖", not_classified: "尚未分类", not_structured: "尚未结构化" };
const areaLabels: Record<string, string> = { income_statement: "利润表", balance_sheet: "资产负债表", cash_flow: "现金流量表", segments: "分部披露", notes: "附注", custom_metrics: "公司自定义指标", non_xbrl: "非 XBRL 内容", periods_units_sources: "期间、单位与来源" };
function unit(fact: DisclosureFact): string {
  if (!fact.unit) return fact.unitRef || "未说明";
  const numerator = fact.unit.numerator.map(value => value.name).join(" × ");
  const denominator = fact.unit.denominator.map(value => value.name).join(" × ");
  return numerator + (denominator ? ` / ${denominator}` : "");
}
function period(fact: DisclosureFact): string {
  const value = fact.context?.period;
  if (!value) return "期间未解析";
  if (value.kind === "instant") return `${value.end ?? "未知日期"}（时点）`;
  if (value.kind === "duration") return `${value.start ?? "?"} → ${value.end ?? "?"}`;
  return value.kind === "forever" ? "永久期间" : "期间未解析";
}

export function DisclosureInspector({ ticker, documents, onUnauthorized }: { ticker: string; documents: DisclosureAuditSummary[]; onUnauthorized: () => void }) {
  const [documentId, setDocumentId] = useState(documents[0]?.documentId ?? "");
  const [concept, setConcept] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [filter, setFilter] = useState({ concept: "", periodEnd: "" });
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<DisclosureAuditPage | null>(null);
  const [selected, setSelected] = useState<DisclosureFact | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const unauthorized = useRef(onUnauthorized);
  useEffect(() => { unauthorized.current = onUnauthorized; }, [onUnauthorized]);
  const currentId = documents.some(document => document.documentId === documentId) ? documentId : documents[0]?.documentId ?? "";
  const document = documents.find(item => item.documentId === currentId);
  const source = safeEvidenceUrl(document?.source.documentUrl);

  useEffect(() => {
    if (!currentId || !expanded) return;
    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) { setLoading(true); setError(""); setPage(null); setSelected(null); } });
    const query = new URLSearchParams({ offset: String(offset), limit: "50", concept: filter.concept, periodEnd: filter.periodEnd });
    void adminApi<DisclosureAuditPage>(`financials/companies/${ticker}/documents/${currentId}?${query}`, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setPage(result);
    }).catch((err: Error) => {
      if (controller.signal.aborted) return;
      if (err instanceof AdminApiError && err.status === 401) unauthorized.current();
      else setError(err.message);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [ticker, currentId, offset, filter, expanded, refresh]);

  function submitFilter(event: FormEvent) { event.preventDefault(); setOffset(0); setFilter({ concept: concept.trim(), periodEnd }); }

  return <section className="fm-audit" aria-labelledby="fm-audit-title">
    <div className="fm-section-heading"><div><h3 id="fm-audit-title">原始披露档案</h3><p>按文档保留 XBRL 标签；未分类的事实不能视为报表语义已完整提取。</p></div><button className="fm-button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? "收起档案" : "查看原始事实"}</button></div>
    {!documents.length && <p className="fm-muted">尚无原始披露审计档案。补全后可查看文档覆盖清单、单位期间及公司自定义标签。</p>}
    {expanded && document && <>
      <label className="fm-document-select">来源文档<select aria-label="原始披露文档" value={currentId} onChange={event => { setDocumentId(event.target.value); setOffset(0); setSelected(null); }}>{documents.map(item => <option key={item.documentId} value={item.documentId}>{item.source.form} · {item.source.reportDate} · {item.source.accessionNumber}</option>)}</select></label>
      <div className="fm-source-metadata"><p>{source && <a href={source} target="_blank" rel="noopener noreferrer">打开原始财报 <ExternalLink size={12} /></a>} · 归档于 {document.archivedAt.replace("T", " ")} · {document.parserVersion}</p><p>遇到 {document.coverage.encountered} 个标签，保留 {document.coverage.retained} 个，成功解析 {document.coverage.parsed} 个；空值 {document.coverage.nil} 个，不支持 {document.coverage.unsupported} 个。</p><p>公司自定义 {document.coverage.custom} 个 · 含维度 {document.coverage.dimensional} 个 · 文本 {document.coverage.text} 个 · 附注 {document.coverage.footnotes} 个</p><details><summary>文档校验值与覆盖清单</summary><code>SHA-256 {document.contentSha256}</code><ul>{document.coverage.checklist.map(item => <li key={item.area}><strong>{areaLabels[item.area] ?? item.area} · {coverageLabels[item.status]}</strong><span>{item.detail}</span></li>)}</ul>{document.coverage.limitations.map((limitation, index) => <p key={index}>{limitation}</p>)}{document.issueDetailsTruncated && <p>问题详情过多，清单已截断；归档原文和逐项事实仍保留。</p>}</details></div>
      <form className="fm-fact-filters" onSubmit={submitFilter}><label>标签<input value={concept} onChange={event => setConcept(event.target.value)} placeholder="例如 Revenues 或 oracle:" maxLength={160} /></label><label>期末<input type="date" value={periodEnd} onChange={event => setPeriodEnd(event.target.value)} /></label><button className="fm-button">筛选事实</button></form>
      {error && <p className="ra-error" role="alert">{error} <button className="ra-text-button" onClick={() => setRefresh(value => value + 1)}>重试读取</button></p>}
      {selected && <div className="fm-fact-detail"><div className="fm-section-heading"><h4>{selected.concept.name}</h4><button className="ra-text-button" onClick={() => setSelected(null)}>关闭事实详情</button></div><dl><dt>期间</dt><dd>{period(selected)}</dd><dt>单位</dt><dd>{unit(selected)}</dd><dt>原始数值</dt><dd>{selected.rawValue || "（空字符串）"}</dd><dt>规范数值</dt><dd>{selected.normalizedValue ?? "尚未解析，不以 0 代替"}</dd><dt>缩放 / 精度</dt><dd>scale = {selected.scale ?? "未提供"} · decimals = {selected.decimals ?? "未提供"} · precision = {selected.precision ?? "未提供"}</dd><dt>来源位置</dt><dd>{selected.source.accessionNumber} · 字符 {selected.source.locator.start}–{selected.source.locator.end}{selected.source.locator.elementId && ` · ${selected.source.locator.elementId}`}</dd><dt>维度</dt><dd>{selected.context?.dimensions.length ? selected.context.dimensions.map((dimension, index) => <p key={index}>{dimension.axis.name} = {dimension.member?.name ?? dimension.value} ({dimension.kind})</p>) : "无维度上下文"}</dd></dl>{selected.issues.length > 0 && <ul className="ra-error">{selected.issues.map((issue, index) => <li key={index}>{issue.code} · {issue.detail}</li>)}</ul>}<details><summary>原始 HTML 片段（只读文本）</summary><pre>{selected.rawHtml}</pre></details></div>}
      {loading ? <p className="fm-muted" role="status"><LoaderCircle size={16} className="ra-spin" />正在读取原始事实…</p> : page && <><div className="fm-table-scroll" tabIndex={0} aria-label="原始事实表，可横向滚动"><table><thead><tr><th>原始标签</th><th>规范值</th><th>单位 / 期间</th><th>状态</th></tr></thead><tbody>{page.facts.map(fact => <tr key={fact.id}><th scope="row"><button className="ra-text-button fm-concept" onClick={() => setSelected(fact)}>{fact.concept.name}</button><small>{fact.taxonomy === "custom" ? "公司自定义" : fact.taxonomy === "standard" ? "标准标签" : "分类待确认"}{fact.context?.dimensions.length ? ` · ${fact.context.dimensions.length} 个维度` : ""}</small></th><td className="fm-fact-value">{fact.status === "nil" ? "披露为空" : fact.normalizedValue === null ? "未解析" : fact.kind === "numeric" ? displayFinancialValue(fact.normalizedValue) : fact.normalizedValue.slice(0, 100) + (fact.normalizedValue.length > 100 ? "…" : "")}</td><td>{unit(fact)}<small>{period(fact)}</small></td><td>{fact.status === "parsed" ? "已解析" : fact.status === "nil" ? "空值" : "待处理"}<small>{fact.kind}</small></td></tr>)}</tbody></table>{!page.facts.length && <p className="fm-muted fm-table-empty">没有符合条件的事实。</p>}</div><div className="fm-pagination"><span>共 {page.total} 个事实 · {page.total ? page.offset + 1 : 0}–{page.offset + page.facts.length}</span><button className="fm-button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>上一页</button><button className="fm-button" disabled={page.nextOffset === null} onClick={() => setOffset(page.nextOffset ?? 0)}>下一页</button></div></>}
    </>}
  </section>;
}
