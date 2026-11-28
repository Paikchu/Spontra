import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/web/shared/ui/table";
import { useEffect, useState } from 'react';
import { Refresh as RefreshCw } from "reicon-react";
import type { BusinessMapUsage, CompanyLayerStatus } from '@/src/api/admin/types/business-map-admin';
import type { Layer } from '@/src/domains/business-map/features-contract';
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
    <header><h4>Token 用量</h4><button className="ra-icon-button" type="button" aria-label="刷新 Token 用量" onClick={() => setRefresh(n => n + 1)}><RefreshCw size={18} strokeWidth={1.5} /></button></header>
    {state.status === 'error' && <p className="ra-error" role="alert">Token 读取失败</p>}
    <div className="min-w-0" tabIndex={0} role="region" aria-label="各板块 Token 用量">
      <Table className="min-w-[36rem] tabular-nums [&_td:nth-child(n+3)]:text-right [&_th:nth-child(n+3)]:text-right" aria-description="累计已归属该公司的用量，不含缺失的历史记录。"><TableHeader><TableRow><TableHead scope="col">板块</TableHead><TableHead scope="col">状态</TableHead><TableHead scope="col">输入（含缓存）</TableHead><TableHead scope="col">输出</TableHead><TableHead scope="col">合计</TableHead></TableRow></TableHeader>
        <TableBody>{rows.map(row => {
          const usage = data?.layers[row.layer], recorded = !!usage && usage.calls > usage.callsWithoutTokens;
          return <TableRow key={row.layer}><TableHead scope="row">{row.label}</TableHead><TableCell aria-live="polite">{row.state ? <span className="bm-layer-status" data-state={row.state.code}>{row.state.label}</span> : '—'}</TableCell>
            <TableCell title={usage ? `其中缓存命中 ${count(usage.cachedTokens)}` : undefined}>{recorded ? count(usage.inputTokens) : '—'}</TableCell>
            <TableCell>{recorded ? count(usage.outputTokens) : '—'}</TableCell>
            <TableCell>{recorded ? count(usage.inputTokens + usage.outputTokens) : !usage ? '—' : usage.calls ? '无 Token 数值' : '暂无记录'}</TableCell></TableRow>;
        })}</TableBody>
      </Table>
    </div>
    {data?.firstAt && <p className="bm-usage-caption">{data.firstAt.slice(0, 10)} 至 {data.lastAt?.slice(0, 10)}{data.unassigned.calls > 0 && ` · 其他任务 ${count(data.unassigned.inputTokens + data.unassigned.outputTokens)} Token`}</p>}
  </section>;
}
