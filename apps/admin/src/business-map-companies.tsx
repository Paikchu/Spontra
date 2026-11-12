import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { WarningIcon as AlertTriangle, CheckCircleIcon as CheckCircle2, CaretLeftIcon as ChevronLeft, CaretRightIcon as ChevronRight, ArrowsClockwiseIcon as RefreshCw, MagnifyingGlassIcon as Search } from "@phosphor-icons/react";
import type { BusinessMapCompanies, BusinessMapCompany, BusinessMapDirectory, DirectoryCompany } from '@/shared/analysis-contract/business-map-admin';
import { FEATURES, LAYER_REQUIRES, LAYERS, type Feature, type Layer } from '@/shared/analysis-contract/business-features';
import { layersAbove } from '@/shared/analysis-runtime/business-features';
import { adminApi, AdminApiError } from './admin-api';
import { pendingRequestId, completeRequestId } from './financial-maintenance-state';
import { financialDate } from './financial-update-history';
import { CompanyLogo } from '@/packages/web/src/company-logo';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/packages/web/src/ui/tooltip';
import { runElapsed, runView } from './run-progress';
import { ValuationInputs } from './valuation-inputs';
import { CompanyUsage } from './company-usage';
import { CompanyReports } from './company-reports';
import { useOnReturn, usePageActive } from './admin-page';
import { addressTicker } from './address-ticker';
import './business-map-companies.css';

const stages: Record<string,string> = {identify:'识别公司',waiting_issuer:'等待同公司任务',collect:'采集及核验最新财报',history:'补充季度历史',audit:'检查披露完整性',complete:'任务结束'};
/** The financial map's preparation in order (financial-maintenance-runner.ts); waiting for the issuer comes before all of it. */
const TASK_PHASES = ['identify','collect','history','audit'] as const;
/** Which run a feature's progress line belongs to, when the feature has more than one kind of run. */
const RUN_LABEL: Record<string,string> = {report:'文件摘要',items:'逐文件分析',findings:'要点',analyst:'分析师卷宗',explainer:'业务解读',tree:'业务脑图',valuation:'估值评估'};
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
  NO_QUARTERLY_PERIOD:'未披露独立季度，无法比较',
  SEC_DOCUMENT_TOO_LARGE:'申报文件超过 20 MB',
  NEWER_PUBLICATION_CURRENT:'已有更新的发布',
  INVALID_PAYLOAD:'已发布数据未通过当前校验',
  MAINTENANCE_STOPPED:'维护任务已停止',
  WORKFLOW_STATUS_UNAVAILABLE:'分析状态不可读',
  CONFLICTING_REVENUE_ELIMINATIONS:'收入抵销数值互相矛盾',
  CONFLICTING_SEGMENT:'分部数值互相矛盾',
  CONFLICTING_CORPORATE_REVENUE:'公司层面收入互相矛盾',
  CONFLICTING_RECONCILING_ITEMS:'调节项互相矛盾',
  AMBIGUOUS_REVENUE_AXIS:'收入拆分维度不明确',
  UNSUPPORTED_NUMBER_FORMAT:'数字格式不受支持',
  DOCUMENT_TOO_LARGE:'文件过大',
};
const active = new Set(['queued','running','cancel_requested']);
/** The five analysis layers, lowest first (docs/spontra-architecture-upgrade.md). */
const LAYER_LABEL: Record<Layer,string> = {map:'财务报表',filings:'财报',findings:'要点',tree:'公司业务',valuation:'估值评估'};
const LAYER_LOCATION: Record<Layer,string> = {map:'利润、现金流、资产负债表与原始文件',filings:'侧栏财报的摘要、解读与报告',findings:'侧栏要点、公司分析与分析师文章',tree:'业务脑图与业务详情；营收金额来自财务报表',valuation:'公司页估值评估'};
const FEATURE_LABEL: Record<Feature,string> = LAYER_LABEL;
/** One problem per code: a filing's code (`<accession>:<code>`) joins the others of the same code, with its filing listed. */
function groupIssues(codes:string[]):Array<{code:string;label:string;filings:string[]}> {
  const groups=new Map<string,{code:string;label:string;filings:string[]}>();
  for(const raw of codes){
    const m=/^(\d{10}-\d{2}-\d{6}):(.+)$/.exec(raw),code=m?m[2]!:raw,group=groups.get(code)??{code,label:issueText(code),filings:[]};
    if(m)group.filings.push(m[1]!);
    groups.set(code,group);
  }
  return [...groups.values()];
}
function issueText(code:string) { const parts=code.split(':'); if(parts[0]==='UNSUPPORTED_SOURCE_FACTS')return `${parts[1]} 项事实格式不受支持`; if(parts[0]==='CONFLICTING_FACT'&&parts[1])return `${parts[1]} 数值互相矛盾`; return errors[code] ?? (parts.length>1&&errors[parts.at(-1)!]?`${parts[0]}：${errors[parts.at(-1)!]}`:code); }
function storage() { try { return window.sessionStorage; } catch { return undefined; } }

export function BusinessMapCompanies({onUnauthorized,onAuthenticated}:{onUnauthorized:()=>void;onAuthenticated:()=>void}) {
  const [data,setData]=useState<BusinessMapCompanies|null>(null);
  // The directory: every listed issuer, paged and searched on the server; by default the companies with layer 1 on.
  const [directory,setDirectory]=useState<BusinessMapDirectory|null>(null);
  const [query,setQuery]=useState(()=>addressTicker(window.location.search)),[typed,setTyped]=useState(query);
  const [scope,setScope]=useState<'on'|'all'>('on'),[page,setPage]=useState(1);
  // The company the page was opened for (a message's link): its row opens and comes into view once, when the list arrives.
  const [focus,setFocus]=useState(()=>addressTicker(window.location.search));
  const [loadError,setLoadError]=useState('');
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(''),[refresh,setRefresh]=useState(0);
  const lock=useRef(false),pending=useRef(new Set<string>()),switched=useRef(0),callbacks=useRef({onUnauthorized,onAuthenticated});
  const pendingCompanies=useRef(new Set<string>());
  // Messages float over the page and leave on their own, so nothing below them moves.
  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),2500);return()=>clearTimeout(timer);},[notice]);
  useEffect(()=>{if(!error)return;const timer=setTimeout(()=>setError(''),6000);return()=>clearTimeout(timer);},[error]);
  useEffect(()=>{callbacks.current={onUnauthorized,onAuthenticated};},[onUnauthorized,onAuthenticated]);
  const unauthorized=useCallback(()=>callbacks.current.onUnauthorized(),[]);
  useEffect(()=>{const timer=setTimeout(()=>{setQuery(typed.trim());setPage(1);},250);return()=>clearTimeout(timer);},[typed]);
  useEffect(()=>{
    const controller=new AbortController(),started=switched.current;
    void adminApi<BusinessMapCompanies>('business-map/companies',{signal:controller.signal}).then(result=>{
      // A read that started before a switch moved would flip it back; the next read picks the switch up.
      if(controller.signal.aborted||pending.current.size||switched.current!==started)return;setData(result);setLoadError('');callbacks.current.onAuthenticated();
    }).catch(err=>{if(controller.signal.aborted)return;if(err instanceof AdminApiError&&err.status===401)callbacks.current.onUnauthorized();else setLoadError(err.message);});
    return ()=>controller.abort();
  },[refresh]);
  useEffect(()=>{
    const controller=new AbortController(),started=switched.current;
    const params=new URLSearchParams({filter:query?'all':scope,page:String(page)});if(query)params.set('q',query);
    void adminApi<BusinessMapDirectory>(`business-map/directory?${params}`,{signal:controller.signal}).then(result=>{
      if(controller.signal.aborted||pending.current.size||switched.current!==started)return;setDirectory(result);
    }).catch(err=>{if(controller.signal.aborted)return;if(err instanceof AdminApiError&&err.status===401)callbacks.current.onUnauthorized();else setLoadError(err.message);});
    return ()=>controller.abort();
  },[query,scope,page,refresh]);
  // Every five seconds while a company is being prepared or a layer runs, every thirty otherwise: the list is a heavy read.
  const working=!!data?.companies.some(c=>(c.task&&active.has(c.task.status))||(c.collection&&['queued','running','retry'].includes(c.collection.status))||FEATURES.some(f=>c.features[f].run !== null));
  const shown=usePageActive();
  useEffect(()=>{const timer=setInterval(()=>{if(!document.hidden&&shown.current&&!lock.current&&!pending.current.size)setRefresh(n=>n+1);},working?5000:30000);return()=>clearInterval(timer);},[working,shown]);
  useOnReturn(()=>{if(!lock.current&&!pending.current.size)setRefresh(n=>n+1);});
  /** Layer 1 (the whitelist) on or off for a company, or its financial map prepared again (enabled undefined). */
  async function mutate(symbol:string,enabled?:boolean) {
    if(lock.current||pendingCompanies.current.has(symbol))return;
    if(enabled===false&&!window.confirm(`关闭 ${symbol} 的财务报表？财报、要点、公司业务与估值评估也将关闭。`))return;
    lock.current=true;pendingCompanies.current.add(symbol);setBusy(symbol);setError('');setNotice('');
    const key=`business-map:${symbol}:${enabled??'prepare'}`,requestId=pendingRequestId(key,storage());
    try {
      await adminApi(enabled===undefined?`financials/companies/${symbol}/actions`:`business-map/companies/${symbol}`,{
        method:'POST',headers:{'idempotency-key':requestId},body:JSON.stringify(enabled===undefined?{action:'extract',requestId}:{enabled,requestId})});
      completeRequestId(key,storage());switched.current++;setRefresh(n=>n+1);
      setNotice(enabled===false?`${symbol} 已关闭`:enabled===true?`${symbol} 已开启财务报表`:`${symbol} 重新准备已提交`);
    } catch(err) {
      if(err instanceof AdminApiError&&err.status===401)callbacks.current.onUnauthorized();
      else setError((err as Error).message);
      if(err instanceof AdminApiError&&err.status>=400&&err.status<500)completeRequestId(key,storage());
    } finally {lock.current=false;pendingCompanies.current.delete(symbol);setBusy('');}
  }
  /**
   * One layer's switch for one company, or its global generation switch (symbol null). The switch moves at once (closing
   * a layer closes the ones above); a refused request puts it back and says why. The regular refresh brings run states.
   */
  async function switchFeature(symbol:string|null,feature:Feature,on:boolean) {
    const key=`${symbol??'*'}:${feature}`;
    if(pending.current.has(key)||symbol&&pendingCompanies.current.has(symbol))return;
    const row=symbol?directory?.rows.find(r=>r.ticker===symbol):null,below=LAYER_REQUIRES[feature]!;
    if(symbol&&on&&row&&!row.layers[below]){setError(`请先开启该公司的${LAYER_LABEL[below]}`);return;}
    const before={data,directory};
    pending.current.add(key);if(symbol)pendingCompanies.current.add(symbol);switched.current++;setError('');
    setData(d=>d&&applySwitch(d,symbol,feature,on));
    if(symbol)setDirectory(d=>d&&{...d,rows:d.rows.map(r=>r.ticker!==symbol?r:{...r,layers:applyLayers(r.layers,feature,on)})});
    try {await adminApi(symbol?`business-map/companies/${symbol}/features/${feature}`:`business-map/features/${feature}`,{method:'POST',body:JSON.stringify({on})});}
    catch(err){
      setData(d=>d&&before.data?restoreSwitch(d,before.data,symbol,feature,on):d);
      if(symbol)setDirectory(d=>{
        const old=before.directory?.rows.find(r=>r.ticker===symbol);
        if(!d||!old)return d;
        const affected:Layer[]=[feature,...(on?[]:layersAbove(feature))];
        return {...d,rows:d.rows.map(r=>r.ticker!==symbol?r:{...r,layers:{...r.layers,...Object.fromEntries(affected.map(layer=>[layer,old.layers[layer]]))}})};
      });
      if(err instanceof AdminApiError&&err.status===401)callbacks.current.onUnauthorized();else setError((err as Error).message);
    }
    finally {pending.current.delete(key);if(symbol)pendingCompanies.current.delete(symbol);setRefresh(n=>n+1);}
  }
  /** The project's scheduled-analysis switch, or one company's own (symbol given), which decides for it whatever the project's says. */
  async function switchScheduledAnalysis(symbol:string|null,on:boolean) {
    const key=`scheduled-analysis:${symbol??'*'}`;
    if(!data||pending.current.has(key)||pending.current.has('scheduled-analysis:*')||symbol===null&&[...pending.current].some(k=>k.startsWith('scheduled-analysis:')))return;
    const before=data;
    const affected=new Map(before.companies.filter(c=>symbol?c.ticker===symbol:c.scheduledAnalysis===before.scheduledAnalysis).map(c=>[c.ticker,c.scheduledAnalysis]));
    pending.current.add(key);switched.current++;setError('');
    // A company without a switch of its own follows the project's; the next read says which those are.
    setData(d=>d&&(symbol?{...d,companies:d.companies.map(c=>c.ticker!==symbol?c:{...c,scheduledAnalysis:on})}:{...d,scheduledAnalysis:on,companies:d.companies.map(c=>c.scheduledAnalysis===d.scheduledAnalysis?{...c,scheduledAnalysis:on}:c)}));
    try {await adminApi('business-map/scheduled-analysis',{method:'POST',body:JSON.stringify(symbol?{on,ticker:symbol}:{on})});}
    catch(err){
      setData(d=>d&&{...d,...(!symbol?{scheduledAnalysis:before.scheduledAnalysis}:{}),companies:d.companies.map(c=>affected.has(c.ticker)?{...c,scheduledAnalysis:affected.get(c.ticker)!}:c)});
      if(err instanceof AdminApiError&&err.status===401)callbacks.current.onUnauthorized();else setError((err as Error).message);
    }
    finally {pending.current.delete(key);setRefresh(n=>n+1);}
  }
  async function switchStage(symbol:string|null,on:boolean) {
    const key=`stage:${symbol??'*'}`;
    if(!data||pending.current.has(key)||lock.current)return;
    const before=symbol?data.companies.find(c=>c.ticker===symbol)?.stageEnabled:data.stageEnabled;
    if(before===undefined)return;
    const move=(d:BusinessMapCompanies,value:boolean)=>symbol?{...d,companies:d.companies.map(c=>c.ticker===symbol?{...c,stageEnabled:value}:c)}:{...d,stageEnabled:value};
    pending.current.add(key);switched.current++;setError('');
    setData(d=>d&&move(d,on));
    try{await adminApi(symbol?`business-map/companies/${symbol}/stage`:'business-map/stage',{method:'POST',body:JSON.stringify({on})});}
    catch(err){setData(d=>d&&move(d,before));if(err instanceof AdminApiError&&err.status===401)callbacks.current.onUnauthorized();else setError((err as Error).message);}
    finally{pending.current.delete(key);setRefresh(n=>n+1);}
  }
  async function judge(symbol:string) {
    if(lock.current)return;lock.current=true;setBusy(symbol);setError('');setNotice('');
    try {await adminApi(`business-map/companies/${symbol}/presentation`,{method:'POST',body:'{}'});setRefresh(n=>n+1);setNotice(`${symbol} 重新判定已提交`);}
    catch(err){if(err instanceof AdminApiError&&err.status===401)callbacks.current.onUnauthorized();else setError((err as Error).message);}
    finally {lock.current=false;setBusy('');}
  }
  const details=new Map(data?.companies.map(c=>[c.ticker,c])??[]);
  const rows=directory?.rows??[];
  return <section className="bm-admin" aria-label="公司">
    <header className="ra-page-header bm-directory-toolbar">
      <label className="bm-admin-search"><span className="bm-admin-sr">搜索公司</span><span className="ra-search bm-admin-query"><Search size={16}/><input aria-label="搜索公司" placeholder="代码或公司名" value={typed} onChange={e=>setTyped(e.target.value.toUpperCase())}/></span></label>
      <div className="bm-admin-filter">
        <div className="bm-admin-scope" role="group" aria-label="范围">
          <button aria-pressed={!query&&scope==='on'} disabled={!!query} onClick={()=>{setScope('on');setPage(1);}}>已开启</button>
          <button aria-pressed={!!query||scope==='all'} disabled={!!query} onClick={()=>{setScope('all');setPage(1);}}>全部美股</button>
        </div>
        <span>{directory?`${directory.total.toLocaleString('en-US')} 家`:''}</span>
        <button className="ra-icon-button" onClick={()=>setRefresh(n=>n+1)} disabled={!!busy} aria-label="刷新"><RefreshCw size={16}/></button>
      </div>
    </header>
    {createPortal(<div className="bm-toasts" aria-live="polite">{notice&&<p className="bm-toast" role="status">{notice}</p>}{(error||loadError)&&<p className="bm-toast" data-tone="error" role="alert">{error||loadError}</p>}</div>,document.body)}
    {data&&!data.automaticCollection&&<p className="bm-admin-warning">自动采集已暂停</p>}
    {data&&scheduledNote(data)&&<p className="bm-admin-warning">{scheduledNote(data)}</p>}
    {data&&FEATURES.some(f=>!data.generation[f])&&<p className="bm-admin-warning">{FEATURES.filter(f=>!data.generation[f]).map(f=>FEATURE_LABEL[f]).join('、')}生成已全局暂停</p>}
    <p className="bm-admin-sr" id="bm-switch-guide">表头开关控制自动生成，提问表头开关控制全部公司的提问入口；每行开关控制该公司的对应功能。财报关闭后保留原始文件，隐藏摘要和解读。</p>
    {!directory&&!loadError&&<div className="bm-admin-loading" role="status"><span>加载公司</span>{Array.from({length:6},(_,i)=><div key={i} aria-hidden="true"/>)}</div>}
    {rows.length>0&&<div className="bm-admin-table-wrap" tabIndex={0} role="region" aria-label="公司功能管理" aria-describedby="bm-switch-guide"><table className="bm-admin-table bm-company-table">
      <thead><tr><th scope="col">公司</th>
        {LAYERS.map(l=><th scope="col" key={l} className="bm-admin-feature-col"><span className="bm-admin-feature-head"><Tooltip><TooltipTrigger asChild><span className="bm-admin-feature-label" tabIndex={0}>{LAYER_LABEL[l]}</span></TooltipTrigger><TooltipContent>{LAYER_LOCATION[l]}</TooltipContent></Tooltip>{l!=='map'&&<button className="bm-switch bm-switch-sm" role="switch" aria-checked={!!data?.generation[l]} aria-label={`${LAYER_LABEL[l]}自动生成（全部公司）`} title={data?.generation[l]?'全部公司自动生成已开启 · 点击暂停':'全部公司自动生成已暂停 · 点击恢复'} disabled={!data} onClick={()=>void switchFeature(null,l,!data?.generation[l])}><span/></button>}</span></th>)}
        <th scope="col" className="bm-admin-feature-col"><span className="bm-admin-feature-head"><span className="bm-admin-feature-label">提问</span><button className="bm-switch bm-switch-sm" role="switch" aria-checked={!!data?.stageEnabled} aria-label="提问（全部公司）" title={data?.stageEnabled?'提问入口已开启 · 点击暂停':'提问入口已全局暂停 · 点击恢复'} disabled={!data} onClick={()=>void switchStage(null,!data?.stageEnabled)}><span/></button></span></th>
        <th scope="col" className="bm-admin-feature-col"><span className="bm-admin-feature-head"><span className="bm-admin-feature-label">定时分析</span><button className="bm-switch bm-switch-sm" role="switch" aria-checked={!!data?.scheduledAnalysis} aria-label="定时分析（全部公司）" title={data?.scheduledAnalysis?'全部公司定时分析已开启 · 点击暂停':'全部公司定时分析已暂停 · 点击恢复'} disabled={!data} onClick={()=>void switchScheduledAnalysis(null,!data?.scheduledAnalysis)}><span/></button></span></th>
        <th scope="col">操作</th></tr></thead>
      {rows.map(row=>{const company=details.get(row.ticker);return company&&row.layers.map
        ?<Company key={row.ticker} company={company} layers={row.layers} onUnauthorized={unauthorized} busy={!!busy} onToggle={()=>void mutate(company.ticker,!row.layers.map)} onPrepare={()=>void mutate(company.ticker)} onJudge={()=>void judge(company.ticker)} onFeature={(feature,on)=>void switchFeature(company.ticker,feature,on)} onStage={on=>void switchStage(company.ticker,on)} stagePaused={!data?.stageEnabled} onScheduled={on=>void switchScheduledAnalysis(company.ticker,on)} focused={company.ticker===focus} onFocused={()=>setFocus('')}/>
        :<Listed key={row.ticker} row={row} busy={!!busy} onMap={()=>void mutate(row.ticker,!row.layers.map)} onFeature={(feature,on)=>void switchFeature(row.ticker,feature,on)}/>;})}
    </table></div>}
    {directory&&!rows.length&&<div className="ra-empty" role="status"><Search size={24} aria-hidden="true"/><h3>无匹配公司</h3></div>}
    {directory&&directory.pages>1&&<nav className="bm-admin-pages" aria-label="分页">
      <button className="ra-icon-button" aria-label="上一页" disabled={page<=1} onClick={()=>setPage(p=>p-1)}><ChevronLeft size={16}/></button>
      <span className="ra-mono">{directory.page} / {directory.pages}</span>
      <button className="ra-icon-button" aria-label="下一页" disabled={page>=directory.pages} onClick={()=>setPage(p=>p+1)}><ChevronRight size={16}/></button>
    </nav>}
  </section>;
}
/** The five switches of one company in the order of the layers: each opens only over the one below it. */
function LayerSwitches({ticker,layers,failed,title,disabled,onMap,onFeature}:{ticker:string;layers:Record<Layer,boolean>;failed?:(l:Feature)=>boolean;title?:(l:Feature)=>string|undefined;disabled:boolean;onMap:()=>void;onFeature:(f:Feature,on:boolean)=>void}) {
  return <>{LAYERS.map(l=>{const below=LAYER_REQUIRES[l],blocked=!layers[l]&&!!below&&!layers[below];
    return <td key={l} className="bm-admin-feature-col"><button className="bm-switch" role="switch" data-failed={l!=='map'&&failed?.(l)||undefined} aria-checked={layers[l]} aria-label={`${ticker} ${LAYER_LABEL[l]}`}
      title={blocked?`先开启${LAYER_LABEL[below!]}`:l!=='map'&&title?title(l):LAYER_LABEL[l]} disabled={disabled||blocked} onClick={()=>l==='map'?onMap():onFeature(l,!layers[l])}><span/></button></td>;})}</>;
}
/** A listed company without a financial map yet: its name and the five switches, layer 1 the only one it can open. */
function Listed({row,busy,onMap,onFeature}:{row:DirectoryCompany;busy:boolean;onMap:()=>void;onFeature:(f:Feature,on:boolean)=>void}) {
  return <tbody><tr className="bm-admin-row" aria-label={row.ticker}>
    <td><div className="bm-admin-company-cell"><span className="bm-admin-toggle-gap"/><CompanyLogo symbol={row.ticker}/><span className="bm-admin-name"><strong className="ra-mono">{row.ticker}</strong><small>{row.name}{row.classes.length?` · ${row.classes.join(' ')}`:''}</small></span></div></td>
    <LayerSwitches ticker={row.ticker} layers={row.layers} disabled={busy} onMap={onMap} onFeature={onFeature}/>
    <td className="bm-admin-feature-col"><button className="bm-switch" role="switch" aria-checked={false} aria-label={`${row.ticker} 提问`} title="先开启财务报表" disabled><span/></button></td><td/><td/>
  </tr></tbody>;
}
/** Layer switches after one moved: closing a layer closes every layer above it. */
function applyLayers(layers:Record<Layer,boolean>,feature:Feature,on:boolean):Record<Layer,boolean> {
  return {...layers,[feature]:on,...(on?{}:Object.fromEntries(layersAbove(feature).map(l=>[l,false])))};
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
/** Ordered phases as a chain of named steps: the phases before `current` done, `current` in progress. */
function Phases({phases,current,label}:{phases:readonly string[];current:number;label:string}) {
  return <ol className="bm-chain" aria-label={label}>
    {phases.map((p,i)=><li key={p} data-state={i<current?'done':i===current?'current':undefined} aria-current={i===current?'step':undefined}>{p}</li>)}
  </ol>;
}
/** One run in flight as a line: what runs, its phases, the phase and step it is on, how many steps and how long. */
function RunProgress({run,name}:{run:BusinessMapCompany['features'][Feature]['progress'][number];name:string}) {
  const view=runView(run),phase=view.phases[view.current];
  return <div className="bm-run" role="listitem">
    <span>{name}</span>
    <Phases phases={view.phases} current={view.current} label={`${name} 进度`}/>
    <p>{view.step&&view.step!==phase?view.step:phase}</p>
    <small>{run.status==='waiting'?'等待中 · ':''}{view.steps?`${view.steps} 步 · `:''}已运行 {runElapsed(run)}</small>
  </div>;
}
/** The financial map's own preparation as the same line, with the current phase's count. */
function TaskProgress({task}:{task:NonNullable<BusinessMapCompany['task']>}) {
  const current=Math.max(0,TASK_PHASES.indexOf(task.stage as typeof TASK_PHASES[number]));
  return <div className="bm-run" role="listitem">
    <span>财务报表</span>
    <Phases phases={TASK_PHASES.map(s=>stages[s]!)} current={task.stage==='waiting_issuer'?-1:current} label="财务报表进度"/>
    <p>{task.stage==='waiting_issuer'?stages.waiting_issuer:stages[task.stage]??task.stage}{task.progress.total>0&&<span className="ra-mono">{task.progress.completed}/{task.progress.total}</span>}</p>
    <small>已运行 {runElapsed({startedAt:task.createdAt,updatedAt:task.updatedAt})}</small>
  </div>;
}
/** Per-document notes from a scan (a filing without a quarter, a fact format the reader skips): not problems with the data. */
const NOTE=/^(?:\d{10}-\d{2}-\d{6}:)?(?:NO_DIRECT_COMPARABLE_QUARTER|NO_QUARTERLY_PERIOD|RESTATEMENT_REVIEW_REQUIRED)$|^UNSUPPORTED_SOURCE_FACTS:/;

/** Which companies scheduled analysis leaves out, or the only ones it runs for while the project's switch is off. */
function scheduledNote(d:BusinessMapCompanies):string {
  const differing=d.companies.filter(c=>c.scheduledAnalysis!==d.scheduledAnalysis).map(c=>c.ticker);
  if(d.scheduledAnalysis)return differing.length?`定时分析已暂停：${differing.join('、')}`:'';
  return differing.length?`定时分析仅开启：${differing.join('、')}`:'定时分析已暂停';
}
/** The list with one switch moved: a company's layer (closing it closes every layer above) or a global one. */
function applySwitch(d:BusinessMapCompanies,symbol:string|null,feature:Feature,on:boolean):BusinessMapCompanies {
  if(!symbol)return {...d,generation:{...d.generation,[feature]:on}};
  // Optimistically move only the switch; task states are replaced by the next server response.
  const moved=(f:BusinessMapCompany['features'][Feature],value:boolean)=>({...f,on:value});
  const closed=on?[]:layersAbove(feature).filter((l):l is Feature=>l!=='map');
  return {...d,companies:d.companies.map(c=>c.ticker!==symbol?c:{...c,features:{...c.features,[feature]:moved(c.features[feature],on),
    ...Object.fromEntries(closed.map(l=>[l,moved(c.features[l],false)]))}})};
}

/** A refused request restores only the switches it moved; other companies and controls keep their latest state. */
function restoreSwitch(d:BusinessMapCompanies,before:BusinessMapCompanies,symbol:string|null,feature:Feature,on:boolean):BusinessMapCompanies {
  if(!symbol)return {...d,generation:{...d.generation,[feature]:before.generation[feature]}};
  const old=before.companies.find(c=>c.ticker===symbol);
  if(!old)return d;
  const affected=[feature,...(on?[]:layersAbove(feature))] as Feature[];
  return {...d,companies:d.companies.map(c=>c.ticker!==symbol?c:{...c,features:{...c.features,...Object.fromEntries(affected.map(f=>[f,old.features[f]]))}})};
}

/** One company as a table row: its map state, one switch per feature and the actions; the row opens to the details. */
function Company({company:c,layers,busy,onToggle,onPrepare,onJudge,onFeature,onStage,stagePaused,onScheduled,focused,onFocused,onUnauthorized}:{company:BusinessMapCompany;layers:Record<Layer,boolean>;onUnauthorized:()=>void;busy:boolean;onToggle:()=>void;onPrepare:()=>void;onJudge:()=>void;onFeature:(feature:Feature,on:boolean)=>void;onStage:(on:boolean)=>void;stagePaused:boolean;onScheduled:(on:boolean)=>void;focused:boolean;onFocused:()=>void}) {
  const running=!!c.task&&active.has(c.task.status);
  const ready=c.publication.status==='ready';
  const revenuePending=c.publication.revenueCoverage?.some(q=>q.status==='unverified');
  // A maintenance task's findings count while it is the latest work on the company; a later collection supersedes them.
  const taskCurrent=!!c.task&&(active.has(c.task.status)||!c.collection||c.task.updatedAt>=c.collection.updatedAt);
  const taskIssues=taskCurrent?[...(c.task?.issues??[]),...(c.task?.errorCode?[c.task.errorCode]:[])]:[];
  const notes=taskIssues.filter(code=>NOTE.test(code));
  const issues=[...new Set([...(revenuePending?['REVENUE_BREAKDOWN_NOT_VERIFIED']:[]),...taskIssues.filter(code=>!NOTE.test(code)),...(c.collection?.status==='succeeded'?[]:c.collection?.reasons??[]),...(!ready||c.publication.outdated?c.publication.reasons:[])])].filter(s=>s!=='PREPARING');
  const skipped=notes.filter(code=>!code.startsWith('UNSUPPORTED_SOURCE_FACTS:')).length,unsupported=notes.filter(code=>code.startsWith('UNSUPPORTED_SOURCE_FACTS:')).reduce((n,code)=>n+Number(code.split(':')[1]??0),0);
  const [open,setOpen]=useState(focused),body=useRef<HTMLTableSectionElement>(null);
  useEffect(()=>{if(!focused)return;body.current?.scrollIntoView({block:'start'});onFocused();},[focused,onFocused]);
  const problems=groupIssues(issues);
  const runs=FEATURES.flatMap(feature=>(c.features[feature].progress??[]).map((run,_,all)=>({feature,run,count:all.length})));
  return <tbody ref={body} data-open={open||undefined}>
    <tr className="bm-admin-row" aria-label={`${c.ticker} 数据准备`}>
      <td><div className="bm-admin-company-cell"><button className="bm-admin-toggle" aria-expanded={open} aria-label={`${c.ticker} 详情`} onClick={()=>setOpen(o=>!o)}><ChevronRight size={15}/></button><CompanyLogo symbol={c.ticker}/><span className="bm-admin-name"><strong className="ra-mono">{c.ticker}</strong>{c.name&&c.name!==c.ticker&&<small>{c.name}</small>}</span></div></td>
      <LayerSwitches ticker={c.ticker} layers={{...layers,...Object.fromEntries(FEATURES.map(f=>[f,c.features[f].on]))} as Record<Layer,boolean>} failed={f=>!!c.features[f].failure} title={f=>c.layerStatuses?.[f].label} disabled={busy} onMap={onToggle} onFeature={onFeature}/>
      <td className="bm-admin-feature-col"><button className="bm-switch" role="switch" aria-checked={c.stageEnabled} aria-label={`${c.ticker} 提问`} title={stagePaused?'提问已全局暂停':c.stageEnabled?'提问入口已开启':'提问入口已关闭'} disabled={busy||!c.dataEnabled} onClick={()=>onStage(!c.stageEnabled)}><span/></button></td>
      <td className="bm-admin-feature-col"><button className="bm-switch" role="switch" aria-checked={c.scheduledAnalysis} aria-label={`${c.ticker} 定时分析`} title={c.scheduledAnalysis?'定时分析已开启':'定时分析已暂停'} onClick={()=>onScheduled(!c.scheduledAnalysis)}><span/></button></td>
      <td><div className="bm-admin-actions"><button className="fm-button" disabled={busy||running||!c.dataEnabled} onClick={onPrepare}>{running?'准备中':'重新准备'}</button></div></td>
    </tr>
    {open&&<tr className="bm-admin-detail"><td colSpan={LAYERS.length+4}><div className="bm-detail">
      <CompanyUsage ticker={c.ticker} onUnauthorized={onUnauthorized} rows={LAYERS.map(layer => ({ layer, label: LAYER_LABEL[layer], state: c.layerStatuses?.[layer] }))}/>
      {(running&&c.task||runs.length>0)&&<div className="bm-progress" role="list" aria-label="进行中">
        {running&&c.task&&<TaskProgress task={c.task}/>}
        {runs.map(({feature,run,count})=><RunProgress key={`${run.kind}:${run.startedAt}`} run={run} name={count>1||RUN_LABEL[run.kind]!==FEATURE_LABEL[feature]?`${FEATURE_LABEL[feature]} · ${RUN_LABEL[run.kind]}`:FEATURE_LABEL[feature]}/>)}
      </div>}
      <header className="bm-detail-head">
        <div><span>可展示期间</span>{ready&&c.publication.periods.length?<ul className="bm-chips">{c.publication.periods.map(p=><li key={p}>{p}</li>)}</ul>:<em>—</em>}</div>
        {c.task&&!running&&<div><span>最近任务</span><em>{stages[c.task.stage]??c.task.stage}{taskStatus[c.task.status]?` · ${taskStatus[c.task.status]}`:''} · {financialDate(c.task.updatedAt)}</em></div>}
      </header>
      <div className="bm-rows" role="list" aria-label="生成状态与数据">
        <section role="listitem" className="bm-col"><h4>营收构成</h4><div>
          {c.publication.revenueCoverage?.length?<dl data-kind="periods">{c.publication.revenueCoverage.map(q=><div key={q.period} data-status={q.status}><dt>{q.period}</dt><dd>{coverage(q)}</dd></div>)}</dl>:<p className="bm-empty">无</p>}</div></section>
        <section role="listitem" className="bm-col"><h4>采集</h4><div>
          {running&&c.task&&<Meter label={stages[c.task.stage]??c.task.stage} completed={c.task.progress.completed} total={c.task.progress.total}/>}
          {!!c.collection?.total&&<Meter label="最新财报扫描" completed={c.collection.completed} total={c.collection.total} done={c.collection.status==='succeeded'}/>}
          {c.history&&<Meter label="历史披露扫描" completed={c.history.completed} total={c.history.total}/>}
          {!running&&!c.collection?.total&&!c.history&&<p className="bm-empty">无采集记录</p>}
          {(skipped>0||unsupported>0)&&<p className="bm-empty">{[skipped?`${skipped} 份文件无可提取的季度`:'',unsupported?`${unsupported} 项事实格式未读取`:''].filter(Boolean).join(' · ')}</p>}</div></section>
        <section role="listitem" className="bm-col"><h4>税前至净利润</h4><div>
          {c.presentation?.source?<>
            <span className="ra-badge" data-status={c.presentation.source==='degraded'?'caution':'reviewed'}>{presentationSource[c.presentation.source]}</span>
            {c.presentation.afterTax.length>0&&<dl>{c.presentation.afterTax.map(a=><div key={a.name}><dt>{a.name}</dt><dd className="ra-mono">{Number(a.value).toLocaleString('en-US')}</dd></div>)}</dl>}
            {c.presentation.basisChanges.length>0&&<p>重述项：{c.presentation.basisChanges.map(k=>lineName[k]??k).join('、')}</p>}
            {c.presentation.profile&&<p>模型判定：{c.presentation.profile.status==='verified'?'已核验':'未通过'} · {c.presentation.profile.attempts} 次{c.presentation.profile.issues.length>0&&<small>{c.presentation.profile.issues.slice(0,3).join('；')}</small>}</p>}
            {(c.presentation.source==='degraded'||c.presentation.profile)&&<button className="fm-button" disabled={busy} onClick={onJudge}>重新判定</button>}
          </>:<p className="bm-empty">暂无记录</p>}</div></section>
        <section role="listitem" className="bm-col" data-tone={problems.length?'caution':'ok'}><h4>{problems.length?<AlertTriangle size={13}/>:<CheckCircle2 size={13}/>}问题{problems.length?` · ${problems.length}`:''}</h4><div>
          {problems.length?<ul>{problems.map(p=><li key={p.code} title={p.code}>{p.label}{p.filings.length>0&&<small>{p.filings.length} 份文件 · {p.filings.join(', ')}</small>}</li>)}</ul>:<p className="bm-empty">无</p>}</div></section>
      </div>
      <CompanyReports ticker={c.ticker} onUnauthorized={onUnauthorized}/>
      <ValuationInputs ticker={c.ticker} onUnauthorized={onUnauthorized}/>
    </div></td></tr>}
  </tbody>;
}
