import test from "node:test";
import assert from "node:assert/strict";
import { handle, loadGuidance, loadPublicFlow, type SiteEnv } from "../apps/business-site/worker/index";
import { guidanceLabel, guidanceOverlay, type Slot } from "../apps/business-site/src/trend-model";
import type { GuidanceItem, GuidancePublication } from "../shared/analysis-contract/guidance";
import {completeOrclFixture} from "./fixtures/complete-orcl-flow";
import { businessFlowFixture } from "./fixtures/business-flow-fixture";
const context={waitUntil:(promise:Promise<unknown>)=>{void promise;}};
const env:SiteEnv={ASSETS:{fetch:async()=>new Response("site shell")},PUBLIC_READ_LIMIT:{limit:async()=>({success:true})}};
const request=(path:string,method="GET")=>new Request("https://site.test"+path,{method});
const endpoint="/api/business/v1/companies/ORCL";
const publication=(flow:typeof completeOrclFixture)=>({schemaVersion:"complete-business-flow.v1",status:"ready",flow,reasons:[],outdated:false,lastAttemptAt:null});
const success:typeof fetch=async()=>Response.json({...publication(completeOrclFixture),overview:{privateNote:"PRIVATE_REPORT"},positions:["PRIVATE_POSITION"],latestRun:{secret:"PRIVATE_RUN"}});
test("new site's public projection strips analysis and nested unrecognized fields",async()=>{
 const polluted=structuredClone(completeOrclFixture) as typeof completeOrclFixture & {account:string};polluted.account="PRIVATE_ACCOUNT";
 Object.assign(polluted.quarters[0],{privateNote:"PRIVATE_QUARTER"});Object.assign(polluted.quarters[0].figures.net!,{privateNote:"PRIVATE_AMOUNT"});
 const response=await handle(request(endpoint),env,context,async()=>Response.json({...publication(polluted),overview:{privateNote:"PRIVATE_REPORT"}}));
 const text=await response.text();assert.equal(response.status,200);assert.ok(!text.includes("PRIVATE_"));assert.equal(JSON.parse(text).flow.quarters[0].figures.net.value,"4760000000");assert.deepEqual(Object.keys(JSON.parse(text)),["schemaVersion","status","flow","reasons","outdated","lastAttemptAt","history","explainer","guidance"]);
});
test("private paths, generation, query injection and writes are unavailable",async()=>{
 let calls=0;const never:typeof fetch=async()=>{calls++;throw new Error("must not run");};
 for(const path of ["/api/positions","/api/ibkr","/api/analysis/v1/companies/MSFT/analysis","/api/internal/sec/refresh/MSFT",endpoint+"?refresh=true","/api/business/v1/companies/../../positions"]){assert.equal((await handle(request(path),env,context,never)).status,404);}
 assert.equal((await handle(request(endpoint,"POST"),env,context,never)).status,405);assert.equal(calls,0);
});
test("limiter rejects excess requests and fails closed without a binding",async()=>{
 const blocked={...env,PUBLIC_READ_LIMIT:{limit:async()=>({success:false})}};assert.equal((await handle(request(endpoint),blocked,context,success)).status,429);
 assert.equal((await handle(request(endpoint),{...env,PUBLIC_READ_LIMIT:undefined} as unknown as SiteEnv,context,success)).status,429);
 const broken={...env,PUBLIC_READ_LIMIT:{limit:async()=>{throw new Error("broken");}}};assert.equal((await handle(request(endpoint),broken,context,success)).status,503);
});
test("reads go to the pipeline's read API over the named-entrypoint binding, with nothing from the browser's request forwarded",async()=>{
 const seen:Request[]=[];await loadPublicFlow("MSFT",async(input,init)=>{const req=new Request(input,init);seen.push(req);return success(input,init);});
 assert.equal(seen.length,1);assert.equal(seen[0].url,"https://spontra-analysis.internal/api/v1/companies/MSFT/business-flow");assert.equal(seen[0].headers.get("cookie"),null);assert.equal(seen[0].headers.get("authorization"),null);
 const {analysisFetcher}=await import("../apps/business-site/worker/index");
 const bound:Request[]=[];const binding={fetch:async(req:Request)=>{bound.push(req);return success(req);}};
 const browser=new Request("https://site.test"+endpoint,{headers:{cookie:"session=PRIVATE",authorization:"Bearer BROWSER"}});
 const answered=await handle(browser,{...env,EARNING_REPORT_PIPELINE:binding},context);
 assert.equal(answered.status,200);assert.equal(bound.length,3,"flow, explainer and guidance");
 for(const req of bound){assert.equal(req.headers.get("authorization"),null);assert.equal(req.headers.get("cookie"),null);assert.ok(req.url.startsWith("https://spontra-analysis.internal/api/v1/companies/ORCL"));}
 assert.equal(analysisFetcher({}),null);
 // Without the binding the data routes say so instead of reaching for a public origin.
 const unconfigured=await handle(request(endpoint),env,context);assert.equal(unconfigured.status,503);assert.equal(unconfigured.headers.get("cache-control"),"no-store");
 assert.equal((await handle(request("/"),env,context)).status,200,"the shell is served without the binding");
 // The deployed entry point reads over the binding, not a global fetch to a public origin.
 const worker=(await import("../apps/business-site/worker/index")).default;
 const viaWorker:Request[]=[];
 const served=await worker.fetch(request(endpoint+"/findings"),{...env,EARNING_REPORT_PIPELINE:{fetch:async(req:Request)=>{viaWorker.push(req);return Response.json({schemaVersion:"findings-response.v1",status:"preparing",findings:null});}}},context);
 assert.equal(served.status,200);assert.equal(viaWorker.length,1);assert.ok(viaWorker[0].url.startsWith("https://spontra-analysis.internal/api/v1/companies/ORCL/findings"));
});
test("missing quarters remain empty, upstream errors expose no detail, mismatched tickers never leak",async()=>{
 const empty=await handle(request("/api/business/v1/companies/NVDA"),env,context,success);assert.equal((await empty.json() as {flow:null}).flow,null);
 const broken=await handle(request(endpoint),env,context,async()=>{throw new Error("SECRET_UPSTREAM");});assert.equal(broken.status,503);assert.ok(!(await broken.text()).includes("SECRET"));assert.equal(broken.headers.get("cache-control"),"no-store");
});
test("public responses carry security headers and the independent asset shell",async()=>{
 const response=await handle(request(endpoint),env,context,success);assert.match(response.headers.get("content-security-policy")!,/connect-src 'self'/);assert.equal(response.headers.get("cache-control"),"public, max-age=60");assert.equal(response.headers.get("access-control-allow-origin"),null);
 const shell=await handle(request("/companies/ORCL"),env,context,success);assert.equal(await shell.text(),"site shell");assert.match(shell.headers.get("content-security-policy")!,/frame-ancestors 'none'/);
});

test("standalone represents expense reversals as sources and does not guess issuer CIK",async()=>{
 const {financialGraph}=await import("../lib/earning-report/web/business-flow-sankey");
 const base=structuredClone(businessFlowFixture.quarters[0]);base.incomeModel="direct_operating";base.figures.operatingExpenses={...base.figures.research!,value:"49404"};
 base.expenseComponents=[{id:"refund",name:"Expense reversal",group:"direct",amount:{...base.figures.research!,value:"-100"}},{id:"costs",name:"Other actual costs",group:"direct",amount:{...base.figures.research!,value:"49504"}}];
 base.otherComponents=[{id:"netOther",name:"Signed other income",amount:{...base.figures.other!}}];
 const {reconcileQuarter}=await import("../lib/earning-report/web/business-flow-model");assert.ok(reconcileQuarter(base).every(row=>row.status==="balanced"));
 const positive=structuredClone(base);positive.expenseComponents![0].amount.value="100";positive.expenseComponents![1].amount.value="49304";assert.ok(financialGraph(positive).links.length>0);
 const graph=financialGraph(base);assert.ok(graph.links.length>0);assert.equal(graph.nodes.find(n=>n.name==="expense:refund")?.amount?.value,"-100");assert.equal(graph.links.filter(l=>l.source==="expense:refund").reduce((sum,l)=>sum+l.value,0),100);
 const fs=await import("node:fs/promises");const model=await fs.readFile(new URL("../lib/earning-report/web/business-flow-model.ts",import.meta.url),"utf8");assert.ok(!model.includes("sourceAccession.slice(0, 10)"));assert.match(model,/sec\.gov\/edgar\/search/);
});

test("public business reading adds sourced context without altering financial amounts or periods",async()=>{
 const {withBusinessDescriptions}=await import("../apps/business-site/src/business-description");const {resolveCompanyBusiness}=await import("../lib/earning-report/web/company-business-content");
 const original=structuredClone(businessFlowFixture);original.ticker="ORCL";original.quarters[0].segments[0].id="cloud";const before=JSON.stringify(original.quarters[0].figures);const enhanced=withBusinessDescriptions(original,resolveCompanyBusiness("ORCL"));
 assert.equal(JSON.stringify(enhanced.quarters[0].figures),before);assert.equal(enhanced.quarters[0].periodEnd,original.quarters[0].periodEnd);assert.match(enhanced.quarters[0].segments[0].description,/2026-06-10/);assert.ok(enhanced.quarters[0].segments[0].products.includes("云应用"));assert.ok(enhanced.quarters[0].sources.some(source=>source.id==="orcl-fy26"));assert.ok(!original.quarters[0].sources.some(source=>source.id==="orcl-fy26"));assert.equal(withBusinessDescriptions(original,null),original);
});

test('legacy v2 signed-interest snapshots gain only the known sign formula and retain all amounts',async()=>{
 const legacy=structuredClone(completeOrclFixture);for(const q of legacy.quarters)for(const c of q.otherComponents??[])if(c.id==='interest')delete c.amount.formula;
 const result=await loadPublicFlow('ORCL',async()=>Response.json(publication(legacy)));assert.equal(result.status,'ready');assert.equal(result.flow!.quarters[0].figures.net!.value,legacy.quarters[0].figures.net!.value);
 const unknown=structuredClone(legacy);unknown.quarters[0].otherComponents![0].amount.lineage![0].concept='custom:UnknownExpense';assert.equal((await loadPublicFlow('ORCL',async()=>Response.json(publication(unknown)))).flow,null);
});

test("history passes through only when valid and for the same ticker",async()=>{
 const quarter={periodStart:"2026-06-01",periodEnd:"2026-08-31",currency:"USD",scale:1,revenue:"100",basis:"reported",segments:[{id:"cloud",name:"Cloud",value:"100",privateNote:"PRIVATE_SEGMENT"}],source:{accession:"0001193125-26-389274",url:"https://www.sec.gov/Archives/edgar/data/1341439/a.htm",filedAt:"2026-09-11",form:"10-Q"}};
 const withHistory=(history:unknown)=>(async()=>Response.json({...publication(completeOrclFixture),history})) as typeof fetch;
 const ok=await loadPublicFlow("ORCL",withHistory({schemaVersion:"revenue-history.v1",ticker:"ORCL",updatedAt:"2026-10-01",quarters:[quarter]}));
 assert.equal(ok.history!.quarters[0].revenue,"100");assert.ok(!JSON.stringify(ok).includes("PRIVATE_"));
 assert.equal((await loadPublicFlow("ORCL",withHistory({schemaVersion:"revenue-history.v1",ticker:"MSFT",updatedAt:"x",quarters:[quarter]}))).history,null);
 assert.equal((await loadPublicFlow("ORCL",withHistory({schemaVersion:"revenue-history.v1",ticker:"ORCL",updatedAt:"x",quarters:[{...quarter,revenue:"90"}]}))).history,null);
 assert.equal((await loadPublicFlow("ORCL",withHistory(undefined))).history,null);
});
const explainer={schemaVersion:"business-explainer.v1",ticker:"ORCL",companyName:"Oracle",generatedAt:"2026-10-04T00:00:00.000Z",model:"deepseek-flash",fingerprint:"fp",
 businesses:[{nodeId:"SoftwareLicense",name:"软件许可",summary:{text:"出售数据库等软件的使用权。",sourceIds:["s1"]},howItWorks:null,products:["Oracle Database"],customers:{text:"企业",sourceIds:["s404"]},monetization:null,relation:null,privateNote:"PRIVATE_FIELD"}],
 sources:[{id:"s1",title:"Oracle 10-K",url:"https://www.sec.gov/Archives/edgar/data/1341439/x.htm",kind:"sec",publishedAt:null}]};
const routed=(explained:unknown):typeof fetch=>async(input)=>String(input).endsWith("/business-explainer")?(explained instanceof Error?Promise.reject(explained):Response.json(explained)):success(input);
test("business explanations are validated, stripped and never block the flow",async()=>{
 const ok=await (await handle(request(endpoint),env,context,routed({schemaVersion:"business-explainer-response.v1",status:"ready",explainer}))).json() as {flow:unknown;explainer:{businesses:Array<{sections:unknown[]}>}};
 assert.ok(ok.flow);assert.deepEqual(ok.explainer.businesses[0].sections,[],"a claim citing an unlisted source is dropped");assert.ok(!JSON.stringify(ok).includes("PRIVATE_"));
 for(const bad of [new Error("down"),{schemaVersion:"business-explainer-response.v1",status:"ready",explainer:{...explainer,ticker:"MSFT"}},{schemaVersion:"business-explainer-response.v1",status:"ready",explainer:{...explainer,sources:[{...explainer.sources[0],url:"javascript:alert(1)"}]}}]){
  const response=await handle(request(endpoint),env,context,routed(bad));assert.equal(response.status,200);const body=await response.json() as {flow:unknown;explainer:unknown};assert.ok(body.flow);assert.equal(body.explainer,null);
 }
});

const guidanceItem=(over:Partial<GuidanceItem>):GuidanceItem=>({id:"i",metric:"revenue",measure:"amount",segment:null,label:"Total revenues",basis:"gaap",horizon:"quarter",form:"range",fiscalYear:2027,fiscalQuarter:2,periodEnd:"2026-11-30",unit:"USD",low:16.2e9,high:16.4e9,direction:null,derived:null,actual:null,text:"指引",quote:"we expect revenue of $16.2 billion to $16.4 billion",sourceIds:["m-1"],issuedAt:"2026-09-09",action:"initiated",previous:null,...over});
const guidancePublication=(items:GuidanceItem[]):GuidancePublication=>({schemaVersion:"guidance.v1",ticker:"ORCL",updatedAt:"2026-10-04",items,coverage:[],sources:[{id:"m-1",kind:"press_release",sourceKind:"sec",title:"Release",url:"https://www.sec.gov/x.htm",publishedAt:"2026-09-09"}]});
test("guidance is supplementary: a valid publication is served, anything else reads as null",async()=>{
 const valid=guidancePublication([guidanceItem({})]);
 assert.equal((await loadGuidance("ORCL",async()=>Response.json({schemaVersion:"guidance-response.v1",status:"ready",guidance:valid})))?.items.length,1);
 assert.equal(await loadGuidance("ORCL",async()=>Response.json({schemaVersion:"guidance-response.v1",status:"preparing",guidance:null})),null);
 assert.equal(await loadGuidance("ORCL",async()=>Response.json({schemaVersion:"guidance-response.v1",status:"ready",guidance:{...valid,ticker:"NET"}})),null);
 assert.equal(await loadGuidance("ORCL",async()=>{throw new Error("down");}),null);
});
test("quarterly revenue guidance lands on its quarter and the next one; longer horizons come from the latest event",()=>{
 const slots:Slot[]=["2026-02-28","2026-05-31","2026-08-31"].map(periodEnd=>({periodEnd,quarter:{periodStart:periodEnd,periodEnd,currency:"USD",scale:1,revenue:"100",basis:"reported",segments:[],source:{accession:"0001193125-26-389274",url:"https://www.sec.gov/Archives/edgar/data/1341439/a.htm",filedAt:periodEnd,form:"10-Q"}}}));
 const items=[
  guidanceItem({id:"old",periodEnd:"2026-08-31",low:14e9,high:14.2e9,issuedAt:"2026-03-10"}),
  guidanceItem({id:"later",periodEnd:"2026-08-31",low:14.1e9,high:14.3e9,issuedAt:"2026-06-11"}),
  guidanceItem({id:"growth",periodEnd:"2026-05-31",measure:"growth",unit:"percent",low:10,high:12,derived:{low:15e9,high:15.3e9,basePeriodEnd:"2025-05-31",base:13.6e9},issuedAt:"2026-03-10"}),
  guidanceItem({id:"next"}),
  guidanceItem({id:"fy",horizon:"annual",fiscalQuarter:null,periodEnd:"2027-05-31",measure:"growth",unit:"percent",low:16,high:17,action:"raised",previous:{low:15,high:16,issuedAt:"2026-06-11"}}),
  guidanceItem({id:"fy-old",horizon:"annual",fiscalQuarter:null,periodEnd:"2027-05-31",measure:"growth",unit:"percent",low:15,high:16,issuedAt:"2026-06-11"}),
  guidanceItem({id:"seg",metric:"segment_revenue",segment:"Cloud Infrastructure",periodEnd:"2026-11-30"}),
 ];
 const overlay=guidanceOverlay(slots,guidancePublication(items),null);
 assert.deepEqual(overlay.bySlot.map(m=>m?.item.id??null),[null,"growth","later"]);
 assert.equal(overlay.bySlot[1]!.derived,true);
 assert.equal(overlay.next?.item.id,"next");
 const cc = guidanceItem({id:"cc",basis:"constant_currency",measure:"growth",unit:"percent",low:30,high:34});
 const ccOverlay = guidanceOverlay(slots,guidancePublication([cc]),null);
 assert.equal(ccOverlay.next,null);
 assert.deepEqual(ccOverlay.outlook.map(i=>i.id),["cc"]);
 assert.deepEqual(overlay.outlook.map(i=>i.id),["fy"]);
 const segment=guidanceOverlay(slots,guidancePublication(items),{key:"k",id:"CloudInfrastructureRevenues",parent:null,name:"云基础设施",slot:1});
 assert.equal(segment.next?.item.id,"seg");
 assert.equal(guidanceOverlay(slots,null,null).next,null);
 const money=(v:number|null)=>`$${(v!/1e9).toFixed(1)}B`;
 assert.equal(guidanceLabel(items[4]!,money),"FY2027 收入增长 16%–17%");
 assert.equal(guidanceLabel(guidanceItem({metric:"eps",measure:"per_share",unit:"USD_per_share",basis:"non_gaap",low:1.46,high:1.5}),money),"FY2027 Q2 EPS $1.46–$1.50（非 GAAP）");
 assert.equal(guidanceLabel(guidanceItem({form:"qualitative",metric:"segment_revenue",segment:"OCI",direction:"up",low:null,high:null,unit:null,horizon:"long_term",fiscalYear:null}),money),"长期 OCI 收入预计上行");
});

test('report list preserves validated historical statements and strips private or wrong-company payloads',async()=>{
 const reports=structuredClone(completeOrclFixture);
 const old=structuredClone(reports.quarters[0]);
 const text=JSON.stringify(old).replaceAll('2026-06-01','2025-06-01').replaceAll('2026-08-31','2025-08-31');
 reports.quarters.push(JSON.parse(text));
 Object.assign(reports.quarters[2],{privateNote:'PRIVATE_REPORT'});
 const load=(value:unknown)=>loadPublicFlow('ORCL',async()=>Response.json({...publication(completeOrclFixture),reports:value}));
 const ok=await load(reports);
 assert.equal(ok.flow!.quarters.length,2);assert.equal(ok.reports!.quarters.length,3);
 assert.equal(ok.reports!.quarters[2].periodEnd,'2025-08-31');assert.ok(!JSON.stringify(ok).includes('PRIVATE_REPORT'));
 assert.equal((await load({...reports,ticker:'MSFT'})).reports,null);
 reports.quarters[2].figures.net!.value='1';
 assert.equal((await load(reports)).reports!.quarters.length,2);
});

test("findings and fundamentals are supplementary routes: re-validated, stripped, and never cached when absent",async()=>{
 const {loadFindings,loadFundamentals}=await import("../apps/business-site/worker/index");
 const {ORCL_FINDINGS}=await import("../workers/pipeline/src/findings/authored/ORCL");
 const seen:string[]=[];
 const upstream:typeof fetch=async(input,init)=>{const url=new Request(input,init).url;seen.push(url);
  if(url.endsWith("/findings"))return Response.json({schemaVersion:"findings-response.v1",status:"ready",findings:{...ORCL_FINDINGS,secret:"PRIVATE_FINDING"}});
  if(url.includes("/fundamentals"))return Response.json({ticker:"ORCL",source:"sec_xbrl",status:"ready",refresh:{secret:"PRIVATE_REFRESH"},series:[{metricKey:"net_income",label:"净利润",category:"income_statement",unitFamily:"currency",currency:"USD",available:true,unit:"USD",points:[{periodEnd:"2026-05-31",valueDecimal:"4304000000",revision:1}]}]});
  return success(input,init);};
 const findings=await handle(request(endpoint+"/findings"),env,context,upstream);const body=await findings.text();
 assert.equal(findings.status,200);assert.ok(!body.includes("PRIVATE_"));assert.equal(JSON.parse(body).findings.findings.length,6);assert.equal(findings.headers.get("cache-control"),"public, max-age=60");
 const fundamentals=await handle(request(endpoint+"/fundamentals"),env,context,upstream);const text=await fundamentals.text();
 assert.ok(!text.includes("PRIVATE_"));assert.deepEqual(Object.keys(JSON.parse(text).fundamentals),["series"]);assert.equal(JSON.parse(text).fundamentals.series[0].points[0].revision,undefined);
 assert.ok(seen.some(u=>u==="https://spontra-analysis.internal/api/v1/companies/ORCL/fundamentals?periodCount=12"));
 assert.equal(await loadFindings("MSFT",async()=>Response.json({schemaVersion:"findings-response.v1",status:"ready",findings:ORCL_FINDINGS})),null);
 assert.equal(await loadFundamentals("ORCL",async()=>Response.json({ticker:"ORCL",source:"yahoo_finance",status:"ready",series:[]})),null);
 const missing=await handle(request(endpoint+"/findings"),env,context,async()=>Response.json({schemaVersion:"findings-response.v1",status:"preparing",findings:null}));
 assert.equal((await missing.json() as {status:string}).status,"unavailable");assert.equal(missing.headers.get("cache-control"),"no-store");
 assert.equal((await handle(request(endpoint+"/findings?x=1"),env,context,upstream)).status,404);
});

test("a legacy fallback answer is served but never cached, so the next request retries the full read",async()=>{
 const put:string[]=[];const cache={match:async()=>undefined,put:async(key:Request)=>{put.push(key.url);}} as unknown as Cache;
 const waits:Promise<unknown>[]=[];const ctx={waitUntil:(p:Promise<unknown>)=>{waits.push(p);}};
 const fallback:typeof fetch=async(input)=>{const url=String(input);if(url.endsWith("/business-flow"))throw new Error("timeout");if(url.endsWith("/analysis"))return Response.json({businessFlow:completeOrclFixture});return new Response(null,{status:404});};
 const served=await handle(request(endpoint),env,ctx,fallback,cache);await Promise.all(waits);
 const body=await served.json() as {status:string;outdated:boolean;reasons:string[]};
 assert.equal(served.status,200);assert.equal(body.status,"ready");assert.equal(body.outdated,true);assert.deepEqual(body.reasons,["PREPARING"]);
 assert.equal(served.headers.get("cache-control"),"no-store");assert.deepEqual(put,[]);
 const fresh=await handle(request(endpoint),env,ctx,success,cache);await Promise.all(waits);
 assert.equal(fresh.headers.get("cache-control"),"public, max-age=60");assert.deepEqual(put,["https://site.test"+endpoint]);
});

test("filings are digested for the map: labels for metric keys, grouped sources, the report pin, and never the analysis envelope",async()=>{
 const {digestFiling,loadFilings,loadFilingDetail}=await import("../apps/business-site/worker/index");
 const filing={ticker:"ORCL",companyName:"Oracle",form:"10-Q",filingDate:"2026-09-11",reportDate:"2026-08-31",accessionNumber:"0001193125-26-389274",description:"10-Q",provenance:"sec_edgar",periodId:"ORCL:2026-08-31",analysisSchemaVersion:"sec-analysis.v2",contentRevision:"abc",analysisStatus:"complete",reportVersion:"sec-analysis.v2:abc",
  edgarUrl:"https://www.sec.gov/i/q1",documentUrl:"https://www.sec.gov/i/q1/10q.htm",analysisRun:{state:"succeeded",updatedAt:null,errorCode:null},
  fiscalPeriod:{fiscalYear:2027,fiscalPeriod:"Q1",periodEnd:"2026-08-31",source:"sec_dei",sourceAccession:"0001193125-26-389274",sourceUrl:"https://www.sec.gov/i/q1"},
  earningsGroup:{id:"g1",periodEnd:"2026-08-31",earningsDate:"2026-09-09",canonicalAccession:"0001193125-26-389274",inputKey:"k",sources:[{form:"8-K",filingDate:"2026-09-10",accessionNumber:"0001193125-26-389100",indexUrl:"https://www.sec.gov/i/k1",ticker:"ORCL",cik:"1",cikNumber:1,companyName:"Oracle",reportDate:"2026-09-09",primaryDocument:"",description:"",items:"2.02",documentUrl:"https://www.sec.gov/i/k1/8k.htm"}]},
  summary:{ticker:"ORCL",form:"10-Q",filingDate:"2026-09-11",accessionNumber:"0001193125-26-389274",headline:"云基础设施拉动增长",bullets:[{label:"收入",detail:"+12%",importance:"high"}],analystView:"看 RPO",report:"补充",source:"deepseek",generatedAt:"2026-09-12T00:00:00.000Z",nodes:[{id:"n",title:"PRIVATE_NODE",status:"complete",findings:[],narrative:"",evidence:[]}],discovery:{version:"sec-discovery.v1",totalCharacters:1,scannedCharacters:1,failedChunks:[],disclosures:[],warnings:["扫描未覆盖附件"]}},
  analysis:{ticker:"ORCL",periodId:"ORCL:2026-08-31",reportVersion:"sec-analysis.v2:abc",headline:"h",keyMetrics:[{metricKey:"revenue",currentValue:"14926000000",unit:"USD",currency:"USD",yoy:"+12.0%",qoq:"-3.1%",status:"verified",evidenceIds:["PRIVATE_EVIDENCE"]},{metricKey:"operating_margin",currentValue:"0.31",unit:"ratio",status:"derived",evidenceIds:[]}],
   changes:{qoq:[{topicKey:"cloud",changeType:"strengthened",currentStatement:"云收入加速",evidenceIds:[],materialityScore:1},{topicKey:"x",changeType:"not_mentioned",evidenceIds:[],materialityScore:0}],yoy:[],guidance:[{topicKey:"g",claimType:"guidance",statement:"FY27 云收入 +40%",direction:"positive",horizon:"next_period",materialityScore:1,confidence:"high",evidenceIds:[]}],risks:[]},
   dataQuality:{coverage:0.9,verificationStatus:"verified",warnings:[]},publication:{filing:{ticker:"ORCL",cik:"1",cikNumber:1,companyName:"Oracle",form:"10-Q",filingDate:"2026-09-11",reportDate:"2026-08-31",accessionNumber:"0001193125-26-389274",primaryDocument:"",description:"",items:"",documentUrl:"",indexUrl:""},summary:{secret:"PRIVATE_SUMMARY"}},reader:{secret:"PRIVATE_READER"}}};
 const digest=digestFiling(filing as never);
 assert.equal(digest.periodLabel,"FY2027 Q1");assert.equal(digest.date,"2026-09-09");assert.equal(digest.periodEnd,"2026-08-31");
 assert.deepEqual(digest.keyMetrics.map(m=>[m.label,m.value,m.yoy,m.status]),[["营收","149.26 亿美元","+12.0%","verified"],["营业利润率","31.0%",null,"derived"]]);
 assert.deepEqual(digest.changes,[{compare:"环比",topic:"cloud",statement:"云收入加速"}]);
 assert.deepEqual(digest.guidance,["FY27 云收入 +40%"]);assert.deepEqual(digest.warnings,["扫描未覆盖附件"]);
 assert.deepEqual(digest.snapshot,{accession:"0001193125-26-389274",reportDate:"2026-08-31",reportVersion:"sec-analysis.v2:abc"});
 assert.equal(digest.sources[0].indexUrl,"https://www.sec.gov/i/k1");assert.ok(!JSON.stringify(digest).includes("PRIVATE_"));
 const page={apiSchemaVersion:"analysis-api.v1",ticker:"ORCL",company:{ticker:"ORCL",name:"Oracle",cik:"1"},filings:[filing,{...filing,ticker:"MSFT"}],nextCursor:null,total:2,checkedAt:"2026-10-09T00:00:00.000Z"};
 const seen:string[]=[];const upstream:typeof fetch=async(input,init)=>{const url=new Request(input,init).url;seen.push(url);
  if(url.endsWith("/filings?limit=50"))return Response.json(page);
  if(/\/filings\/0001193125-26-389274\?reportDate=2026-08-31&reportVersion=sec-analysis.v2%3Aabc$/.test(url))return Response.json({apiSchemaVersion:"analysis-api.v1",ticker:"ORCL",company:page.company,filing,extra:"PRIVATE_EXTRA"});
  return new Response("missing",{status:404});};
 const list=await handle(request(endpoint+"/filings"),env,context,upstream);const body=await list.text();
 assert.equal(list.status,200);assert.equal(JSON.parse(body).filings.filings.length,1,"the wrong-company row is dropped");assert.ok(!body.includes("PRIVATE_"));assert.equal(list.headers.get("cache-control"),"public, max-age=60");
 assert.equal((await loadFilings("ORCL",async()=>Response.json({...page,ticker:"MSFT"}))),null);
 const detail=await handle(request(endpoint+"/filings/0001193125-26-389274?reportDate=2026-08-31&reportVersion=sec-analysis.v2%3Aabc"),env,context,upstream);const text=await detail.text();
 assert.equal(detail.status,200);assert.ok(!text.includes("PRIVATE_EXTRA"));assert.ok(text.includes("PRIVATE_READER"),"the reader passes through to the in-page report");
 assert.equal((await handle(request(endpoint+"/filings/0001193125-26-389274?other=1"),env,context,upstream)).status,404);
 assert.equal((await handle(request(endpoint+"/filings/not-an-accession"),env,context,upstream)).status,404);
 assert.equal(await loadFilingDetail("ORCL","0001193125-26-000000",null,upstream),null);
});
