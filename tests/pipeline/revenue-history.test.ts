import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {deriveFourthQuarters, historyKey, readRevenueHistory, runHistoryStep} from '../../workers/pipeline/src/financial-data/history.ts';
import type {Fact, DocumentSource} from '../../workers/pipeline/src/financial-data/parser.ts';
import {extractRevenueHistory, parseOracleOfferingsHistory} from '../../workers/pipeline/src/financial-data/revenue-parser.ts';
import {mergeHistory, readHistory, validHistoryQuarter} from '../../shared/analysis-runtime/financial-data/history.ts';
import {D1SecRepository} from '../../workers/pipeline/src/sec/d1.ts';

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
  assert.deepEqual(history.quarters.map(q=>q.periodEnd),['2024-11-30','2025-02-28','2025-05-31','2025-08-31','2025-11-30','2026-02-28','2026-05-31','2026-08-31']);
  const stored=JSON.parse((raw.raw.prepare("SELECT payload FROM sec_cache WHERE cache_key='sec:revenue-history:v1:0001341439'").get() as {payload:string}).payload);
  assert.deepEqual(stored.quarters.map((q:{periodEnd:string})=>q.periodEnd),['2024-08-31','2024-11-30','2025-02-28','2025-05-31','2025-08-31','2025-11-30','2026-02-28','2026-05-31','2026-08-31']);
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
 // Matching concept and dimensions cannot prove that another filing did not recast the prior period.
 const crossFiling=facts.map(f=>f.end==='2026-03-31'?{...f,source:{...f.source,accession:'0000000001-26-000002'}}:f);
 assert.equal(deriveFourthQuarters(crossFiling,'0000000001').length,0);
 const conflicted=[...facts,{...facts[1],value:295}];
 assert.equal(deriveFourthQuarters(conflicted,'0000000001').length,0);
});

const releaseSource={url:'https://www.sec.gov/Archives/edgar/data/1341439/000119312526265848/orcl-ex99_1.htm',accession:'0001193125-26-265848',filedAt:'2026-06-10',form:'8-K'};

test('all eight explicitly labelled GAAP offerings columns are direct quarters with per-cell lineage, never annual totals',()=>{
 const quarters=parseOracleOfferingsHistory(q4,releaseSource);
 assert.deepEqual(quarters.map(q=>[q.periodEnd,Number(q.revenue)/1e6]),[['2024-08-31',13307],['2024-11-30',14059],['2025-02-28',14130],['2025-05-31',15903],['2025-08-31',14926],['2025-11-30',16058],['2026-02-28',17190],['2026-05-31',19184]]);
 for(const q of quarters){
  assert.equal(q.basis,'reported');assert.equal(q.segments.length,4);assert.equal(q.segments[0].children?.length,2);assert.equal(q.segments[1].children?.length,2);
  assert.equal(q.segments.reduce((sum,s)=>sum+Number(s.value),0),Number(q.revenue));
  assert.ok(q.lineage?.every(l=>l.periodEnd===q.periodEnd&&l.contextId.includes(':Q')&&!l.contextId.includes('TOTAL')));
 }
 assert.equal(quarters[1].segments[0].value,'5937000000');
 assert.equal(quarters[1].segments[0].children![0].value,'3503000000');
});

test('offerings parser requires a verified fiscal year-end, units and unambiguous quarter columns',()=>{
 assert.deepEqual(parseOracleOfferingsHistory(q4.replaceAll('Year Ended May 31,','Period Ended May 31,'),releaseSource),[]);
 assert.deepEqual(parseOracleOfferingsHistory(q4.replaceAll('$ in millions','$ unspecified'),releaseSource),[]);
 assert.deepEqual(parseOracleOfferingsHistory(q4.replaceAll('>Q2<','>Q1<'),releaseSource),[]);
 // Explicit unavailable data leaves only that quarter unavailable; the next column is not shifted.
 const missing=q4.replace('>5,623<','>—<');
 const parsed=parseOracleOfferingsHistory(missing,releaseSource);
 assert.ok(!parsed.some(q=>q.periodEnd==='2024-08-31'));
 assert.equal(parsed.find(q=>q.periodEnd==='2024-11-30')?.segments[0].value,'5937000000');
});

test('revenue projection survives unrelated missing income-statement expenses and keeps comparative periods',()=>{
 const source:DocumentSource={...releaseSource,cik:'0001341439',industry:'standard'};
 const withoutExpenses=q1.replaceAll('name="orcl:CloudAndSoftwareExpenses"','name="orcl:UnmappedExpense"');
 assert.notEqual(withoutExpenses,q1);
 const extracted=extractRevenueHistory(withoutExpenses,source,'10-Q');
 const latest=extracted.quarters.find(q=>q.periodEnd==='2026-08-31')!;
 assert.equal(latest.revenue,'19345000000');assert.equal(latest.segments.length,4);assert.equal(latest.segments[0].children?.length,2);
});

test('an equal-revenue total fallback cannot overwrite a detailed historical disclosure',()=>{
 const detailed=parseOracleOfferingsHistory(q4,releaseSource)[0];
 const total={...detailed,segments:[{id:'whole-company',name:'公司',value:detailed.revenue}],source:{...detailed.source,filedAt:'2026-09-11'}};
 assert.equal(mergeHistory('ORCL',[detailed],[total],'now').quarters[0].segments.length,4);
 // A newly reported changed total is evidence of a change; do not keep the old split against it.
 const changed={...total,revenue:String(Number(total.revenue)+1000000),segments:[{...total.segments[0],value:String(Number(total.revenue)+1000000)}]};
 assert.equal(mergeHistory('ORCL',[detailed],[changed],'now').quarters[0].revenue,changed.revenue);
 const lessDetail={...detailed,segments:detailed.segments.map(({children,...s})=>s)};
 assert.equal(mergeHistory('ORCL',[detailed],[lessDetail],'now').quarters[0].segments[0].children?.length,2);
 const reportedZero={...detailed,segments:[...detailed.segments,{id:'new-business',name:'已披露零收入',value:'0'}]};
 assert.equal(validHistoryQuarter(reportedZero),true);
 assert.equal(validHistoryQuarter({...reportedZero,segments:[...detailed.segments,{id:'new-business',name:'未知',value:''}]}),false);
});

test('generic revenue history is independent from conflicting net-income facts',()=>{
 const context=(id:string,member?:string)=>`<xbrli:context id="${id}"><xbrli:entity><xbrli:identifier>1</xbrli:identifier>${member?`<xbrli:segment><xbrldi:explicitMember dimension="us-gaap:StatementBusinessSegmentsAxis">x:${member}Member</xbrldi:explicitMember></xbrli:segment>`:''}</xbrli:entity><xbrli:period><xbrli:startDate>2026-01-01</xbrli:startDate><xbrli:endDate>2026-03-31</xbrli:endDate></xbrli:period></xbrli:context>`;
 const fact=(tag:string,context:string,value:number)=>`<ix:nonFraction name="us-gaap:${tag}" contextRef="${context}" unitRef="USD" decimals="0">${value}</ix:nonFraction>`;
 const html=context('all')+context('a','A')+context('b','B')+'<xbrli:unit id="USD"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>'+fact('Revenues','all',100)+fact('Revenues','a',60)+fact('Revenues','b',40)+fact('NetIncomeLoss','all',10)+fact('NetIncomeLoss','all',20);
 const parsed=extractRevenueHistory(html,{...releaseSource,cik:'0000000001',industry:'standard'},'10-Q');
 assert.equal(parsed.quarters.length,1);assert.equal(parsed.quarters[0].revenue,'100');
 assert.deepEqual(parsed.quarters[0].segments.map(s=>s.value),['60','40']);
});

async function historyRetryFixture(failure: 'source' | 'archive', initialFailures: number) {
 const {createAnalysisDatabase}=await import('./helpers/analysis-backend.ts');
 const raw=await createAnalysisDatabase(), db=raw as unknown as D1Database;
 const target={ticker:'ORCL',cik:'0001341439'}, now=new Date('2026-10-04T00:00:00Z');
 const cursorKey='sec:revenue-history-cursor:v1:0001341439', historyKey='sec:revenue-history:v1:0001341439';
 const failedAccession='0001193125-26-265848';
 const reads={latest:0,previous:0}, archives={latest:0,previous:0};
 let failures=initialFailures;
 const previous=q1.replaceAll('2026-08-31','2026-05-31').replaceAll('2026-06-01','2026-03-01');
 const reader={
  async read(url:string) {
   if(url.includes('/submissions/'))return Response.json({cik:1341439,sic:'7372',filings:{recent:{form:['10-Q','10-Q'],accessionNumber:['0001193125-26-389274',failedAccession],primaryDocument:['latest.htm','previous.htm'],filingDate:['2026-09-11','2026-06-10'],reportDate:['2026-08-31','2026-05-31']}}});
   if(url.endsWith('/latest.htm')){reads.latest++;return new Response(q1);}
   assert.ok(url.endsWith('/previous.htm'));reads.previous++;
   if(failure==='source'&&failures-->0)throw new Error('SEC_SOURCE_UNAVAILABLE');
   return new Response(previous);
  },
  async archive(source:DocumentSource) {
   if(source.accession!==failedAccession){archives.latest++;return;}
   archives.previous++;
   if(failure==='archive'&&failures-->0)throw new Error('R2_TEMPORARILY_UNAVAILABLE');
  },
 };
 const cache=(key:string)=>JSON.parse((raw.raw.prepare('SELECT payload FROM sec_cache WHERE cache_key=?').get(key) as {payload:string}).payload);
 return {raw,db,target,now,reader,reads,archives,failedAccession,cursorKey,historyKey,cache,restore(){failures=0;}};
}

for(const failure of ['source','archive'] as const)test(`history checkpoints a temporary ${failure} failure and clears it after retry without losing successful quarters`,async()=>{
 const f=await historyRetryFixture(failure,1);
 try{
  const first=await runHistoryStep(f.db,f.reader,f.target,f.now);
  assert.equal(first.documents,2);assert.equal(first.finished,false);assert.equal(first.partial,false);
  assert.deepEqual(first.retry,{accession:f.failedAccession,attempts:1,remaining:2});
  assert.equal(first.quarters,1);assert.equal(f.cache(f.cursorKey).index,1);assert.equal(f.cache(f.cursorKey).finishedAt,undefined);
  const saved=f.cache(f.historyKey).quarters[0];assert.equal(saved.periodEnd,'2026-08-31');
  const second=await runHistoryStep(f.db,f.reader,f.target,f.now);
  assert.equal(second.documents,1);assert.equal(second.finished,true);assert.equal(second.partial,false);assert.equal(second.retry,undefined);
  assert.deepEqual(second.issues,[]);assert.deepEqual(second.resolvedIssues,[`${f.failedAccession}:SOURCE_TEMPORARILY_UNAVAILABLE`]);
  assert.equal(f.reads.latest,1);assert.equal(f.archives.latest,1);assert.equal(f.reads.previous,2);
  assert.deepEqual(f.cache(f.cursorKey).attempts,{});assert.deepEqual(f.cache(f.cursorKey).issues,[]);
  assert.equal(second.quarters,2);assert.deepEqual(f.cache(f.historyKey).quarters.find((q:{periodEnd:string})=>q.periodEnd===saved.periodEnd),saved);
 }finally{f.raw.close();}
});

test('history caps permanent source failures at three attempts, reports partial and allows a fresh manual scan',async()=>{
 const f=await historyRetryFixture('source',100);
 try{
  for(let attempt=1;attempt<=2;attempt++){
   const result=await runHistoryStep(f.db,f.reader,f.target,f.now);
   assert.equal(result.finished,false);assert.equal(result.retry?.attempts,attempt);assert.equal(f.cache(f.cursorKey).index,1);
  }
  const exhausted=await runHistoryStep(f.db,f.reader,f.target,f.now);
  assert.equal(exhausted.finished,true);assert.equal(exhausted.partial,true);assert.equal(exhausted.quarters,1);assert.equal(exhausted.retry,undefined);
  assert.deepEqual(exhausted.issues,[`${f.failedAccession}:SOURCE_RETRY_EXHAUSTED`]);
  assert.deepEqual(exhausted.resolvedIssues,[`${f.failedAccession}:SOURCE_TEMPORARILY_UNAVAILABLE`]);
  assert.equal(f.cache(f.cursorKey).attempts[f.failedAccession],3);assert.equal(f.cache(f.cursorKey).partial,true);
  assert.equal(f.reads.previous,3);assert.equal(f.reads.latest,1);
  const idle=await runHistoryStep(f.db,f.reader,f.target,f.now);
  assert.equal(idle.documents,0);assert.equal(idle.partial,true);assert.equal(f.reads.previous,3);
  // Admin's explicit rescan clears only this cursor; the already successful quarter stays available.
  await f.db.prepare('DELETE FROM sec_cache WHERE cache_key=?').bind(f.cursorKey).run();
  assert.equal(f.cache(f.historyKey).quarters.length,1);f.restore();
  const recovered=await runHistoryStep(f.db,f.reader,f.target,f.now);
  assert.equal(recovered.finished,true);assert.equal(recovered.partial,false);assert.equal(recovered.quarters,2);assert.deepEqual(recovered.issues,[]);
  assert.equal(f.reads.previous,4);
 }finally{f.raw.close();}
});

const aliasHistory = () => ({schemaVersion:'revenue-history.v1' as const,ticker:'GOOG',updatedAt:'2026-07-21T00:00:00Z',quarters:[{
 periodStart:'2026-04-01',periodEnd:'2026-06-30',currency:'USD',scale:1,revenue:'100',basis:'reported' as const,
 segments:[{id:'a',name:'A',value:'60'},{id:'b',name:'B',value:'40'}],
 source:{accession:'0001652044-26-000001',url:'https://www.sec.gov/Archives/edgar/data/1652044/000165204426000001/goog.htm',filedAt:'2026-07-21',form:'10-Q'},
}]});

test('same-CIK aliases retain last good quarters through retries and both read the completed history',async()=>{
 const {createAnalysisDatabase}=await import('./helpers/analysis-backend.ts');const raw=await createAnalysisDatabase(),db=raw as unknown as D1Database;
 const repository=new D1SecRepository(db),cik='0001652044',original=aliasHistory();
 await repository.setCache(historyKey(cik),original,original.updatedAt);
 let unavailable=true;
 const reader={async read(url:string){
  if(url.includes('/submissions/'))return Response.json({cik:1652044,sic:'7370',filings:{recent:{form:['10-Q'],accessionNumber:['0001652044-26-000002'],primaryDocument:['latest.htm'],filingDate:['2026-10-01'],reportDate:['2026-09-30']}}});
  if(unavailable)throw new Error('SEC_SOURCE_UNAVAILABLE');
  return new Response('<xbrli:context id="q"><xbrli:entity><xbrli:identifier>1652044</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:startDate>2026-07-01</xbrli:startDate><xbrli:endDate>2026-09-30</xbrli:endDate></xbrli:period></xbrli:context><xbrli:unit id="USD"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit><ix:nonFraction name="us-gaap:Revenues" contextRef="q" unitRef="USD" decimals="0">120</ix:nonFraction>');
 }};
 try{
  const first=await runHistoryStep(db,reader,{ticker:'GOOGL',cik},new Date('2026-10-04'));
  assert.equal(first.finished,false);assert.equal(first.quarters,1);
  for(const ticker of ['GOOG','GOOGL']){const projected=await readRevenueHistory(db,cik,ticker);assert.equal(projected?.ticker,ticker);assert.deepEqual(projected?.quarters,original.quarters);}
  const interim=(await repository.getCache(historyKey(cik)))!.payload;
  assert.equal(readHistory(interim,'GOOG'),null); // The global reader still rejects a mismatched ticker.
  unavailable=false;
  const finished=await runHistoryStep(db,reader,{ticker:'GOOGL',cik},new Date('2026-10-04'));
  assert.equal(finished.finished,true);assert.equal(finished.quarters,2);
  for(const ticker of ['GOOG','GOOGL']){const projected=await readRevenueHistory(db,cik,ticker);assert.equal(projected?.ticker,ticker);assert.equal(projected?.quarters.length,2);assert.deepEqual(projected?.quarters[0],original.quarters[0]);assert.equal(projected?.quarters[1].revenue,'120');}
 }finally{raw.close();}
});

test('issuer-scoped history refuses wrong-CIK sources, mixed provenance and unverified submissions',async()=>{
 const {createAnalysisDatabase}=await import('./helpers/analysis-backend.ts');const raw=await createAnalysisDatabase(),db=raw as unknown as D1Database;
 const repository=new D1SecRepository(db),cik='0001652044',original=aliasHistory();
 try{
  const wrong={...original,quarters:original.quarters.map(q=>({...q,source:{...q.source,url:q.source.url.replace('/1652044/','/1341439/')}}))};
  await repository.setCache(historyKey(cik),wrong,wrong.updatedAt);
  assert.equal(await readRevenueHistory(db,cik,'GOOG'),null);assert.equal(await readRevenueHistory(db,cik,'GOOGL'),null);
  const emptyReader={async read(){return Response.json({cik:1652044,filings:{recent:{form:[],accessionNumber:[],primaryDocument:[],filingDate:[],reportDate:[]}}});}};
  assert.equal((await runHistoryStep(db,emptyReader,{ticker:'GOOGL',cik},new Date('2026-10-04'))).quarters,0);
  const mixed={...original,quarters:original.quarters.map(q=>({...q,lineage:[{accession:q.source.accession,url:wrong.quarters[0].source.url,concept:'us-gaap:Revenues',contextId:'q',periodStart:q.periodStart,periodEnd:q.periodEnd,dimensions:{},parserVersion:'test'}]}))};
  await repository.setCache(historyKey(cik),mixed,mixed.updatedAt);assert.equal(await readRevenueHistory(db,cik,'GOOGL'),null);
  await repository.setCache(historyKey(cik),original,original.updatedAt);
  // Switching aliases revalidates the SEC listing before it may merge/relabel the CIK cache.
  const mismatch={async read(){return Response.json({cik:1341439});}};
  await assert.rejects(runHistoryStep(db,mismatch,{ticker:'GOOG',cik},new Date('2026-10-04')),/Issuer identity mismatch/);
  assert.equal((await repository.getCache<{ticker:string}>(historyKey(cik)))?.payload.ticker,'GOOG');
  assert.equal(await readRevenueHistory(db,'1652044','GOOG'),null);
 }finally{raw.close();}
});
