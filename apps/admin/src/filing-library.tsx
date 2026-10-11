import { useEffect, useRef, useState } from 'react';
import { RefreshCw, RotateCcw } from 'lucide-react';
import type { LibraryDocumentDetail, LibraryDocumentSummary, LibraryOverview, LibrarySectionDetail, LibraryTable } from '@/shared/analysis-contract/filing-library';
import { adminApi, AdminApiError } from './admin-api';
import { FindPanel, LinksPanel, WikiPanel } from './filing-library-cross';
import './filing-library.css';

type View = 'documents' | 'links' | 'find' | 'wiki';
const views: Array<[View, string]> = [['documents', '文件结构'], ['links', '业务主线'], ['wiki', '公司页面'], ['find', '跨公司查找']];

const roles: Record<string, string> = { core: '正文', signal: '信号', boilerplate: '套话' };
const changes: Record<string, string> = { new: '新增', changed: '有变化', unchanged: '未变' };
const structures: Record<string, string> = { items: '按 Item', outline: '按标题', flat: '平铺' };
const docTypes: Record<string, string> = { primary: '正文', press_release: '新闻稿', exhibit: '附件' };
const reasons: Record<string, string> = { ARCHIVE_MISMATCH: '原始归档与指针不一致', NO_READABLE_TEXT: '没有可读文字', ARCHIVE_SOURCE_MISSING: '原始归档缺失' };
const day = (value: string) => value ? value.slice(0, 10) : '—';

function TableView({ table }: { table: LibraryTable }) {
  return <div className="fl-table-wrap">{table.unit && <p className="fl-unit">单位：{table.unit}</p>}<table className="fl-table"><thead><tr><th />{table.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
    <tbody>{table.rows.map((row, r) => <tr key={r}><th>{[...row.path, row.label].filter(Boolean).join(' › ')}</th>{row.cells.map((cell, c) => <td key={c}>{cell.text}</td>)}</tr>)}</tbody></table>
    {table.notes.map((n, i) => <p key={i} className="fl-note">{n}</p>)}</div>;
}

/** The filing library: how far splitting is, which documents need a look, and each document's sections and passages as stored. */
export function FilingLibrary({ onAuthenticated, onUnauthorized }: { onAuthenticated: () => void; onUnauthorized: () => void }) {
  const [overview, setOverview] = useState<LibraryOverview | null>(null), [ticker, setTicker] = useState(''), [documents, setDocuments] = useState<LibraryDocumentSummary[]>([]);
  const [documentId, setDocumentId] = useState(''), [detail, setDetail] = useState<LibraryDocumentDetail | null>(null), [sectionId, setSectionId] = useState('');
  const [section, setSection] = useState<LibrarySectionDetail | null>(null), [error, setError] = useState(''), [refresh, setRefresh] = useState(0), [notice, setNotice] = useState('');
  const [view, setView] = useState<View>('documents'), pendingSection = useRef('');
  const callbacks = useRef({ onAuthenticated, onUnauthorized }); callbacks.current = { onAuthenticated, onUnauthorized };
  const fail = (e: unknown) => { if (e instanceof AdminApiError && e.status === 401) callbacks.current.onUnauthorized(); else setError(e instanceof Error ? e.message : String(e)); };
  useEffect(() => { const c = new AbortController(); void adminApi<LibraryOverview>('library', { signal: c.signal }).then(r => { setOverview(r); setError(''); callbacks.current.onAuthenticated(); setTicker(t => t || r.companies[0]?.ticker || ''); }).catch(e => { if (!c.signal.aborted) fail(e); }); return () => c.abort(); }, [refresh]);
  useEffect(() => { if (!ticker) return; const c = new AbortController(); void adminApi<{ documents: LibraryDocumentSummary[] }>(`library/companies/${encodeURIComponent(ticker)}`, { signal: c.signal }).then(r => { setDocuments(r.documents); setDocumentId(id => r.documents.some(d => d.documentId === id) ? id : r.documents[0]?.documentId ?? ''); }).catch(e => { if (!c.signal.aborted) fail(e); }); return () => c.abort(); }, [ticker, refresh]);
  useEffect(() => { if (!documentId) return; const c = new AbortController(); setDetail(null); setSection(null); setSectionId(''); void adminApi<LibraryDocumentDetail>(`library/documents/${documentId}`, { signal: c.signal }).then(d => { setDetail(d); if (pendingSection.current) { setSectionId(pendingSection.current); pendingSection.current = ''; } }).catch(e => { if (!c.signal.aborted) fail(e); }); return () => c.abort(); }, [documentId, refresh]);
  useEffect(() => { if (!documentId || !sectionId) return; const c = new AbortController(); setSection(null); void adminApi<LibrarySectionDetail>(`library/documents/${documentId}/sections/${sectionId}`, { signal: c.signal }).then(setSection).catch(e => { if (!c.signal.aborted) fail(e); }); return () => c.abort(); }, [documentId, sectionId]);
  const rerun = () => void adminApi(`library/documents/${documentId}/rerun`, { method: 'POST', body: '{}' }).then(() => setNotice('已重新排入拆解，约一分钟后刷新查看。')).catch(fail);
  const cards = new Map(detail?.cards.map(c => [c.sectionId, c]));
  // A section found elsewhere opens in the document view, once its document's outline has loaded.
  const open = (t: string, d: string, s: string) => { setView('documents'); setTicker(t); if (d === documentId && detail) setSectionId(s); else { pendingSection.current = s; setDocumentId(d); } };
  return <div className="ra-workspace fl-workspace">
    <section className="ra-list" aria-label="文件列表">
      <div className="ra-filters"><label className="fl-filter">公司<select aria-label="筛选公司" value={ticker} onChange={e => setTicker(e.target.value)}>{overview?.companies.map(c => <option key={c.ticker} value={c.ticker}>{c.ticker} · {c.documents} 份{c.unreadable ? ` · ${c.unreadable} 份无法读取` : ''}</option>)}</select></label><button className="fl-icon" aria-label="刷新" onClick={() => setRefresh(n => n + 1)}><RefreshCw size={17} /></button></div>
      {overview && <div className="fl-stats"><span><strong>{overview.totals.ready}</strong>已拆解</span><span><strong>{overview.pending}</strong>待拆解</span><span><strong>{overview.totals.unreadable}</strong>无法读取</span><span><strong>{overview.totals.cards}</strong>索引卡</span></div>}
      <div className="ra-list-caption">{overview ? `${overview.totals.sections.toLocaleString()} 个章节 · ${overview.totals.passages.toLocaleString()} 段 · 解析器 ${overview.parserVersion}${overview.enabled ? '' : ' · 自动拆解未开启'}` : '正在加载…'}</div>
      {error && <p className="ra-error" role="alert">{error}</p>}
      <div className="ra-list-scroll">{documents.map(d => <button key={d.documentId} className="ra-report-row" aria-pressed={documentId === d.documentId} onClick={() => setDocumentId(d.documentId)}>
        <span className="ra-row-info"><strong>{d.form} · {docTypes[d.docType]} · {day(d.filedAt)}</strong><span>{d.status === 'unreadable' ? `无法读取：${reasons[d.failureReason ?? ''] ?? d.failureReason}` : `${structures[d.structure]} · ${d.sections} 节 · ${d.passages} 段`}</span>
          <small>{d.structureCheck.status === 'segments_missing' ? `业务部门未出现在标题中：${d.structureCheck.missing.join('、')}` : d.accessionNumber}</small></span></button>)}</div>
    </section>
    <section className="ra-detail fl-detail" aria-label="文件库" aria-busy={view === 'documents' && !!documentId && !detail}>
      <nav className="fl-views" aria-label="视图">{views.map(([v, label]) => <button key={v} aria-pressed={view === v} onClick={() => setView(v)}>{label}{v === 'links' || v === 'wiki' ? ` · ${ticker}` : ''}</button>)}</nav>
      {view === 'links' ? <LinksPanel ticker={ticker} onOpen={open} fail={fail} /> : view === 'wiki' ? <WikiPanel ticker={ticker} onOpen={open} fail={fail} /> : view === 'find' ? <FindPanel tickers={overview?.companies.map(c => c.ticker) ?? []} onOpen={open} fail={fail} /> : <>
      {notice && <p className="fl-notice" role="status">{notice}</p>}
      {detail ? <>
        <header className="fl-header"><div><p>{detail.document.ticker} · {detail.document.form} · {docTypes[detail.document.docType]} · {structures[detail.document.structure]}</p><h2>{detail.document.accessionNumber}</h2><a href={detail.document.documentUrl} target="_blank" rel="noreferrer">在 SEC 打开原文 ↗</a></div><button className="fl-rerun" onClick={rerun}><RotateCcw size={15} />重新拆解</button></header>
        <div className="fl-columns">
          <ol className="fl-outline" aria-label="章节">{detail.outline.map(s => <li key={s.sectionId} style={{ paddingLeft: s.depth * 14 }}><button aria-pressed={sectionId === s.sectionId} onClick={() => setSectionId(s.sectionId)}>
            <span className="fl-title">{s.title}</span><span className="fl-meta"><em data-role={s.role}>{roles[s.role]}</em>{s.change !== 'unchanged' && <em data-change={s.change}>{changes[s.change]}</em>}{cards.has(s.sectionId) && <em data-card>卡片</em>}<small>{s.chars.toLocaleString()}</small></span></button></li>)}</ol>
          <div className="fl-reader">{section ? <>
            <p className="fl-path">{section.section.path.join(' › ')}</p>
            {section.card && <div className="fl-card"><p><strong>索引卡</strong>{section.card.topic && <em>{section.card.topic}</em>}<small>{section.card.model} · 推理 {section.card.reasoning}</small></p>{section.card.gist && <p>{section.card.gist}</p>}{!!section.card.entities.length && <p className="fl-entities">{section.card.entities.map(e => <span key={e}>{e}</span>)}</p>}{!!section.card.answers.length && <ul>{section.card.answers.map(a => <li key={a}>{a}</li>)}</ul>}</div>}
            {section.passages.map(p => <article key={p.passageId} className="fl-passage" data-change={p.change}><small>{p.passageId}{p.factRefs.length ? ` · ${p.factRefs.length} 个 XBRL 数字` : ''}{p.change !== 'unchanged' ? ` · ${changes[p.change]}` : ''}</small>{p.table ? <TableView table={p.table} /> : <p>{p.text}</p>}</article>)}
          </> : <p className="fl-empty">{sectionId ? '正在读取…' : '选择左侧章节查看原文段落。'}</p>}</div>
        </div>
      </> : <p className="fl-empty">{documentId ? '正在读取文件结构…' : '选择一份文件。'}</p>}
      </>}
    </section>
  </div>;
}
