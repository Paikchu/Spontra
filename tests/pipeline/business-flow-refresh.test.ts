import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseSecBusinessFlow} from '../../workers/pipeline/src/sec/business-flow-parser.ts';
import {parseSecEarningsRelease} from '../../workers/pipeline/src/sec/business-flow-release.ts';
import {buildPublishedBusinessQuarter,handleBusinessFlowRefresh,runBusinessFlowBootstrap} from '../../workers/pipeline/src/sec/business-flow-refresh.ts';
import type {SecPipelineEnv} from '../../workers/pipeline/src/operations.ts';
const current=parseSecBusinessFlow(readFileSync(new URL('./fixtures/orcl-2026-q1-sec-xbrl.html',import.meta.url),'utf8'),{sourceUrl:'https://www.sec.gov/Archives/edgar/data/1341439/000119312526389274/orcl-20260831.htm',accession:'0001193125-26-389274',periodEnd:'2026-08-31'})[0];
const previous=parseSecEarningsRelease(readFileSync(new URL('./fixtures/orcl-2026-q4-sec-exhibit-tables.html',import.meta.url),'utf8'),{sourceUrl:'https://www.sec.gov/Archives/edgar/data/1341439/000119312526265848/orcl-ex99_1.htm',accession:'0001193125-26-265848'})[0];
test('actual two SEC quarters publish exact revenue, eight expenses and signed other with traceable contexts',()=>{
 for(const [p,date,net] of [[current,'2026-09-11',4760e6],[previous,'2026-06-10',4304e6]] as const){const q=buildPublishedBusinessQuarter(p,date)!;assert.ok(q);assert.equal(q.incomeModel,'direct_operating');assert.equal(q.figures.net?.value,String(net));assert.equal(q.figures.gross,undefined);assert.equal(q.segments.length,4);assert.equal(q.expenseComponents?.length,8);assert.equal(q.segments.reduce((s,x)=>s+Number(x.revenue?.value),0),Number(q.figures.revenue?.value));assert.equal(q.otherComponents?.find(x=>x.id==='interest')?.amount.value,String(-p.financials.interestExpense.value));assert.equal(q.figures.net?.lineage?.[0].accession,p.financials.netIncome.lineage.accession);}
 const a=buildPublishedBusinessQuarter(current,'2026-09-11')!,b=buildPublishedBusinessQuarter(previous,'2026-06-10')!;assert.equal(a.figures.revenue?.comparabilityKey,b.figures.revenue?.comparabilityKey);
});
test('missing, inconsistent and partial records cannot replace a verified publication',()=>{
 assert.equal(buildPublishedBusinessQuarter({...current,issues:['bad equation']},'2026-09-11'),null);assert.equal(buildPublishedBusinessQuarter({...current,profile:'partial'},'2026-09-11'),null);const c=structuredClone(current);delete c.financials.interestExpense;assert.equal(buildPublishedBusinessQuarter(c,'2026-09-11'),null);
});
test('deterministic refresh requires existing authorization and bootstrap is opt-in',async()=>{
 assert.equal((await handleBusinessFlowRefresh(new Request('https://example.com/sec-financials/refresh/ORCL',{method:'POST'}),{} as SecPipelineEnv)).status,401);assert.deepEqual(await runBusinessFlowBootstrap({} as SecPipelineEnv),{results:[]});
});
