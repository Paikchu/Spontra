import test from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';
import{readReportedFacts,extractVerifiedCurrentQuarters,type DocumentSource,type Fact}from'../../workers/pipeline/src/financial-data/parser.ts';
import{reviewedCurrentPair,priorPresentationOnly}from'../../workers/pipeline/src/financial-data/period-review.ts';
import{readIncomeStatementCells}from'../../shared/analysis-runtime/financial-data/income-statement.ts';
import type{FinancialStatements,StatementCell}from'../../shared/analysis-runtime/financial-data/financial-statements.ts';
import{checkCompleteFlow}from'../../shared/analysis-runtime/financial-data/completeness.ts';

const fixture=(file:string)=>readFileSync(new URL('./fixtures/'+file,import.meta.url),'utf8');
const days=(f:Fact)=>(Date.parse(f.end)-Date.parse(f.start))/86400000;
const crwv=[
 {file:'crwv-2026-06-30-sec-income.html',accession:'0001769628-26-000366',url:'https://www.sec.gov/Archives/edgar/data/1769628/000176962826000366/crwv-20260630.htm',filedAt:'2026-08-12'},
 {file:'crwv-2026-03-31-sec-income.html',accession:'0001769628-26-000222',url:'https://www.sec.gov/Archives/edgar/data/1769628/000176962826000222/crwv-20260331.htm',filedAt:'2026-05-08'},
];
const components=(q:{expenseComponents?:Array<{id:string;name:string;group:string;amount:{value:string}}>})=>q.expenseComponents!.map(c=>[c.id,c.name,c.group,c.amount.value]);

test('CRWV operating expenses follow the face statement, not the R&D note included in technology and infrastructure',()=>{
 const facts:Fact[]=[],documents=[];
 for(const f of crwv){const html=fixture(f.file),source:DocumentSource={url:f.url,accession:f.accession,filedAt:f.filedAt,cik:'0001769628',industry:'standard'};const read=readReportedFacts(html,source);assert.deepEqual(read.issues,[]);facts.push(...read.facts);documents.push({source,eligible:priorPresentationOnly(html)});}
 // The note discloses R&D for the quarter; the statement has no such line.
 assert.ok(facts.some(f=>f.tag==='us-gaap:ResearchAndDevelopmentExpense'&&f.end==='2026-06-30'&&days(f)<110&&f.value===117e6&&!f.statementRow));
 const review=reviewedCurrentPair(facts,'2026-06-30',documents);
 assert.equal(review.reviewed,true);
 const [current,previous]=review.quarters.sort((a,b)=>b.periodEnd.localeCompare(a.periodEnd));
 assert.deepEqual(components(current),[
  ['TechnologyAndInfrastructure','Technology and infrastructure','other','1507000000'],
  ['SellingAndMarketingExpense','Sales and marketing','sales','60000000'],
  ['GeneralAndAdministrativeExpense','General and administrative','administration','178000000'],
 ]);
 assert.equal(current.figures.operatingExpenses!.value,'1745000000');
 assert.equal(current.expenseComponents![0].amount.lineage![0].concept,'crwv:TechnologyAndInfrastructure');
 assert.equal(current.figures.research,undefined);
 assert.equal(current.figures.sales!.value,'60000000');
 assert.deepEqual(components(previous).map(c=>c[3]),['1273000000','69000000','164000000']);
 assert.deepEqual(checkCompleteFlow({schemaVersion:'business-flow.v1',ticker:'CRWV',fetchedAt:null,quarters:[current,previous]}),{complete:true,reasons:[]});
});

test('lines that do not add up to the operating expense total keep the reported total',()=>{
 const f=crwv[0],source:DocumentSource={url:f.url,accession:f.accession,filedAt:f.filedAt,cik:'0001769628',industry:'standard'};
 const facts=readReportedFacts(fixture(f.file),source).facts.filter(x=>x.end==='2026-06-30'&&days(x)<110)
  .map(x=>x.tag==='crwv:TechnologyAndInfrastructure'?{...x,value:x.value+1e6}:x);
 const [q]=extractVerifiedCurrentQuarters(source,facts).quarters;
 assert.deepEqual(components(q),[['reported-expense-total','财报成本费用合计','other','1745000000']]);
});

test('AAPL keeps research and development and combined SG&A as printed on the statement',()=>{
 const source:DocumentSource={url:'https://www.sec.gov/Archives/edgar/data/320193/000032019326000020/aapl-20260627.htm',accession:'0000320193-26-000020',filedAt:'2026-07-31',cik:'0000320193',industry:'standard'};
 const facts=readReportedFacts(fixture('aapl-2026-06-27-sec-income.html'),source).facts.filter(f=>f.end==='2026-06-27'&&days(f)<110);
 const [q]=extractVerifiedCurrentQuarters(source,facts).quarters;
 assert.deepEqual(components(q),[
  ['ResearchAndDevelopmentExpense','Research and development','research','11729000000'],
  ['SellingGeneralAndAdministrativeExpense','Selling, general and administrative','other','7346000000'],
 ]);
 assert.equal(q.figures.operatingExpenses!.value,'19075000000');
 assert.equal(q.figures.research!.value,'11729000000');
});

test('statements printing expenses as deductions reconcile with the opposite orientation',()=>{
 const source:DocumentSource={url:'https://www.sec.gov/Archives/edgar/data/1/000000000126000001/x.htm',accession:'0000000001-26-000001',filedAt:'2026-08-01',cik:'0000000001',industry:'standard'};
 const fact=(tag:string,value:number,order:number,label:string,flip=false):Fact=>({source,precision:-6,tag,value,currency:'USD',start:'2026-04-01',end:'2026-06-30',context:'c-'+order,dimensions:{},statementRow:{order,label,flip}});
 const facts=[fact('us-gaap:Revenues',1000e6,1,'Revenue'),fact('us-gaap:CostOfRevenue',400e6,2,'Cost of revenue',true),fact('us-gaap:GrossProfit',600e6,3,'Gross profit'),
  fact('us-gaap:ResearchAndDevelopmentExpense',200e6,4,'Research and development',true),fact('acme:PlatformOperations',150e6,5,'Platform operations',true),
  fact('us-gaap:GainLossOnSaleOfPropertyPlantEquipment',10e6,6,'Gain on sale of assets'),fact('us-gaap:OperatingExpenses',340e6,7,'Total operating expenses',true),
  fact('us-gaap:OperatingIncomeLoss',260e6,8,'Operating income'),fact('us-gaap:IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',260e6,9,'Income before taxes'),
  fact('us-gaap:IncomeTaxExpenseBenefit',60e6,10,'Income taxes'),fact('us-gaap:NetIncomeLoss',200e6,11,'Net income')];
 const [q]=extractVerifiedCurrentQuarters(source,facts).quarters;
 assert.deepEqual(components(q),[
  ['ResearchAndDevelopmentExpense','Research and development','research','200000000'],
  ['PlatformOperations','Platform operations','other','150000000'],
  ['GainLossOnSaleOfPropertyPlantEquipment','Gain on sale of assets','other','-10000000'],
 ]);
});

test('statement cells skip facts quoted in the caption and accept a dimensional fact printed as the amount',()=>{
 const period={kind:'duration' as const,start:'2026-04-01',end:'2026-06-30'};
 const f=(id:string,concept:string,value:string,dimensions:StatementCell['facts'][number]['dimensions']=[])=>({id,concept,value,status:'parsed',period,unit:'iso4217:USD',scale:'6',dimensions});
 const cell=(column:number,text:string,facts:StatementCell['facts']=[]):StatementCell=>({column,rowSpan:1,colSpan:1,header:false,text,locator:{start:0,end:0,elementId:null},facts});
 const statements={status:'extracted',tables:[
  {id:'t1',title:'',section:'1. Basis of presentation',precedingText:'',locator:{start:0,end:0,elementId:null},columns:2,issues:[],rows:[{cells:[cell(0,'Operating income'),cell(1,'1',[f('n1','us-gaap:OperatingIncomeLoss','1000000')])]}]},
  {id:'t2',title:'',section:'Condensed Consolidated Statements of Operations',precedingText:'',locator:{start:0,end:0,elementId:null},columns:2,issues:[],rows:[
   {cells:[cell(0,'Research and development (includes $5 of stock-based compensation)',[f('q1','us-gaap:ShareBasedCompensation','5000000')]),cell(1,'90',[f('a1','us-gaap:ResearchAndDevelopmentExpense','90000000')])]},
   {cells:[cell(0,'Partner services'),cell(1,'(12)',[f('a2','us-gaap:Revenues','12000000',[{axis:'srt:ProductOrServiceAxis',value:'acme:PartnerMember'}])])]},
   {cells:[cell(0,'Operating income'),cell(1,'78',[f('a3','us-gaap:OperatingIncomeLoss','78000000')])]},
   {cells:[cell(0,'Net income'),cell(1,'60',[f('a4','us-gaap:NetIncomeLoss','60000000')])]},
  ]}]} as unknown as FinancialStatements;
 assert.deepEqual(readIncomeStatementCells(statements).map(c=>[c.order,c.label,c.factId,c.flip]),[
  [0,'Research and development (includes $5 of stock-based compensation)','a1',false],[1,'Partner services','a2',true],[2,'Operating income','a3',false],
 ]);
});
