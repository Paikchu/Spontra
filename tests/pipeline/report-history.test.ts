import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {completeOrclFixture} from '../fixtures/complete-orcl-flow.ts';
import {checkCompleteFlow,checkCompleteQuarter} from '../../shared/analysis-runtime/financial-data/completeness.ts';
import {readReportHistory} from '../../shared/analysis-runtime/financial-data/report-history.ts';
import {readArchivedReportHistory} from '../../workers/pipeline/src/financial-data/report-history.ts';
import {createAnalysisDatabase,ReadOnlyGuardDatabase,readEnv,readRequest} from './helpers/analysis-backend.ts';
import {handleAnalysisReadRequest} from '../../workers/pipeline/src/read-api/router.ts';
import {D1SecRepository} from '../../workers/pipeline/src/sec/d1.ts';
import {archiveFilingDisclosures} from '../../workers/pipeline/src/financial-data/disclosure-audit.ts';
import type {BusinessFlowQuarter} from '../../shared/analysis-contract/business-flow.ts';

function shiftQuarter(index:number):BusinessFlowQuarter{
 const q=structuredClone(completeOrclFixture.quarters[0]);
 const end=new Date(Date.UTC(2026,8-index*3,0)).toISOString().slice(0,10);
 const start=new Date(Date.UTC(2026,5-index*3,1)).toISOString().slice(0,10);
 const oldStart=q.periodStart!,oldEnd=q.periodEnd;
 return JSON.parse(JSON.stringify(q).replaceAll(oldStart,start).replaceAll(oldEnd,end));
}
test('eight independently audited reports span two years without weakening the latest-pair gate',()=>{
 const quarters=Array.from({length:10},(_,i)=>shiftQuarter(i));
 const old=quarters[7];for(const amount of Object.values(old.figures))amount.comparabilityKey=null;
 assert.equal(checkCompleteQuarter(old).complete,true);
 assert.equal(checkCompleteFlow({...completeOrclFixture,quarters:[old]}).complete,false);
 assert.equal(checkCompleteFlow({...completeOrclFixture,quarters}).complete,false);
 const reports=readReportHistory({...completeOrclFixture,quarters},'ORCL')!;
 assert.equal(reports.quarters.length,8);assert.equal(reports.quarters.at(-1)!.periodEnd,'2024-11-30');
 assert.equal(readReportHistory({...reports,ticker:'MSFT'},'ORCL'),null);
 const broken=structuredClone(quarters[4]);broken.figures.net!.value='999';
 assert.equal(checkCompleteQuarter(broken).complete,false);
 const invalidSource=structuredClone(quarters[5]);invalidSource.figures.revenue!.lineage![0].url='https://example.com/financials';
 assert.equal(checkCompleteQuarter(invalidSource).complete,false);
 const result=readReportHistory({...completeOrclFixture,quarters:[broken,invalidSource,quarters[0]]},'ORCL')!;
 assert.deepEqual(result.quarters.map(q=>q.periodEnd),['2026-08-31']);
});

test('existing archives yield historical statements read-only and retain original current quarters',async()=>{
 const raw=await createAnalysisDatabase(),db=raw as unknown as D1Database;
 const objects=new Map<string,string>();
 const bucket={get:async(key:string)=>objects.has(key)?{text:async()=>objects.get(key)!}:null,put:async(key:string,text:string)=>{objects.set(key,text);}};
 const html=readFileSync(new URL('./fixtures/orcl-2026-q1-sec-xbrl.html',import.meta.url),'utf8').replaceAll('2026-06-01','2025-06-01').replaceAll('2026-08-31','2025-08-31');
 try{
  await archiveFilingDisclosures({DB:db,SEC_FILINGS:bucket},'ORCL',{url:'https://www.sec.gov/Archives/edgar/data/1341439/000119312526389274/orcl-20260831.htm',accession:'0001193125-26-389274',filedAt:'2026-09-11',cik:'0001341439',industry:'standard'},html,{form:'10-Q',reportDate:'2026-08-31'});
  await new D1SecRepository(db).setCache('sec:business-flow:v2:ORCL',completeOrclFixture,'2026-10-01');
  const guard=new ReadOnlyGuardDatabase(raw);
  const reports=await readArchivedReportHistory(guard as unknown as D1Database,bucket,completeOrclFixture);
  assert.deepEqual(reports.quarters.map(q=>q.periodEnd),['2026-08-31','2026-05-31','2025-08-31']);
  assert.equal(reports.quarters[2].figures.revenue!.value,'19345000000');
  assert.deepEqual(reports.quarters[0],completeOrclFixture.quarters[0]);
  const response=await handleAnalysisReadRequest(readRequest('/api/v1/companies/ORCL/business-flow'),{...readEnv(guard),SEC_FILINGS:bucket});
  assert.equal(response.status,200);
  const body=await response.json() as {flow:{quarters:unknown[]};reports:{quarters:BusinessFlowQuarter[]}};
  assert.equal(body.flow.quarters.length,2);
  assert.deepEqual(body.reports.quarters.map(q=>q.periodEnd),reports.quarters.map(q=>q.periodEnd));
  assert.deepEqual(guard.attemptedWrites,[]);
  // Unknown/wrong-company archives cannot add a report or cause outbound source fetches.
  await new D1SecRepository(db).setCache('sec:disclosure-audit:v1:ORCL:wrong',{ticker:'MSFT',source:{ticker:'MSFT'},rawKey:'private/file'},'2026-10-05');
  const again=await readArchivedReportHistory(guard as unknown as D1Database,bucket,completeOrclFixture);
  assert.deepEqual(again.quarters.map(q=>q.periodEnd),reports.quarters.map(q=>q.periodEnd));
 }finally{raw.close();}
});
