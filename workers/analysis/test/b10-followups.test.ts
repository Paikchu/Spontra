import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {mergeHistory,validHistoryQuarter,historyQuarterFrom} from '../../../shared/analysis-runtime/financial-data/history.ts';
import {extractDisclosedQuarters,readReportedFacts,hasSingleReportableSegment,type DocumentSource} from '../src/financial-data/parser.ts';
import {extractRevenueHistory} from '../src/financial-data/revenue-parser.ts';
import {historyKey,readRevenueHistory,rereadHistoryFiling} from '../src/financial-data/history.ts';
import {republishStoredFinancials,rebuildPublication} from '../src/financial-data/republish.ts';
import {getSecFundamentals} from '../src/fundamentals/sec-fundamentals.ts';
import {readCompletePublicationForTicker} from '../src/financial-data/publication.ts';
import {FinancialMaintenanceStore,MAINTENANCE_LEASE_MS} from '../src/admin/financial-maintenance-store.ts';
import {runFinancialMaintenanceTick,type MaintenanceDependencies} from '../src/admin/financial-maintenance-runner.ts';
import {archiveFilingDisclosures} from '../src/financial-data/disclosure-audit.ts';
import {checkCompleteFlow} from '../../../shared/analysis-runtime/financial-data/completeness.ts';
import type {RevenueHistoryQuarter} from '../../../shared/analysis-contract/revenue-history.ts';
import type {AnalysisEnv} from '../src/operations.ts';
import type {SecReader} from '../src/financial-data/provider.ts';

// All writes in these tests target an ephemeral in-memory SQLite adapter, never Cloudflare D1.
function database():D1Database {
 const sqlite=new DatabaseSync(':memory:');
 for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8').replace(/--> statement-breakpoint/g,''));
 const stmt=(sql:string,args:unknown[]=[])=>({bind:(...v:unknown[])=>stmt(sql,v),
  first:async()=>sqlite.prepare(sql).get(...args as never[])??null,
  all:async()=>({results:sqlite.prepare(sql).all(...args as never[])}),
  run:async()=>({success:true,meta:{changes:Number(sqlite.prepare(sql).run(...args as never[]).changes)}})});
 return {prepare:stmt,batch:async(items:Array<{run():Promise<unknown>}>)=>{sqlite.exec('BEGIN');try{const results=[];for(const item of items)results.push(await item.run());sqlite.exec('COMMIT');return results;}catch(e){sqlite.exec('ROLLBACK');throw e;}}} as unknown as D1Database;
}
const source:DocumentSource={cik:'0000000001',accession:'0000000001-26-000001',filedAt:'2026-02-01',url:'https://www.sec.gov/Archives/edgar/data/1/000000000126000001/report.htm',industry:'standard'};
const releaseAcc='0000000001-26-000002', releaseUrl='https://www.sec.gov/Archives/edgar/data/1/000000000126000002/ex99.htm';
const q4:RevenueHistoryQuarter={periodStart:'2025-10-01',periodEnd:'2025-12-31',fiscalQuarter:4,currency:'USD',scale:1e6,revenue:'300',basis:'derived',formula:'FY 1000 − 9M 700',source:{...source,form:'10-K'},
 lineage:[{accession:source.accession,url:source.url,concept:'us-gaap:Revenues',contextId:'FY',periodStart:'2025-01-01',periodEnd:'2025-12-31',dimensions:{},parserVersion:'test'}],
 segments:['North','South'].map((name,i)=>({id:name,name,value:String(i?100:200),basis:'derived',formula:'FY − 9M',lineage:[{accession:source.accession,url:source.url,concept:'us-gaap:Revenues',contextId:name,periodStart:'2025-01-01',periodEnd:'2025-12-31',dimensions:{'us-gaap:StatementBusinessSegmentsAxis':`test:${name}Member`},parserVersion:'test'}]}))};
const total=(revenue='299'):RevenueHistoryQuarter=>({...q4,basis:'reported',formula:undefined,revenue,source:{...q4.source,accession:releaseAcc,url:releaseUrl,form:'8-K'},lineage:q4.lineage!.map(l=>({...l,accession:releaseAcc,url:releaseUrl,periodStart:q4.periodStart})),segments:[{id:'reported-company-total',name:'Total',value:revenue}]});
const row=(name:string,...values:(string|number)[])=>`<tr><td>${name}</td>${values.map(v=>`<td>${v}</td>`).join('')}</tr>`;
const table=(body:string)=>`<p>($ in millions)</p><table>${row('','Three Months Ended December 31, 2025','Three Months Ended September 30, 2025')}${body}</table>`;
const statement=()=>'<p>CONSOLIDATED STATEMENTS OF INCOME</p>'+table(row('Revenue',300,300)+row('Cost of revenue',100,100)+row('Gross profit',200,200)+row('Operating expenses',100,100)+row('Operating income',100,100)+row('Other income',0,0)+row('Income before income taxes',100,100)+row('Income tax expense',20,20)+row('Net income',80,80)+row('Earnings per share')+row('Basic',1.7,1.7)+row('Diluted',1.5,1.5));
const exhibit=()=>statement()+table(row('North',200,200)+row('South',100,100)+row('Total revenue',300,300));
const seed=async(db:D1Database,quarters:RevenueHistoryQuarter[])=>db.prepare('INSERT INTO sec_cache(cache_key,payload,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload')
 .bind(historyKey(source.cik),JSON.stringify(mergeHistory('TEST',[],quarters,source.filedAt)),source.filedAt).run();
const anchor=():RevenueHistoryQuarter=>({...q4,periodStart:'2025-07-01',periodEnd:'2025-09-30',fiscalQuarter:3,basis:'reported',formula:undefined,source:{...q4.source,form:'10-Q'},
 lineage:q4.lineage!.map(l=>({...l,periodStart:'2025-07-01',periodEnd:'2025-09-30'})),segments:q4.segments.map(s=>({...s,basis:'reported',formula:undefined,lineage:s.lineage!.map(l=>({...l,periodStart:'2025-07-01',periodEnd:'2025-09-30'}))}))});
function localReader(annual=false):{reader:SecReader;reads:string[]} {
 const reads:string[]=[];
 const documents=annual?['annual.htm','quarter.htm']:['cover.htm'];
 return {reads,reader:{async read(url){reads.push(url);
  if(url.includes('/submissions/')) return Response.json({cik:source.cik,sic:'7370',filings:{recent:{form:annual?['10-K','10-Q']:['8-K'],filingDate:annual?['2026-02-01','2025-11-01']:['2026-02-01'],accessionNumber:annual?[source.accession,'0000000001-25-000003']:[releaseAcc],primaryDocument:documents,reportDate:annual?['2025-12-31','2025-09-30']:['2026-02-01'],items:annual?['','']:['2.02,9.01']}}});
  if(url.endsWith('/cover.htm'))return new Response('<p>Item 2.02 Results of Operations</p><table><tr><td>99.1</td><td><a href="ex99.htm">Earnings release</a></td></tr></table>');
  if(url.endsWith('/ex99.htm'))return new Response(exhibit());
  if(annual&&documents.some(d=>url.endsWith('/'+d)))return new Response(statement());
  throw new Error('Unexpected local fixture URL: '+url);
 }}};
}

test('Q4 rounding is scale-aware, sourced, exactly reconciled, and stable on retries/order',()=>{
 for(const scale of [1,1e3,1e6]){
  const rescale=(q:RevenueHistoryQuarter)=>({...q,scale,revenue:String(Number(q.revenue)*q.scale/scale),segments:q.segments.map(s=>({...s,value:String(Number(s.value)*q.scale/scale)}))});
  const split=rescale(q4),placeholder=rescale(total());
  for(const inputs of [[split,placeholder],[placeholder,split]]){
   const result=mergeHistory('TEST',[],inputs,source.filedAt).quarters[0];
   assert.equal(Number(result.revenue)*scale,299e6);assert.equal(result.segments.length,2);assert.ok(validHistoryQuarter(result));
   assert.equal(Number(result.revenueAdjustments![0].value)*scale,-1e6);assert.equal(result.revenueAdjustments![0].id,'rounding');
   assert.match(result.revenueAdjustments![0].formula!,/Reported revenue/);assert.ok(result.revenueAdjustments![0].lineage!.some(l=>l.accession===releaseAcc));
   assert.deepEqual(mergeHistory('TEST',[result],[placeholder],source.filedAt).quarters[0],result);
  }
 }
 assert.equal(mergeHistory('TEST',[],[q4,total('290')],source.filedAt).quarters[0].segments.length,1);
 const high={...q4,revenue:'100000',segments:q4.segments.map((s,i)=>({...s,value:String(i?40000:60000)}))};
 assert.equal(mergeHistory('TEST',[],[high,total('99995')],source.filedAt).quarters[0].segments.length,2); // 5M within one basis point
 for(const invalid of [{...total(),currency:'EUR'},{...total(),periodStart:'2025-10-02'}])assert.equal(mergeHistory('TEST',[],[q4,invalid],source.filedAt).quarters[0].segments.length,1);
 const single={...q4,segmentDisclosure:'single_reportable_segment' as const,segments:[{id:'reported-company-total',name:'Single',value:'300',lineage:q4.lineage,basis:'derived' as const,formula:q4.formula}]};
 assert.equal(mergeHistory('TEST',[],[total('300'),single],source.filedAt).quarters[0].segmentDisclosure,'single_reportable_segment');
 const before=anchor();assert.deepEqual(mergeHistory('TEST',[before],[q4,total()],source.filedAt).quarters[0],before);
});

test('Item 2.02 reread follows Exhibit 99.1, replaces placeholder, and public fundamentals reads diluted EPS',async()=>{
 const db=database(),before=anchor();await seed(db,[before,total('300')]);
 const {reader,reads}=localReader();
 const result=await rereadHistoryFiling(db,reader,{ticker:'TEST',cik:source.cik},releaseAcc,new Date('2026-03-01'));
 assert.ok(result.quarters.includes('2025-12-31'));assert.ok(reads.includes(releaseUrl));
 const history=await readRevenueHistory(db,source.cik,'TEST');const current=history!.quarters.at(-1)!;
 assert.deepEqual(current.segments.map(s=>s.name),['North','South']);assert.equal(current.dilutedEps?.value,'1.5');
 const response=await getSecFundamentals(db,{ticker:'TEST',metricKeys:['diluted_eps'],periodCount:4});
 assert.equal(response.series[0].points.at(-1)?.valueDecimal,'1.5');assert.equal(response.series[0].points.at(-1)?.sourceAccession,releaseAcc);
});

test('single-segment disclosure and standard count reject product lines; unrelated prose does not classify an issuer',()=>{
 assert.equal(hasSingleReportableSegment('The company operates in a single reportable segment.'),true);
 assert.equal(hasSingleReportableSegment('Example operates in one operating and reportable segment, the Company as a whole.'),true);
 assert.equal(hasSingleReportableSegment('Expenses significant for one operating segment may not be significant in others.'),false);
 assert.equal(hasSingleReportableSegment('The standard applies to entities with a single reportable segment.'),false);
 assert.equal(hasSingleReportableSegment('<ix:nonFraction name="us-gaap:SegmentReportingNumberOfReportableSegments">1</ix:nonFraction>'),true);
 const single={...anchor(),segmentDisclosure:'single_reportable_segment' as const,segments:[{id:'reported-company-total',name:'Single',value:'300'}]};
 const released=extractRevenueHistory(exhibit(),{...source,accession:releaseAcc,url:releaseUrl},'8-K',[single]).quarters.at(-1)!;
 assert.equal(released.segmentDisclosure,'single_reportable_segment');assert.equal(released.segments.length,1);assert.equal(released.dilutedEps?.value,'1.5');
 const products={...anchor(),segments:anchor().segments.map(s=>({...s,lineage:s.lineage!.map(l=>({...l,dimensions:{'srt:ProductOrServiceAxis':s.id}}))}))};
 assert.equal(extractRevenueHistory(exhibit(),source,'8-K',[products]).quarters.at(-1)?.segments[0].id,'reported-company-total');
 const html='<p>Example operates in one operating and reportable segment, the Company as a whole.</p>'+statement();
 assert.equal(readReportedFacts(html,{...source,singleSegment:true}).facts[0].source.singleSegment,true);
});

test('reread checkpoints one document per step and resumes without rereading the annual document',async()=>{
 const db=database(),{reader,reads}=localReader(true),opts={checkpointKey:'test:checkpoint',maxDocuments:1};
 const first=await rereadHistoryFiling(db,reader,{ticker:'TEST',cik:source.cik},source.accession,new Date('2026-03-01'),opts);
 assert.equal(first.pending,true);assert.equal(await readRevenueHistory(db,source.cik,'TEST'),null);
 const done=await rereadHistoryFiling(db,reader,{ticker:'TEST',cik:source.cik},source.accession,new Date('2026-03-01'),opts);
 assert.ok(!done.pending);assert.ok(done.quarters.length);assert.equal(reads.filter(u=>u.endsWith('/annual.htm')).length,1);
 const count=reads.length;assert.deepEqual(await rereadHistoryFiling(db,reader,{ticker:'TEST',cik:source.cik},source.accession,new Date('2026-03-01'),opts),done);assert.equal(reads.length,count);
});

test('leases heartbeat, expire into bounded retries, and fence stale/cancelled workers',async()=>{
 const db=database(),store=new FinancialMaintenanceStore(db),now=new Date('2026-03-01');
 await store.create({requestId:'lease-test',ticker:'TEST',action:'reread',accessionNumber:releaseAcc},now);
 const first=(await store.claim(now))!;
 await store.heartbeat(first,new Date(now.getTime()+MAINTENANCE_LEASE_MS-1));
 assert.equal(await store.claim(new Date(now.getTime()+MAINTENANCE_LEASE_MS+1)),null);
 const retry=(await store.claim(new Date(now.getTime()+2*MAINTENANCE_LEASE_MS)))!;
 assert.equal(retry.attempt,2);assert.equal(retry.error_code,'LEASE_EXPIRED_RETRY');assert.notEqual(retry.lease_token,first.lease_token);
 await assert.rejects(store.heartbeat(first,new Date(now.getTime()+2*MAINTENANCE_LEASE_MS)),/LEASE_LOST/);
 await store.finishStep(first,{stage:'complete',state:{},status:'succeeded'},new Date(now.getTime()+2*MAINTENANCE_LEASE_MS));
 assert.equal((await store.get(first.task_id))!.status,'running');
 const third=(await store.claim(new Date(now.getTime()+3*MAINTENANCE_LEASE_MS)))!;assert.equal(third.attempt,3);
 assert.equal(await store.claim(new Date(now.getTime()+4*MAINTENANCE_LEASE_MS)),null);assert.equal((await store.get(first.task_id))!.error_code,'LEASE_EXPIRED');
 await store.create({requestId:'cancel-test',ticker:'TEST',action:'reread',accessionNumber:releaseAcc},now);
 const cancelled=(await store.claim(now))!;await store.cancel(cancelled.task_id,now);await assert.rejects(store.heartbeat(cancelled,now),/LEASE_LOST/);
 assert.equal(await store.claim(new Date(now.getTime()+MAINTENANCE_LEASE_MS)),null);assert.equal((await store.get(cancelled.task_id))!.status,'cancelled');
});

async function publicationFixture(){
 const db=database(),now=new Date(),store=new FinancialMaintenanceStore(db);
 const flow={schemaVersion:'business-flow.v1' as const,ticker:'TEST',fetchedAt:source.filedAt,quarters:extractDisclosedQuarters(statement(),source).quarters};
 assert.equal(checkCompleteFlow(flow).complete,true);
 await db.prepare('INSERT INTO financial_complete_versions(version_id,cik,ticker,generation,payload_json,published_at) VALUES(?,?,?,?,?,?)').bind('old',source.cik,'TEST',1,JSON.stringify(flow),source.filedAt).run();
 await db.prepare('INSERT INTO financial_complete_current(cik,version_id,generation) VALUES(?,?,?)').bind(source.cik,'old',1).run();
 const history=extractRevenueHistory(exhibit(),{...source,url:releaseUrl,accession:releaseAcc},'8-K',[anchor()]).quarters;
 await seed(db,history);
 await store.create({requestId:'publish-test',ticker:'TEST',action:'reread',accessionNumber:releaseAcc},now);
 await db.prepare("UPDATE financial_maintenance_tasks SET stage='republish',cik=?,state_json=? WHERE task_id='publish-test'").bind(source.cik,JSON.stringify({cik:source.cik})).run();
 return {db,store,now,flow,history};
}

test('republish atomically inserts immutable version, updates public payload/revisions and aliases, without model events',async()=>{
 const {db,store,now,flow}=await publicationFixture(),task=(await store.claim(now))!;
 await db.prepare('INSERT INTO sec_cache(cache_key,payload,fetched_at) VALUES(?,?,?)').bind('admin:financial-issuer:TEST.A',JSON.stringify({cik:source.cik}),source.filedAt).run();
 const target={ticker:'TEST',cik:source.cik,taskId:task.task_id,leaseToken:task.lease_token!};
 const version=await republishStoredFinancials(db,target,now);
 const publication=await readCompletePublicationForTicker(db,'TEST');assert.equal(publication.status,'ready');
 assert.deepEqual(publication.flow?.quarters.at(-1)?.figures,flow.quarters.at(-1)?.figures);
 assert.equal(publication.flow?.quarters[0].segments.length,2);assert.equal(publication.history?.quarters.at(-1)?.dilutedEps?.value,'1.5');
 for(const ticker of ['TEST','TEST.A'])assert.deepEqual((await db.prepare('SELECT resource FROM publication_revisions WHERE ticker=? ORDER BY resource').bind(ticker).all<{resource:string}>()).results.map(r=>r.resource),['capital','company','fundamentals']);
 const rows=await db.prepare('SELECT payload_json FROM financial_complete_versions WHERE version_id=?').bind('old').first<{payload_json:string}>();assert.deepEqual(JSON.parse(rows!.payload_json),flow);
 assert.equal(await republishStoredFinancials(db,target,now),version);assert.equal((await db.prepare('SELECT count(*) n FROM financial_complete_versions').first<{n:number}>())!.n,2);
 assert.equal((await db.prepare('SELECT count(*) n FROM pipeline_outbox').first<{n:number}>())!.n,0);
 assert.throws(()=>rebuildPublication(flow,[{...historyQuarterFrom(flow.quarters[0],{...source,form:'10-K'})!,revenue:'999'}],now.toISOString()),/REPUBLICATION_REVENUE_CONFLICT/);
});

test('republish stays within D1 compound SELECT limits and revises share classes from every source once',async()=>{
 const {db,store,now}=await publicationFixture(),task=(await store.claim(now))!;
 await db.prepare("UPDATE financial_complete_versions SET ticker='TEST.V' WHERE version_id='old'").run();
 await db.prepare('INSERT INTO financial_collection_jobs(job_id,cik,ticker,generation,status,next_attempt_at,updated_at) VALUES(?,?,?,?,?,?,?)')
  .bind('alias-job',source.cik,'TEST.J',2,'succeeded',source.filedAt,source.filedAt).run();
 await db.prepare('INSERT INTO sec_filings(filing_id,ticker,accession_number,cik,form,filing_date,report_date,document_url,index_url) VALUES(?,?,?,?,?,?,?,?,?)')
  .bind('alias-filing','TEST.F',source.accession,source.cik,'10-K',source.filedAt,'2025-12-31',source.url,source.url).run();
 for(const ticker of ['TEST.A','TEST.J'])await db.prepare('INSERT INTO sec_cache(cache_key,payload,fetched_at) VALUES(?,?,?)')
  .bind(`admin:financial-issuer:${ticker}`,JSON.stringify({cik:source.cik}),source.filedAt).run();
 let batches=0;
 const limitedDb={...db,prepare(sql:string){
  assert.ok((sql.match(/\bUNION\b/gi)??[]).length<=4,`D1 compound SELECT limit exceeded: ${sql}`);
  return db.prepare(sql);
 },batch:async(items:D1PreparedStatement[])=>{batches++;return db.batch(items);}} as D1Database;
 await republishStoredFinancials(limitedDb,{ticker:'TEST.R',cik:source.cik,taskId:task.task_id,leaseToken:task.lease_token!},now);
 assert.equal(batches,1);
 const revisions=(await db.prepare('SELECT ticker,resource,revision FROM publication_revisions ORDER BY ticker,resource').all()).results;
 assert.deepEqual(revisions.map(row=>({...row})),['TEST','TEST.A','TEST.F','TEST.J','TEST.R','TEST.V'].flatMap(ticker=>
  ['capital','company','fundamentals'].map(resource=>({ticker,resource,revision:now.toISOString()}))));
});

test('republish stage completes through maintenance and never invokes discover, collect, reread or AI',async()=>{
 const {db}=await publicationFixture();
 const unexpected=async()=>{throw new Error('Unexpected workflow');};
 const deps:MaintenanceDependencies={reader:()=>({read:unexpected}),discover:unexpected,collect:unexpected,history:unexpected,reread:unexpected};
 const result=await runFinancialMaintenanceTick({DB:db,SEC_ANALYSIS_WORKFLOW:{create:unexpected}} as unknown as AnalysisEnv,deps);
 assert.equal(result.stage,'republish');assert.equal((await new FinancialMaintenanceStore(db).get('publish-test'))!.status,'succeeded');
});

test('an expired task cannot publish or move any revision',async()=>{
 const {db,store,now}=await publicationFixture(),task=(await store.claim(now))!;
 await assert.rejects(republishStoredFinancials(db,{ticker:'TEST',cik:source.cik,taskId:task.task_id,leaseToken:task.lease_token!},new Date(now.getTime()+MAINTENANCE_LEASE_MS)),/LEASE_OR_VERSION_CHANGED/);
 assert.equal((await db.prepare('SELECT count(*) n FROM financial_complete_versions').first<{n:number}>())!.n,1);
 assert.equal((await db.prepare('SELECT count(*) n FROM publication_revisions').first<{n:number}>())!.n,0);
});

test('successful reread queues deterministic publication, preserving request idempotency and Q1-Q3 amounts',async()=>{
 const {db,store}=await publicationFixture();
 await db.prepare("UPDATE financial_maintenance_tasks SET stage='reread' WHERE task_id='publish-test'").run();
 await seed(db,[anchor(),total('300')]);
 const unexpected=async()=>{throw new Error('AI/collection must not run');};
 const deps:MaintenanceDependencies={reader:(_env,_ticker,options)=>{assert.equal(options?.silentArchive,true);return localReader().reader;},discover:unexpected,collect:unexpected,history:unexpected,reread:rereadHistoryFiling};
 const env={DB:db,SEC_ANALYSIS_WORKFLOW:{create:unexpected}} as unknown as AnalysisEnv;
 await runFinancialMaintenanceTick(env,deps);
 const task=(await store.get('publish-test'))!;
 assert.equal(task.stage,'republish');assert.equal(task.status,'queued');assert.equal(task.total_steps,3);
 assert.equal(await store.create({requestId:'publish-test',ticker:'TEST',action:'reread',accessionNumber:releaseAcc},new Date()),null);
 const prior=(await readRevenueHistory(db,source.cik,'TEST'))!.quarters.find(q=>q.periodEnd==='2025-09-30')!;
 assert.deepEqual(prior.segments,JSON.parse(JSON.stringify(anchor().segments)));assert.equal(prior.revenue,anchor().revenue);
 await runFinancialMaintenanceTick(env,deps);
 assert.equal((await store.get('publish-test'))!.status,'succeeded');
 assert.equal((await db.prepare('SELECT count(*) n FROM financial_complete_versions').first<{n:number}>())!.n,2);
});

test('reportable-segment counts use the latest consolidated issuer context, not subsidiary or old counts',()=>{
 const context=(id:string,end:string,dimension='')=>`<xbrli:context id="${id}"><xbrli:entity><xbrli:identifier>1</xbrli:identifier>${dimension}</xbrli:entity><xbrli:period><xbrli:instant>${end}</xbrli:instant></xbrli:period></xbrli:context>`;
 const count=(id:string,n:number)=>`<ix:nonFraction name="us-gaap:SegmentReportingNumberOfReportableSegments" contextRef="${id}">${n}</ix:nonFraction>`;
 const html=context('old','2024-12-31')+context('new','2025-12-31')+context('sub','2025-12-31','<xbrldi:explicitMember dimension="srt:LegalEntityAxis">test:SubsidiaryMember</xbrldi:explicitMember>');
 assert.equal(hasSingleReportableSegment(html+count('old',1)+count('new',2)+count('sub',1),source.cik),false);
 assert.equal(hasSingleReportableSegment(html+count('old',2)+count('new',1)+count('sub',2),source.cik),true);
 assert.equal(hasSingleReportableSegment(html+count('new',1),'0000000002'),false);
});


test('silent reread archiving retains audit objects and pointers without emitting model-triggering events',async()=>{
 const db=database(),objects=new Map<string,string>();
 const env={DB:db,SEC_FILINGS:{get:async(key:string)=>objects.has(key)?{text:async()=>objects.get(key)!}:null,put:async(key:string,value:string)=>{objects.set(key,value);}}};
 const first=await archiveFilingDisclosures(env,'TEST',source,statement(),{form:'10-K'},null,{announce:false});
 assert.ok(first.documentId);assert.equal(objects.size,3);
 await archiveFilingDisclosures(env,'TEST',source,statement()+'<p>Updated disclosure</p>',{form:'10-K'},null,{announce:false});
 assert.equal((await db.prepare('SELECT count(*) n FROM pipeline_outbox').first<{n:number}>())!.n,0);
 assert.equal((await db.prepare('SELECT count(*) n FROM pipeline_superseded').first<{n:number}>())!.n,3);
 assert.equal((await db.prepare("SELECT count(*) n FROM sec_cache WHERE cache_key LIKE 'sec:disclosure-audit:%'").first<{n:number}>())!.n,1);
});
