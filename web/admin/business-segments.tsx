import { useEffect, useRef, useState } from 'react';
import { ArrowsClockwiseIcon as RefreshCw, MagnifyingGlassIcon as Search } from "@phosphor-icons/react";
import type { AiCompanies } from '@/src/api/admin/types/ai-runs-admin';
import { adminApi, AdminApiError } from './admin-api';
import { AiKindPanel } from './ai-runs';
import { usePageActive } from './admin-page';
import { BusinessCharts } from './business-charts';
import './business-charts.css';
import { CompanyLogo } from '@/web/shared/company-logo';
import './business-segments.css';

type View = 'charts' | 'tree' | 'explainer';
const views: Array<[View, string]> = [['charts', '图表数据'], ['tree', '业务脑图'], ['explainer', '业务解读']];
type Company = { ticker: string };
function initial(name: 'ticker' | 'view') { try { return new URLSearchParams(window.location.search).get(name) ?? ''; } catch { return ''; } }

export function BusinessSegments({ onAuthenticated, onUnauthorized }: { onAuthenticated: () => void; onUnauthorized: () => void }) {
  const [companies, setCompanies] = useState<Company[] | null>(null), [error, setError] = useState(''), [refresh, setRefresh] = useState(0), [search, setSearch] = useState('');
  const [ticker, setTicker] = useState(() => initial('ticker')), [view, setView] = useState<View>(() => views.find(([v]) => v === initial('view'))?.[0] ?? 'charts');
  const callbacks = useRef({ onAuthenticated, onUnauthorized });
  useEffect(() => { callbacks.current = { onAuthenticated, onUnauthorized }; }, [onAuthenticated, onUnauthorized]);
  const fail = (e: unknown) => { if (e instanceof AdminApiError && e.status === 401) callbacks.current.onUnauthorized(); else setError(e instanceof Error ? e.message : String(e)); };

  useEffect(() => {
    const c = new AbortController();
    void adminApi<AiCompanies>('ai/companies', { signal: c.signal }).then(ai => {
      const tickers = ai.companies.map(company => company.ticker).sort();
      setCompanies(tickers.map(ticker => ({ ticker })));
      setError(''); callbacks.current.onAuthenticated();
      setTicker(t => tickers.includes(t) ? t : tickers[0] ?? '');
    }).catch(e => { if (!c.signal.aborted) fail(e); });
    return () => c.abort();
  }, [refresh]);
  const visible = usePageActive();
  useEffect(() => {
    if (!ticker || !visible.current) return;
    try { window.history.replaceState(null, '', `${window.location.pathname}?${new URLSearchParams({ ticker, view })}`); } catch { /* Sandboxed preview. */ }
  }, [ticker, view, visible]);

  const shown = companies?.filter(c => c.ticker.toLowerCase().includes(search.toLowerCase())) ?? [];
  return <div className="ra-workspace bs-workspace">
    <section className="ra-list" aria-label="公司">
      <div className="ra-filters"><label className="ra-search"><Search size={17} /><input aria-label="搜索公司" placeholder="代码" value={search} onChange={e => setSearch(e.target.value)} /></label><button className="bs-icon" aria-label="刷新" onClick={() => setRefresh(n => n + 1)}><RefreshCw size={17} /></button></div>
      <div className="ra-list-caption">{companies ? `${shown.length} 家公司` : '加载中'}</div>
      {error && <p className="ra-error" role="alert">{error}</p>}
      <div className="ra-list-scroll">{shown.map(c => <button key={c.ticker} className="ra-report-row" aria-pressed={ticker === c.ticker} onClick={() => setTicker(c.ticker)}>
        <CompanyLogo symbol={c.ticker} /><span className="ra-row-info"><strong>{c.ticker}</strong></span></button>)}
        {companies && !shown.length && <p className="bs-empty">没有匹配的公司</p>}
      </div>
    </section>
    <section className="ra-detail bs-detail" aria-label="业务板块">
      <nav className="bs-views" aria-label="视图">{views.map(([v, label]) => <button key={v} aria-pressed={view === v} onClick={() => setView(v)}>{label}</button>)}</nav>
      {!ticker ? <p className="bs-empty">未选择公司</p>
        : view === 'charts' ? <div className="bs-panel"><BusinessCharts key={ticker} ticker={ticker} onUnauthorized={onUnauthorized} /></div>
        : <div className="bs-panel"><AiKindPanel key={`${ticker}:${view}`} ticker={ticker} kind={view} onUnauthorized={onUnauthorized} /></div>}
    </section>
  </div>;
}
