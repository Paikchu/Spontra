import assert from 'node:assert/strict';
import test from 'node:test';
import {createAnalysisDatabase,ReadOnlyGuardDatabase} from './helpers/analysis-backend.ts';
import {completeOrclFixture} from '../fixtures/complete-orcl-flow.ts';
import {readCompletePublication,readCompletePublicationForTicker} from '../../workers/pipeline/src/financial-data/publication.ts';
import {checkCompleteFlow} from '../../shared/analysis-runtime/financial-data/completeness.ts';
import type {PublicBusinessFlow} from '../../shared/analysis-contract/business-flow.ts';

// Synthetic second share class isolates CIK aliasing while keeping a complete SEC-sourced fixture.
async function fixture(){
 const raw=await createAnalysisDatabase(),cik='0001341439',now=new Date().toISOString();
 for(const [i,ticker]of ['ORCL','ORCL.A'].entries())raw.raw.prepare('INSERT INTO financial_collection_jobs(job_id,cik,ticker,generation,status,next_attempt_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(ticker,cik,ticker,i+1,'succeeded',now,now);
 const flow:PublicBusinessFlow={...JSON.parse(JSON.stringify(completeOrclFixture)),ticker:'ORCL.A'};
 raw.raw.prepare('INSERT INTO financial_complete_versions(version_id,cik,ticker,generation,payload_json,published_at) VALUES(?,?,?,?,?,?)').run('latest',cik,flow.ticker,2,JSON.stringify(flow),now);
 raw.raw.prepare('INSERT INTO financial_complete_current(cik,version_id,generation) VALUES(?,?,?)').run(cik,'latest',2);
 const guard=new ReadOnlyGuardDatabase(raw),db=guard as unknown as D1Database;
 const save=(next:PublicBusinessFlow)=>raw.raw.prepare('UPDATE financial_complete_versions SET payload_json=? WHERE version_id=?').run(JSON.stringify(next),'latest');
 return{raw,db,guard,cik,flow,save};
}

test('a verified CIK publication serves both share classes without changing its stored ticker or quarters',async()=>{
 const f=await fixture();try{
  for(const ticker of ['ORCL','ORCL.A']){
   const result=await readCompletePublicationForTicker(f.db,ticker);
   assert.equal(result.status,'ready');assert.equal(result.flow!.ticker,ticker);
   assert.deepEqual(result.flow!.quarters,f.flow.quarters);assert.equal(checkCompleteFlow(result.flow!).complete,true);
   assert.equal(result.history!.ticker,ticker);assert.equal(result.history!.quarters.length,2);
  }
  assert.equal((await readCompletePublication(f.db,f.cik)).flow!.ticker,'ORCL.A');
  assert.deepEqual(f.guard.attemptedWrites,[]);
 }finally{f.raw.close();}
});

test('alias projection rejects wrong issuer sources and provenance in every amount location',async()=>{
 const f=await fixture();try{
  const wrong=(url:string)=>url.replace('/1341439/','/1652044/');
  const variants:Array<[string,(flow:PublicBusinessFlow)=>void]>=[
   ['source',flow=>{flow.quarters[0].sources[0].url=wrong(flow.quarters[0].sources[0].url);} ],
   ['figure',flow=>{flow.quarters[0].figures.revenue!.lineage![0].url=wrong(flow.quarters[0].figures.revenue!.lineage![0].url);} ],
   ['segment',flow=>{flow.quarters[0].segments[0].revenue!.lineage![0].url=wrong(flow.quarters[0].segments[0].revenue!.lineage![0].url);} ],
   ['child',flow=>{const q=flow.quarters[0],amount=structuredClone(q.segments[0].revenue!);amount.lineage![0].url=wrong(amount.lineage![0].url);q.segments[0].children=[{id:'child',name:'Child',revenue:amount}];} ],
   ['breakdown',flow=>{const q=flow.quarters[0],segment=structuredClone(q.segments[0]);segment.revenue!.lineage![0].url=wrong(segment.revenue!.lineage![0].url);q.revenueBreakdowns=[{id:'breakdown',label:'Breakdown',kind:'business',definitionKey:'test',periodStart:q.periodStart!,periodEnd:q.periodEnd,currency:q.currency,scale:q.scale,complete:false,nodes:[{...segment,parentId:null,childrenComplete:false}]}];} ],
   ['expense',flow=>{const amount=flow.quarters[0].expenseComponents![0].amount;amount.lineage![0].url=wrong(amount.lineage![0].url);} ],
   ['other',flow=>{const amount=flow.quarters[0].otherComponents![0].amount;amount.lineage![0].url=wrong(amount.lineage![0].url);} ],
  ];
  for(const [label,change]of variants){
   const flow=structuredClone(f.flow);change(flow);assert.equal(checkCompleteFlow(flow).complete,true,label+' must reach the issuer check');f.save(flow);
   const result=await readCompletePublicationForTicker(f.db,'ORCL');
   assert.equal(result.flow,null,label);assert.equal(result.status,'preparing',label);assert.deepEqual(result.reasons,['INVALID_SOURCE'],label);
  }
 }finally{f.raw.close();}
});

test('alias projection requires an identified CIK and rejects non-archive or credentialed provenance',async()=>{
 const f=await fixture();try{
  assert.equal((await readCompletePublicationForTicker(f.db,'UNTRACKED')).flow,null);
  for(const url of ['https://www.sec.gov/Archives/edgar/data/1652044/a.htm','https://data.sec.gov/Archives/edgar/data/1341439/a.htm','https://user@www.sec.gov/Archives/edgar/data/1341439/a.htm','https://www.sec.gov:444/Archives/edgar/data/1341439/a.htm','https://www.sec.gov/edgar/search/']){
   const flow=structuredClone(f.flow);flow.quarters[0].sources[0].url=url;f.save(flow);
   assert.equal((await readCompletePublicationForTicker(f.db,'ORCL')).flow,null,url);
  }
  f.save(f.flow);
  f.raw.raw.prepare('UPDATE financial_collection_jobs SET cik=? WHERE ticker=?').run('0001652044','ORCL');
  assert.equal((await readCompletePublicationForTicker(f.db,'ORCL')).flow,null,'a different issuer cannot borrow the existing pointer');
 }finally{f.raw.close();}
});
