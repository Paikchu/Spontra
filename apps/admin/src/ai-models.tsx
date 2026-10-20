import { useEffect, useRef, useState } from "react";
import { LoaderCircle, RefreshCw, RotateCcw } from "lucide-react";
import type { AiEffort, AiModel, AiModelSettings, AiToolModelRow, AiToolModelUpdate } from "@/shared/analysis-contract/ai-models-admin";
import { adminApi, AdminApiError } from "./admin-api";
import { financialDate } from "./financial-update-history";
import "./ai-models.css";

const MODEL_LABEL: Record<AiModel, string> = {
  "claude-opus-5-5": "Claude Opus 5.5", "claude-sonnet-5-5": "Claude Sonnet 5.5", "claude-haiku-5-5": "Claude Haiku 5.5", "claude-fable-5-1": "Claude Fable 5.1",
};
const EFFORT_LABEL: Record<AiEffort, string> = { low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高" };
const modelName = (model: string) => MODEL_LABEL[model as AiModel] ?? model;

/** The model and effort of every AI tool in Spontra Analysis; an empty choice follows the deployment default. */
export function AiModels({ onUnauthorized, onAuthenticated }: { onUnauthorized: () => void; onAuthenticated: () => void }) {
  const [data, setData] = useState<AiModelSettings | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(""), [refresh, setRefresh] = useState(0);
  const callbacks = useRef({ onUnauthorized, onAuthenticated });
  useEffect(() => { callbacks.current = { onUnauthorized, onAuthenticated }; }, [onUnauthorized, onAuthenticated]);
  const fail = (e: unknown) => { if (e instanceof AdminApiError && e.status === 401) callbacks.current.onUnauthorized(); else setError((e as Error).message); };
  useEffect(() => {
    const c = new AbortController();
    void adminApi<AiModelSettings>("ai/models", { signal: c.signal }).then(r => { setData(r); setError(""); callbacks.current.onAuthenticated(); })
      .catch(e => { if (!c.signal.aborted) fail(e); });
    return () => c.abort();
  }, [refresh]);

  async function save(row: AiToolModelRow, update: AiToolModelUpdate) {
    setBusy(row.tool); setError("");
    try { setData(await adminApi<AiModelSettings>(`ai/models/${row.tool}`, { method: "POST", body: JSON.stringify(update) })); }
    catch (e) { fail(e); }
    finally { setBusy(""); }
  }

  return <section className="am-admin" aria-label="模型配置">
    <div className="bm-admin-toolbar">
      <span className="am-count">{data ? `${data.tools.filter(t => t.model || t.effort).length} / ${data.tools.length} 项已调整` : ""}</span>
      <button className="ra-icon-button" onClick={() => setRefresh(n => n + 1)} disabled={!!busy} aria-label="刷新"><RefreshCw size={16} /></button>
    </div>
    {error && <p className="ra-error ra-error-banner" role="alert">{error}</p>}
    {!data && !error && <p role="status"><LoaderCircle size={15} className="ra-spin" /> 加载中</p>}
    {data && <div className="bm-admin-table-wrap ra-panel"><table className="bm-admin-table am-table">
      <thead><tr><th>功能</th><th>模型</th><th>推理强度</th><th>更新时间</th><th><span className="bm-admin-sr">恢复默认</span></th></tr></thead>
      <tbody>{data.tools.map(row => <tr key={row.tool} data-custom={row.model || row.effort ? "" : undefined}>
        <td><b>{row.label}</b><small>{row.tool}</small></td>
        <td><select aria-label={`${row.label}的模型`} value={row.model ?? ""} disabled={busy === row.tool}
          onChange={e => void save(row, { model: (e.target.value || null) as AiModel | null, effort: row.effort })}>
          <option value="">默认 · {modelName(row.defaultModel)}</option>
          {data.models.map(m => <option key={m} value={m}>{MODEL_LABEL[m]}</option>)}
        </select></td>
        <td><select aria-label={`${row.label}的推理强度`} value={row.effort ?? ""} disabled={busy === row.tool}
          onChange={e => void save(row, { model: row.model, effort: (e.target.value || null) as AiEffort | null })}>
          <option value="">默认 · {EFFORT_LABEL[row.defaultEffort]}</option>
          {data.efforts.map(effort => <option key={effort} value={effort}>{EFFORT_LABEL[effort]}</option>)}
        </select></td>
        <td className="am-date">{row.updatedAt ? financialDate(row.updatedAt) : "—"}</td>
        <td>{(row.model || row.effort) && <button className="ra-icon-button" disabled={busy === row.tool} onClick={() => void save(row, { model: null, effort: null })} aria-label={`${row.label}恢复默认`} title="恢复默认"><RotateCcw size={15} /></button>}</td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}
