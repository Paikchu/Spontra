import { useEffect, useState } from 'react';
import { Check, RotateCcw, Search, Undo2 } from 'lucide-react';
import type { IndustryCategory, LibraryFactRow, LibraryFindResult, LibraryLinksView, LibraryWikiEntry, LibraryWikiPage } from '@/shared/analysis-contract/filing-library';
import { adminApi } from './admin-api';

type Open = (ticker: string, documentId: string, sectionId: string) => void;
const via: Record<string, string> = { index: '索引', recall: '语义召回' };
const recallState: Record<string, string> = { ok: '已用语义召回', off: '未用语义召回', empty: '语义召回无结果', error: '语义召回出错' };
const linkState: Record<string, string> = { proposed: '待确认', confirmed: '已确认', unlinked: '未关联' };
const slugOf = (businessKey: string) => businessKey.slice(businessKey.indexOf(':') + 1);

function Facts({ facts }: { facts: LibraryFactRow[] }) {
  if (!facts.length) return null;
  return <table className="fl-table fl-facts"><thead><tr><th>公司</th><th>业务</th><th>指标</th><th>期间</th><th>数值</th><th>单位</th></tr></thead>
    <tbody>{facts.map((f, i) => <tr key={i}><td>{f.ticker}</td><td>{f.business}</td><td>{f.metric}</td><td>{f.periodEnd}</td><td>{f.value}</td><td><a href={f.source} target="_blank" rel="noreferrer">{f.unit || '—'}</a></td></tr>)}</tbody></table>;
}

/** A company's business links: the model's proposals and the admin's decisions on them. */
export function LinksPanel({ ticker, onOpen, fail }: { ticker: string; onOpen: Open; fail: (e: unknown) => void }) {
  const [view, setView] = useState<LibraryLinksView | null>(null), [refresh, setRefresh] = useState(0), [notice, setNotice] = useState('');
  useEffect(() => { if (!ticker) return; const c = new AbortController(); setView(null); void adminApi<LibraryLinksView>(`library/links/${encodeURIComponent(ticker)}`, { signal: c.signal }).then(setView).catch(e => { if (!c.signal.aborted) fail(e); }); return () => c.abort(); }, [ticker, refresh]);
  const decide = (businessKey: string, body: { status: 'confirmed' | 'proposed'; industryCategory?: IndustryCategory | null }) =>
    void adminApi(`library/links/${encodeURIComponent(ticker)}/${encodeURIComponent(slugOf(businessKey))}`, { method: 'POST', body: JSON.stringify(body) }).then(() => setRefresh(n => n + 1)).catch(fail);
  const rerun = () => void adminApi(`library/links/${encodeURIComponent(ticker)}/run`, { method: 'POST', body: '{}' }).then(() => setNotice('已请求重新提议')).catch(fail);
  return <div className="fl-panel">
    <header className="fl-panel-head"><button className="fl-rerun" onClick={rerun}><RotateCcw size={15} />重新提议</button></header>
    {notice && <p className="fl-notice" role="status">{notice}</p>}
    {!view ? <p className="fl-empty">加载中</p> : !view.links.length ? <p className="fl-empty">无业务主线</p> :
      <ul className="fl-links">{view.links.map(l => <li key={l.businessKey} data-status={l.status}>
        <div className="fl-link-head"><strong>{l.name}</strong><em data-status={l.status}>{linkState[l.status]}</em>
          <select aria-label={`${l.name} 的行业类别`} value={l.industryCategory ?? ''} onChange={e => decide(l.businessKey, { status: l.status, industryCategory: (e.target.value || null) as IndustryCategory | null })}>
            <option value="">未分类</option>{Object.entries(view.categories).map(([k, label]) => <option key={k} value={k}>{k} · {label}</option>)}</select>
          {l.status === 'proposed' ? <button onClick={() => decide(l.businessKey, { status: 'confirmed' })}><Check size={14} />确认</button> : <button onClick={() => decide(l.businessKey, { status: 'proposed' })}><Undo2 size={14} />退回</button>}</div>
        <small>{l.flowNodeId ? `地图节点 ${l.flowNodeId}` : '无地图节点'}{l.xbrlMembers.length ? ` · XBRL ${l.xbrlMembers.join('、')}` : ''}{l.proposedBy ? ` · ${l.proposedBy}` : ''}</small>
        <ol>{l.sections.map(s => <li key={s.sectionId}><button className="fl-linkish" onClick={() => onOpen(ticker, s.documentId, s.sectionId)}>{s.path.join(' › ')}</button>{s.gist && <span>{s.gist}</span>}</li>)}</ol>
      </li>)}</ul>}
  </div>;
}

/** Sections across companies, from the index and from AI Search, and the validated numbers of a category. */
export function FindPanel({ onOpen, fail }: { onOpen: Open; fail: (e: unknown) => void }) {
  const [form, setForm] = useState({ q: '', category: '', topic: '', entity: '', tickers: '', proposed: true });
  const [result, setResult] = useState<LibraryFindResult | null>(null), [facts, setFacts] = useState<LibraryFactRow[]>([]), [busy, setBusy] = useState(false);
  const [categories, setCategories] = useState<Record<string, string>>({}), [status, setStatus] = useState<{ enabled?: boolean; items?: Array<{ status: string; n: number }>; error?: string } | null>(null);
  useEffect(() => { void adminApi<LibraryLinksView>('library/links').then(v => setCategories(v.categories)).catch(fail); void adminApi<typeof status>('library/search').then(setStatus).catch(() => setStatus(null)); }, []);
  const run = () => {
    const params = new URLSearchParams();
    for (const key of ['q', 'category', 'topic', 'entity', 'tickers'] as const) if (form[key].trim()) params.set(key, form[key].trim());
    if (form.proposed) params.set('proposed', '1');
    setBusy(true);
    void Promise.all([
      adminApi<LibraryFindResult>(`library/find?${params}`).then(setResult),
      form.category ? adminApi<{ facts: LibraryFactRow[] }>(`library/facts?${new URLSearchParams({ category: form.category, ...(form.tickers ? { tickers: form.tickers } : {}), ...(form.proposed ? { proposed: '1' } : {}) })}`).then(r => setFacts(r.facts)) : Promise.resolve(setFacts([])),
    ]).catch(fail).finally(() => setBusy(false));
  };
  const uploaded = status?.items?.filter(i => i.status === 'uploaded').reduce((n, i) => n + i.n, 0) ?? 0;
  return <div className="fl-panel">
    <form className="fl-find" onSubmit={e => { e.preventDefault(); run(); }}>
      <input aria-label="自然语言问题" placeholder="问题" value={form.q} onChange={e => setForm({ ...form, q: e.target.value })} />
      <select aria-label="行业类别" value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}><option value="">全部类别</option>{Object.entries(categories).map(([k, label]) => <option key={k} value={k}>{k} · {label}</option>)}</select>
      <input aria-label="卡片主题" placeholder="主题" value={form.topic} onChange={e => setForm({ ...form, topic: e.target.value })} />
      <input aria-label="实体" placeholder="实体" value={form.entity} onChange={e => setForm({ ...form, entity: e.target.value })} />
      <input aria-label="公司" placeholder="公司" value={form.tickers} onChange={e => setForm({ ...form, tickers: e.target.value.toUpperCase() })} />
      <label><input type="checkbox" checked={form.proposed} onChange={e => setForm({ ...form, proposed: e.target.checked })} />含待确认主线</label>
      <button type="submit" disabled={busy}><Search size={15} />{busy ? '查找中' : '查找'}</button>
    </form>
    <p className="fl-caption">语义召回：{status ? status.enabled ? `${uploaded.toLocaleString()} 个小节已上传${status.error ? ` · ${status.error}` : ''}` : '未开启' : '—'}{result ? ` · ${recallState[result.recall]}${result.recallError ? `：${result.recallError}` : ''}` : ''}</p>
    <Facts facts={facts} />
    {result && (!result.found.length ? <p className="fl-empty">无结果</p> : <ul className="fl-found">{result.found.map(f => <li key={f.sectionId}>
      <button className="fl-linkish" onClick={() => onOpen(f.ticker, f.documentId, f.sectionId)}><strong>{f.ticker}</strong> · {f.form} {f.filedAt.slice(0, 10)} · {f.path.join(' › ')}</button>
      <small><em data-via={f.via}>{via[f.via]}</em>{f.topic && ` · ${f.topic}`} · {f.score}</small>{f.gist && <p>{f.gist}</p>}</li>)}</ul>)}
  </div>;
}

function Entry({ e, ticker, onOpen }: { e: LibraryWikiEntry; ticker: string; onOpen: Open }) {
  return <article className="fl-wiki-entry"><button className="fl-linkish" onClick={() => onOpen(ticker, e.documentId, e.sectionId)}>{e.path.join(' › ')}</button><small>{e.form} · {e.filedAt.slice(0, 10)}{e.change !== 'unchanged' ? ` · ${e.change === 'new' ? '新增' : '有变化'}` : ''}</small>
    {e.gist && <p className="fl-gist">摘要：{e.gist}</p>}{e.excerpts.map(x => <blockquote key={x.passageId}><small>{x.passageId}</small>{x.text}</blockquote>)}</article>;
}

/** The derived company page: businesses with numbers and their sections, what changed, new risks; all from the library. */
export function WikiPanel({ ticker, onOpen, fail }: { ticker: string; onOpen: Open; fail: (e: unknown) => void }) {
  const [page, setPage] = useState<LibraryWikiPage | null>(null);
  useEffect(() => { if (!ticker) return; const c = new AbortController(); setPage(null); void adminApi<LibraryWikiPage>(`library/wiki/${encodeURIComponent(ticker)}`, { signal: c.signal }).then(setPage).catch(e => { if (!c.signal.aborted) fail(e); }); return () => c.abort(); }, [ticker]);
  if (!page) return <p className="fl-empty">加载中</p>;
  return <div className="fl-panel fl-wiki">
    <p className="fl-caption">来源：{page.documents.map(d => `${d.form} ${d.filedAt.slice(0, 10)}`).join('、')}</p>
    {page.businesses.map(b => <section key={b.businessKey ?? b.name}><h3>{b.name}<em data-status={b.status}>{linkState[b.status]}</em>{b.industryCategory && <small>{b.industryCategory}</small>}</h3><Facts facts={b.facts} />{b.sections.map(e => <Entry key={e.sectionId} e={e} ticker={ticker} onOpen={onOpen} />)}</section>)}
    {!!page.changes.length && <section><h3>最新季报变化小节</h3>{page.changes.map(e => <Entry key={e.sectionId} e={e} ticker={ticker} onOpen={onOpen} />)}</section>}
    {!!page.risks.length && <section><h3>新增或改动的风险因素</h3>{page.risks.map(e => <Entry key={e.sectionId} e={e} ticker={ticker} onOpen={onOpen} />)}</section>}
  </div>;
}
