import assert from 'node:assert/strict';
import test from 'node:test';
import {createAnalysisDatabase} from './helpers/analysis-backend.ts';
import {seedTranscripts,syncTranscript,listTranscripts,transcriptDetail} from '../../workers/pipeline/src/transcripts/library.ts';
import {handleTranscriptAdminRequest} from '../../workers/pipeline/src/admin/transcripts.ts';
import {createAdminSession} from '../../workers/pipeline/src/admin/auth.ts';
import type {SecPipelineEnv} from '../../workers/pipeline/src/operations.ts';

test('archived whitelist reports are queued once, fiscal DEI drives requests, full text is private and budgets resume tomorrow',async()=>{
 const db=await createAnalysisDatabase(),now=new Date('2026-10-07T12:00:00Z');
 const html=(end:string,period:string)=>`<ix:nonNumeric name="dei:DocumentFiscalYearFocus" contextRef="c">2026</ix:nonNumeric><ix:nonNumeric name="dei:DocumentFiscalPeriodFocus" contextRef="c">${period}</ix:nonNumeric><ix:nonNumeric name="dei:DocumentPeriodEndDate" contextRef="c">${end}</ix:nonNumeric>`;
 const raw=new Map([['first',html('2026-05-31','FY')],['second',html('2026-02-28','Q3')]]);
 const env={DB:db,SEC_FILINGS:{async get(k:string){return raw.has(k)?{async text(){return raw.get(k)!;}}:null;},async put(){}},SEC_DATA_TICKERS:'ORCL',ALPHA_VANTAGE_API_KEY:'test-secret',TRANSCRIPTS_ENABLED:'true',GUIDANCE_DAILY_TRANSCRIPT_CALLS:'1',REPORT_ADMIN_PASSWORD:'admin-secret'} as unknown as SecPipelineEnv;
 for(const [ticker,end,key,form] of [['ORCL','2026-05-31','first','10-K'],['ORCL','2026-02-28','second','10-Q'],['NET','2026-05-31','first','10-Q']]){
  await db.prepare('INSERT INTO sec_cache(cache_key,payload,fetched_at) VALUES(?,?,?)').bind(`sec:disclosure-audit:v1:${ticker}:${key}`,JSON.stringify({ticker,rawKey:key,source:{form,reportDate:end,accessionNumber:key,documentUrl:'https://www.sec.gov/report.htm',filedAt:'2026-06-15'}}),now.toISOString()).run();
 }
 await seedTranscripts(env,now);await seedTranscripts(env,now);
 assert.equal((await listTranscripts(env,new URL('https://test/admin/transcripts'))).total,2);
 const text='We expect revenue growth. '.repeat(1300)+' Last analyst question and final answer.';
 const requests:URL[]=[];
 const fetcher=(async(input:URL|string)=>{const u=new URL(String(input));requests.push(u);return Response.json({symbol:'ORCL',quarter:u.searchParams.get('quarter'),transcript:[{speaker:'CEO',content:text}]});}) as typeof fetch;
 assert.equal((await syncTranscript(env,now,fetcher)).status,'ready');
 assert.equal(requests[0].searchParams.get('quarter'),'2026Q4');
 assert.equal((await syncTranscript(env,now,fetcher)).status,'daily_budget');
 assert.equal((await syncTranscript(env,new Date('2026-10-08T12:00:00Z'),fetcher)).status,'ready');
 assert.equal(requests[1].searchParams.get('quarter'),'2026Q3');
 const detail=await transcriptDetail(env,'ORCL-2026-05-31');
 assert.equal(detail?.content,'CEO: '+text);assert.ok(!JSON.stringify(detail).includes('test-secret'));
 assert.equal((await handleTranscriptAdminRequest(new Request('https://test/admin/transcripts/ORCL-2026-05-31'),env)).status,401);
 const token=await createAdminSession('admin-secret');
 const response=await handleTranscriptAdminRequest(new Request('https://test/admin/transcripts/ORCL-2026-05-31',{headers:{authorization:`Bearer ${token}`}}),env);
 assert.equal(response.status,200);assert.equal((await response.json() as {content:string}).content,'CEO: '+text);
 assert.equal(response.headers.get('cache-control'),'private, no-store');
 db.close();
});
