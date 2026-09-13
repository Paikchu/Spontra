import assert from 'node:assert/strict';
import test from 'node:test';
import { attachDiscovery, auditDisclosureCoverage, discoveryChunkCount, enforceDiscoveryCoverage, MAX_DISCOVERY_CHUNKS, scanDisclosureChunk } from '../../workers/pipeline/src/sec/discovery.ts';
import { analyzePreparedSecNode, planPreparedSecFiling, prepareSecFiling, summarizePreparedSecFiling } from '../../workers/pipeline/src/sec/pipeline.ts';
import { buildSecNodeInput } from '../../workers/pipeline/src/sec/report.ts';
import type { SecFiling } from '../../workers/pipeline/src/sec/sec.ts';

const filing:SecFiling={ticker:'ORCL',cik:'0001341439',cikNumber:1341439,companyName:'Oracle',form:'10-Q',filingDate:'2026-09-11',reportDate:'2026-08-31',accessionNumber:'0001193125-26-389274',primaryDocument:'orcl.htm',description:'',items:'',documentUrl:'https://sec.test/orcl.htm',indexUrl:'https://sec.test/index.htm'};
// Source-faithful regression fragments: no useful heading, and disclosure near the tail.
const usefulLife='Comprised primarily of servers and networking equipment with estimated useful life of six years.';
const trading='Lawrence J. Ellison, our Executive Chair of the Board of Directors and Chief Technology Officer, adopted a new trading plan on June 22, 2026. The trading plan is intended to permit Mr. Ellison to sell up to 50 million shares of Oracle common stock.';
const candidate=(quote:string,materiality='high')=>({title:quote===usefulLife?'设备寿命假设':'管理层交易计划',quote,whyItMatters:'影响资本回报或治理判断，需要核对边界。',question:'披露了什么，哪些推断不能成立？',materiality,polarity:'mixed'});
async function prepare(text:string){return prepareSecFiling(filing,{userAgent:'test@example.com',fetcher:async()=>new Response(`<p>${text}</p>`)});}

test('semantic discovery sees all chunks including the tail and grounds every candidate against source spans',async()=>{
 const prepared=await prepare(usefulLife+' '+ 'Ordinary background. '.repeat(1400)+trading);
 const chunks=[];
 for(let i=0;i<discoveryChunkCount(prepared.document.text.length);i++){
  chunks.push(await scanDisclosureChunk(prepared,i,async(_stage,_system,payload)=>{
   const {text}=payload as {text:string};
   return {disclosures:[usefulLife,trading].filter(quote=>text.includes(quote)).map(quote=>candidate(quote))};
  }));
 }
 const meta=attachDiscovery(prepared,prepared.document.text.length,chunks);
 assert.equal(meta.discovery?.scannedCharacters,prepared.document.text.length);
 assert.equal(meta.discovery?.disclosures.length,2);
 for(const item of meta.discovery!.disclosures){
  assert.equal(prepared.document.text.slice(item.start,item.end),item.quote);
  const plan=enforceDiscoveryCoverage({nodes:[],outlineSections:meta.outline.length},meta.discovery);
  const node=plan.nodes.find(n=>n.id===item.id)!;
  const input=buildSecNodeInput(node,meta.outline,prepared.document.text);
  assert.ok(input.sections.some(section=>section.text.includes(item.quote)));
 }
});

test('rejects hallucinated evidence and malformed responses; duplicate overlapping chunks are deduplicated',async()=>{
 const prepared=await prepare(usefulLife);
 const chunk=await scanDisclosureChunk(prepared,0,async()=>({disclosures:[candidate(usefulLife),candidate(trading)]}));
 assert.equal(chunk.rejected,1);assert.equal(chunk.disclosures.length,1);
 const meta=attachDiscovery(prepared,prepared.document.text.length,[chunk,chunk]);
 assert.equal(meta.discovery?.disclosures.length,1);
 assert.equal(meta.discovery?.scannedCharacters,prepared.document.text.length);
 const retried=attachDiscovery(meta,prepared.document.text.length,[chunk]);
 assert.equal(retried.outline.length,meta.outline.length);
 await assert.rejects(scanDisclosureChunk(prepared,0,async()=>({findings:[]})),/must contain disclosures/);
});

test('failed or over-budget scans never claim the source has no important disclosures',async()=>{
 const prepared=await prepare(usefulLife);
 const meta=attachDiscovery(prepared,prepared.document.text.length,[{index:0,start:0,end:0,status:'failed',disclosures:[],rejected:0}]);
 assert.equal(meta.discovery?.scannedCharacters,0);assert.deepEqual(meta.discovery?.failedChunks,[0]);
 assert.match(meta.materialWarnings!.join(' '),/未扫描部分不能视为没有重要事项/);
 assert.equal(discoveryChunkCount(100_000_000),MAX_DISCOVERY_CHUNKS);
});

test('Manager cannot omit a high-materiality disclosure even when it only chooses ordinary metrics',async()=>{
 const prepared=await prepare(usefulLife+' '+trading);
 const chunk=await scanDisclosureChunk(prepared,0,async()=>({disclosures:[candidate(usefulLife),candidate(trading)]}));
 const meta=attachDiscovery(prepared,prepared.document.text.length,[chunk]);
 const plan=await planPreparedSecFiling(meta,async(_stage,_system,payload)=>{
  assert.equal((payload as {disclosures:unknown[]}).disclosures.length,2);
  return {nodes:[{id:'revenue',title:'收入',question:'收入变化',sectionIds:[meta.outline[0].id]}]};
 });
 for(const item of meta.discovery!.disclosures)assert.ok(plan.nodes.some(n=>n.sectionIds.includes(item.id)));
 assert.equal(plan.nodes[0].sectionIds[0],meta.discovery!.disclosures[0].id);
});

test('independent audit can add an unplanned qualitative theme and rejects invented candidate ids',async()=>{
 const prepared=await prepare(trading);
 const chunk=await scanDisclosureChunk(prepared,0,async()=>({disclosures:[candidate(trading,'medium')]}));
 const meta=attachDiscovery(prepared,prepared.document.text.length,[chunk]);
 const tasks=await auditDisclosureCoverage(meta,{nodes:[],outlineSections:1},[],async()=>({missingDisclosureIds:['invented',chunk.disclosures[0].id]}));
 assert.equal(tasks.length,1);assert.equal(tasks[0].sectionIds[0],chunk.disclosures[0].id);
});

test('evidence-backed qualitative reports can publish partially without inventing financial metrics',async()=>{
 const prepared=await prepare(trading);
 const chunk=await scanDisclosureChunk(prepared,0,async()=>({disclosures:[candidate(trading)]}));
 const meta=attachDiscovery(prepared,prepared.document.text.length,[chunk]);
 const plan=enforceDiscoveryCoverage({nodes:[],outlineSections:1},meta.discovery);
 const node=await analyzePreparedSecNode({...prepared,...meta},plan.nodes[0],async()=>({findings:[{label:'交易计划',detail:'这是允许出售的计划，并非实际成交记录。',importance:'high'}],narrative:'执行董事长设立交易计划；应核对实际成交与后续取消公告，不推测其动机。',facts:[]}));
 const result=await summarizePreparedSecFiling(meta,{currentPeriodId:meta.periodId,qoqPeriodId:null,yoyPeriodId:null},async()=>({headline:'管理层交易计划值得跟踪',bullets:[{label:'计划',detail:'设立交易计划不等于实际减持。',importance:'high'}],analystView:'后续核对执行状态。',report:'本期披露交易安排，应区分计划与实际成交，并核对人物职务和后续状态。',keyMetrics:[],changes:{qoq:[],yoy:[],guidance:[],risks:[]},dataQuality:{warnings:[]}}),new Date(),plan,[node]);
 assert.equal(result.artifact.report.dataQuality.verificationStatus,'partial');
 assert.equal(result.artifact.report.keyMetrics.length,0);
 assert.equal(result.summary.discovery?.disclosures.length,1);
});

test('node quote positions stay accurate when its evidence window starts with whitespace',async()=>{
 const prepared=await prepare(' '+trading);
 const text='   '+prepared.document.text;
 const node={id:'test',title:'test',question:'test',sectionIds:['s'],historySeriesIds:[],memoryIds:[],acceptanceCriteria:[],materiality:'high' as const};
 const input=buildSecNodeInput(node,[{id:'s',title:'test',start:0,end:text.length,characters:text.length,level:1}],text);
 for(const evidence of input.evidence)assert.equal(text.slice(evidence.start,evidence.end),evidence.excerpt);
});
