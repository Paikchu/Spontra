import { Fragment, useEffect, useState } from 'react';
import { ArrowsClockwiseIcon as RefreshCw } from "@phosphor-icons/react";
import type { ReportAdminItem, ReportAdminPage, ReportAdminStatus, ReportRunProcess } from '@/shared/analysis-contract/admin';
import { adminApi, AdminApiError } from './admin-api';
import { useOnReturn, usePageActive } from './admin-page';

type State = { status: 'loading' } | { status: 'ready'; reports: ReportAdminItem[] } | { status: 'error' };
const STATUS: Record<ReportAdminStatus, string> = { unreviewed: '已生成', reviewed: '已检查', processing: '生成中', failed: '失败', pending: '未生成' };

/** The company's SEC filings, each with its report's state and a regenerate action. */
export function CompanyReports({ ticker, onUnauthorized }: { ticker: string; onUnauthorized: () => void }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [refresh, setRefresh] = useState(0);
  const [sent, setSent] = useState<Record<string, string>>({});
  const [rechecked, setRechecked] = useState<Record<string, Array<{ block: string; ref: string; shown: string; status: string; reason?: string }>>>({});
  const [viewing, setViewing] = useState<string | null>(null);
  const [process, setProcess] = useState<ReportRunProcess | 'loading' | 'error' | null>(null);
  const active = usePageActive();
  useEffect(() => {
    const controller = new AbortController();
    void adminApi<ReportAdminPage>(`reports?ticker=${encodeURIComponent(ticker)}`, { signal: controller.signal })
      .then(page => setState({ status: 'ready', reports: page.reports }))
      .catch(error => {
        if (controller.signal.aborted) return;
        if (error instanceof AdminApiError && error.status === 401) onUnauthorized();
        setState({ status: 'error' });
      });
    return () => controller.abort();
  }, [ticker, refresh, onUnauthorized]);
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden && active.current) setRefresh(n => n + 1); }, 30_000);
    return () => clearInterval(timer);
  }, [active]);
  useOnReturn(() => setRefresh(n => n + 1));

  async function view(report: ReportAdminItem) {
    if (viewing === report.accessionNumber) { setViewing(null); return; }
    setViewing(report.accessionNumber);
    setProcess('loading');
    try { setProcess(await adminApi<ReportRunProcess>(`reports/${report.ticker}/${report.accessionNumber}/runs/${encodeURIComponent(report.workflowInstanceId ?? '')}`)); }
    catch (error) { if (error instanceof AdminApiError && error.status === 401) onUnauthorized(); setProcess('error'); }
  }

  async function recheck(report: ReportAdminItem) {
    const key = report.accessionNumber;
    setSent(s => ({ ...s, [key]: '核对中' }));
    try {
      const result = await adminApi<{ version: number; checked: number; differs: number; unreadable: number; items: Array<{ block: string; ref: string; shown: string; status: string; reason?: string }> }>(`reports/${report.ticker}/${report.accessionNumber}/recheck`, { method: 'POST', body: '{}' });
      setSent(s => ({ ...s, [key]: `v${result.version} · ${result.checked} 处 · 不符 ${result.differs} · 读不到 ${result.unreadable}` }));
      setRechecked(s => ({ ...s, [key]: result.items.filter(i => i.status !== 'holds') }));
    } catch (error) {
      if (error instanceof AdminApiError && error.status === 401) onUnauthorized();
      setSent(s => ({ ...s, [key]: error instanceof Error ? error.message : '核对失败' }));
    }
  }

  async function regenerate(report: ReportAdminItem, mode: 'regenerate' | 'revise' = 'regenerate') {
    const key = report.accessionNumber;
    setSent(s => ({ ...s, [key]: '提交中' }));
    try {
      await adminApi(`reports/${report.ticker}/${report.accessionNumber}/${mode}`, { method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: '{}' });
      setSent(s => ({ ...s, [key]: '已提交' }));
      setRefresh(n => n + 1);
    } catch (error) {
      if (error instanceof AdminApiError && error.status === 401) onUnauthorized();
      setSent(s => ({ ...s, [key]: error instanceof Error ? error.message : '提交失败' }));
    }
  }

  const reports = state.status === 'ready' ? state.reports : [];
  return <section className="bm-usage" aria-label={`${ticker} SEC 文件分析`} aria-busy={state.status === 'loading'}>
    <header><h4>SEC 文件分析</h4><button className="ra-icon-button" type="button" aria-label="刷新 SEC 文件分析" onClick={() => setRefresh(n => n + 1)}><RefreshCw size={14} /></button></header>
    {state.status === 'error' && <p className="ra-error" role="alert">文件列表读取失败</p>}
    {state.status === 'ready' && !reports.length && <p className="bm-empty">无文件</p>}
    {reports.length > 0 && <div className="bm-usage-scroll" tabIndex={0} role="region" aria-label="SEC 文件与分析状态">
      <table className="bm-usage-table"><thead><tr><th scope="col">文件</th><th scope="col">报告期</th><th scope="col">提交日</th><th scope="col">状态</th><th scope="col">生成于</th><th scope="col"><span className="sr-only">操作</span></th></tr></thead>
        <tbody>{reports.map(r => <Fragment key={r.accessionNumber}><tr>
          <th scope="row"><span className="ra-mono" title={r.accessionNumber}>{r.form}</span></th>
          <td>{r.reportDate || '—'}</td>
          <td>{r.filingDate}</td>
          <td aria-live="polite" title={r.errorCode ?? undefined}><span className="bm-layer-status" data-state={r.status}>{STATUS[r.status]}{r.status === 'processing' && r.stage ? ` · ${r.stage}` : ''}{r.status === 'failed' && r.errorCode ? ` · ${r.errorCode}` : ''}</span></td>
          <td>{r.generatedAt?.slice(0, 10) ?? '—'}</td>
          <td>{sent[r.accessionNumber] && <small role="status">{sent[r.accessionNumber]} </small>}
            <button className="fm-button" type="button" disabled={!r.canRegenerate || r.status === 'processing' || sent[r.accessionNumber] === '提交中'} onClick={() => void regenerate(r)} aria-label={`重新生成 ${r.form} ${r.reportDate}`}>重新生成</button>
            {r.generatedAt && /^(10-[QK]|20-F|40-F)/.test(r.form) && <button className="fm-button" type="button" disabled={!r.canRegenerate || r.status === 'processing' || sent[r.accessionNumber] === '提交中'} onClick={() => void regenerate(r, 'revise')} aria-label={`修订 ${r.form} ${r.reportDate}`}>修订</button>}
            {r.generatedAt && <button className="fm-button" type="button" disabled={sent[r.accessionNumber] === '核对中'} onClick={() => void recheck(r)} aria-label={`核对 ${r.form} ${r.reportDate}`}>核对</button>}
            {r.workflowInstanceId && <button className="fm-button" type="button" aria-expanded={viewing === r.accessionNumber} onClick={() => void view(r)}>过程</button>}</td>
        </tr>{rechecked[r.accessionNumber]?.length ? <tr><td colSpan={6}><ul className="bm-usage-caption ra-mono">{rechecked[r.accessionNumber]!.map((i, n) => <li key={n}>{i.block} · {i.ref} · {i.shown} · {i.reason}</li>)}</ul></td></tr> : null}
        {viewing === r.accessionNumber && <tr><td colSpan={6}><RunProcess process={process} /></td></tr>}</Fragment>)}</tbody>
      </table>
    </div>}
  </section>;
}

/** How the run's version differs from the one before it, block by block. */
function changesOf(summary: ReportRunProcess['summary']): string | null {
  const detail = summary?.detail as { mode?: string; edits?: number; changes?: { from: number | null; added: string[]; changed: string[]; removed: string[]; unchanged: string[] } } | undefined;
  const c = detail?.changes;
  if (!c) return null;
  const part = (label: string, ids: string[]) => ids.length ? `${label} ${ids.join('、')}` : null;
  return [detail?.mode === 'revise' ? '修订' : '重写', c.from === null ? '首个版本' : `对比 v${c.from}`, part('新增', c.added), part('改动', c.changed), part('删除', c.removed), `未变 ${c.unchanged.length} 块`, `编辑 ${detail?.edits ?? 0} 次`].filter(Boolean).join(' · ');
}

function RunProcess({ process }: { process: ReportRunProcess | 'loading' | 'error' | null }) {
  if (process === 'loading' || !process) return <p className="bm-empty">读取中</p>;
  if (process === 'error') return <p className="ra-error" role="alert">运行记录读取失败</p>;
  return <div>
    <p className="bm-usage-caption">{process.status ?? '—'}{process.step ? ` · ${process.step}` : ''}{process.updatedAt ? ` · ${process.updatedAt}` : ''}{process.error?.message ? ` · ${process.error.message}` : ''}</p>
    {process.summary && <p className="bm-usage-caption">{process.summary.settledBy === 'harness' ? '引擎结算' : process.summary.settledBy === 'agent' ? 'Agent 结算' : '未结算'} · 复核 {process.summary.reviewRounds} 轮 · 渲染 {process.summary.renderRounds} 轮 · 读 {process.summary.sectionsRead} 节 {process.summary.charsRead.toLocaleString('en-US')} 字 · 压缩 {process.summary.compactions} 次 · {process.summary.blocks} 块{process.summary.degraded.length ? ` · 降级 ${process.summary.degraded.join(', ')}` : ''}</p>}
    {changesOf(process.summary) && <p className="bm-usage-caption">{changesOf(process.summary)}</p>}
    {process.summary && <p className="bm-usage-caption ra-mono">{Object.entries(process.summary.tools).sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} ${n}`).join(' · ')}</p>}
    {process.sessions.map(session => <div key={session.operationId}>
      <p className="bm-usage-caption">{session.kind} · {session.turns} 轮 · {session.spent.toLocaleString('en-US')} Token（未缓存输入与输出）{session.active ? ' · 运行中' : ''}</p>
      {session.trail.map((entry, index) => <details key={index}>
        <summary><span className="ra-mono">{entry.turn} · {entry.action}</span>{entry.failed && <span className="ra-error"> 失败</span>}</summary>
        {entry.thought && <p>{entry.thought}</p>}
        {entry.input && <pre style={{ whiteSpace: 'pre-wrap' }}>{entry.input}</pre>}
        <pre style={{ whiteSpace: 'pre-wrap' }}>{entry.observation}</pre>
      </details>)}
    </div>)}
  </div>;
}
