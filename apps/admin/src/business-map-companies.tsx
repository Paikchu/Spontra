import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, ChevronRight, ExternalLink, Layers, Plus, RefreshCw, Scale, ScanLine, Search, Trash2 } from 'lucide-react';
import type { BusinessMapCompanies, BusinessMapCompany } from '@/shared/analysis-contract/business-map-admin';
import { FEATURES, type Feature } from '@/shared/analysis-contract/business-features';
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
  SEC_DOCUMENT_TOO_LARGE:'申报文件超过 20 MB',
  NEWER_PUBLICATION_CURRENT:'已有更新的发布',
  INVALID_PAYLOAD:'已发布数据未通过当前校验',
  MAINTENANCE_STOPPED:'维护任务已停止',
  WORKFLOW_STATUS_UNAVAILABLE:'分析状态不可读',
};
const active = new Set(['queued','running','cancel_requested']);
/** The reader-facing features, as the map labels them (docs/whitelist-feature-switches-design.md). */
const FEATURE_LABEL: Record<Feature,string> = {reports:'财报摘要',findings:'要点',explainer:'业务解读',tree:'业务脑图'};
function issueText(code:string) { const parts=code.split(':'); if(parts[0]==='UNSUPPORTED_SOURCE_FACTS')return `${parts[1]} 项事实格式不受支持`; return errors[code] ?? (parts.length>1&&errors[parts.at(-1)!]?`${parts[0]}：${errors[parts.at(-1)!]}`:code); }
function storage() { try { return window.sessionStorage; } catch { return undefined; } }

export function BusinessMapCompanies({onUnauthorized,onAuthenticated}:{onUnauthorized:()=>void;onAuthenticated:()=>void}) {
  const [data,setData]=useState<BusinessMapCompanies|null>(null),[ticker,setTicker]=useState(''),[search,setSearch]=useState('');
  const [loadError,setLoadError]=useState('');
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(''),[refresh,setRefresh]=useState(0);
  const lock=useRef(false),pending=useRef(new Set<string>()),switched=useRef(0),callbacks=useRef({onUnauthorized,onAuthenticated});
  // Messages float over the page and leave on their own, so nothing below them moves.
  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),2500);return()=>clearTimeout(timer);},[notice]);
  useEffect(()=>{if(!error)return;const timer=setTimeout(()=>setError(''),6000);return()=>clearTimeout(timer);},[error]);
  useEffect(()=>{callbacks.current={onUnauthorized,onAuthenticated};},[onUnauthorized,onAuthenticated]);
  useEffect(()=>{
    const controller=new AbortController(),started=switched.current;
    void adminApi<BusinessMapCompanies>('business-map/companies',{signal:controller.signal}).then(result=>{
      // A read that started before a switch moved would flip it back; the next read picks the switch up.
      if(controller.signal.aborted||pending.current.size||switched.current!==started)return;setData(result);setLoadError('');callbacks.current.onAuthenticated();
    }).catch(err=>{if(controller.signal.aborted)return;if(err instanceof AdminApiError&&err.status===401)callbacks.current.onUnauthorized();else setLoadError(err.message);});
    return ()=>controller.abort();
  },[refresh]);
  // Every five seconds while a company is being prepared, every thirty otherwise: the list is a heavy read.
  const working=!!data?.companies.some(c=>(c.task&&active.has(c.task.status))||(c.collection&&['queued','running','retry'].includes(c.collection.status)));
  useEffect(()=>{const timer=setInterval(()=>{if(!document.hidden&&!lock.current&&!pending.current.size)setRefresh(n=>n+1);},working?5000:30000);return()=>clearInterval(timer);},[working]);
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
  /**
   * One feature's switch for one company, or its global generation switch (symbol null). The switch moves at once and
   * the rest of the page stays as it is; a refused request puts it back and says why. The list is not read again: the
   * regular refresh brings the run states.
   */
  async function switchFeature(symbol:string|null,feature:Feature,on:boolean) {
    const key=`${symbol??'*'}:${feature}`;
    if(!data||pending.current.has(key))return;
    if(symbol&&feature==='findings'&&on&&!data.companies.find(c=>c.ticker===symbol)?.features.reports.on){setError('请先开启该公司的财报摘要');return;}
    const before=data;
    pending.current.add(key);switched.current++;setError('');
    setData(d=>d&&applySwitch(d,symbol,feature,on));
    try {await adminApi(symbol?`business-map/companies/${symbol}/features/${feature}`:`business-map/features/${feature}`,{method:'POST',body:JSON.stringify({on})});}
    catch(err){
      setData(d=>d&&restoreSwitch(d,before,symbol,feature));
      if(err instanceof AdminApiError&&err.status===401)callbacks.current.onUnauthorized();else setError((err as Error).message);
    }
    finally {pending.current.delete(key);}
  }
  async function judge(symbol:string) {
    if(lock.current)return;lock.current=true;setBusy(symbol);setError('');setNotice('');
    try {await adminApi(`business-map/companies/${symbol}/presentation`,{method:'POST',body:'{}'});setRefresh(n=>n+1);setNotice(`${symbol} 重新判定已提交`);}
    catch(err){if(err instanceof AdminApiError&&err.status===401)callbacks.current.onUnauthorized();else setError((err as Error).message);}
    finally {lock.current=false;setBusy('');}
  }
  function add(event:FormEvent){event.preventDefault();const symbol=normalizeCompanyTicker(ticker);if(!symbol){setError('股票代码无效');return;}void mutate(symbol,true);}
  const companies=data?.companies.filter(c=>c.ticker.toLowerCase().includes(search.toLowerCase()))??[];
  return <section className="bm-admin" aria-label="白名单">
    <div className="bm-admin-toolbar">
      <form className="bm-admin-add" onSubmit={add}><label htmlFor="bm-ticker" className="bm-admin-sr">股票代码</label><input id="bm-ticker" placeholder="股票代码" value={ticker} maxLength={10} onChange={e=>setTicker(e.target.value.toUpperCase())} required/><button className="ra-primary" disabled={!data||!!busy}><Plus size={16}/>加入白名单</button></form>
      <div className="bm-admin-filter"><span>白名单 · {data?.companies.filter(c=>c.dataEnabled).length??0} 家</span><label className="ra-search"><Search size={16}/><input aria-label="筛选公司" placeholder="代码" value={search} onChange={e=>setSearch(e.target.value)}/></label><button className="ra-icon-button" onClick={()=>setRefresh(n=>n+1)} disabled={!!busy} aria-label="刷新"><RefreshCw size={16}/></button></div>
    </div>
    {/* In the body: the section's enter animation leaves a transform that would pin a fixed child to the section. */}
    {createPortal(<div className="bm-toasts" aria-live="polite">{notice&&<p className="bm-toast" role="status">{notice}</p>}{(error||loadError)&&<p className="bm-toast" data-tone="error" role="alert">{error||loadError}</p>}</div>,document.body)}
    {data&&!data.automaticCollection&&<p className="bm-admin-warning">自动采集已暂停</p>}
    {data&&FEATURES.some(f=>!data.generation[f])&&<p className="bm-admin-warning">{FEATURES.filter(f=>!data.generation[f]).map(f=>FEATURE_LABEL[f]).join('、')}生成已全局暂停</p>}
    {!data&&!loadError&&<p role="status">加载中</p>}
    {companies.length>0&&<div className="bm-admin-table-wrap ra-panel"><table className="bm-admin-table">
      <thead><tr><th>公司</th><th>状态</th>
        {FEATURES.map(f=><th key={f} className="bm-admin-feature-col"><span className="bm-admin-feature-head">{FEATURE_LABEL[f]}<button className="bm-switch bm-switch-sm" role="switch" aria-checked={!!data?.generation[f]} aria-label={`${FEATURE_LABEL[f]}（全部公司）`} title={data?.generation[f]?'全部公司生成中 · 点击暂停':'已全局暂停 · 点击恢复'} disabled={!data} onClick={()=>void switchFeature(null,f,!data?.generation[f])}><span/></button></span></th>)}
        <th>操作</th></tr></thead>
      {companies.map(company=><Company key={company.ticker} company={company} generation={data!.generation} busy={!!busy} onToggle={()=>void mutate(company.ticker,!company.dataEnabled)} onPrepare={()=>void mutate(company.ticker)} onJudge={()=>void judge(company.ticker)} onFeature={(feature,on)=>void switchFeature(company.ticker,feature,on)}/>)}
    </table></div>}
    {data&&!companies.length&&<p>无匹配公司</p>}
  </section>;
}
const coverage=(q:NonNullable<BusinessMapCompany['publication']['revenueCoverage']>[number])=>q.status==='verified'?`${q.segments} 个分部已核验${q.adjustments?` · ${q.adjustments} 项调节已对账`:''}`:q.status==='single_segment'?'单一报告部门':'仅合并收入 · 拆分待核验';
const presentationSource:Record<string,string>={calculation:'申报计算链',statement:'报表行',profile:'模型判定（算术核验）',degraded:'未拆分（合计）'};
const lineName:Record<string,string>={revenue:'营收',cost:'营业成本',gross:'毛利',research:'研发费用',sales:'销售费用',administration:'管理费用',operatingExpenses:'营业费用',operating:'营业利润',other:'营业外收支',pretax:'税前利润',tax:'所得税',net:'净利润'};
const taskStatus:Record<string,string>={succeeded:'已完成',partial:'部分完成',failed:'失败',cancelled:'已停止'};

/** A scan's progress as a labelled bar. */
function Meter({label,completed,total,done=false}:{label:string;completed:number;total:number;done?:boolean}) {
  // A scan that stopped once the newest pair verified is finished, not two tenths done.
  return <div className="bm-meter" data-done={done||undefined}><span>{label}</span><b>{done?`已完成 · 读取 ${completed} 份`:`${completed}/${total}`}</b><progress aria-label={label} value={done?1:completed} max={done?1:Math.max(total,1)}/></div>;
}
/** Per-document notes from a scan (a filing without a quarter, a fact format the reader skips): not problems with the data. */
const NOTE=/^(?:\d{10}-\d{2}-\d{6}:)?(?:NO_DIRECT_COMPARABLE_QUARTER|RESTATEMENT_REVIEW_REQUIRED)$|^UNSUPPORTED_SOURCE_FACTS:/;

/** The list with one switch moved: a company's feature (switching the reports off takes the findings with them) or a global one. */
function applySwitch(d:BusinessMapCompanies,symbol:string|null,feature:Feature,on:boolean):BusinessMapCompanies {
  if(!symbol)return {...d,generation:{...d.generation,[feature]:on}};
  // Switched on, the feature's first task is queued; switched off, nothing of it runs.
  const moved=(f:BusinessMapCompany['features'][Feature],value:boolean)=>({...f,on:value,run:value?(f.run??'queued'):null});
  return {...d,companies:d.companies.map(c=>c.ticker!==symbol?c:{...c,features:{...c.features,[feature]:moved(c.features[feature],on),
    ...(feature==='reports'&&!on?{findings:moved(c.features.findings,false)}:{})}})};
}
/** Puts back what one switch moved, from the list as it was before the click; other switches keep their own changes. */
function restoreSwitch(d:BusinessMapCompanies,before:BusinessMapCompanies,symbol:string|null,feature:Feature):BusinessMapCompanies {
  if(!symbol)return {...d,generation:{...d.generation,[feature]:before.generation[feature]}};
  const old=before.companies.find(c=>c.ticker===symbol);
  if(!old)return d;
  return {...d,companies:d.companies.map(c=>c.ticker!==symbol?c:{...c,features:{...c.features,[feature]:old.features[feature],...(feature==='reports'?{findings:old.features.findings}:{})}})};
}

/** What a feature is doing for the company right now, for the detail: a badge and a line on what it last wrote. */
function featureState(f:BusinessMapCompany['features'][Feature],paused:boolean):{status:string;text:string;note:string} {
  const written=f.publishedAt?`上次生成 ${financialDate(f.publishedAt)}`:'尚无内容';
  if(!f.on)return {status:'idle',text:'已关闭',note:f.publishedAt?'已生成的内容不展示':'尚无内容'};
  if(paused)return {status:'caution',text:'已全局暂停',note:written};
  if(f.run==='running')return {status:'processing',text:'正在生成',note:written};
  if(f.run==='queued')return {status:'processing',text:'排队中',note:written};
  if(f.run==='failed')return {status:'failed',text:'上次生成失败',note:written};
  return f.publishedAt?{status:'reviewed',text:'已生成',note:written}:{status:'unreviewed',text:'等待生成',note:'有新数据时开始'};
}

/** One company as a table row: its map state, the four feature switches and the actions; the row opens to the details. */
function Company({company:c,generation,busy,onToggle,onPrepare,onJudge,onFeature}:{company:BusinessMapCompany;generation:Record<Feature,boolean>;busy:boolean;onToggle:()=>void;onPrepare:()=>void;onJudge:()=>void;onFeature:(feature:Feature,on:boolean)=>void}) {
  const running=!!c.task&&active.has(c.task.status),collecting=!!c.collection&&['queued','running','retry'].includes(c.collection.status);
  const ready=c.publication.status==='ready';
  const revenuePending=c.publication.revenueCoverage?.some(q=>q.status==='unverified');
  // A maintenance task's findings count while it is the latest work on the company; a later collection supersedes them.
  const taskCurrent=!!c.task&&(active.has(c.task.status)||!c.collection||c.task.updatedAt>=c.collection.updatedAt);
  const taskIssues=taskCurrent?[...(c.task?.issues??[]),...(c.task?.errorCode?[c.task.errorCode]:[])]:[];
  const notes=taskIssues.filter(code=>NOTE.test(code));
  const issues=[...new Set([...(revenuePending?['REVENUE_BREAKDOWN_NOT_VERIFIED']:[]),...taskIssues.filter(code=>!NOTE.test(code)),...(c.collection?.status==='succeeded'?[]:c.collection?.reasons??[]),...(!ready||c.publication.outdated?c.publication.reasons:[])])].filter(s=>s!=='PREPARING');
  const skipped=notes.filter(code=>!code.startsWith('UNSUPPORTED_SOURCE_FACTS:')).length,unsupported=notes.filter(code=>code.startsWith('UNSUPPORTED_SOURCE_FACTS:')).reduce((n,code)=>n+Number(code.split(':')[1]??0),0);
  const [open,setOpen]=useState(false);
  const map=ready?{status:'reviewed',text:'财务地图已显示'}:running||collecting?{status:'processing',text:'财务地图准备中'}:{status:'idle',text:'财务地图未就绪'};
  const remove=()=>{if(window.confirm(`移出 ${c.ticker}？`))onToggle();};
  return <tbody data-open={open||undefined}>
    <tr className="bm-admin-row" aria-label={`${c.ticker} 数据准备`}>
      <td><div className="bm-admin-company-cell"><button className="bm-admin-toggle" aria-expanded={open} aria-label={`${c.ticker} 详情`} onClick={()=>setOpen(o=>!o)}><ChevronRight size={15}/></button><CompanyLogo symbol={c.ticker}/><span className="bm-admin-name"><strong className="ra-mono">{c.ticker}</strong>{c.name&&c.name!==c.ticker&&<small>{c.name}</small>}</span></div></td>
      <td><div className="bm-admin-states"><span className="ra-badge" data-status={map.status}>{map.text}</span></div></td>
      {FEATURES.map(f=><td key={f} className="bm-admin-feature-col"><button className="bm-switch" role="switch" aria-checked={c.features[f].on} aria-label={`${c.ticker} ${FEATURE_LABEL[f]}`} title={featureState(c.features[f],!generation[f]).text} disabled={!c.dataEnabled&&!c.features[f].on} onClick={()=>onFeature(f,!c.features[f].on)}><span/></button></td>)}
      <td><div className="bm-admin-actions"><button className="fm-button" disabled={busy||running||!c.dataEnabled} onClick={onPrepare}>{running?'准备中':'重新准备'}</button><a href={`/admin/financials?ticker=${c.ticker}`}>财报</a>{ready&&<a href={`https://spontra-business-map.max-zhangyuchen.workers.dev/companies/${c.ticker}`} target="_blank" rel="noreferrer" aria-label={`${c.ticker} 业务地图`}>地图<ExternalLink size={12}/></a>}
        {c.dataEnabled?<button className="bm-admin-remove" disabled={busy} onClick={remove} aria-label={`移出 ${c.ticker}`} title="移出白名单"><Trash2 size={16}/></button>:<button className="fm-button" disabled={busy} onClick={onToggle}>加入</button>}</div></td>
    </tr>
    {open&&<tr className="bm-admin-detail"><td colSpan={7}><div className="bm-detail">
      <header className="bm-detail-head">
        <div><span>可展示期间</span>{ready&&c.publication.periods.length?<ul className="bm-chips">{c.publication.periods.map(p=><li key={p}>{p}</li>)}</ul>:<em>—</em>}</div>
        {c.task&&<div><span>最近任务</span><em>{stages[c.task.stage]??c.task.stage}{taskStatus[c.task.status]?` · ${taskStatus[c.task.status]}`:''} · {financialDate(c.task.updatedAt)}</em></div>}
      </header>
      <ul className="bm-features" aria-label="生成状态">{FEATURES.map(f=>{const state=featureState(c.features[f],!generation[f]);return <li key={f} data-status={state.status}>
        <span>{FEATURE_LABEL[f]}</span><span className="ra-badge" data-status={state.status}>{state.text}</span><small>{state.note}</small></li>;})}</ul>
      <div className="bm-detail-grid">
        <article className="bm-card"><h4><Layers size={14}/>收入构成</h4>
          {c.publication.revenueCoverage?.length?<dl data-kind="periods">{c.publication.revenueCoverage.map(q=><div key={q.period} data-status={q.status}><dt>{q.period}</dt><dd>{coverage(q)}</dd></div>)}</dl>:<p className="bm-empty">无</p>}</article>
        <article className="bm-card"><h4><ScanLine size={14}/>采集</h4>
          {running&&c.task&&<Meter label={stages[c.task.stage]??c.task.stage} completed={c.task.progress.completed} total={c.task.progress.total}/>}
          {!!c.collection?.total&&<Meter label="最新财报扫描" completed={c.collection.completed} total={c.collection.total} done={c.collection.status==='succeeded'}/>}
          {c.history&&<Meter label="历史披露扫描" completed={c.history.completed} total={c.history.total}/>}
          {!running&&!c.collection?.total&&!c.history&&<p className="bm-empty">无采集记录</p>}
          {(skipped>0||unsupported>0)&&<p className="bm-empty">{[skipped?`${skipped} 份文件无可提取的季度`:'',unsupported?`${unsupported} 项事实格式未读取`:''].filter(Boolean).join(' · ')}</p>}</article>
        <article className="bm-card"><h4><Scale size={14}/>税前至净利润</h4>
          {c.presentation?.source?<>
            <span className="ra-badge" data-status={c.presentation.source==='degraded'?'caution':'reviewed'}>{presentationSource[c.presentation.source]}</span>
            {c.presentation.afterTax.length>0&&<dl>{c.presentation.afterTax.map(a=><div key={a.name}><dt>{a.name}</dt><dd className="ra-mono">{Number(a.value).toLocaleString('en-US')}</dd></div>)}</dl>}
            {c.presentation.basisChanges.length>0&&<p>重述行（不比较环比）：{c.presentation.basisChanges.map(k=>lineName[k]??k).join('、')}</p>}
            {c.presentation.profile&&<p>模型判定：{c.presentation.profile.status==='verified'?'已核验':'未通过'} · {c.presentation.profile.attempts} 次{c.presentation.profile.issues.length>0&&<small>{c.presentation.profile.issues.slice(0,3).join('；')}</small>}</p>}
            {(c.presentation.source==='degraded'||c.presentation.profile)&&<button className="fm-button" disabled={busy} onClick={onJudge}>重新判定</button>}
          </>:<p className="bm-empty">{c.presentation&&['financial','insurance'].includes(c.presentation.model??'')?'金融/保险报表 · 税前 − 所得税 = 净利润':c.presentation?.model?'直接读取 · 税前 − 所得税 = 净利润':'无'}</p>}</article>
        <article className="bm-card" data-tone={issues.length?'caution':'ok'}><h4>{issues.length?<AlertTriangle size={14}/>:<CheckCircle2 size={14}/>}问题{issues.length?` · ${issues.length}`:''}</h4>
          {issues.length?<ul>{issues.map(code=><li key={code}>{issueText(code)}{errors[code]&&<small>{code}</small>}</li>)}</ul>:<p className="bm-empty">无</p>}</article>
      </div>
    </div></td></tr>}
  </tbody>;
}
