import test from 'node:test';
import {trackedTickersFor,assertTrackedTicker,assertDataTicker,runCompanyAnalysisSweep,runSecMemorySweep,runSecRefresh} from '../../workers/pipeline/src/core.ts';
import assert from 'node:assert/strict';
import {checkCompleteFlow} from '../../shared/analysis-runtime/financial-data/completeness.ts';
import {financialPolicy,allowData,allowAi,validateUniverse} from '../../shared/analysis-runtime/financial-data/policy.ts';
import {collectComplete} from '../../workers/pipeline/src/financial-data/collect.ts';
import type {CompleteStore,Job} from '../../workers/pipeline/src/financial-data/store.ts';
import type {BusinessFlowQuarter} from '../../shared/analysis-contract/business-flow.ts';
import {completeOrclFixture as flow,current,previous} from '../fixtures/complete-orcl-flow.ts';
test('actual two-quarter ORCL SEC disclosures pass the complete publication gate',()=>assert.deepEqual(checkCompleteFlow(flow),{complete:true,reasons:[]}));
test('missing quarter, source, cost, unbalanced figures and unknown comparison never publish',()=>{
 const single=structuredClone(flow);single.quarters.pop();assert.equal(checkCompleteFlow(single).complete,false);
 for(const mutate of [(q:BusinessFlowQuarter)=>{delete q.figures.tax;},(q:BusinessFlowQuarter)=>{q.figures.net!.value='1';},(q:BusinessFlowQuarter)=>{q.figures.net!.lineage=[];},(q:BusinessFlowQuarter)=>{q.figures.revenue!.comparabilityKey=null;},(q:BusinessFlowQuarter)=>{q.incomeModel='financial';}]){const broken=structuredClone(flow);mutate(broken.quarters[0]);assert.equal(checkCompleteFlow(broken).complete,false);}
});
test('data-only selection never grants AI and AI can be globally switched off',()=>{
 const policy=financialPolicy({SEC_TRACKED_TICKERS:'ORCL,ADSK,NET',SEC_DATA_TICKERS:'ORCL,NVDA',SEC_AI_TICKERS:'ORCL'});assert.equal(allowData(policy,'NVDA'),true);assert.equal(allowAi(policy,'NVDA',true),false);assert.equal(allowAi(policy,'ORCL',false),false);assert.equal(allowAi(policy,'ORCL',true),true);assert.equal(allowAi(financialPolicy({SEC_DATA_TICKERS:'ORCL',SEC_AI_TICKERS:'ORCL',SEC_AI_ENABLED:'false'}),'ORCL',true),false);
});
test('versioned issuer universe deduplicates share classes and rejects conflicting CIKs',()=>{
 const source={schemaVersion:'financial-universe.v1' as const,id:'test-only',asOf:'2026-10-01',sourceUrl:'https://example.org/public-test-list',issuers:[{cik:'0001652044',name:'Alphabet',industry:'standard' as const,tickers:['GOOG']},{cik:'0001652044',name:'Alphabet',industry:'standard' as const,tickers:['GOOGL']}]};assert.deepEqual(validateUniverse(source)[0].tickers,['GOOG','GOOGL']);assert.throws(()=>validateUniverse({...source,issuers:[...source.issuers,{cik:'0000000001',name:'Conflict',industry:'standard',tickers:['GOOG']}]}));
});
test('incomplete batches remain staged; failing refresh retains old complete publication',async()=>{
 const staged:BusinessFlowQuarter[]=[];let published=flow,calls=0;const store:CompleteStore={stage:async(_job,q)=>{staged.push(q);},staged:async()=>staged,publish:async(_job,next)=>{calls++;published=next;return true;},defer:async()=>{}};
 const job:Job={id:'test-job',cik:'0001341439',ticker:'ORCL',generation:1,lease:'test-lease',cursor:'{}',attempt:1};const policy=financialPolicy({SEC_DATA_TICKERS:'ORCL',SEC_AI_ENABLED:'false'});
 assert.equal((await collectComplete(job,policy,store,async()=>({quarters:[current],nextCursor:'second-document',finished:false}))).published,false);assert.equal(calls,0);assert.equal(published,flow);
 assert.equal((await collectComplete(job,policy,store,async()=>{throw new Error('provider failed');})).published,false);assert.equal(published,flow);
 assert.equal((await collectComplete(job,policy,store,async()=>({quarters:[previous],nextCursor:'done',finished:true}))).published,true);assert.equal(calls,1);assert.equal(checkCompleteFlow(published).complete,true);
});

test('legacy whitelist defaults remain compatible and explicit empty lists stay empty',()=>{
 const legacy={SEC_TRACKED_TICKERS:'ORCL,ADSK,NET'};const policy=financialPolicy(legacy);
 assert.deepEqual([...policy.dataTickers],['ORCL','ADSK','NET']);assert.deepEqual([...policy.aiTickers],['ORCL','ADSK','NET']);
 assert.deepEqual(trackedTickersFor(legacy),['ADSK','NET','ORCL']);
 assertDataTicker({...legacy,SEC_DATA_TICKERS:'NVDA',SEC_AI_TICKERS:'ORCL'},'NVDA');
 assert.throws(()=>assertTrackedTicker({...legacy,SEC_DATA_TICKERS:'NVDA',SEC_AI_TICKERS:'ORCL'},'NVDA'));
 assert.deepEqual(trackedTickersFor({...legacy,SEC_AI_TICKERS:''}),[]);
 assert.equal(financialPolicy({...legacy,SEC_DATA_TICKERS:''}).dataTickers.size,0);
});
test('AI global off skips company and memory workflows before database access',async()=>{
 const forbidden=()=>{throw new Error('AI or database must not be touched');};
 const env={SEC_TRACKED_TICKERS:'ORCL',SEC_DATA_TICKERS:'ORCL,NVDA',SEC_AI_ENABLED:'false',DB:{prepare:forbidden},COMPANY_ANALYSIS_WORKFLOW:{get:forbidden,create:forbidden},SEC_MEMORY_WORKFLOW:{create:forbidden}};
 assert.deepEqual(await runCompanyAnalysisSweep(env as never),{candidates:0,started:[],failed:[]});
 assert.deepEqual(await runSecMemorySweep(env as never),{started:[]});
 assert.deepEqual(await runSecRefresh(env as never),{started:[],failed:[],skipped:[]});
 assertDataTicker(env,'NVDA');assert.throws(()=>assertTrackedTicker(env,'ORCL'));
});
