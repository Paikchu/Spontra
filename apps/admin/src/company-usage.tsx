import { useEffect, useState } from 'react';
import { ArrowsClockwiseIcon as RefreshCw } from "@phosphor-icons/react";
import type { BusinessMapUsage, CompanyLayerStatus } from '@/shared/analysis-contract/business-map-admin';
import type { Layer } from '@/shared/analysis-contract/business-features';
import { adminApi, AdminApiError } from './admin-api';
import { useOnReturn, usePageActive } from './admin-page';

type UsageState = { status: 'loading' } | { status: 'ready'; data: BusinessMapUsage } | { status: 'error' };
type LayerState = { layer: Layer; label: string; state: CompanyLayerStatus | undefined };
const count = (value: number) => value.toLocaleString('en-US');

export function CompanyUsage({ ticker, rows, onUnauthorized }: { ticker: string; rows: LayerState[]; onUnauthorized: () => void }) {
  const [state, setState] = useState<UsageState>({ status: 'loading' });
  const [refresh, setRefresh] = useState(0);
  const active = usePageActive();
  useEffect(() => {
    const controller = new AbortController();
    void adminApi<BusinessMapUsage>(`business-map/companies/${ticker}/usage`, { signal: controller.signal })
      .then(data => setState({ status: 'ready', data }))
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
  const data = state.status === 'ready' ? state.data : null;
  return <section className="bm-usage" aria-label={`${ticker} Token 用量`} aria-busy={state.status === 'loading'}>
    <header><h4>Token 记录</h4><button className="ra-icon-button" type="button" aria-label="刷新 Token 用量" onClick={() => setRefresh(n => n + 1)}><RefreshCw size={14} /></button></header>
    {state.status === 'error' && <p className="ra-error" role="alert">Token 读取失败</p>}
    <div className="bm-usage-scroll" tabIndex={0} role="region" aria-label="各板块 Token 用量">
      <table className="bm-usage-table" aria-description="累计已归属该公司的用量，不含缺失的历史记录。"><thead><tr><th scope="col">板块</th><th scope="col">状态</th><th scope="col">输入（含缓存）</th><th scope="col">输出</th><th scope="col">合计</th></tr></thead>
        <tbody>{rows.map(row => {
          const usage = data?.layers[row.layer], recorded = !!usage && usage.calls > usage.callsWithoutTokens;
          return <tr key={row.layer}><th scope="row">{row.label}</th><td aria-live="polite">{row.state ? <span className="bm-layer-status" data-state={row.state.code}>{row.state.label}</span> : '—'}</td>
            <td title={usage ? `其中缓存命中 ${count(usage.cachedTokens)}` : undefined}>{recorded ? count(usage.inputTokens) : '—'}</td>
            <td>{recorded ? count(usage.outputTokens) : '—'}</td>
            <td>{recorded ? count(usage.inputTokens + usage.outputTokens) : !usage ? '—' : usage.calls ? '无 Token 数值' : '暂无记录'}</td></tr>;
        })}</tbody>
      </table>
    </div>
    {data?.firstAt && <p className="bm-usage-caption">{data.firstAt.slice(0, 10)} 至 {data.lastAt?.slice(0, 10)}{data.unassigned.calls > 0 && ` · 其他任务 ${count(data.unassigned.inputTokens + data.unassigned.outputTokens)} Token`}</p>}
  </section>;
}
