import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ChevronRight, ExternalLink, Plus, RefreshCw, Search } from 'lucide-react';
import type { BusinessMapCompanies, BusinessMapCompany } from '@/shared/analysis-contract/business-map-admin';
import { adminApi, AdminApiError } from './admin-api';
import { normalizeCompanyTicker, pendingRequestId, completeRequestId } from './financial-maintenance-state';
import { financialDate } from './financial-update-history';
import { CompanyLogo } from '@/packages/web/src/company-logo';
import './business-map-companies.css';

const stages: Record<string,string> = {identify:'识别公司',waiting_issuer:'等待同公司任务',collect:'采集及核验最新财报',history:'补充季度历史',audit:'检查披露完整性',complete:'任务结束'};
const errors: Record<string,string> = {
  SEC_ISSUER_NOT_FOUND:'SEC 目录无此代码',
  SEC_ACCESS_PAUSED:'SEC 访问受限 · 退避重试',
  SOURCE_TEMPORARILY_UNAVAILABLE:'来源不可读',
  SEC_FACT_FORMAT_UNSUPPORTED:'事实格式不受支持',
  NO_SUPPORTED_FILINGS:'无可解析的定期报告或业绩披露',
  NO_ARCHIVED_DISCLOSURES:'无原始披露存档',
  RESTATEMENT_REVIEW_REQUIRED:'重述或口径变化 · 可比期间待核验',
  LATEST_PERIOD_NOT_COLLECTED:'最新披露期间未提取完整',
  REVENUE_BREAKDOWN_NOT_VERIFIED:'业务收入拆分未核验',
  PREPARING:'准备中',
  MISSING_TWO_QUARTERS:'缺少两个相邻季度的完整数据',
  MISSING_DISCLOSURE:'利润、费用或收入来源缺失',
  INCOMPARABLE_QUARTERS:'相邻季度口径可比性未核验',
  UNBALANCED_STATEMENT:'报表勾稽未通过',
  NO_DIRECT_COMPARABLE_QUARTER:'无可直接提取的季度数据',
};
const active = new Set(['queued','running','cancel_requested']);
function issueText(code:string) { const parts=code.split(':'); if(parts[0]==='UNSUPPORTED_SOURCE_FACTS')return `${parts[1]} 项事实格式不受支持`; return errors[code] ?? (parts.length>1&&errors[parts.at(-1)!]?`${parts[0]}：${errors[parts.at(-1)!]}`:code); }
function storage() { try { return window.sessionStorage; } catch { return undefined; } }

export function BusinessMapCompanies({onUnauthorized,onAuthenticated}:{onUnauthorized:()=>void;onAuthenticated:()=>void}) {
  const [data,setData]=useState<BusinessMapCompanies|null>(null),[ticker,setTicker]=useState(''),[search,setSearch]=useState('');
  const [loadError,setLoadError]=useState('');
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(''),[refresh,setRefresh]=useState(0);
  const lock=useRef(false),callbacks=useRef({onUnauthorized,onAuthenticated});
  useEffect(()=>{callbacks.current={onUnauthorized,onAuthenticated};},[onUnauthorized,onAuthenticated]);
  useEffect(()=>{
    const controller=new AbortController();
    void adminApi<BusinessMapCompanies>('business-map/companies',{signal:controller.signal}).then(result=>{
      if(controller.signal.aborted)return;setData(result);setLoadError('');callbacks.current.onAuthenticated();
    }).catch(err=>{if(controller.signal.aborted)return;if(err instanceof AdminApiError&&err.status===401)callbacks.current.onUnauthorized();else setLoadError(err.message);});
    return ()=>controller.abort();
  },[refresh]);
  useEffect(()=>{const timer=setInterval(()=>{if(!document.hidden&&!lock.current)setRefresh(n=>n+1);},5000);return()=>clearInterval(timer);},[]);
  async function mutate(symbol:string,enabled?:boolean) {
    if(lock.current)return;lock.current=true;setBusy(symbol);setError('');setNotice('');
    const key=`business-map:${symbol}:${enabled??'prepare'}`,requestId=pendingRequestId(key,storage());
    try {
      await adminApi(enabled===undefined?`financials/companies/${symbol}/actions`:`business-map/companies/${symbol}`,{
        method:'POST',headers:{'idempotency-key':requestId},body:JSON.stringify(enabled===undefined?{action:'extract',requestId}:{enabled,requestId})});
      completeRequestId(key,storage());setTicker('');setRefresh(n=>n+1);
      setNotice(enabled===false?`${symbol} 已移出白名单`:enabled===true?`${symbol} 已加入白名单`:`${symbol} 重新准备已提交`);
    } catch(err) {
      if(err instanceof AdminApiError&&err.status===401)callbacks.current.onUnauthorized();
      else setError((err as Error).message);
      if(err instanceof AdminApiError&&err.status>=400&&err.status<500)completeRequestId(key,storage());
    } finally {lock.current=false;setBusy('');}
  }
  function add(event:FormEvent){event.preventDefault();const symbol=normalizeCompanyTicker(ticker);if(!symbol){setError('股票代码无效');return;}void mutate(symbol,true);}
  const companies=data?.companies.filter(c=>c.ticker.toLowerCase().includes(search.toLowerCase()))??[];
  return <section className="bm-admin" aria-label="白名单">
    <div className="bm-admin-toolbar">
      <form className="bm-admin-add" onSubmit={add}><label htmlFor="bm-ticker" className="bm-admin-sr">股票代码</label><input id="bm-ticker" placeholder="股票代码" value={ticker} maxLength={10} onChange={e=>setTicker(e.target.value.toUpperCase())} required/><button className="ra-primary" disabled={!data||!!busy}><Plus size={16}/>加入白名单</button></form>
      <div className="bm-admin-filter"><span>白名单 · {data?.companies.filter(c=>c.dataEnabled).length??0} 家</span><label className="ra-search"><Search size={16}/><input aria-label="筛选公司" placeholder="代码" value={search} onChange={e=>setSearch(e.target.value)}/></label><button className="ra-icon-button" onClick={()=>setRefresh(n=>n+1)} disabled={!!busy} aria-label="刷新"><RefreshCw size={16}/></button></div>
    </div>
    {notice&&<p className="ra-notice" role="status">{notice}</p>}{(error||loadError)&&<p className="ra-error ra-error-banner" role="alert">{error||loadError}</p>}
    {data&&!data.automaticCollection&&<p className="bm-admin-warning">自动采集已暂停</p>}
    {!data&&!loadError&&<p role="status">加载中</p>}
    {companies.length>0&&<div className="bm-admin-table-wrap ra-panel"><table className="bm-admin-table">
      <thead><tr><th>公司</th><th>状态</th><th>可展示期间</th><th>收入构成</th><th>采集</th><th>问题</th><th>操作</th></tr></thead>
      {companies.map(company=><Company key={company.ticker} company={company} busy={!!busy} onToggle={()=>void mutate(company.ticker,!company.dataEnabled)} onPrepare={()=>void mutate(company.ticker)}/>)}
    </table></div>}
    {data&&!companies.length&&<p>无匹配公司</p>}
  </section>;
}
const coverage=(q:NonNullable<BusinessMapCompany['publication']['revenueCoverage']>[number])=>q.status==='verified'?`${q.segments} 个分部已核验${q.adjustments?` · ${q.adjustments} 项抵销已对账`:''}`:q.status==='single_segment'?'单一报告部门':'仅合并收入 · 拆分待核验';
const taskStatus:Record<string,string>={succeeded:'已完成',partial:'部分完成',failed:'失败',cancelled:'已停止'};

/** One company as a table row; the row opens to its quarters, task progress and collection problems. */
function Company({company:c,busy,onToggle,onPrepare}:{company:BusinessMapCompany;busy:boolean;onToggle:()=>void;onPrepare:()=>void}) {
  const running=!!c.task&&active.has(c.task.status),collecting=!!c.collection&&['queued','running','retry'].includes(c.collection.status);
  const ready=c.publication.status==='ready';
  const revenuePending=c.publication.revenueCoverage?.some(q=>q.status==='unverified');
  const issues=[...new Set([...(revenuePending?['REVENUE_BREAKDOWN_NOT_VERIFIED']:[]),...(c.task?.issues??[]),...(c.task?.errorCode?[c.task.errorCode]:[]),...(c.collection?.reasons??[]),...(!ready||c.publication.outdated?c.publication.reasons:[])])].filter(s=>s!=='PREPARING');
  const [open,setOpen]=useState(false);
  const latest=c.publication.revenueCoverage?.[0];
  const scans=[c.collection?.total?`最新 ${c.collection.completed}/${c.collection.total}`:'',c.history?`历史 ${c.history.completed}/${c.history.total}`:''].filter(Boolean).join(' · ');
  return <tbody data-open={open||undefined}>
    <tr className="bm-admin-row" aria-label={`${c.ticker} 数据准备`}>
      <td><div className="bm-admin-company-cell"><button className="bm-admin-toggle" aria-expanded={open} aria-label={`${c.ticker} 详情`} onClick={()=>setOpen(o=>!o)}><ChevronRight size={15}/></button><CompanyLogo symbol={c.ticker}/><span className="bm-admin-name"><strong className="ra-mono">{c.ticker}</strong><small>{c.dataEnabled?'已加入白名单':'未加入白名单'}{c.cik?` · CIK ${c.cik}`:''}</small></span></div></td>
      <td><span className="ra-badge" data-status={ready?(revenuePending?'caution':'reviewed'):running||collecting?'processing':'idle'}>{ready?(revenuePending?'业务拆分待核验':c.publication.outdated||running?'已就绪 · 更新中':'地图已就绪'):running||collecting?'准备中':'未就绪'}</span></td>
      <td>{ready?c.publication.periods.join('、'):'—'}</td>
      <td>{latest?coverage(latest):'—'}</td>
      <td>{running&&c.task?<>{stages[c.task.stage]??c.task.stage} · {c.task.progress.completed}/{c.task.progress.total}</>:scans||'—'}</td>
      <td>{issues.length?<button className="bm-admin-issue-count" onClick={()=>setOpen(true)}>{issues.length} 项</button>:<span className="bm-admin-muted">无</span>}</td>
      <td><div className="bm-admin-actions"><button className="fm-button" disabled={busy} onClick={onToggle}>{c.dataEnabled?'移出':'加入'}</button><button className="fm-button" disabled={busy||running} onClick={onPrepare}>{running?'准备中':'重新准备'}</button><a href={`/admin/financials?ticker=${c.ticker}`}>财报</a>{ready&&<a href={`https://spontra-business-map.max-zhangyuchen.workers.dev/companies/${c.ticker}`} target="_blank" rel="noreferrer" aria-label={`${c.ticker} 业务地图`}>地图<ExternalLink size={12}/></a>}</div></td>
    </tr>
    {open&&<tr className="bm-admin-detail"><td colSpan={7}><div>
      <section><h4>收入构成</h4>{c.publication.revenueCoverage?.length?<ul>{c.publication.revenueCoverage.map(q=><li key={q.period}>{q.period}：{coverage(q)}</li>)}</ul>:<p>无</p>}</section>
      <section><h4>采集</h4>{c.task&&<div className="bm-admin-progress" data-status={c.task.status}><label>{stages[c.task.stage]??c.task.stage} · {c.task.progress.completed}/{c.task.progress.total} 个阶段{!running&&taskStatus[c.task.status]?` · ${taskStatus[c.task.status]}`:''}</label><progress aria-label={`${c.ticker} 准备进度`} value={c.task.progress.completed} max={c.task.progress.total}/><small>任务更新于 {financialDate(c.task.updatedAt)}</small></div>}
        {!!c.collection?.total&&<p>最新财报扫描：{c.collection.completed}/{c.collection.total} 份候选文件</p>}{c.history&&<p>历史披露扫描：{c.history.completed}/{c.history.total} 份文件</p>}{!c.task&&!c.collection?.total&&!c.history&&<p>无采集记录</p>}</section>
      <section className="bm-admin-issues"><h4>采集问题（{issues.length}）</h4>{issues.length?<ul>{issues.map(code=><li key={code}>{issueText(code)}{errors[code]&&<small>{code}</small>}</li>)}</ul>:<p>无</p>}</section>
    </div></td></tr>}
  </tbody>;
}
