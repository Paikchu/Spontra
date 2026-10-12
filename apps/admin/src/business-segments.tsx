import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import type { AiCompanies } from '@/shared/analysis-contract/ai-runs-admin';
import type { LibraryOverview } from '@/shared/analysis-contract/filing-library';
import { adminApi, AdminApiError } from './admin-api';
import { AiKindPanel } from './ai-runs';
import { CompanyLogo } from '@/packages/web/src/company-logo';
import { LinksPanel, WikiPanel } from './filing-library-cross';
import './filing-library.css';

type View = 'wiki' | 'tree' | 'explainer' | 'links';
const views: Array<[View, string]> = [['wiki', '板块数据'], ['tree', '业务脑图'], ['explainer', '业务解读'], ['links', '业务主线']];
type Company = { ticker: string; documents: number };
function initial(name: 'ticker' | 'view') { try { return new URLSearchParams(window.location.search).get(name) ?? ''; } catch { return ''; } }

/**
 * A company's business segments in one place: the segment numbers and passages the library assembles, the model's
 * breakdown and explanation of each segment, and the links that tie a segment to its sections.
 */
export function BusinessSegments({ onAuthenticated, onUnauthorized, onOpenSection }: { onAuthenticated: () => void; onUnauthorized: () => void; onOpenSection: (ticker: string, documentId: string, sectionId: string) => void }) {
  const [companies, setCompanies] = useState<Company[] | null>(null), [error, setError] = useState(''), [refresh, setRefresh] = useState(0), [search, setSearch] = useState('');
  const [ticker, setTicker] = useState(() => initial('ticker')), [view, setView] = useState<View>(() => views.find(([v]) => v === initial('view'))?.[0] ?? 'wiki');
  const callbacks = useRef({ onAuthenticated, onUnauthorized });
  useEffect(() => { callbacks.current = { onAuthenticated, onUnauthorized }; }, [onAuthenticated, onUnauthorized]);
  const fail = (e: unknown) => { if (e instanceof AdminApiError && e.status === 401) callbacks.current.onUnauthorized(); else setError(e instanceof Error ? e.message : String(e)); };

  useEffect(() => {
    const c = new AbortController();
    void Promise.all([adminApi<LibraryOverview>('library', { signal: c.signal }), adminApi<AiCompanies>('ai/companies', { signal: c.signal })]).then(([library, ai]) => {
      const tickers = [...new Set([...library.companies.map(x => x.ticker), ...ai.companies.map(x => x.ticker)])].sort();
      setCompanies(tickers.map(t => ({ ticker: t, documents: library.companies.find(x => x.ticker === t)?.documents ?? 0 })));
      setError(''); callbacks.current.onAuthenticated();
      setTicker(t => tickers.includes(t) ? t : tickers[0] ?? '');
    }).catch(e => { if (!c.signal.aborted) fail(e); });
    return () => c.abort();
  }, [refresh]);
  useEffect(() => {
    if (!ticker) return;
    try { window.history.replaceState(null, '', `${window.location.pathname}?${new URLSearchParams({ ticker, view })}`); } catch { /* Sandboxed preview. */ }
  }, [ticker, view]);

  const shown = companies?.filter(c => c.ticker.toLowerCase().includes(search.toLowerCase())) ?? [];
  return <div className="ra-workspace fl-workspace">
    <section className="ra-list" aria-label="公司">
      <div className="ra-filters"><label className="ra-search"><Search size={17} /><input aria-label="搜索公司" placeholder="代码" value={search} onChange={e => setSearch(e.target.value)} /></label><button className="fl-icon" aria-label="刷新" onClick={() => setRefresh(n => n + 1)}><RefreshCw size={17} /></button></div>
      <div className="ra-list-caption">{companies ? `${companies.length} 家公司` : '加载中'}</div>
      {error && <p className="ra-error" role="alert">{error}</p>}
      <div className="ra-list-scroll">{shown.map(c => <button key={c.ticker} className="ra-report-row" aria-pressed={ticker === c.ticker} onClick={() => setTicker(c.ticker)}>
        <CompanyLogo symbol={c.ticker} /><span className="ra-row-info"><strong>{c.ticker}</strong><small>{c.documents} 份</small></span></button>)}</div>
    </section>
    <section className="ra-detail fl-detail" aria-label="业务板块">
      <nav className="fl-views" aria-label="视图">{views.map(([v, label]) => <button key={v} aria-pressed={view === v} onClick={() => setView(v)}>{label}</button>)}</nav>
      {!ticker ? <p className="fl-empty">未选择公司</p>
        : view === 'wiki' ? <WikiPanel key={ticker} ticker={ticker} onOpen={onOpenSection} fail={fail} />
        : view === 'links' ? <LinksPanel key={ticker} ticker={ticker} onOpen={onOpenSection} fail={fail} />
        : <div className="fl-panel"><AiKindPanel key={`${ticker}:${view}`} ticker={ticker} kind={view} onUnauthorized={onUnauthorized} /></div>}
    </section>
  </div>;
}
