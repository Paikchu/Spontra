import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEarningsGroups, combineEarningsDocuments, identifyEarningsPeriod } from '../../workers/pipeline/src/sec/earnings.ts';
import { D1SecRepository } from '../../workers/pipeline/src/sec/d1.ts';
import { getPublicFiling, getPublicFilingPage } from '../../workers/pipeline/src/sec/public-api.ts';
import { FILING_PAGE_SCHEMA, FILING_DETAIL_SCHEMA } from '../../workers/pipeline/src/read-api/contract-support/schema.ts';
import { validateJsonSchema } from '../../workers/pipeline/src/read-api/contract-support/json-schema.ts';
import { createAnalysisDatabase } from './helpers/analysis-backend.ts';
import type { SecFiling } from '../../shared/analysis-contract/report.ts';
import type { PreparedSecFiling } from '../../workers/pipeline/src/sec/pipeline.ts';

const filing = (accessionNumber: string, form: string, filingDate: string, reportDate: string): SecFiling => ({
  ticker: 'ORCL', cik: '0001341439', cikNumber: 1341439, companyName: 'Oracle', form, filingDate, reportDate, accessionNumber,
  primaryDocument: 'orcl.htm', description: form, items: '', documentUrl: `https://www.sec.gov/${accessionNumber}/orcl.htm`, indexUrl: `https://www.sec.gov/${accessionNumber}/index.htm`,
});
const release = filing('0001193125-26-387905', '8-K', '2026-09-10', '2026-09-10');
const quarterly = filing('0001193125-26-389274', '10-Q', '2026-09-11', '2026-08-31');
const executive = filing('0001193125-26-389275', '8-K', '2026-09-11', '2026-09-11');
const prepared = (source: SecFiling, text: string): PreparedSecFiling => ({ filing: source, document: {text, headings: [{title:source.form,start:0,level:1}]},
  blocks: [{blockId:source.accessionNumber, heading:source.form,body:text,preview:text,start:0,end:text.length}],
  blockIds: [source.accessionNumber], periodId: 'ORCL:2026-08-31:quarter', periodScope: 'quarter', outline: [],
  sourceMaterials: [{type:source.form,filename:'orcl.htm',url:source.documentUrl,status:'read'}],
});
const periods = () => new Map([[release.accessionNumber,'2026-08-31'],[quarterly.accessionNumber,'2026-08-31'],[executive.accessionNumber,null]]);

test('same fiscal period groups different filing dates; management event stays separate', () => {
  const grouped = buildEarningsGroups([quarterly,executive,release],periods());
  assert.equal(grouped[0].earningsGroup?.canonicalAccession,quarterly.accessionNumber);
  assert.equal(grouped[2].earningsGroup?.id,'ORCL:2026-08-31');
  assert.equal(grouped[0].earningsGroup?.earningsDate,'2026-09-10');
  assert.equal(grouped[1].earningsGroup,undefined);
  assert.equal(grouped[2].reportDate,'2026-09-10','original SEC event date is preserved');
});

test('year-end results merge with annual filing, other quarters and tickers do not', () => {
  const annual = {...quarterly, form:'10-K'};
  const prior = {...release,accessionNumber:'prior',reportDate:'2026-05-31'};
  const other = {...release,accessionNumber:'other',ticker:'MSFT'};
  const p = periods();p.set('prior','2026-05-31');p.set('other','2026-08-31');
  const grouped = buildEarningsGroups([annual,release,prior,other],p);
  assert.equal(grouped[0].earningsGroup?.sources.length,2);
  assert.equal(grouped[2].earningsGroup?.sources.length,1);
  assert.notEqual(grouped[3].earningsGroup?.id,grouped[0].earningsGroup?.id);
});

test('date classification requires source evidence, rejects future dates and standalone events', async () => {
  const source = prepared(release,'Financial results for the quarter ended August 31, 2026.');
  assert.equal(await identifyEarningsPeriod(source,async () => ({isEarnings:true,periodEnd:'2026-08-31',dateQuote:source.document.text})),'2026-08-31');
  assert.equal(await identifyEarningsPeriod(source,async () => ({isEarnings:true,periodEnd:'2026-09-10',dateQuote:source.document.text})),null);
  assert.equal(await identifyEarningsPeriod(source,async () => ({isEarnings:true,periodEnd:'2026-08-31',dateQuote:'invented'})),null);
  assert.equal(await identifyEarningsPeriod(prepared(executive,'Appointment of a new CEO.'),async () => {throw new Error('must not call model');}),null);
  assert.equal(await identifyEarningsPeriod(source,async () => ({isEarnings:false,periodEnd:null,dateQuote:''})),null);
});

test('merging adds source text, preserves unique evidence and offsets every span', () => {
  const combined=combineEarningsDocuments(prepared(quarterly,'Quarterly report'),[prepared(release,'Earnings release')]);
  assert.equal(combined.document.text,'Quarterly report\n\nEarnings release');
  assert.equal(combined.blocks[1].start,18);
  assert.equal(combined.document.text.slice(combined.blocks[1].start,combined.blocks[1].end),'Earnings release');
  assert.equal(combined.document.headings[1].start,18);
  assert.equal(combined.sourceMaterials?.length,2);
  assert.equal(new Set(combined.blockIds).size,2);
});

test('D1 grouped paging/count and old release links resolve one report, with initial summary retained',async () => {
  const db=await createAnalysisDatabase();const repo=new D1SecRepository(db);
  const initial=buildEarningsGroups([release],periods());await repo.saveEarningsGroups(initial);
  await repo.setSummary(release,{ticker:'ORCL',form:'8-K',filingDate:release.filingDate,accessionNumber:release.accessionNumber,
    headline:'Initial earnings',bullets:[],analystView:'',report:'Initial report',source:'deepseek',generatedAt:'2026-09-10T22:00:00Z',earningsGroup:initial[0].earningsGroup});
  assert.equal(await repo.countPublicFilings('ORCL'),1);
  await repo.saveEarningsGroups(buildEarningsGroups([quarterly,release,executive],periods()));
  assert.equal(await repo.countPublicFilings('ORCL'),2);
  const first=await getPublicFilingPage(repo,'ORCL',null,'1');
  assert.equal(first.filings[0].accessionNumber,executive.accessionNumber);
  const second=await getPublicFilingPage(repo,'ORCL',first.nextCursor,'1');
  assert.equal(second.filings[0].accessionNumber,quarterly.accessionNumber);
  assert.equal(second.filings[0].summary?.headline,'Initial earnings');
  assert.equal(second.nextCursor,null);
  assert.deepEqual(validateJsonSchema(FILING_PAGE_SCHEMA,second),[]);
  const oldLink=await getPublicFiling(repo,'ORCL',release.accessionNumber);
  assert.equal(oldLink?.filing.accessionNumber,quarterly.accessionNumber);
  assert.equal(oldLink?.filing.earningsGroup?.sources.length,2);
  assert.deepEqual(validateJsonSchema(FILING_DETAIL_SCHEMA,oldLink),[]);
  const standalone=await getPublicFiling(repo,'ORCL',executive.accessionNumber);
  assert.equal(standalone?.filing.earningsGroup,undefined);
  db.raw.close();
});

test('new source invalidates a completed report once; matching input does not repeatedly regenerate',async () => {
  const {createSecPipelineOperations} = await import('../../workers/pipeline/src/operations.ts');
  const db=await createAnalysisDatabase();const repo=new D1SecRepository(db);
  const source=buildEarningsGroups([quarterly,release],periods())[0];
  await repo.upsertAnalysisJob({jobId:'done',ticker:'ORCL',accessionNumber:quarterly.accessionNumber,analysisVersion:'sec-analysis.v3',status:'complete',currentStage:'published',attempt:1,requestedBy:'cron',workflowInstanceId:'old',updatedAt:'2026-09-11T22:00:00Z'});
  const ops=createSecPipelineOperations({DB:db,SEC_TRACKED_TICKERS:'ORCL'} as never);
  assert.equal(await ops.shouldAnalyze(source,'cron'),true);
  await repo.setSummary(quarterly,{ticker:'ORCL',form:'10-Q',filingDate:quarterly.filingDate,accessionNumber:quarterly.accessionNumber,headline:'Merged',bullets:[],analystView:'',source:'deepseek',generatedAt:'2026-09-11T22:00:00Z',earningsGroup:source.earningsGroup});
  assert.equal(await ops.shouldAnalyze(source,'cron'),false);
  assert.equal(await ops.shouldAnalyze(source,'manual'),true);
  db.raw.close();
});

test('an older discovery cannot split a merged report back into its initial release',async () => {
  const db=await createAnalysisDatabase();const repo=new D1SecRepository(db);
  await repo.saveEarningsGroups(buildEarningsGroups([quarterly,release],periods()));
  await repo.saveEarningsGroups(buildEarningsGroups([release],periods()));
  assert.equal(await repo.countPublicFilings('ORCL'),1);
  assert.equal((await repo.getPublicFiling('ORCL',release.accessionNumber))?.accessionNumber,quarterly.accessionNumber);
  db.raw.close();
});

test('production preparation sends both raw filings to the shared document and keeps source links',async () => {
  const {createSecPipelineOperations} = await import('../../workers/pipeline/src/operations.ts');
  const stored=new Map<string,string>();
  const ops=createSecPipelineOperations({SEC_USER_AGENT:'test@example.com',SEC_FILINGS:{async put(key:string,value:string){stored.set(key,value);},async get(){return null;}}} as never,
    async (input) => {
      const url=String(input);
      if (url.endsWith('.txt')) return new Response('Unavailable',{status:404});
      if (url.includes('/companyfacts/')) return Response.json({facts:{}});
      return new Response(url.includes(quarterly.accessionNumber)?'<h1>Quarterly Results</h1><p>Quarterly filing unique evidence.</p>':'<h1>Earnings Release</h1><p>Release unique evidence.</p>');
    });
  const source=buildEarningsGroups([quarterly,release],periods())[0];
  const reference=await ops.prepare(source);
  const text=JSON.parse(stored.get(`${reference.key}/text.json`)!);
  const meta=JSON.parse(stored.get(`${reference.key}/meta.json`)!);
  assert.match(text.document.text,/Quarterly filing unique evidence/);
  assert.match(text.document.text,/Release unique evidence/);
  assert.equal(meta.sourceMaterials.length,2);
  assert.equal(meta.filing.earningsGroup.inputKey,source.earningsGroup?.inputKey);
  assert.ok(meta.outline.some((section:{title:string})=>section.title==='Earnings Release'));
});

test('a newly indexed amendment retains the last full report and pinned snapshots remain original',async () => {
  const db=await createAnalysisDatabase();const repo=new D1SecRepository(db);
  const original=buildEarningsGroups([quarterly,release],periods())[0];
  const summary={ticker:'ORCL',form:'10-Q',filingDate:quarterly.filingDate,accessionNumber:quarterly.accessionNumber,headline:'Existing merged report',bullets:[],analystView:'',report:'Last successful full analysis',source:'deepseek' as const,generatedAt:'2026-09-11T22:00:00Z',earningsGroup:original.earningsGroup};
  const report={ticker:'ORCL',periodId:'ORCL:2026-08-31:quarter',reportVersion:'sec-analysis.v3:pinned-original',headline:summary.headline,keyMetrics:[],changes:{qoq:[],yoy:[],guidance:[],risks:[]},dataQuality:{coverage:1,verificationStatus:'verified',warnings:[]},publication:{filing:original,summary}};
  db.raw.prepare('INSERT INTO sec_published_reports(ticker,period_id,report_version,payload,verification_status,generated_at) VALUES(?,?,?,?,?,?)')
    .run('ORCL',report.periodId,report.reportVersion,JSON.stringify(report),'verified',summary.generatedAt);
  const amendment={...quarterly,form:'10-Q/A',accessionNumber:'0001193125-26-399999',filingDate:'2026-09-12'};
  const p=periods();p.set(amendment.accessionNumber,'2026-08-31');
  await repo.saveEarningsGroups(buildEarningsGroups([amendment,quarterly,release],p));
  const current=await getPublicFiling(repo,'ORCL',release.accessionNumber);
  assert.equal(current?.filing.summary?.report,'Last successful full analysis');
  assert.equal(current?.filing.earningsGroup?.sources.length,3);
  const pinned=await getPublicFiling(repo,'ORCL',quarterly.accessionNumber,{reportDate:'2026-08-31',reportVersion:report.reportVersion});
  assert.equal(pinned?.filing.earningsGroup?.sources.length,2);
  assert.equal(pinned?.filing.accessionNumber,quarterly.accessionNumber);
  db.raw.close();
});
