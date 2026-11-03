import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deriveFourthQuarters} from '../src/financial-data/history.ts';
import {readReportedFacts, type DocumentSource, type Fact} from '../src/financial-data/parser.ts';
import {mergeHistory, readHistory} from '../../../shared/analysis-runtime/financial-data/history.ts';
import {enrichReleaseHistory} from '../../../shared/analysis-runtime/financial-data/earnings-release.ts';
import {withReleaseEps, buildSecFundamentals} from '../src/fundamentals/sec-fundamentals.ts';
import type {RevenueHistoryQuarter} from '../../../shared/analysis-contract/revenue-history.ts';
const source: DocumentSource = {cik:'0000000001',accession:'0000000001-26-000001',filedAt:'2026-02-01',url:'https://www.sec.gov/Archives/edgar/data/1/000000000126000001/report.htm',industry:'standard'};
const pair = (tag: string, annual: number, nine: number, dimensions: Record<string,string> = {}): Fact[] => [
  {source,tag,value:annual,start:'2025-01-01',end:'2025-12-31',context:'FY',currency:'USD',dimensions,precision:0},
  {source,tag,value:nine,start:'2025-01-01',end:'2025-09-30',context:'9M',currency:'USD',dimensions,precision:0},
];
const facts = () => [...pair('us-gaap:Revenues',1000,700), ...pair('us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax',600,400,{'us-gaap:StatementBusinessSegmentsAxis':'test:NorthMember'}), ...pair('us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax',410,305,{'us-gaap:StatementBusinessSegmentsAxis':'test:SouthMember'})];

test('FY minus nine months preserves disclosed reconciliation and operand lineage despite duplicate facts',()=>{
 const input=[...facts(),...pair('us-gaap:RevenueNotFromContractWithCustomer',-10,-5)];
 const q=deriveFourthQuarters([...input,...input,...input],source.cik)[0]!;
 assert.deepEqual(q.segments.map(s=>s.value),['200','105']);
 assert.equal(q.revenue,'300');
 assert.deepEqual(q.revenueAdjustments?.map(a=>[a.value,a.basis]),[['-5','derived']]);
 assert.deepEqual(q.revenueAdjustments?.[0].lineage?.map(l=>l.periodEnd),['2025-12-31','2025-09-30']);
 assert.match(q.revenueAdjustments?.[0].formula??'',/full fiscal year/);
});
test('unexplained Q4 residual is explicitly derived and sourced to every operand',()=>{
 const q=deriveFourthQuarters(facts(),source.cik)[0]!;
 assert.equal(q.revenueAdjustments?.[0].value,'-5');
 assert.equal(q.revenueAdjustments?.[0].basis,'derived');
 assert.match(q.revenueAdjustments?.[0].formula??'',/300 − segment revenue 305/);
 assert.equal(q.revenueAdjustments?.[0].lineage?.length,6);
 assert.equal(readHistory(mergeHistory('TEST',[],[q],source.filedAt),'TEST')?.quarters[0].revenueAdjustments?.[0].formula,q.revenueAdjustments?.[0].formula);
});
test('a missing member bridge cannot be hidden in a residual',()=>{
 const q=deriveFourthQuarters(facts().slice(0,-1),source.cik)[0];
 assert.ok(!q || q.segments.length===1);
});
test('history chooses a verified derived Q4 split over equal-revenue release placeholders in either order',()=>{
 const q=deriveFourthQuarters(facts(),source.cik)[0]!;
 const total={...q,basis:'reported' as const,source:{...q.source,form:'8-K'},segments:[{id:'reported-company-total',name:'Total',value:q.revenue}],revenueAdjustments:undefined};
 for(const list of [[q,total],[total,q]]) assert.deepEqual(mergeHistory('TEST',[],list,source.filedAt).quarters[0].segments,q.segments);
 assert.equal(mergeHistory('TEST',[],[q,{...total,revenue:'301',segments:[{...total.segments[0],value:'301'}]}],source.filedAt).quarters[0].segments.length,2); // near tolerance
 const different={...total,revenue:'2000000',segments:[{...total.segments[0],value:'2000000'}]};
 assert.equal(mergeHistory('TEST',[],[q,different],source.filedAt).quarters[0].source.form,'8-K');
});
const quarter: RevenueHistoryQuarter={periodStart:'2025-10-01',periodEnd:'2025-12-31',currency:'USD',scale:1e6,revenue:'300',basis:'reported',source:{...source,form:'8-K'},segments:[{id:'reported-company-total',name:'Total',value:'300'}]};
const anchor: RevenueHistoryQuarter={...quarter,periodStart:'2025-07-01',periodEnd:'2025-09-30',source:{...quarter.source,form:'10-Q'},segments:['North','South'].map((name,i)=>({id:name.toLowerCase(),name,value:String(i?100:200),lineage:[{accession:source.accession,url:source.url,concept:'us-gaap:Revenues',contextId:'segment',periodStart:'2025-07-01',periodEnd:'2025-09-30',parserVersion:'test',dimensions:{'us-gaap:StatementBusinessSegmentsAxis':`test:${name}Member`}}]}))};
const row=(name:string,values:string|number='')=>`<tr><td>${name}</td><td>${values}</td></tr>`;
const table=(body:string)=>`<p>In millions, except per share amounts</p><table>${row('','Three Months Ended December 31, 2025')}${body}</table>`;
const statement=()=>'<p>Consolidated statements of income</p>'+table(row('Revenue',300)+row('Net income',30)+row('Earnings per share')+row('Basic',1.75)+row('Diluted',1.5)+row('Weighted average shares')+row('Diluted',20));
const read=(html:string,known=[anchor])=>enrichReleaseHistory([{url:source.url,html}],quarter,known);

test('release block per segment reads net sales, not operating income',()=>{
 const result=read(statement()+table(row('North')+row('Net sales',200)+row('Operating income',20)+row('South')+row('Net sales',100)+row('Operating income',10)));
 assert.deepEqual(result.segments.map(s=>s.value),['200','100']);
});
test('release segment rows include signed eliminations and hedging before total, ignoring income block',()=>{
 for(const name of ['Intersegment eliminations','Hedging gains (losses)']){
  const result=read(statement()+table(row('North',200)+row('South',105)+row(name,'(5)')+row('Total net sales',300)+row('Operating income (loss)')+row('North',20)+row('South',10)));
  assert.deepEqual(result.segments.map(s=>s.value),['200','105']);
  assert.deepEqual(result.revenueAdjustments?.map(a=>a.value),['-5']);
 }
});
test('footnote chooses verified reportable segments over categories that also reconcile',()=>{
 const result=read(statement()+table(row('(1) Net sales by category:')+row('Products',250)+row('Services',50)+row('Total net sales',300)+row('(1) Net sales by reportable segment:')+row('North',200)+row('South',100)+row('Total net sales',300)));
 assert.deepEqual(result.segments.map(s=>s.name),['North','South']);
 assert.equal(read(statement()+table(row('North',200)+row('South',100)),[]).segments[0].id,'reported-company-total');
});
test('no segment table, unknown names, or mismatched amounts remain total-only',()=>{
 for(const extra of ['',table(row('Platform A',200)+row('Platform B',100)),table(row('North',200)+row('South',110))]) assert.equal(read(statement()+extra).segments[0].id,'reported-company-total');
});
test('quarterly diluted EPS keeps decimals, ignores annual/basic/share-count/non-GAAP rows, and fills only missing series points',async()=>{
 const q=read(statement());
 assert.equal(q.dilutedEps?.value,'1.5');assert.equal(q.dilutedEps?.basis,'reported');assert.equal(q.dilutedEps?.source.accession,source.accession);
 const history=withReleaseEps({registryVersion:'test',series:[]},[q]);
 assert.equal(history.series[0].quarters[0].value,'1.5');
 assert.equal(withReleaseEps(history,[{...q,dilutedEps:{...q.dilutedEps!,value:'99'}}]),history);
 const response=await buildSecFundamentals({registryVersion:'test',series:[]},{ticker:'TEST',metricKeys:['diluted_eps'],periodCount:4},null,new Date(),[q]);
 assert.equal(response.series[0].points.at(-1)?.valueDecimal,'1.5');
 assert.equal(response.series[0].points.at(-1)?.sourceAccession,source.accession);
 assert.equal(response.series[0].basis,'reported');
 const annual=statement().replace('Three Months Ended','Twelve Months Ended');assert.equal(read(annual).dilutedEps,undefined);
 const nonGaap=statement().replace('Consolidated','Non-GAAP Consolidated');assert.equal(read(nonGaap).dilutedEps,undefined);
});
test('reconciling revenue concepts are read without requiring a custom calculation linkbase',()=>{
 const html=`<xbrli:context id="c"><xbrli:entity><xbrli:identifier>1</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:startDate>2025-01-01</xbrli:startDate><xbrli:endDate>2025-12-31</xbrli:endDate></xbrli:period></xbrli:context><xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit><ix:nonFraction name="us-gaap:RevenueNotFromContractWithCustomer" contextRef="c" unitRef="usd" decimals="0" sign="-">10</ix:nonFraction>`;
 assert.equal(readReportedFacts(html,source).facts[0].value,-10);
});

test('percentage breakdowns with repeated names cannot displace the revenue block',()=>{
 const result=read(statement()+table(row('Market mix')+row('North','66</td><td>%')+row('South','34</td><td>%')+row('Net sales:')+row('North',200)+row('South',100)+row('Total net sales',300)+row('Operating income:')+row('North',20)+row('South',10)));
 assert.deepEqual(result.segments.map(s=>s.value),['200','100']);
});
test('a periodic Q4 split keeps independently reported release EPS whichever order is merged',()=>{
 const eps=read(statement()).dilutedEps;
 const q=deriveFourthQuarters(facts(),source.cik)[0]!;
 const release={...q,basis:'reported' as const,source:{...q.source,form:'8-K'},dilutedEps:eps,revenueAdjustments:undefined,segments:[{id:'reported-company-total',name:'Total',value:q.revenue}]};
 for(const list of [[q,release],[release,q]]){
  const got=mergeHistory('TEST',[],list,source.filedAt).quarters[0];
  assert.equal(got.basis,'derived');assert.equal(got.dilutedEps?.value,'1.5');assert.equal(got.dilutedEps?.basis,'reported');
 }
 assert.equal(q.dilutedEps,undefined);
});
test('reported Q1–Q3 retain their existing source ranking',()=>{
 const q={...anchor,fiscalQuarter:3 as const};
 const release={...q,source:{...q.source,form:'8-K'},segments:[{id:'reported-company-total',name:'Total',value:q.revenue}]};
 assert.equal(mergeHistory('TEST',[],[q,release],source.filedAt).quarters[0].source.form,'10-Q');
});
test('the fundamentals read path fills release EPS both with and without the Company Facts cache',async()=>{
 const {getSecFundamentals}=await import('../src/fundamentals/sec-fundamentals.ts');
 const {historyKey}=await import('../src/financial-data/history.ts');
 const q=read(statement());
 for(const cached of [true,false]){
  const payloads=new Map<string,unknown>([[historyKey(source.cik),mergeHistory('TEST',[],[q],source.filedAt)]]);
  if(cached)payloads.set('sec:fundamentals:TEST',{registryVersion:'test',series:[]});
  const database={prepare(sql:string){return {bind(key:unknown){return {
   async first<T>():Promise<T|null>{
    if(sql.includes('SELECT cik FROM sec_filings'))return {cik:source.cik} as T;
    const payload=payloads.get(String(key));return payload?{payload:JSON.stringify(payload),fetchedAt:source.filedAt} as T:null;
   },
   async all<T>():Promise<{results:T[]}>{return {results:[]};},
   async run(){throw new Error('read path must not write');},
  };}};}};
  const response=await getSecFundamentals(database,{ticker:'TEST',metricKeys:['diluted_eps'],periodCount:4});
  assert.equal(response.series[0].points.at(-1)?.valueDecimal,'1.5');
  assert.equal(response.series[0].points.at(-1)?.sourceAccession,source.accession);
 }
});

test('the sourced residual is only what remains after disclosed adjustments',()=>{
 const q=deriveFourthQuarters([...facts(),...pair('us-gaap:RevenueNotFromContractWithCustomer',-8,-5)],source.cik)[0]!;
 assert.deepEqual(q.revenueAdjustments?.map(a=>a.value),['-3','-2']);
 const residual=q.revenueAdjustments![1];
 assert.match(residual.formula??'',/disclosed adjustments -3 = -2/);
 assert.equal(residual.lineage?.length,8);
});

test('quarter-code EPS columns are dated from the release, including its prior-year Q4',()=>{
 const html=`<p>For the three months ended December 31, 2025.</p><p>Consolidated statements of income (in millions)</p><table><tr><td></td><td>4Q25</td><td>4Q24</td></tr><tr><td>Revenue</td><td>300</td><td>250</td></tr><tr><td>Net income</td><td>30</td><td>25</td></tr><tr><td>Diluted earnings per share</td><td>1.5</td><td>1.2</td></tr></table>`;
 const prior={...quarter,periodStart:'2024-10-01',periodEnd:'2024-12-31',revenue:'250',segments:[{id:'reported-company-total',name:'Total',value:'250'}]};
 assert.equal(read(html).dilutedEps?.value,'1.5');
 assert.equal(enrichReleaseHistory([{url:source.url,html}],prior,[anchor]).dilutedEps?.value,'1.2');
});
