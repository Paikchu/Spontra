import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {deriveFourthQuarters} from '../../workers/pipeline/src/financial-data/history.ts';
import type {Fact, DocumentSource} from '../../workers/pipeline/src/financial-data/parser.ts';

const q1=readFileSync(new URL('./fixtures/orcl-2026-q1-sec-xbrl.html',import.meta.url),'utf8');
const q4=readFileSync(new URL('./fixtures/orcl-2026-q4-sec-exhibit-tables.html',import.meta.url),'utf8');

test('idle data ticks collect quarterly revenue history from the same filings without touching the snapshot or models',async()=>{
 const {createAnalysisDatabase}=await import('./helpers/analysis-backend.ts');const {runDataOnlySweep}=await import('../../workers/pipeline/src/financial-data/queue.ts');const {readCompletePublicationForTicker}=await import('../../workers/pipeline/src/financial-data/publication.ts');const raw=await createAnalysisDatabase();
 const db={
  prepare(sql:string){return {bind(...args:unknown[]){const bound=raw.prepare(sql).bind(...args);return {first:bound.first.bind(bound),all:bound.all.bind(bound),run:async()=>{const r=await bound.run() as {changes:number};return {meta:{changes:Number(r.changes)}};}};}};},
  async batch(statements:Array<{run():Promise<unknown>}>){raw.raw.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());raw.raw.exec('COMMIT');return results;}catch(error){raw.raw.exec('ROLLBACK');throw error;}}
 } as unknown as D1Database;
 const fetcher:typeof fetch=async input=>{const url=String(input);assert.ok(['www.sec.gov','data.sec.gov'].includes(new URL(url).hostname));if(url.endsWith('company_tickers_exchange.json'))return Response.json({fields:['cik','name','ticker','exchange'],data:[[1341439,'Oracle','ORCL','NYSE']]});if(url.includes('/submissions/'))return Response.json({cik:1341439,sic:'7372',filings:{recent:{form:['10-Q','8-K'],accessionNumber:['0001193125-26-389274','0001193125-26-265848'],primaryDocument:['orcl-20260831.htm','orcl-20260610.htm'],filingDate:['2026-09-11','2026-06-10'],reportDate:['2026-08-31','2026-05-31'],items:['','2.02']}}});if(url.endsWith('orcl-20260831.htm'))return new Response(q1);if(url.endsWith('orcl-ex99_1.htm'))return new Response(q4);if(url.endsWith('orcl-20260610.htm'))return new Response('<a href="orcl-ex99_1.htm">Exhibit 99.1</a>');throw new Error('Unexpected dependency');};
 const env={DB:db,SEC_USER_AGENT:'test-contact@example.org',SEC_DATA_TICKERS:'ORCL',SEC_DATA_COLLECTION_ENABLED:'true'};Object.defineProperty(env,'DEEPSEEK_API_KEY',{get(){throw new Error('Model key accessed');}});
 try{
  assert.equal((await runDataOnlySweep(env,fetcher)).published,true);
  const pointer=raw.raw.prepare('SELECT version_id FROM financial_complete_current').get();
  const idle=await runDataOnlySweep(env,fetcher);
  assert.equal(idle.modelCalls,0);assert.equal(idle.published,false);assert.ok(idle.history&&'finished' in idle.history&&idle.history.finished);
  assert.deepEqual(raw.raw.prepare('SELECT version_id FROM financial_complete_current').get(),pointer);
  const publication=await readCompletePublicationForTicker(db,'ORCL');
  const history=publication.history!;assert.equal(history.schemaVersion,'revenue-history.v1');
  assert.deepEqual(history.quarters.map(q=>q.periodEnd),['2026-05-31','2026-08-31']);
  const stored=JSON.parse((raw.raw.prepare("SELECT payload FROM sec_cache WHERE cache_key='sec:revenue-history:v1:0001341439'").get() as {payload:string}).payload);
  assert.deepEqual(stored.quarters.map((q:{periodEnd:string})=>q.periodEnd),['2026-05-31','2026-08-31']);
  const latest=history.quarters.at(-1)!;assert.equal(latest.revenue,'19345000000');assert.equal(latest.basis,'reported');
  assert.ok(latest.segments.some(s=>s.id==='cloud'&&s.children?.length===2));
  assert.ok(history.quarters.every(q=>q.source.url.startsWith('https://www.sec.gov/')));
  const third=await runDataOnlySweep(env,fetcher);assert.equal(third.history,undefined);
 }finally{raw.close();}
});

test('fourth quarter is derived only as same-key full year minus nine months and is labelled as derived',()=>{
 const source:DocumentSource={url:'https://www.sec.gov/Archives/edgar/data/1/000000000126000001/a-10k.htm',accession:'0000000001-26-000001',filedAt:'2026-07-20',cik:'0000000001',industry:'standard'};
 const fact=(tag:string,start:string,end:string,value:number,member?:string):Fact=>({source,precision:-6,tag,value,currency:'USD',start,end,context:`${tag}-${start}-${end}-${member??''}`,dimensions:member?{'us-gaap:StatementBusinessSegmentsAxis':member}:{}});
 const facts=[fact('us-gaap:Revenues','2025-07-01','2026-06-30',400),fact('us-gaap:Revenues','2025-07-01','2026-03-31',290),
  fact('us-gaap:Revenues','2025-07-01','2026-06-30',250,'x:AMember'),fact('us-gaap:Revenues','2025-07-01','2026-03-31',180,'x:AMember'),
  fact('us-gaap:Revenues','2025-07-01','2026-06-30',150,'x:BMember'),fact('us-gaap:Revenues','2025-07-01','2026-03-31',110,'x:BMember')];
 const [q]=deriveFourthQuarters(facts,'0000000001');
 assert.equal(q.periodStart,'2026-04-01');assert.equal(q.periodEnd,'2026-06-30');assert.equal(q.revenue,'110');assert.equal(q.basis,'derived');assert.match(q.formula!,/全年累计 400 − 前九个月累计 290/);
 assert.deepEqual(q.segments.map(s=>[s.id,s.value]),[['x:AMember','70'],['x:BMember','40']]);
 assert.equal(deriveFourthQuarters(facts.filter(f=>!(f.end==='2026-03-31'&&Object.keys(f.dimensions).length===0)),'0000000001').length,0);
});
