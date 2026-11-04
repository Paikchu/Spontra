import { useEffect, useId, useRef, useState } from 'react';
import { BookmarkSimpleIcon, CaretDownIcon, CaretLeftIcon as ChevronLeft, ArrowsClockwiseIcon as RefreshCw, ArrowCounterClockwiseIcon as RotateCcw, MagnifyingGlassIcon as Search } from "@phosphor-icons/react";
import { usePageActive } from './admin-page';
import type { LibraryDocumentDetail, LibraryDocumentSummary, LibraryOverview, LibrarySectionDetail, LibraryTable } from '@/shared/analysis-contract/filing-library';
import { adminApi, AdminApiError } from './admin-api';
import { FindPanel } from './filing-library-cross';
import { CompanyLogo } from '@/packages/web/src/company-logo';
import './filing-library.css';

const docOrder: Record<string, number> = { primary: 0, press_release: 1, exhibit: 2 };
const reasons: Record<string, string> = { ARCHIVE_MISMATCH: '原始归档与指针不一致', NO_READABLE_TEXT: '没有可读文字', ARCHIVE_SOURCE_MISSING: '原始归档缺失' };
const fileName = (url: string) => new URL(url).pathname.split('/').at(-1) || '文件';
const day = (value: string) => value ? value.slice(0, 10) : '—';

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

/** Column one: every company in the library, with how far its filings are split. */
function Companies({ companies, ticker, onOpen }: { companies: LibraryOverview['companies']; ticker: string; onOpen: (ticker: string) => void }) {
  if (!companies.length) return <p className="fl-empty">无匹配公司</p>;
  return <ul className="fl-col-list" aria-label="公司">{companies.map(c => <li key={c.ticker}>
    <button aria-pressed={c.ticker === ticker} onClick={() => onOpen(c.ticker)}>
      <span className="fl-row-main" title={`最新申报 ${day(c.latestFiledAt)}`}><CompanyLogo symbol={c.ticker} /><strong>{c.ticker}</strong><small>{c.documents} 份</small></span>
    </button>
  </li>)}</ul>;
}

/** Column two: a company's filings newest first, grouped by year. */
function Filings({ filings, accession, onOpen }: { filings: Filing[]; accession: string; onOpen: (accession: string) => void }) {
  if (!filings.length) return <p className="fl-empty">无已拆分 SEC 文件</p>;
  const years = [...new Set(filings.map(f => f.head.filedAt.slice(0, 4)))];
  return <div className="fl-filings">{years.map(year => <section key={year}><h3>{year}</h3><ul className="fl-col-list">{filings.filter(f => f.head.filedAt.startsWith(year)).map(f => <li key={f.accession}>
    <button aria-pressed={f.accession === accession} onClick={() => onOpen(f.accession)}>
      <span className="fl-row-main"><time>{day(f.head.filedAt).slice(5)}</time><span className="fl-form">{f.head.form}</span><span className="fl-period" title="报告期">{f.head.reportDate || '无报告期'}</span></span>
    </button>
  </li>)}</ul></section>)}</div>;
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
  return <>
    <header className="fl-header"><div>
      <p><span className="fl-form">{filing.head.form}</span>申报 {day(filing.head.filedAt)}{filing.head.reportDate ? ` · 报告期 ${filing.head.reportDate}` : ''}</p>
      <h2>{filing.accession}</h2></div>
      <div className="fl-header-actions"><a href={document.documentUrl} target="_blank" rel="noreferrer">SEC 原文 ↗</a><button className="fl-rerun" onClick={rerun}><RotateCcw size={15} />重新拆解</button></div>
    </header>
    {filing.docs.length > 1 && <nav className="fl-views fl-document-tabs" aria-label="文件">{filing.docs.map(d => <button key={d.documentId} aria-pressed={d.documentId === documentId} onClick={() => onDocument(d.documentId)}>{fileName(d.documentUrl)}</button>)}</nav>}
    {notice && <p className="fl-notice" role="status">{notice}</p>}
    {document.status === 'unreadable' ? <p className="fl-empty">无法读取：{reasons[document.failureReason ?? ''] ?? document.failureReason}</p>
      : document.structureCheck.status === 'segments_missing' && <p className="fl-caption">标题缺少业务部门：{document.structureCheck.missing.join('、')}</p>}
    {!shown ? <p className="fl-empty">加载中</p> : <div className="fl-columns">
      <ol className="fl-outline" aria-label="章节">{shown.outline.map(s => <li key={s.sectionId} style={{ paddingLeft: s.depth * 14 }}><button aria-pressed={sectionId === s.sectionId} onClick={() => onSection(s.sectionId)}>
        <span className="fl-title">{s.title}</span></button></li>)}</ol>
      <div className="fl-reader" role="region" aria-label="章节内容" tabIndex={0}>{reading ? <>
        <p className="fl-path">{reading.section.path.join(' › ')}</p>
        {reading.card && <div className="fl-card">{reading.card.gist && <p>{reading.card.gist}</p>}{!!reading.card.answers.length && <ul>{reading.card.answers.map(a => <li key={a}>{a}</li>)}</ul>}</div>}
        {reading.passages.map(p => <article key={p.passageId} className="fl-passage">{p.table ? <TableView table={p.table} /> : <p>{p.text}</p>}</article>)}
      </> : <p className="fl-empty">{sectionId ? '加载中' : '未选择章节'}</p>}</div>
    </div>}
  </>;
}

/** The filing library as a drill-down: companies, then a company's filings, then one filing's documents and sections. */
export function FilingLibrary({ onAuthenticated, onUnauthorized }: { onAuthenticated: () => void; onUnauthorized: () => void }) {
  const [place, setPlace] = useState<Place>(placeFromUrl), [tab, setTab] = useState<'filing' | 'find'>('filing'), [search, setSearch] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const navigationId = useId(), bookmark = useRef<HTMLButtonElement>(null);
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
  // Hidden behind another page, the history is that page's.
  const shown = usePageActive();
  useEffect(() => { const onPop = () => { if (shown.current) { setPlace(placeFromUrl()); setBrowsing(false); } }; window.addEventListener('popstate', onPop); return () => window.removeEventListener('popstate', onPop); }, [shown]);

  function go(next: Place) {
    setPlace(next); setError(''); setBrowsing(false);
    const q = new URLSearchParams(Object.entries(next).filter(([, v]) => v) as Array<[string, string]>);
    try { window.history.pushState(null, '', `${window.location.pathname}${q.size ? `?${q}` : ''}`); } catch { /* Sandboxed preview. */ }
  }
  const list = documents?.ticker === place.ticker ? documents.list : null;
  const filings = list ? filingsOf(list) : [];
  // A section linked from elsewhere names its document; the filing follows from it.
  const accession = place.accession || (place.document && list?.find(d => d.documentId === place.document)?.accessionNumber) || '';
  const filing = filings.find(f => f.accession === accession);
  const documentId = filing && (filing.docs.some(d => d.documentId === place.document) ? place.document : filing.head.documentId);
  const selectedDocument = filing?.docs.find(d => d.documentId === documentId);
  const navigationOpen = !filing || browsing;
  const openSection = (ticker: string, document: string, section: string) => go({ ticker, accession: '', document, section });

  const companies = overview?.companies.filter(c => c.ticker.toLowerCase().includes(search.trim().toLowerCase())) ?? [];
  return <div className="fl-page">
    {filing && selectedDocument && <div className="fl-bookmark-bar">
      <button ref={bookmark} className="fl-bookmark" aria-expanded={navigationOpen} aria-controls={`${navigationId}-companies ${navigationId}-filings`}
        aria-label={`${navigationOpen ? '收起' : '展开'}公司和文件列表，当前 ${place.ticker} ${filing.head.form} ${fileName(selectedDocument.documentUrl)}`}
        onClick={() => setBrowsing(open => !open)}>
        <BookmarkSimpleIcon size={16} weight="fill" aria-hidden="true" />
        <strong>{place.ticker}</strong><span className="fl-bookmark-form">{filing.head.form}</span>
        <time>{filing.head.reportDate || day(filing.head.filedAt)}</time>
        <span className="fl-bookmark-file" title={fileName(selectedDocument.documentUrl)}>{fileName(selectedDocument.documentUrl)}</span>
        <span className="fl-bookmark-action">{navigationOpen ? '收起列表' : '切换文件'}</span><CaretDownIcon className="fl-bookmark-caret" size={14} aria-hidden="true" />
      </button>
    </div>}
    <div className="fl-cols" data-navigation={navigationOpen ? 'open' : 'collapsed'} data-level={!place.ticker ? 'companies' : navigationOpen ? 'filings' : 'filing'}>
      <section id={`${navigationId}-companies`} className="fl-col" aria-label="公司" hidden={!navigationOpen}>
        <div className="ra-filters"><label className="ra-search"><Search size={16} /><input aria-label="搜索公司" placeholder="代码" value={search} onChange={e => setSearch(e.target.value)} /></label><button className="fl-icon" aria-label="刷新" onClick={() => setRefresh(n => n + 1)}><RefreshCw size={17} /></button></div>
        <div className="ra-list-caption">{overview ? `${overview.companies.length} 家公司` : '加载中'}</div>
        <div className="fl-col-scroll">{overview && <Companies companies={companies} ticker={place.ticker} onOpen={ticker => { setTab('filing'); go({ ticker, accession: '', document: '', section: '' }); }} />}</div>
      </section>
      <section id={`${navigationId}-filings`} className="fl-col" aria-label="申报" hidden={!navigationOpen}>
        <header>{place.ticker && <button className="fl-back" onClick={() => go({ ticker: '', accession: '', document: '', section: '' })} aria-label="返回公司"><ChevronLeft size={16} /></button>}{place.ticker ? <><strong>{place.ticker}</strong>的申报</> : '申报'}{list && place.ticker && <small>{filings.length} 份 · {list.length} 个文件</small>}</header>
        <div className="fl-col-scroll">{!place.ticker ? <p className="fl-empty">未选择公司</p> : !list ? <p className="fl-empty">加载中</p>
          : <Filings filings={filings} accession={accession} onOpen={a => { setTab('filing'); go({ ticker: place.ticker, accession: a, document: '', section: '' }); requestAnimationFrame(() => bookmark.current?.focus({ preventScroll: true })); }} />}</div>
      </section>
      <section className="fl-content" aria-label="内容">
        <nav className="fl-views" aria-label="视图"><button aria-pressed={tab === 'filing'} onClick={() => setTab('filing')}>申报内容</button><button aria-pressed={tab === 'find'} onClick={() => setTab('find')}>跨公司查找</button></nav>
        {error && <p className="ra-error" role="alert">{error}</p>}
        {tab === 'find' ? <div className="fl-scroll"><FindPanel onOpen={(ticker, document, section) => { setTab('filing'); openSection(ticker, document, section); }} fail={fail} /></div>
          : filing && documentId ? <FilingDocuments filing={filing} documentId={documentId} sectionId={place.section}
              onDocument={document => go({ ...place, accession, document, section: '' })} onSection={section => go({ ...place, accession, document: documentId, section })} fail={fail} />
          : <div className="fl-placeholder">
              {overview && <div className="fl-stats"><span><strong>{overview.totals.ready}</strong>已拆解</span><span><strong>{overview.pending}</strong>待拆解</span><span><strong>{overview.totals.unreadable}</strong>无法读取</span><span><strong>{overview.totals.cards}</strong>索引卡</span></div>}
              <p>{place.ticker ? '未选择申报' : '未选择公司'}</p>
            </div>}
      </section>
    </div>
  </div>;
}
