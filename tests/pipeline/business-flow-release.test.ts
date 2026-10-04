import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSecEarningsRelease } from '../../workers/pipeline/src/sec/business-flow-release.ts';
import {extractDisclosedQuarters} from '../../workers/pipeline/src/financial-data/parser.ts';
// Actual SEC exhibit table excerpts fetched 2026-10-01, not synthetic amounts.
const html=readFileSync(new URL('./fixtures/orcl-2026-q4-sec-exhibit-tables.html',import.meta.url),'utf8');
const source={sourceUrl:'https://www.sec.gov/Archives/edgar/data/1341439/000119312526265848/orcl-ex99_1.htm',accession:'0001193125-26-265848'};
test('GAAP direct Q4 cells, six revenue leaves, eight nonduplicated expense leaves',()=>{
 const result=parseSecEarningsRelease(html,source);assert.equal(result.length,1);const q=result[0];
 assert.equal(q.start,'2026-03-01');assert.equal(q.end,'2026-05-31');
 assert.deepEqual(Object.fromEntries(Object.entries(q.financials).map(([k,v])=>[k,v.value/1e6])),{revenue:19184,totalOperatingExpenses:13051,operatingIncome:6133,interestExpense:1438,otherIncome:675,pretaxIncome:5370,taxExpense:1066,netIncome:4304});
 assert.deepEqual(Object.fromEntries(q.revenues.map(x=>[x.id,x.fact.value/1e6])),{SoftwareLicense:1881,SoftwareSupport:4943,HardwareRevenues:924,SalesRevenueServicesNet:1523,CloudApplications:4126,CloudInfrastructure:5787});
 assert.equal(q.expenses.length,8);assert.equal(q.expenses.reduce((s,x)=>s+x.fact.value,0),13051e6);assert.deepEqual(q.issues,[]);
 assert.equal(q.financials.grossProfit,undefined);assert.equal(q.expenses.some(x=>/stock/i.test(x.id)),false);
 assert.match(q.financials.revenue.lineage.contextId,/table-\d+:row-\d+:amount-0/);assert.equal(q.financials.revenue.lineage.sourceUrl,source.sourceUrl);
});
test('reject annual-only, non-GAAP, period mismatch, unknown dash values',()=>{
 assert.deepEqual(parseSecEarningsRelease(html,{...source,periodEnd:'2026-08-31'}),[]);
 assert.deepEqual(parseSecEarningsRelease(html.replaceAll('Three Months Ended','Year Ended'),source),[]);
 assert.deepEqual(parseSecEarningsRelease(html.replaceAll('Three Months Ended','Non-GAAP Three Months Ended'),source),[]);
 const changed=html.replace('19,184','—');assert.equal(parseSecEarningsRelease(changed,source).length,0);
});
test('values are dynamically read rather than substituted from expected amounts',()=>{
 const changed=html.replaceAll('19,184','19,185');const q=parseSecEarningsRelease(changed,source)[0];assert.equal(q.financials.revenue.value,19185e6);assert.ok(q.issues.includes('Revenue leaves do not reconcile'));
});

test('original FY2025 Q4 categories retain their disclosed meaning and reconcile a complete quarter',()=>{
 const historical=readFileSync(new URL('./fixtures/orcl-2025-q4-sec-operations-table.html',import.meta.url),'utf8');
 const oldSource={url:'https://www.sec.gov/Archives/edgar/data/1341439/000095017025084831/orcl-ex99_1.htm',accession:'0000950170-25-084831',filedAt:'2025-06-11',cik:'0001341439',industry:'standard' as const};
 const result=extractDisclosedQuarters(historical,oldSource);
 assert.deepEqual(result.issues,[]);assert.equal(result.quarters.length,1);
 const q=result.quarters[0];assert.equal(q.periodStart,'2025-03-01');assert.equal(q.periodEnd,'2025-05-31');
 assert.equal(q.figures.revenue?.value,'15903000000');assert.equal(q.figures.net?.value,'3427000000');
 assert.equal(q.expenseComponents?.length,9);assert.equal(q.expenseComponents?.find(c=>c.id==='CloudServicesAndLicenseSupportExpense')?.group,'direct');
 assert.equal(q.segmentsComplete,true);
 assert.deepEqual(q.segments.map(s=>[s.id,s.revenue?.value]),[
  ['CloudServicesAndLicenseSupportRevenues','11698000000'],['CloudLicenseAndOnPremiseLicenseRevenues','2007000000'],['hardware','850000000'],['services','1348000000'],
 ]);
 assert.equal(q.segments.some(s=>s.id==='cloud'||s.id==='software'),false,'historical combined labels cannot become new cloud/software categories');
 assert.equal(q.otherComponents?.find(c=>c.id==='nonoperating')?.amount.value,'20000000');
 assert.equal(q.sources[0].url,oldSource.url);assert.equal(q.figures.revenue?.basis,'reported');
 assert.equal(q.figures.gross,undefined,'a direct operating-cost statement does not disclose GAAP gross profit');
 const changed=historical.replaceAll('11,698','11,699');
 assert.equal(extractDisclosedQuarters(changed,oldSource).quarters.length,0,'inconsistent sums fail the existing gate');
});
