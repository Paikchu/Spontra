import { useEffect, useState } from "react";
import { messages, useLocale } from "@/packages/web/src/i18n";
import { perShare } from "@/shared/analysis-runtime/locale";
import type { ValuationResponse } from "@/shared/analysis-contract/valuation";
import type { ValuationAdjustmentFactor, ValuationAdjustmentRead } from "@/shared/analysis-contract/valuation-adjustment";
const m = messages({ title: "Assumption sensitivity", pp: "pp", bear: "Bear", base: "Base", bull: "Bull", growth: "Annual revenue growth", margin: "Operating margin", rate: "Discount rate", change: "Change (percentage points)", save: "Calculate and save", waiting: "Calculating…", note: "Private cash-flow sensitivity; original research stays unchanged. No new research generation.", failed: "Sensitivity unavailable. A reproducible, reviewed cash-flow model is required.", loading: "Loading saved sensitivity…", before: "Before", after: "After", delta: "Model change", detail: "Open saved sensitivity", review: "Underlying research needs review. Quantified sensitivity is suspended." }, { title: "假设敏感性", pp: "百分点", bear: "悲观", base: "基准", bull: "乐观", growth: "年度收入增长率", margin: "营业利润率", rate: "折现率", change: "变化（百分点）", save: "计算并保存", waiting: "计算中…", note: "个人现金流敏感性，原研究保持不变，不触发新研究生成。", failed: "敏感性暂不可用，需要可复算且完成复核的现金流模型。", loading: "正在读取已保存敏感性…", before: "调整前", after: "调整后", delta: "模型变化", detail: "查看已保存敏感性", review: "引用研究需要复核，暂停展示量化敏感性。" });
export function ValuationAdjustmentControl({ valuation }: { valuation: ValuationResponse }) {
  const [factor, setFactor] = useState<ValuationAdjustmentFactor>("discountRate");
  const [delta, setDelta] = useState("1");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [access, setAccess] = useState<{ ticker: string; open: boolean } | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    fetch(`/agents/valuation-adjustments/status?ticker=${encodeURIComponent(valuation.ticker)}`, { signal: abort.signal }).then(async response => response.ok ? response.json() as Promise<{ open?: boolean }> : null).then(body => { if (!abort.signal.aborted) setAccess({ ticker: valuation.ticker, open: body?.open === true }); }).catch(() => {});
    return () => abort.abort();
  }, [valuation.ticker]);
  const report = valuation.report;
  if (access?.ticker !== valuation.ticker || !access.open || !report?.model || report.model.modelType !== "fcff" || report.reportStatus !== "ready" || valuation.researchStatus && valuation.researchStatus !== "valid") return null;
  return <details className="valuation-adjustment-control"><summary>{m.title}</summary><form onSubmit={async event => {
    event.preventDefault(); setPending(true); setFailed(false);
    try {
      const identity = await fetch("/agents/identity", { method: "POST" });
      if (!identity.ok) throw new Error();
      const response = await fetch("/agents/valuation-adjustments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticker: valuation.ticker, baseVersionId: report.versionId, factor, delta: Number(delta) / 100 }) });
      if (!response.ok) throw new Error();
      const body = await response.json() as ValuationAdjustmentRead;
      if (body.status !== "available") throw new Error();
      const url = new URL(location.href); url.searchParams.set("valuationAdjustment", body.result.id);
      location.assign(url.pathname + url.search);
    } catch { setFailed(true); } finally { setPending(false); }
  }}><label>{m.title}<select value={factor} onChange={event => setFactor(event.target.value as ValuationAdjustmentFactor)}><option value="discountRate">{m.rate}</option><option value="revenueGrowth">{m.growth}</option><option value="operatingMargin">{m.margin}</option></select></label><label>{m.change}<input type="number" min="-10" max="10" step="0.1" required value={delta} onChange={event => setDelta(event.target.value)} /></label><p>{m.note}</p><button disabled={pending || !Number(delta)}>{pending ? m.waiting : m.save}</button>{failed && <p role="alert">{m.failed}</p>}</form></details>;
}
export function ValuationAdjustmentSummary({ ticker }: { ticker: string }) {
  const locale = useLocale();
  const [id, setId] = useState(() => typeof location === "undefined" ? null : new URLSearchParams(location.search).get("valuationAdjustment"));
  const [saved, setSaved] = useState<{ id: string; value: ValuationAdjustmentRead | null } | null>(null);
  useEffect(() => { const changed = () => setId(new URLSearchParams(location.search).get("valuationAdjustment")); window.addEventListener("popstate", changed); return () => window.removeEventListener("popstate", changed); }, []);
  useEffect(() => {
    if (!id || !/^[0-9a-f]{32}$/.test(id)) return;
    const abort = new AbortController();
    fetch(`/agents/valuation-adjustments/${id}`, { signal: abort.signal }).then(async response => { if (!response.ok) throw new Error(); return response.json() as Promise<ValuationAdjustmentRead>; }).then(value => { if (!abort.signal.aborted) setSaved({ id, value }); }).catch(() => { if (!abort.signal.aborted) setSaved({ id, value: null }); });
    return () => abort.abort();
  }, [id]);
  if (!id) return null;
  const value = !/^[0-9a-f]{32}$/.test(id) ? null : saved?.id === id ? saved.value : undefined;
  const result = value?.status === "available" && value.result.ticker === ticker ? value.result : null;
  return <section className="price-impact" data-valuation-adjustment={result?.id}><h3>{m.title}</h3>{!result ? <p role="status">{value === undefined ? m.loading : value?.status === "review_required" ? m.review : m.failed}</p> : <><p>{m.note}</p><p className="price-impact-meta">{result.researchAsOf.slice(0, 10)} · {result.input.factor === "discountRate" ? m.rate : result.input.factor === "operatingMargin" ? m.margin : m.growth} {result.input.delta > 0 ? "+" : ""}{(result.input.delta * 100).toFixed(1)} {m.pp} · {result.id}</p><div className="price-impact-table"><table><thead><tr><th></th><th>{m.before}</th><th>{m.after}</th><th>{m.delta}</th></tr></thead><tbody>{result.cases.map(row => <tr key={row.key}><th>{m[row.key]}</th><td>{perShare(row.before, result.currency, locale)}</td><td>{perShare(row.after, result.currency, locale)}</td><td>{perShare(row.absoluteChange, result.currency, locale)}</td></tr>)}</tbody></table></div><a href={`/companies/${encodeURIComponent(ticker)}?view=valuation&valuationVersion=${result.baseVersionId}&valuationAdjustment=${result.id}`}>{m.detail}</a></>}</section>;
}
