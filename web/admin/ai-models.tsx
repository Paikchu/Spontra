import { Button } from "@/web/shared/ui/button";
import { Input } from "@/web/shared/ui/input";
import { NativeSelect, NativeSelectOption } from "@/web/shared/ui/native-select";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/web/shared/ui/table";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Refresh as RefreshCw } from "reicon-react";
import type { AiEffort, AiEndpointInput, AiModel, AiModelSettings, AiToolModelRow, AiToolModelUpdate } from "@/src/api/admin/types/ai-models-admin";
import { adminApi, AdminApiError } from "./admin-api";
import { financialDate } from "./financial-update-history";

const MODEL_LABEL: Record<AiModel, string> = {
  "deepseek-flash": "DeepSeek Flash", "deepseek-v4-pro": "DeepSeek V4 Pro",
};
const EFFORT_LABEL: Record<AiEffort, string> = { low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高" };
const modelName = (model: string) => MODEL_LABEL[model as AiModel] ?? model;

/** The model and effort of every AI tool in Spontra Analysis; an empty choice follows the deployment default. */
export function AiModels({ onUnauthorized, onAuthenticated }: { onUnauthorized: () => void; onAuthenticated: () => void }) {
  const [data, setData] = useState<AiModelSettings | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(""), [refresh, setRefresh] = useState(0);
  const [draft, setDraft] = useState<AiEndpointInput>({ name: "", url: "", apiKey: "", thinkingLevel: "high" });
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

  async function connect(event: FormEvent) {
    event.preventDefault();
    setBusy("endpoint"); setError("");
    try { setData(await adminApi<AiModelSettings>("ai/endpoints", { method: "POST", body: JSON.stringify(draft) })); setDraft(d => ({ ...d, apiKey: "" })); }
    catch (e) { fail(e); }
    finally { setBusy(""); }
  }

  async function disconnect(name: string) {
    setBusy(name); setError("");
    try { setData(await adminApi<AiModelSettings>("ai/endpoints", { method: "POST", body: JSON.stringify({ name, remove: true }) })); }
    catch (e) { fail(e); }
    finally { setBusy(""); }
  }

  const choices = data ? [...new Set<string>([...data.models, ...data.endpoints.map(endpoint => endpoint.name)])] : [];
  const editingEndpoint = data?.endpoints.some(endpoint => endpoint.name === draft.name);

  return <section className="flex min-w-0 flex-col gap-6" aria-label="模型配置">
    <header className="flex items-center justify-between gap-3">
      <h2 className="text-lg! font-semibold">模型接入</h2>
      <Button variant="ghost" size="icon" type="button" onClick={() => setRefresh(n => n + 1)} disabled={!!busy} aria-label="刷新模型配置" title="刷新模型配置"><RefreshCw size={18} strokeWidth={1.5} aria-hidden="true" /></Button>
    </header>
    <form className="grid items-end gap-4 sm:grid-cols-2 xl:grid-cols-5" aria-label="模型接入" aria-busy={busy === "endpoint"} onSubmit={e => void connect(e)}>
      <label className="flex min-w-0 flex-col gap-2 text-sm font-medium">模型名称<Input name="name" value={draft.name} autoComplete="off" required onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} /></label>
      <label className="flex min-w-0 flex-col gap-2 text-sm font-medium">API 地址<Input name="url" type="url" value={draft.url} placeholder="https://" required onChange={e => setDraft(d => ({ ...d, url: e.target.value }))} /></label>
      <label className="flex min-w-0 flex-col gap-2 text-sm font-medium">API 密钥<Input name="apiKey" type="password" value={draft.apiKey} autoComplete="off" required={editingEndpoint === false}
        aria-describedby={editingEndpoint ? "am-key-hint" : undefined} onChange={e => setDraft(d => ({ ...d, apiKey: e.target.value }))} /></label>
      <label className="flex min-w-0 flex-col gap-2 text-sm font-medium">推理强度<NativeSelect name="thinkingLevel" value={draft.thinkingLevel} onChange={e => setDraft(d => ({ ...d, thinkingLevel: e.target.value as AiEffort }))}>
        {(data?.efforts ?? ["low", "medium", "high", "xhigh", "max"]).map(effort => <NativeSelectOption key={effort} value={effort}>{EFFORT_LABEL[effort]}</NativeSelectOption>)}
      </NativeSelect></label>
      <Button variant="outline" type="submit" disabled={busy === "endpoint"}>{busy === "endpoint" ? "保存中" : "保存接入配置"}</Button>
      {editingEndpoint && <small id="am-key-hint">留空可保留已保存的密钥。</small>}
    </form>
    {data && data.endpoints.length > 0 && <ul className="flex flex-col gap-2" aria-label="已接入的模型">{data.endpoints.map(endpoint => <li className="flex flex-wrap items-center gap-3 py-2 text-sm" key={endpoint.name}>
      <strong>{endpoint.name}</strong>
      <span className="break-all text-muted-foreground">{endpoint.url}</span>
      <span>推理强度 {EFFORT_LABEL[endpoint.thinkingLevel]}</span>
      <span>{endpoint.keyHint ? `密钥 …${endpoint.keyHint}` : "已保存密钥"}</span>
      <Button variant="outline" type="button" disabled={busy === endpoint.name} aria-label={`移除 ${endpoint.name} 接入配置`} onClick={() => void disconnect(endpoint.name)}>移除</Button>
    </li>)}</ul>}
    {error && <p className="ra-error ra-error-banner am-state" role="alert">{error}</p>}
    <h2 className="text-lg! font-semibold" id="am-tool-heading">各功能的模型配置</h2>
    {!data && !error && <p className="text-sm text-muted-foreground" role="status">正在加载模型配置…</p>}
    {data && <div className="min-w-0" role="region" aria-labelledby="am-tool-heading" tabIndex={0}><Table>
      <TableHeader><TableRow><TableHead scope="col">功能</TableHead><TableHead scope="col">模型</TableHead><TableHead scope="col">推理强度</TableHead><TableHead scope="col">更新时间</TableHead><TableHead scope="col">操作</TableHead></TableRow></TableHeader>
      <TableBody>{data.tools.map(row => <TableRow key={row.tool} aria-busy={busy === row.tool}>
        <TableHead scope="row"><strong>{row.label}</strong></TableHead>
        <TableCell><NativeSelect aria-label={`${row.label}的模型`} value={row.model ?? ""} disabled={busy === row.tool}
          onChange={e => void save(row, { model: (e.target.value || null) as AiModel | null, effort: row.effort })}>
          <NativeSelectOption value="">默认 · {modelName(row.defaultModel)}</NativeSelectOption>
          {choices.map(m => <NativeSelectOption key={m} value={m}>{modelName(m)}</NativeSelectOption>)}
        </NativeSelect></TableCell>
        <TableCell><NativeSelect aria-label={`${row.label}的推理强度`} value={row.effort ?? ""} disabled={busy === row.tool}
          onChange={e => void save(row, { model: row.model, effort: (e.target.value || null) as AiEffort | null })}>
          <NativeSelectOption value="">默认 · {EFFORT_LABEL[row.defaultEffort]}</NativeSelectOption>
          {data.efforts.map(effort => <NativeSelectOption key={effort} value={effort}>{EFFORT_LABEL[effort]}</NativeSelectOption>)}
        </NativeSelect></TableCell>
        <TableCell className="am-date">{row.updatedAt ? financialDate(row.updatedAt) : "—"}</TableCell>
        <TableCell>{(row.model || row.effort) && <Button variant="outline" type="button" disabled={busy === row.tool} onClick={() => void save(row, { model: null, effort: null })} aria-label={`恢复默认（${row.label}）`}>恢复默认</Button>}</TableCell>
      </TableRow>)}</TableBody>
    </Table></div>}
  </section>;
}
