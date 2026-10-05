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
test("only fixed public reads occur, with no cookie or authentication forwarded",async()=>{
 const seen:Request[]=[];await loadPublicFlow("MSFT",async(input,init)=>{const req=new Request(input,init);seen.push(req);return success(input,init);});
 assert.equal(seen.length,1);assert.equal(seen[0].url,"https://spontra-app.max-zhangyuchen.workers.dev/api/analysis/v1/companies/MSFT/business-flow");assert.equal(seen[0].headers.get("authorization"),null);assert.equal(seen[0].headers.get("cookie"),null);
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
 const ok=await (await handle(request(endpoint),env,context,routed({schemaVersion:"business-explainer-response.v1",status:"ready",explainer}))).json() as {flow:unknown;explainer:{businesses:Array<{customers:unknown}>}};
 assert.ok(ok.flow);assert.equal(ok.explainer.businesses[0].customers,null,"a claim citing an unlisted source is dropped");assert.ok(!JSON.stringify(ok).includes("PRIVATE_"));
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
 const slots:Slot[]=["2026-02-28","2026-05-31","2026-08-31"].map(periodEnd=>({periodEnd,quarter:null}));
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
