import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readSecDocumentBatch} from '../../workers/pipeline/src/financial-data/provider.ts';
import {extractDisclosedQuarters} from '../../workers/pipeline/src/financial-data/parser.ts';
import {checkCompleteFlow,newestPair} from '../../shared/analysis-runtime/financial-data/completeness.ts';
import type {Job} from '../../workers/pipeline/src/financial-data/store.ts';
const job:Job={id:'provider-test',cik:'0001341439',ticker:'ORCL',generation:1,lease:'test',cursor:'{}',attempt:1};
const q1=readFileSync(new URL('./fixtures/orcl-2026-q1-sec-xbrl.html',import.meta.url),'utf8');
const q4=readFileSync(new URL('./fixtures/orcl-2026-q4-sec-exhibit-tables.html',import.meta.url),'utf8');
test('actual ORCL disclosures dynamically parse through the data-only provider including the earnings exhibit',async()=>{
 const urls:string[]=[];const reader={read:async(url:string)=>{urls.push(url);if(url.includes('/submissions/'))return Response.json({cik:1341439,sic:'7372',filings:{recent:{form:['10-Q','8-K'],accessionNumber:['0001193125-26-389274','0001193125-26-265848'],primaryDocument:['orcl-20260831.htm','orcl-20260610.htm'],filingDate:['2026-09-11','2026-06-10'],reportDate:['2026-08-31','2026-05-31'],items:['','2.02']}}});if(url.endsWith('orcl-20260831.htm'))return new Response(q1);if(url.endsWith('orcl-ex99_1.htm'))return new Response(q4);return new Response('<a href="orcl-ex99_1.htm">Exhibit 99.1</a><a href="https://bad.example/ex99.htm">external</a>');}};
 const batch=await readSecDocumentBatch(job,reader,2);assert.equal(batch.finished,true);const flow=newestPair({schemaVersion:'business-flow.v1',ticker:'ORCL',fetchedAt:'2026-10-01',quarters:batch.quarters});assert.deepEqual(checkCompleteFlow(flow),{complete:true,reasons:[]});assert.equal(flow.quarters[0].figures.net!.value,'4760000000');assert.equal(flow.quarters[1].figures.net!.value,'4304000000');assert.equal(urls.length,4);assert.ok(urls.every(url=>new URL(url).hostname.endsWith('sec.gov')));
});
test('known issuer profile is not reused for another issuer and missing table format is explicit',()=>{
 const result=extractDisclosedQuarters(q4,{cik:'0000320193',url:'https://www.sec.gov/Archives/edgar/data/320193/test.htm',accession:'0000320193-26-000001',filedAt:'2026-10-01',industry:'standard'});assert.equal(result.quarters.length,0);assert.ok(result.issues.includes('NO_DIRECT_COMPARABLE_QUARTER'));
});

test('opt-in scheduled collection publishes to the real migrated database without accessing model credentials or workflows',async()=>{
 const {createAnalysisDatabase}=await import('./helpers/analysis-backend.ts');const {runDataOnlySweep}=await import('../../workers/pipeline/src/financial-data/queue.ts');const {readCompletePublicationForTicker}=await import('../../workers/pipeline/src/financial-data/publication.ts');const raw=await createAnalysisDatabase();
 const db={
  prepare(sql:string){
   return {bind(...args:unknown[]){
    const bound=raw.prepare(sql).bind(...args);
    return {first:bound.first.bind(bound),all:bound.all.bind(bound),run:async()=>{const r=await bound.run() as {changes:number};return {meta:{changes:Number(r.changes)}};}};
   }};
  },
  async batch(statements:Array<{run():Promise<unknown>}>){
   raw.raw.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());raw.raw.exec('COMMIT');return results;}catch(error){raw.raw.exec('ROLLBACK');throw error;}
  }
 } as unknown as D1Database;
 const calls:string[]=[];const fetcher:typeof fetch=async input=>{const url=String(input);calls.push(url);assert.ok(['www.sec.gov','data.sec.gov'].includes(new URL(url).hostname));if(url.endsWith('company_tickers_exchange.json'))return Response.json({fields:['cik','name','ticker','exchange'],data:[[1341439,'Oracle','ORCL','NYSE']]});if(url.includes('/submissions/'))return Response.json({cik:1341439,sic:'7372',filings:{recent:{form:['10-Q','8-K'],accessionNumber:['0001193125-26-389274','0001193125-26-265848'],primaryDocument:['orcl-20260831.htm','orcl-20260610.htm'],filingDate:['2026-09-11','2026-06-10'],reportDate:['2026-08-31','2026-05-31'],items:['','2.02']}}});if(url.endsWith('orcl-20260831.htm'))return new Response(q1);if(url.endsWith('orcl-ex99_1.htm'))return new Response(q4);if(url.endsWith('orcl-20260610.htm'))return new Response('<a href="orcl-ex99_1.htm">Exhibit 99.1</a>');throw new Error('Unexpected dependency');};
 const env={DB:db,SEC_USER_AGENT:'test-contact@example.org',SEC_DATA_TICKERS:'ORCL',SEC_DATA_COLLECTION_ENABLED:'true'};Object.defineProperty(env,'DEEPSEEK_API_KEY',{get(){throw new Error('Model key accessed');}});Object.defineProperty(env,'SEC_ANALYSIS_WORKFLOW',{get(){throw new Error('AI workflow accessed');}});
 try{const result=await runDataOnlySweep(env,fetcher);assert.equal(result.published,true);assert.equal(result.modelCalls,0);assert.equal(calls.length,5);const published=await readCompletePublicationForTicker(db,'ORCL');assert.equal(published.status,'ready');assert.equal(published.flow!.quarters.length,2);assert.equal(raw.raw.prepare('SELECT count(*) n FROM company_analysis_runs').get()!.n,0);}finally{raw.close();}
});
