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

  async function regenerate(report: ReportAdminItem) {
    const key = report.accessionNumber;
    setSent(s => ({ ...s, [key]: '提交中' }));
    try {
      await adminApi(`reports/${report.ticker}/${report.accessionNumber}/regenerate`, { method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: '{}' });
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
            {r.workflowInstanceId && <button className="fm-button" type="button" aria-expanded={viewing === r.accessionNumber} onClick={() => void view(r)}>过程</button>}</td>
        </tr>{viewing === r.accessionNumber && <tr><td colSpan={6}><RunProcess process={process} /></td></tr>}</Fragment>)}</tbody>
      </table>
    </div>}
  </section>;
}

function RunProcess({ process }: { process: ReportRunProcess | 'loading' | 'error' | null }) {
  if (process === 'loading' || !process) return <p className="bm-empty">读取中</p>;
  if (process === 'error') return <p className="ra-error" role="alert">运行记录读取失败</p>;
  return <div>
    <p className="bm-usage-caption">{process.status ?? '—'}{process.step ? ` · ${process.step}` : ''}{process.updatedAt ? ` · ${process.updatedAt}` : ''}{process.error?.message ? ` · ${process.error.message}` : ''}</p>
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
