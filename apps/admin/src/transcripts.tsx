import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { TranscriptList, TranscriptDetail, TranscriptStatus } from '@/shared/analysis-contract/transcripts';
import { adminApi, AdminApiError } from './admin-api';
import './transcripts.css';
const labels:Record<TranscriptStatus,string>={queued:'待获取',fetching:'获取中',ready:'已入库',unavailable:'暂不可用',needs_period:'财季待确认',retry:'等待重试'};
const reasons:Record<string,string>={FISCAL_PERIOD_UNKNOWN:'原始财报中未能确认财年财季，尚未请求文字稿。',PROVIDER_NO_TRANSCRIPT:'Alpha Vantage 未返回该财季文字稿。',PROVIDER_ACCESS:'供应商拒绝访问该文字稿。',PROVIDER_QUOTA:'供应商额度已用尽，将于次日继续。',DAILY_BUDGET:'今日请求预算已用尽，将于次日继续。',PROVIDER_ERROR:'供应商请求失败。',SOURCE_MISSING:'原始财报暂不可读取。'};
export function Transcripts({onAuthenticated,onUnauthorized}:{onAuthenticated:()=>void;onUnauthorized:()=>void}) {
 const [data,setData]=useState<TranscriptList|null>(null),[ticker,setTicker]=useState(''),[offset,setOffset]=useState(0),[selected,setSelected]=useState('');
 const [detail,setDetail]=useState<TranscriptDetail|null>(null),[error,setError]=useState(''),[detailError,setDetailError]=useState(''),[refresh,setRefresh]=useState(0);
 const callbacks=useRef({onAuthenticated,onUnauthorized});callbacks.current={onAuthenticated,onUnauthorized};
 useEffect(()=>{const c=new AbortController();void adminApi<TranscriptList>(`transcripts?${new URLSearchParams({ticker,offset:String(offset)})}`,{signal:c.signal}).then(r=>{setData(r);setError('');callbacks.current.onAuthenticated();setSelected(s=>r.transcripts.some(t=>t.id===s)?s:r.transcripts[0]?.id??'');}).catch(e=>{if(c.signal.aborted)return;if(e instanceof AdminApiError&&e.status===401)callbacks.current.onUnauthorized();else setError(e.message);});return()=>c.abort();},[ticker,offset,refresh]);
 useEffect(()=>{if(!selected)return;const c=new AbortController();setDetail(null);setDetailError('');void adminApi<TranscriptDetail>(`transcripts/${encodeURIComponent(selected)}`,{signal:c.signal}).then(setDetail).catch(e=>{if(c.signal.aborted)return;if(e instanceof AdminApiError&&e.status===401)callbacks.current.onUnauthorized();else setDetailError(e.message);});return()=>c.abort();},[selected,refresh]);
 return <div className="ra-workspace tr-workspace">
  <section className="ra-list" aria-label="Transcript 列表"><div className="ra-filters"><label className="tr-filter">公司<select aria-label="筛选公司" value={ticker} onChange={e=>{setTicker(e.target.value);setOffset(0);}}><option value="">全部公司</option>{data?.companies.map(t=><option key={t}>{t}</option>)}</select></label><button className="tr-refresh" aria-label="刷新 Transcript" onClick={()=>setRefresh(n=>n+1)}><RefreshCw size={17}/></button></div>
  <div className="ra-list-caption">{data?`${data.total} 份财报记录 · ${data.enabled?'后台自动获取':'自动获取未开启'}`:'正在加载…'}</div>
  {error&&<p className="ra-error" role="alert">{error}</p>}
  <div className="ra-list-scroll">{data?.transcripts.map(t=><button key={t.id} className="ra-report-row" aria-pressed={selected===t.id} onClick={()=>setSelected(t.id)}><span className="ra-row-info"><strong>{t.ticker} · {t.fiscalYear?`FY${t.fiscalYear} Q${t.fiscalQuarter}`:t.periodEnd}</strong><span>财报期末 {t.periodEnd}</span><small>{labels[t.status]}{t.characters?` · ${t.characters.toLocaleString()} 字符`:''}</small></span></button>)}{data&&!data.transcripts.length&&<p className="tr-empty">暂无 Transcript 记录。后台会从白名单已有财报中发现对应会议。</p>}</div>
  {data&&data.total>100&&<div className="tr-pagination"><button disabled={!offset} onClick={()=>setOffset(n=>Math.max(0,n-100))}>上一页</button><span>{offset+1}–{Math.min(offset+100,data.total)}</span><button disabled={offset+100>=data.total} onClick={()=>setOffset(n=>n+100)}>下一页</button></div>}
  </section>
  <section className="ra-detail tr-reader" aria-label="Transcript 全文" aria-busy={!!selected&&!detail&&!detailError}>
   {detailError?<p className="ra-error" role="alert">{detailError}</p>:detail?<><header><p>{detail.ticker} · {labels[detail.status]}</p><h2>{detail.title??`${detail.ticker} · ${detail.periodEnd}`}</h2><p>财报期末 {detail.periodEnd} · 来源 Alpha Vantage</p><a href={detail.filingUrl} target="_blank" rel="noreferrer">查看关联 SEC 财报 ↗</a></header>
   {detail.content?<div className="tr-content">{detail.content.split(/\n\n+/).map((paragraph,i)=><p key={i}>{paragraph}</p>)}</div>:<div className="tr-empty"><p>{detail.errorCode?reasons[detail.errorCode]??'暂未取得文字稿。':'文字稿正在排队获取，请稍后刷新。'}</p>{detail.status==='retry'&&<p>下次尝试：{new Date(detail.nextAttemptAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}（北京时间）</p>}</div>}</>:<p className="tr-empty">{selected?'正在读取全文…':'选择一份 Transcript 查看全文。'}</p>}
  </section>
 </div>;
}
