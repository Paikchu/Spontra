import { useEffect, useRef, useState } from 'react';
import { ChevronRight, RefreshCw, RotateCcw } from 'lucide-react';
import type { LibraryDocumentDetail, LibraryDocumentSummary, LibraryOverview, LibrarySectionDetail, LibraryTable } from '@/shared/analysis-contract/filing-library';
import { adminApi, AdminApiError } from './admin-api';
import { FindPanel } from './filing-library-cross';
import './filing-library.css';

const roles: Record<string, string> = { core: '正文', signal: '信号', boilerplate: '套话' };
const changes: Record<string, string> = { new: '新增', changed: '有变化', unchanged: '未变' };
const structures: Record<string, string> = { items: '按 Item', outline: '按标题', flat: '平铺' };
const docTypes: Record<string, string> = { primary: '正文', press_release: '新闻稿', exhibit: '附件' };
const docOrder: Record<string, number> = { primary: 0, press_release: 1, exhibit: 2 };
const reasons: Record<string, string> = { ARCHIVE_MISMATCH: '原始归档与指针不一致', NO_READABLE_TEXT: '没有可读文字', ARCHIVE_SOURCE_MISSING: '原始归档缺失' };
const day = (value: string) => value ? value.slice(0, 10) : '—';
const formKey = (form: string) => form.replace(/\/A$/, '');

/** Where the page is: no ticker lists companies, a ticker lists its filings, an accession opens one filing. Kept in the URL. */
type Place = { ticker: string; accession: string; document: string; section: string };
function placeFromUrl(): Place {
  try { const q = new URLSearchParams(window.location.search); return { ticker: q.get('ticker') ?? '', accession: q.get('accession') ?? '', document: q.get('document') ?? '', section: q.get('section') ?? '' }; }
  catch { return { ticker: '', accession: '', document: '', section: '' }; }
}
type Filing = { accession: string; head: LibraryDocumentSummary; docs: LibraryDocumentSummary[] };
function filingsOf(documents: LibraryDocumentSummary[]): Filing[] {
  const byAccession = new Map<string, LibraryDocumentSummary[]>();
  for (const d of documents) byAccession.set(d.accessionNumber, [...byAccession.get(d.accessionNumber) ?? [], d]);
  return [...byAccession].map(([accession, docs]) => {
    const sorted = [...docs].sort((a, b) => docOrder[a.docType]! - docOrder[b.docType]! || a.documentUrl.localeCompare(b.documentUrl));
    return { accession, head: sorted[0]!, docs: sorted };
  }).sort((a, b) => b.head.filedAt.localeCompare(a.head.filedAt));
}

function TableView({ table }: { table: LibraryTable }) {
  return <div className="fl-table-wrap">{table.unit && <p className="fl-unit">单位：{table.unit}</p>}<table className="fl-table"><thead><tr><th />{table.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
    <tbody>{table.rows.map((row, r) => <tr key={r}><th>{[...row.path, row.label].filter(Boolean).join(' › ')}</th>{row.cells.map((cell, c) => <td key={c}>{cell.text}</td>)}</tr>)}</tbody></table>
    {table.notes.map((n, i) => <p key={i} className="fl-note">{n}</p>)}</div>;
}

/** Every company in the library, with how far its filings are split. */
function Companies({ overview, onOpen }: { overview: LibraryOverview; onOpen: (ticker: string) => void }) {
  if (!overview.companies.length) return <p className="fl-empty">无公司</p>;
  return <div className="fl-scroll"><table className="fl-list">
    <thead><tr><th>公司</th><th>文件</th><th>最新申报</th><th>无法读取</th><th>标题缺业务部门</th><th /></tr></thead>
    <tbody>{overview.companies.map(c => <tr key={c.ticker} tabIndex={0} onClick={() => onOpen(c.ticker)} onKeyDown={e => { if (e.key === 'Enter') onOpen(c.ticker); }}>
      <td><strong>{c.ticker}</strong></td><td>{c.documents} 份</td><td>{day(c.latestFiledAt)}</td>
      <td>{c.unreadable ? <span className="fl-warn">{c.unreadable}</span> : <span className="fl-muted">0</span>}</td>
      <td>{c.segmentsMissing ? <span className="fl-warn">{c.segmentsMissing}</span> : <span className="fl-muted">0</span>}</td>
      <td className="fl-go"><ChevronRight size={16} /></td>
    </tr>)}</tbody>
  </table></div>;
}

/** A company's filings newest first, grouped by year; each row opens that filing. */
function Filings({ filings, onOpen }: { filings: Filing[]; onOpen: (accession: string) => void }) {
  if (!filings.length) return <p className="fl-empty">无已拆分 SEC 文件</p>;
  const years = [...new Set(filings.map(f => f.head.filedAt.slice(0, 4)))];
  return <div className="fl-scroll fl-timeline">
    <p className="fl-caption">{filings.length} 份申报 · {filings.reduce((n, f) => n + f.docs.length, 0)} 个文件 · 最早 {day(filings.at(-1)!.head.filedAt)}</p>
    {years.map(year => <section key={year}><h3>{year}</h3><ol>{filings.filter(f => f.head.filedAt.startsWith(year)).map(({ accession, head, docs }) => <li key={accession}>
      <button onClick={() => onOpen(accession)}>
        <time>{day(head.filedAt).slice(5)}</time><em data-form={formKey(head.form)}>{head.form}</em>
        <span className="fl-filing"><span className="fl-filing-head">{head.reportDate ? `报告期 ${head.reportDate}` : '无报告期'}<small>{accession}</small></span>
          <span className="fl-chips">{docs.map(d => <span key={d.documentId} className="fl-chip" data-status={d.status}>{docTypes[d.docType]}{d.status === 'unreadable' ? ' · 无法读取' : ` · ${d.sections} 节`}</span>)}</span></span>
        <ChevronRight size={16} className="fl-go" />
      </button>
    </li>)}</ol></section>)}
  </div>;
}

/** One filing: its documents as tabs, the chosen document's outline, and a section's passages and index card. */
function FilingDocuments({ filing, documentId, sectionId, onDocument, onSection, fail }: { filing: Filing; documentId: string; sectionId: string; onDocument: (id: string) => void; onSection: (id: string) => void; fail: (e: unknown) => void }) {
  const [detail, setDetail] = useState<LibraryDocumentDetail | null>(null), [section, setSection] = useState<LibrarySectionDetail | null>(null), [notice, setNotice] = useState('');
  const failRef = useRef(fail);
  useEffect(() => { failRef.current = fail; }, [fail]);
  useEffect(() => { const c = new AbortController(); void adminApi<LibraryDocumentDetail>(`library/documents/${documentId}`, { signal: c.signal }).then(setDetail).catch(e => { if (!c.signal.aborted) failRef.current(e); }); return () => c.abort(); }, [documentId]);
  useEffect(() => { if (!sectionId) return; const c = new AbortController(); void adminApi<LibrarySectionDetail>(`library/documents/${documentId}/sections/${sectionId}`, { signal: c.signal }).then(setSection).catch(e => { if (!c.signal.aborted) failRef.current(e); }); return () => c.abort(); }, [documentId, sectionId]);
  const shown = detail?.document.documentId === documentId ? detail : null;
  const reading = section?.section.sectionId === sectionId ? section : null;
  const document = filing.docs.find(d => d.documentId === documentId) ?? filing.head;
  const rerun = () => void adminApi(`library/documents/${documentId}/rerun`, { method: 'POST', body: '{}' }).then(() => setNotice('已重新排队')).catch(fail);
  const cards = new Map(shown?.cards.map(c => [c.sectionId, c]));
  return <>
    <header className="fl-header"><div>
      <p><em data-form={formKey(filing.head.form)}>{filing.head.form}</em>申报 {day(filing.head.filedAt)}{filing.head.reportDate ? ` · 报告期 ${filing.head.reportDate}` : ''}</p>
      <h2>{filing.accession}</h2></div>
      <div className="fl-header-actions"><a href={document.documentUrl} target="_blank" rel="noreferrer">SEC 原文 ↗</a><button className="fl-rerun" onClick={rerun}><RotateCcw size={15} />重新拆解</button></div>
    </header>
    <nav className="fl-views" aria-label="文件">{filing.docs.map(d => <button key={d.documentId} aria-pressed={d.documentId === documentId} onClick={() => onDocument(d.documentId)}>
      {docTypes[d.docType]}<small>{d.status === 'unreadable' ? '无法读取' : `${structures[d.structure]} · ${d.sections} 节 · ${d.passages} 段`}</small></button>)}</nav>
    {notice && <p className="fl-notice" role="status">{notice}</p>}
    {document.status === 'unreadable' ? <p className="fl-empty">无法读取：{reasons[document.failureReason ?? ''] ?? document.failureReason}</p>
      : document.structureCheck.status === 'segments_missing' && <p className="fl-caption">标题缺少业务部门：{document.structureCheck.missing.join('、')}</p>}
    {!shown ? <p className="fl-empty">加载中</p> : <div className="fl-columns">
      <ol className="fl-outline" aria-label="章节">{shown.outline.map(s => <li key={s.sectionId} style={{ paddingLeft: s.depth * 14 }}><button aria-pressed={sectionId === s.sectionId} onClick={() => onSection(s.sectionId)}>
        <span className="fl-title">{s.title}</span><span className="fl-meta"><em data-role={s.role}>{roles[s.role]}</em>{s.change !== 'unchanged' && <em data-change={s.change}>{changes[s.change]}</em>}{cards.has(s.sectionId) && <em data-card>卡片</em>}<small>{s.chars.toLocaleString()}</small></span></button></li>)}</ol>
      <div className="fl-reader">{reading ? <>
        <p className="fl-path">{reading.section.path.join(' › ')}</p>
        {reading.card && <div className="fl-card"><p><strong>索引卡</strong>{reading.card.topic && <em>{reading.card.topic}</em>}<small>{reading.card.model} · 推理 {reading.card.reasoning}</small></p>{reading.card.gist && <p>{reading.card.gist}</p>}{!!reading.card.entities.length && <p className="fl-entities">{reading.card.entities.map(e => <span key={e}>{e}</span>)}</p>}{!!reading.card.answers.length && <ul>{reading.card.answers.map(a => <li key={a}>{a}</li>)}</ul>}</div>}
        {reading.passages.map(p => <article key={p.passageId} className="fl-passage" data-change={p.change}><small>{p.passageId}{p.factRefs.length ? ` · ${p.factRefs.length} 个 XBRL 数字` : ''}{p.change !== 'unchanged' ? ` · ${changes[p.change]}` : ''}</small>{p.table ? <TableView table={p.table} /> : <p>{p.text}</p>}</article>)}
      </> : <p className="fl-empty">{sectionId ? '加载中' : '未选择章节'}</p>}</div>
    </div>}
  </>;
}

/** The filing library as a drill-down: companies, then a company's filings, then one filing's documents and sections. */
export function FilingLibrary({ onAuthenticated, onUnauthorized }: { onAuthenticated: () => void; onUnauthorized: () => void }) {
  const [place, setPlace] = useState<Place>(placeFromUrl), [tab, setTab] = useState<'companies' | 'find'>('companies');
  const [overview, setOverview] = useState<LibraryOverview | null>(null), [documents, setDocuments] = useState<{ ticker: string; list: LibraryDocumentSummary[] } | null>(null);
  const [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const callbacks = useRef({ onAuthenticated, onUnauthorized });
  useEffect(() => { callbacks.current = { onAuthenticated, onUnauthorized }; }, [onAuthenticated, onUnauthorized]);
  const fail = (e: unknown) => { if (e instanceof AdminApiError && e.status === 401) callbacks.current.onUnauthorized(); else setError(e instanceof Error ? e.message : String(e)); };
  const failRef = useRef(fail);
  useEffect(() => { failRef.current = fail; });

  useEffect(() => { const c = new AbortController(); void adminApi<LibraryOverview>('library', { signal: c.signal }).then(r => { setOverview(r); setError(''); callbacks.current.onAuthenticated(); }).catch(e => { if (!c.signal.aborted) failRef.current(e); }); return () => c.abort(); }, [refresh]);
  useEffect(() => { if (!place.ticker) return; const c = new AbortController(); void adminApi<{ documents: LibraryDocumentSummary[] }>(`library/companies/${encodeURIComponent(place.ticker)}`, { signal: c.signal }).then(r => setDocuments({ ticker: place.ticker, list: r.documents })).catch(e => { if (!c.signal.aborted) failRef.current(e); }); return () => c.abort(); }, [place.ticker, refresh]);
  // Browser back and forward move through the levels.
  useEffect(() => { const onPop = () => setPlace(placeFromUrl()); window.addEventListener('popstate', onPop); return () => window.removeEventListener('popstate', onPop); }, []);

  function go(next: Place) {
    setPlace(next); setError('');
    const q = new URLSearchParams(Object.entries(next).filter(([, v]) => v) as Array<[string, string]>);
    try { window.history.pushState(null, '', `${window.location.pathname}${q.size ? `?${q}` : ''}`); } catch { /* Sandboxed preview. */ }
  }
  const list = documents?.ticker === place.ticker ? documents.list : null;
  const filings = list ? filingsOf(list) : [];
  // A section linked from elsewhere names its document; the filing follows from it.
  const accession = place.accession || (place.document && list?.find(d => d.documentId === place.document)?.accessionNumber) || '';
  const filing = filings.find(f => f.accession === accession);
  const documentId = filing && (filing.docs.some(d => d.documentId === place.document) ? place.document : filing.head.documentId);
  const openSection = (ticker: string, document: string, section: string) => go({ ticker, accession: '', document, section });

  return <div className="fl-page">
    <div className="fl-bar">
      <nav className="fl-crumbs" aria-label="位置">
        <button onClick={() => go({ ticker: '', accession: '', document: '', section: '' })} aria-current={!place.ticker ? 'page' : undefined}>全部公司</button>
        {place.ticker && <><ChevronRight size={14} /><button onClick={() => go({ ticker: place.ticker, accession: '', document: '', section: '' })} aria-current={!accession ? 'page' : undefined}>{place.ticker}</button></>}
        {filing && <><ChevronRight size={14} /><span aria-current="page">{filing.head.form} · {day(filing.head.filedAt)}</span></>}
      </nav>
      <button className="fl-icon" aria-label="刷新" onClick={() => setRefresh(n => n + 1)}><RefreshCw size={17} /></button>
    </div>
    {error && <p className="ra-error" role="alert">{error}</p>}
    {!place.ticker ? <>
      {overview && <div className="fl-stats"><span><strong>{overview.totals.ready}</strong>已拆解</span><span><strong>{overview.pending}</strong>待拆解</span><span><strong>{overview.totals.unreadable}</strong>无法读取</span><span><strong>{overview.totals.cards}</strong>索引卡</span>
        <small>{overview.totals.sections.toLocaleString()} 个章节 · {overview.totals.passages.toLocaleString()} 段 · 解析器 {overview.parserVersion}{overview.enabled ? '' : ' · 自动拆解未开启'}</small></div>}
      <nav className="fl-views" aria-label="视图"><button aria-pressed={tab === 'companies'} onClick={() => setTab('companies')}>公司</button><button aria-pressed={tab === 'find'} onClick={() => setTab('find')}>跨公司查找</button></nav>
      {tab === 'find' ? <div className="fl-scroll"><FindPanel onOpen={openSection} fail={fail} /></div>
        : overview ? <Companies overview={overview} onOpen={ticker => go({ ticker, accession: '', document: '', section: '' })} /> : <p className="fl-empty">加载中</p>}
    </> : !list ? <p className="fl-empty">加载中</p>
      : filing && documentId ? <FilingDocuments filing={filing} documentId={documentId} sectionId={place.section}
          onDocument={document => go({ ...place, accession, document, section: '' })} onSection={section => go({ ...place, accession, document: documentId, section })} fail={fail} />
      : <Filings filings={filings} onOpen={a => go({ ticker: place.ticker, accession: a, document: '', section: '' })} />}
  </div>;
}
