import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createAnalysisDatabase} from './helpers/analysis-backend.ts';
import {runBusinessFlowBootstrap,refreshSecBusinessFlow,handleBusinessFlowRefresh} from '../../workers/pipeline/src/sec/business-flow-refresh.ts';
import {requestFinancialCollection} from '../../workers/pipeline/src/financial-data/requests.ts';
import {runDataOnlySweep,enqueueIssuer} from '../../workers/pipeline/src/financial-data/queue.ts';
import {financialPolicy} from '../../shared/analysis-runtime/financial-data/policy.ts';
import {FinancialMaintenanceStore} from '../../workers/pipeline/src/admin/financial-maintenance-store.ts';
import type {SecPipelineEnv} from '../../workers/pipeline/src/operations.ts';

const q1=readFileSync(new URL('./fixtures/orcl-2026-q1-sec-xbrl.html',import.meta.url),'utf8');
const q4=readFileSync(new URL('./fixtures/orcl-2026-q4-sec-exhibit-tables.html',import.meta.url),'utf8');
async function fixture(){
 const raw=await createAnalysisDatabase(),objects=new Map<string,string>(),calls:string[]=[];
 const db={prepare(sql:string){return {bind(...args:unknown[]){const s=raw.prepare(sql).bind(...args);return {first:s.first.bind(s),all:s.all.bind(s),run:async()=>{const r=await s.run() as {changes:number};return {meta:{changes:Number(r.changes)}};}};}};},
  async batch(statements:Array<{run():Promise<unknown>}>){raw.raw.exec('BEGIN');try{const r=[];for(const s of statements)r.push(await s.run());raw.raw.exec('COMMIT');return r;}catch(e){raw.raw.exec('ROLLBACK');throw e;}}
 } as unknown as D1Database;
 const env={DB:db,SEC_USER_AGENT:'fixture@example.test',SEC_DATA_TICKERS:'ORCL,ORCL.A',SEC_DATA_COLLECTION_ENABLED:'true',SEC_BUSINESS_FLOW_BOOTSTRAP_TICKERS:'ORCL',SEC_REFRESH_KEY:'test-refresh',
  SEC_FILINGS:{async get(key:string){const value=objects.get(key);return value===undefined?null:{async text(){return value;}};},async put(key:string,value:string){objects.set(key,value);}}
 } as unknown as SecPipelineEnv;
 for(const name of ['DEEPSEEK_API_KEY','SEC_ANALYSIS_WORKFLOW'])Object.defineProperty(env,name,{enumerable:true,get(){throw new Error('Model dependency accessed');}});
 const fetcher:typeof fetch=async input=>{
  const url=String(input);calls.push(url);
  if(url.endsWith('company_tickers_exchange.json'))return Response.json({fields:['cik','name','ticker'],data:[[1341439,'Oracle','ORCL'],[1341439,'Oracle alias fixture','ORCL.A']]});
  if(url.includes('/submissions/'))return Response.json({cik:1341439,sic:'7372',filings:{recent:{form:['10-Q','8-K'],accessionNumber:['0001193125-26-389274','0001193125-26-265848'],primaryDocument:['orcl-20260831.htm','orcl-20260610.htm'],filingDate:['2026-09-11','2026-06-10'],reportDate:['2026-08-31','2026-05-31'],items:['','2.02']}}});
  if(url.endsWith('orcl-20260831.htm'))return new Response(q1);
  if(url.endsWith('orcl-ex99_1.htm'))return new Response(q4);
  if(url.endsWith('orcl-20260610.htm'))return new Response('<a href="orcl-ex99_1.htm">Exhibit 99.1</a>');
  throw new Error('Unexpected source');
 };
 return {raw,db,env,objects,calls,fetcher};
}

test('legacy bootstrap feeds canonical snapshots, disclosure archives and history without writing the legacy cache',async()=>{
 const f=await fixture();
 try{
  await f.db.prepare('INSERT INTO sec_cache(cache_key,payload,fetched_at) VALUES(?,?,?)').bind('sec:business-flow:v2:ORCL','{"legacy":"unchanged"}','2000-01-01').run();
  const queued=await runBusinessFlowBootstrap(f.env,f.fetcher);
  assert.equal((queued.results[0] as {status:string}).status,'queued');
  assert.ok(f.calls.every(url=>url.endsWith('company_tickers_exchange.json')),'producer does not parse reports');
  // Use one configured consumer ticker; the alias is tested independently below.
  const dataEnv={DB:f.db,SEC_USER_AGENT:f.env.SEC_USER_AGENT,SEC_DATA_TICKERS:'ORCL',SEC_DATA_COLLECTION_ENABLED:'true',SEC_FILINGS:f.env.SEC_FILINGS};
  assert.equal((await runDataOnlySweep(dataEnv,f.fetcher)).published,true);
  const pointer=f.raw.raw.prepare('SELECT * FROM financial_complete_current').get();assert.ok(pointer);
  assert.ok(f.objects.size>=6);assert.ok(f.raw.raw.prepare("SELECT count(*) n FROM sec_cache WHERE cache_key LIKE 'sec:disclosure-audit:v1:ORCL:%'").get()!.n as number>=3);
  const idle=await runDataOnlySweep(dataEnv,f.fetcher);assert.equal(idle.modelCalls,0);assert.ok(idle.history);
  const history=JSON.parse(f.raw.raw.prepare("SELECT payload FROM sec_cache WHERE cache_key='sec:revenue-history:v1:0001341439'").get()!.payload as string);
  assert.equal(history.quarters.filter((q:{periodEnd:string})=>q.periodEnd>='2024-11-30').length,8);
  const reads=f.calls.length;assert.equal((await runBusinessFlowBootstrap(f.env,f.fetcher)).results.length,1);assert.equal(f.calls.length,reads,'fresh canonical job suppresses old cron refetch');
  await refreshSecBusinessFlow(f.env,'ORCL',f.fetcher);
  const failed=await runDataOnlySweep(dataEnv,async()=>{throw new Error('SEC temporary failure');});
  assert.deepEqual(failed.reasons,['SOURCE_TEMPORARILY_UNAVAILABLE']);assert.deepEqual(f.raw.raw.prepare('SELECT * FROM financial_complete_current').get(),pointer);
  assert.equal(f.raw.raw.prepare("SELECT payload FROM sec_cache WHERE cache_key='sec:business-flow:v2:ORCL'").get()!.payload,'{"legacy":"unchanged"}');
  assert.equal(f.raw.raw.prepare('SELECT count(*) n FROM company_analysis_runs').get()!.n,0);
 }finally{f.raw.close();}
});

test('legacy cron, manual producers and the normal enqueue deduplicate concurrent issuer work',async()=>{
 const f=await fixture();
 try{
  const results=await Promise.all([runBusinessFlowBootstrap(f.env,f.fetcher),refreshSecBusinessFlow(f.env,'ORCL',f.fetcher),refreshSecBusinessFlow(f.env,'ORCL.A',f.fetcher)]);
  assert.equal(f.raw.raw.prepare('SELECT count(*) n FROM financial_collection_jobs').get()!.n,1);
  const ids=[(results[0].results[0] as {jobId:string}).jobId,results[1].jobId,results[2].jobId];assert.equal(new Set(ids).size,1);
  const id=await enqueueIssuer(f.db,{cik:'0001341439',tickers:['ORCL'],name:'Oracle',industry:'unknown'},financialPolicy({SEC_DATA_TICKERS:'ORCL'}),Date.now()+1);
  assert.equal(id,ids[0]);assert.equal(f.raw.raw.prepare('SELECT count(*) n FROM financial_collection_jobs').get()!.n,1);
 }finally{f.raw.close();}
});

test('legacy producers honor maintenance ownership and scheduled failure cooldown',async()=>{
 const f=await fixture();
 try{
  const store=new FinancialMaintenanceStore(f.db),id=crypto.randomUUID();await store.create({requestId:id,ticker:'ORCL.A',action:'extract'},new Date());
  await f.db.prepare('UPDATE financial_maintenance_tasks SET cik=? WHERE task_id=?').bind('0001341439',id).run();
  assert.equal((await requestFinancialCollection({DB:f.db,SEC_USER_AGENT:f.env.SEC_USER_AGENT,SEC_DATA_TICKERS:'ORCL'},'ORCL',{fetcher:f.fetcher})).status,'maintenance');
  assert.equal(f.raw.raw.prepare('SELECT count(*) n FROM financial_collection_jobs').get()!.n,0);
  await store.cancel(id,new Date());await runBusinessFlowBootstrap(f.env,f.fetcher);
  await f.db.prepare("UPDATE financial_collection_jobs SET status='unavailable',updated_at=?").bind(new Date().toISOString()).run();
  assert.equal(((await runBusinessFlowBootstrap(f.env,f.fetcher)).results[0] as {status:string}).status,'fresh');
  assert.equal(f.raw.raw.prepare('SELECT count(*) n FROM financial_collection_jobs').get()!.n,1);
 }finally{f.raw.close();}
});

test('legacy HTTP queue entry retains authorization and reports a paused consumer',async()=>{
 const env={SEC_REFRESH_KEY:'test',SEC_DATA_TICKERS:'ORCL',SEC_DATA_COLLECTION_ENABLED:'false'} as SecPipelineEnv;
 const req=(ticker:string,key?:string)=>new Request('https://pipeline.test/sec-financials/refresh/'+ticker,{method:'POST',headers:key?{'x-sec-refresh-key':key}:{}});
 assert.equal((await handleBusinessFlowRefresh(req('ORCL'),env)).status,401);
 assert.equal((await handleBusinessFlowRefresh(req('AAPL','test'),env)).status,403);
 assert.equal((await handleBusinessFlowRefresh(req('ORCL','test'),env)).status,409);
 assert.deepEqual(await runBusinessFlowBootstrap(env),{results:[]});
});
