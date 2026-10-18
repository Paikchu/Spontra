import { Fragment, useEffect, useRef, useState } from 'react';
import { RotateCcw, Undo2 } from 'lucide-react';
import { SECTOR_LABELS, TAG_FACET_LABELS, TAG_FACETS, type BusinessTag, type BusinessTagsView, type PeerBasis, type PeerTier, type SectorTagView } from '@/shared/analysis-contract/business-tags';
import type { IndustryCategory } from '@/shared/analysis-contract/filing-library';
import { adminApi } from './admin-api';
import './business-tags.css';

type Open = (ticker: string, documentId: string, sectionId: string) => void;
const TIERS: PeerTier[] = ['direct', 'partial', 'adjacent', 'sector'];
const tierLabel: Record<PeerTier, string> = { direct: '直接同行', partial: '部分可比', adjacent: '相邻', sector: '同大类' };
const basisLabel: Record<PeerBasis, string> = { company: '公司级对比', unit: '单元级对比', quote: '仅引用原文' };
const valueLabel: Record<string, string> = { same: '相同', partial: '相近', different: '不同', unknown: '无标签' };
const sectorName = (s: string) => SECTOR_LABELS[s as IndustryCategory] ?? s;
const percent = (v: number | null) => v == null ? '未披露' : `${Math.round(v * 1000) / 10}%`;
function money(value: string | null) {
  const n = Number(value);
  if (value == null || !Number.isFinite(n)) return '未披露';
  const abs = Math.abs(n);
  return abs >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : abs >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${n.toLocaleString()}`;
}

function Passages({ ids, view, onOpen, ticker }: { ids: string[]; view: BusinessTagsView; onOpen: Open; ticker: string }) {
  return <div className="bt-passages">{ids.map(id => { const p = view.passages[id]; return p ? <blockquote key={id}>
    <button className="fl-linkish" onClick={() => onOpen(ticker, p.documentId, p.sectionId)}>{p.path}</button><p>{p.text}</p><small>{id}</small></blockquote> : <blockquote key={id}><small>{id}</small></blockquote>; })}</div>;
}

/** One unit's tags under one sector, by facet; a tag opens its passages and can be rejected or restored. */
function SectorTags({ sector, tags, selected, onSelect }: { sector: string; tags: BusinessTag[]; selected: string; onSelect: (id: string) => void }) {
  return <div className="bt-sector-block"><span className="bt-sector">{sectorName(sector)}</span>
    {tags.length ? <dl>{TAG_FACETS.map(f => { const list = tags.filter(t => t.facet === f); return list.length ? <Fragment key={f}><dt>{TAG_FACET_LABELS[f]}</dt>
      <dd>{list.map(t => <button key={t.tagId} className="bt-tag" data-status={t.status} aria-pressed={selected === t.tagId} title={`${t.label} — ${t.definition}`} onClick={() => onSelect(selected === t.tagId ? '' : t.tagId)}>{t.labelZh}</button>)}</dd></Fragment> : null; })}</dl>
      : <p className="fl-caption">无细标签</p>}</div>;
}

function CompanyTags({ ticker, onOpen, fail }: { ticker: string; onOpen: Open; fail: (e: unknown) => void }) {
  const [loaded, setLoaded] = useState<BusinessTagsView | null>(null), [refresh, setRefresh] = useState(0), [notice, setNotice] = useState('');
  const [selected, setSelected] = useState(''), [open, setOpen] = useState(''), [peerTag, setPeerTag] = useState('');
  // The parent's handler changes every render; the latest one is read when a request fails.
  const onFail = useRef(fail);
  useEffect(() => { onFail.current = fail; }, [fail]);
  useEffect(() => { const c = new AbortController(); void adminApi<BusinessTagsView>(`library/tags/${encodeURIComponent(ticker)}`, { signal: c.signal }).then(setLoaded).catch(e => { if (!c.signal.aborted) onFail.current(e); }); return () => c.abort(); }, [ticker, refresh]);
  const view = loaded?.ticker === ticker ? loaded : null;
  const post = (path: string, body: unknown, done: string) => void adminApi(`library/tags/${encodeURIComponent(ticker)}/${path}`, { method: 'POST', body: JSON.stringify(body) }).then(() => { setNotice(done); setRefresh(n => n + 1); }).catch(fail);
  if (!view) return <p className="fl-empty">加载中</p>;
  const tag = view.units.flatMap(u => u.tags).find(t => t.tagId === selected);
  const groups = TIERS.map(t => [t, view.pairs.filter(p => p.tier === t)] as const).filter(([, list]) => list.length);
  return <>
    <header className="fl-panel-head"><p className="fl-caption">{view.version} · 相同 ≥ {view.thresholds.same} · 相近 ≥ {view.thresholds.near}{view.matching ? '' : ' · 向量匹配未开启'}</p>
      <button className="fl-rerun" onClick={() => post('run', {}, '已请求重新打标签')}><RotateCcw size={15} />重新打标签</button></header>
    {notice && <p className="fl-notice" role="status">{notice}</p>}
    {!view.units.length ? <p className="fl-empty">无业务单元</p> : <div className="bt-columns">
      <section aria-label="单元与标签" className="bt-units">{view.units.map(u => <article key={u.unitKey} className="bt-unit">
        <header><strong>{u.name}</strong><small>{u.flowNodeId} · {money(u.revenue)} · 占比 {percent(u.exposure)}{u.periodEnd ? ` · ${u.periodEnd}` : ''}</small></header>
        {!u.sectors.length ? <p className="fl-caption">无大标签</p> : u.sectors.map(s => <SectorTags key={s} sector={s} tags={u.tags.filter(t => t.sector === s)} selected={selected} onSelect={setSelected} />)}
        {tag && tag.unitKey === u.unitKey && <div className="bt-detail">
          <p><strong>{tag.label}</strong> · {TAG_FACET_LABELS[tag.facet]} · {sectorName(tag.sector)}</p><p className="fl-caption">{tag.definition}</p>
          <Passages ids={tag.passageIds} view={view} onOpen={onOpen} ticker={ticker} />
          {tag.status === 'verified' ? <button className="fl-rerun" onClick={() => post(`tag/${tag.tagId}`, { status: 'rejected' }, '已删除标签')}>删除</button>
            : <button className="fl-rerun" onClick={() => post(`tag/${tag.tagId}`, { status: 'verified' }, '已恢复标签')}><Undo2 size={14} />恢复</button>}
        </div>}
      </article>)}
      {view.unplaced.length > 0 && <article className="bt-unit"><header><strong>未归入单元</strong></header><ul className="bt-plain">{view.unplaced.map(l => <li key={l.businessKey}>{l.name}</li>)}</ul></article>}
      </section>
      <section aria-label="同行" className="bt-peers">{!groups.length ? <p className="fl-empty">无同行</p> : groups.map(([tier, list]) => <div key={tier} className="bt-group">
        <h3>{tierLabel[tier]}<small>{list.length}</small></h3>
        <ul>{list.map(p => { const own = p.leftTicker === ticker ? 'leftTag' : 'rightTag', other = own === 'leftTag' ? 'rightTag' : 'leftTag'; const facets = p.sectors[p.tierSector]; return <li key={p.pairKey}>
          <button className="bt-pair" aria-expanded={open === p.pairKey} onClick={() => setOpen(open === p.pairKey ? '' : p.pairKey)}>
            <strong>{p.peer.ticker}</strong><span>{p.peer.name}</span><em data-basis={p.basis}>{basisLabel[p.basis]}</em><small>{sectorName(p.tierSector)} · 占比 {percent(p.peer.exposure)} · 本公司 {p.own.name}{p.status === 'confirmed' ? ' · 人工指定' : ''}</small></button>
          {open === p.pairKey && <div className="bt-pair-detail">
            {facets && <table className="fl-table"><thead><tr><th>方面</th><th>结果</th><th>得分</th><th>本公司</th><th>{p.peer.ticker}</th></tr></thead>
              <tbody>{TAG_FACETS.map(f => { const m = facets[f]; const mine = m[own] ? view.tags[m[own]!] : null, theirs = m[other] ? view.tags[m[other]!] : null; return <tr key={f}>
                <th>{TAG_FACET_LABELS[f]}</th><td data-value={m.value}>{valueLabel[m.value]}</td><td>{m.score ?? '—'}</td>
                <td>{mine ? <button className="bt-tag" aria-pressed={peerTag === mine.tagId} title={mine.label} onClick={() => setPeerTag(peerTag === mine.tagId ? '' : mine.tagId)}>{mine.labelZh}</button> : '—'}</td>
                <td>{theirs ? <button className="bt-tag" aria-pressed={peerTag === theirs.tagId} title={theirs.label} onClick={() => setPeerTag(peerTag === theirs.tagId ? '' : theirs.tagId)}>{theirs.labelZh}</button> : '—'}</td></tr>; })}</tbody></table>}
            {peerTag && view.tags[peerTag] && <Passages ids={view.tags[peerTag]!.passageIds} view={view} onOpen={onOpen} ticker={view.units.some(u => u.tags.some(x => x.tagId === peerTag)) ? ticker : p.peer.ticker} />}
            <div className="bt-actions"><select aria-label="档位" value={p.tier} onChange={e => post('pair', { pairKey: p.pairKey, tier: e.target.value }, '已设定档位')}>{TIERS.map(t => <option key={t} value={t}>{tierLabel[t]}</option>)}</select>
              {p.status === 'confirmed' && <button className="fl-rerun" onClick={() => post('pair', { pairKey: p.pairKey, automatic: true }, '已恢复自动结果')}><Undo2 size={14} />恢复自动结果（{tierLabel[p.matchedTier]}）</button>}</div>
          </div>}
        </li>; })}</ul></div>)}</section>
    </div>}
  </>;
}

function SectorBrowse({ fail }: { fail: (e: unknown) => void }) {
  const [sector, setSector] = useState<IndustryCategory>('cloud_infrastructure'), [loaded, setLoaded] = useState<SectorTagView | null>(null);
  const onFail = useRef(fail);
  useEffect(() => { onFail.current = fail; }, [fail]);
  useEffect(() => { const c = new AbortController(); void adminApi<SectorTagView>(`library/tags/sectors/${sector}`, { signal: c.signal }).then(setLoaded).catch(e => { if (!c.signal.aborted) onFail.current(e); }); return () => c.abort(); }, [sector]);
  const view = loaded?.sector === sector ? loaded : null;
  return <>
    <header className="fl-panel-head bt-start"><select aria-label="大标签" value={sector} onChange={e => setSector(e.target.value as IndustryCategory)}>{Object.entries(SECTOR_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select></header>
    {!view ? <p className="fl-empty">加载中</p> : !view.units.length ? <p className="fl-empty">无单元</p> :
      <table className="fl-table bt-sector-table"><thead><tr><th>公司 · 单元</th><th>占比</th><th>卖什么</th></tr></thead>
        <tbody>{view.units.map(u => <tr key={u.unitKey}><th><strong>{u.ticker}</strong> · {u.name}</th><td>{percent(u.exposure)}</td>
          <td>{u.offering.length ? u.offering.map(t => <span key={t.tagId} className="bt-tag" title={t.label}>{t.labelZh}</span>) : '—'}</td></tr>)}</tbody></table>}
  </>;
}

/** Two-level business tags: a company's units with both levels and its peers, or every unit under one sector tag. */
export function BusinessTagsPanel({ ticker, onOpen, fail }: { ticker: string; onOpen: Open; fail: (e: unknown) => void }) {
  const [mode, setMode] = useState<'company' | 'sector'>('company');
  return <div className="fl-panel">
    <nav className="fl-views" aria-label="查看方式"><button aria-pressed={mode === 'company'} onClick={() => setMode('company')}>本公司</button><button aria-pressed={mode === 'sector'} onClick={() => setMode('sector')}>按大标签</button></nav>
    {mode === 'company' ? <CompanyTags key={ticker} ticker={ticker} onOpen={onOpen} fail={fail} /> : <SectorBrowse fail={fail} />}
  </div>;
}
