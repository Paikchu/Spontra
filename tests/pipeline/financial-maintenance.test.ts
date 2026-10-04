import assert from "node:assert/strict";
import test from "node:test";
import { createAnalysisDatabase, ReadOnlyGuardDatabase } from "./helpers/analysis-backend.ts";
import { createAdminSession } from "../../workers/pipeline/src/admin/auth.ts";
import { handleFinancialAdminRequest } from "../../workers/pipeline/src/admin/financials.ts";
import { FinancialMaintenanceStore, MAINTENANCE_LEASE_MS } from "../../workers/pipeline/src/admin/financial-maintenance-store.ts";
import { maintenanceAnalysisEnvironment, runFinancialMaintenanceTick, type MaintenanceDependencies } from "../../workers/pipeline/src/admin/financial-maintenance-runner.ts";
import { claimJob } from "../../workers/pipeline/src/financial-data/queue.ts";
import type { SecPipelineEnv } from "../../workers/pipeline/src/operations.ts";
import type { FinancialMaintenanceCompanyDetail, FinancialMaintenanceCompanyList } from "../../shared/analysis-contract/financial-maintenance.ts";
import { completeOrclFixture } from "../fixtures/complete-orcl-flow.ts";
import { historyFromSnapshot } from "../../shared/analysis-runtime/financial-data/history.ts";
import { HISTORY_VERSION, runHistoryStep } from "../../workers/pipeline/src/financial-data/history.ts";

async function fixture() {
  const database = await createAnalysisDatabase(), secret = "maintenance-test-secret", objects = new Map<string,string>();
  const token = await createAdminSession(secret);
  const env = { DB: database as unknown as D1Database, REPORT_ADMIN_PASSWORD: secret, SEC_REFRESH_KEY: "different-internal-key",
    SEC_AI_ENABLED: "false", SEC_DATA_TICKERS: "ORCL", SEC_TRACKED_TICKERS: "MSFT", SEC_USER_AGENT: "test@example.com",
    SEC_FILINGS: { async get(key: string) { const text = objects.get(key); return text ? { async text() { return text; } } : null; }, async put(key:string, value:string) { objects.set(key,value); } },
    SEC_ANALYSIS_WORKFLOW: { async create(options: { id: string }) { return { id: options.id }; }, async get() { return { async status() { return { status: "complete" }; } }; } },
  } as SecPipelineEnv;
  const request = (path: string, init: RequestInit={}) => new Request(`https://pipeline.test/admin/financials/${path}`, { ...init,
    headers: { authorization: `Bearer ${token}`, ...init.headers } });
  const action = (ticker="ORCL", requestId=crypto.randomUUID(), type="extract", extra: object={}) => handleFinancialAdminRequest(request(`companies/${ticker}/actions`,
    { method:"POST", body:JSON.stringify({ action:type, requestId, ...extra }) }), env);
  return { database, env, objects, request, action };
}

test("maintenance auth rejects public read credentials, refresh credentials, anonymous writes and methods", async()=>{
  const f=await fixture();
  try {
    for (const headers of [{}, {authorization:"Bearer public-reader.token"}, {"x-sec-refresh-key":f.env.SEC_REFRESH_KEY}]) {
      const response=await handleFinancialAdminRequest(new Request("https://pipeline.test/admin/financials/companies/ORCL/actions", {method:"POST",headers}),f.env);
      assert.equal(response.status,401);
    }
    assert.equal((await handleFinancialAdminRequest(f.request("companies",{method:"POST"}),f.env)).status,405);
    assert.equal(f.database.raw.prepare("SELECT count(*) count FROM financial_maintenance_tasks").get()!.count,0);
  } finally { f.database.close(); }
});

test("repeat and concurrent clicks are idempotent and different intent cannot reuse a request id", async()=>{
  const f=await fixture();
  try {
    const id=crypto.randomUUID();
    const [a,b]=await Promise.all([f.action("ORCL",id),f.action("ORCL",id)]);
    assert.equal(a.status,202);assert.equal(b.status,202);
    const first=await a.json() as {task:{id:string}};
    assert.equal(first.task.id,id);
    const different=await f.action("MSFT",id);assert.equal(different.status,409);
    const collisions=await Promise.all([f.action(),f.action()]);assert.deepEqual(collisions.map(r=>r.status),[409,409]);
    const read=await handleFinancialAdminRequest(f.request(`tasks/${id}`),f.env);assert.equal(read.status,200);
    assert.equal((await read.json() as {task:{status:string}}).task.status,"queued");
    assert.equal(f.database.raw.prepare("SELECT count(*) count FROM financial_maintenance_tasks").get()!.count,1);
  } finally { f.database.close(); }
});

test("same request id racing across companies never returns another company's task", async()=>{
  const f=await fixture();
  try {
    const id=crypto.randomUUID();
    const results=await Promise.all([f.action("ORCL",id),f.action("MSFT",id)]);
    assert.deepEqual(results.map(r=>r.status).sort(),[202,409]);
  } finally { f.database.close(); }
});

test("global AI-off is preserved but one-off data collection can add an untracked company", async()=>{
  const f=await fixture();
  try {
    assert.equal((await f.action("NEWCO",crypto.randomUUID(),"analyze")).status,409);
    assert.equal((await f.action("NEWCO")).status,202);
    assert.equal(f.env.SEC_DATA_TICKERS,"ORCL");assert.equal(f.env.SEC_AI_ENABLED,"false");
    assert.equal((await f.action("bad/ticker")).status,404);
  } finally { f.database.close(); }
});

test("queued cancel is terminal, a running cancel waits for its checkpoint and retries get a new task", async()=>{
  const f=await fixture();
  try {
    const id=crypto.randomUUID();await f.action("ORCL",id);
    const store=new FinancialMaintenanceStore(f.env.DB!),row=await store.claim(new Date());assert.ok(row);
    assert.equal((await store.cancel(id,new Date()))!.status,"cancel_requested");
    assert.equal((await f.action()).status,409);
    await store.finishStep(row,{stage:"collect",state:{},completedSteps:1},new Date());
    assert.equal((await store.get(id))!.status,"cancelled");
    const retry=await f.action("ORCL",crypto.randomUUID(),"retry",{retryTaskId:id});assert.equal(retry.status,202);
    const next=(await retry.json() as {task:{id:string}}).task.id;
    const cancel=await handleFinancialAdminRequest(f.request(`tasks/${next}/cancel`,{method:"POST"}),f.env);assert.equal(cancel.status,200);
    assert.equal((await store.get(next))!.status,"cancelled");
  } finally { f.database.close(); }
});

test("leases permit only one worker, stale writes cannot advance the task, and expired work recovers", async()=>{
  const f=await fixture();
  try {
    const id=crypto.randomUUID();await f.action("ORCL",id);
    const now=new Date(),store=new FinancialMaintenanceStore(f.env.DB!);
    const [a,b]=await Promise.all([store.claim(now),store.claim(now)]);assert.equal([a,b].filter(Boolean).length,1);
    const old=(a??b)!;const later=new Date(now.getTime()+MAINTENANCE_LEASE_MS+1),fresh=await store.claim(later);assert.ok(fresh);
    await store.finishStep(old,{stage:"complete",state:{},status:"succeeded"},later);
    assert.equal((await store.get(id))!.stage,"identify");
    await store.finishStep(fresh,{stage:"collect",state:{},completedSteps:1},later);
    assert.equal((await store.get(id))!.stage,"collect");
  } finally { f.database.close(); }
});

test("company/task GETs are read-only and disclose explicit missing status rather than zeroes", async()=>{
  const f=await fixture();
  try {
    f.database.raw.prepare(`INSERT INTO sec_filings(filing_id,ticker,accession_number,cik,form,filing_date,report_date,document_url,index_url,parser_version,ingest_status)
      VALUES('accession','ORCL','accession','0001341439','10-Q','2026-09-01','2026-08-31','https://www.sec.gov/a','https://www.sec.gov/i','v1','indexed')`).run();
    const id=crypto.randomUUID();await f.action("ORCL",id);
    const guard=new ReadOnlyGuardDatabase(f.database),env={...f.env,DB:guard as unknown as D1Database};
    for(const path of ["companies","companies/ORCL",`tasks/${id}`])assert.equal((await handleFinancialAdminRequest(f.request(path),env)).status,200);
    const detail=await (await handleFinancialAdminRequest(f.request("companies/ORCL"),env)).json() as {periods:Array<{status:string;metrics:unknown[]}>};
    assert.equal(detail.periods[0].status,"missing");assert.deepEqual(detail.periods[0].metrics,[]);assert.deepEqual(guard.attemptedWrites,[]);
  } finally { f.database.close(); }
});

test("company metadata shows the same successful data for tracked and manually added companies despite newer failures or missing filings", async()=>{
  const f=await fixture();
  try {
    const publishedAt="2026-09-12T00:00:00.000Z", failedAt="2026-12-01T00:00:00.000Z";
    const flow={...completeOrclFixture,fetchedAt:publishedAt};
    f.database.raw.prepare("INSERT INTO financial_complete_versions VALUES(?,?,?,?,?,?)").run("published","0001341439","ORCL",1,JSON.stringify(flow),publishedAt);
    f.database.raw.prepare("INSERT INTO financial_complete_current VALUES(?,?,?)").run("0001341439","published",1);
    f.database.raw.prepare("INSERT INTO financial_collection_jobs(job_id,cik,ticker,generation,status,next_attempt_at,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run("failed-alias","0001341439","ORCL.A",2,"unavailable",failedAt,failedAt);
    const cache=f.database.raw.prepare("INSERT INTO sec_cache(cache_key,payload,fetched_at) VALUES(?,?,?)");
    cache.run("sec:filings:ORCL","invalid-json",failedAt);
    cache.run("admin:financial-issuer:ORCL.A","invalid-json",failedAt);
    f.database.raw.prepare(`INSERT INTO sec_filings(filing_id,ticker,accession_number,cik,form,filing_date,report_date,document_url,index_url,parser_version,ingest_status)
      VALUES('new-filing','ORCL.A','new-filing','0001341439','10-Q','2026-12-01','2026-11-30','https://www.sec.gov/a','https://www.sec.gov/i','v1','indexed')`).run();
    const guard=new ReadOnlyGuardDatabase(f.database),env={...f.env,SEC_AI_ENABLED:"true",SEC_AI_TICKERS:"ORCL",DB:guard as unknown as D1Database};
    const list=await (await handleFinancialAdminRequest(f.request("companies"),env)).json() as FinancialMaintenanceCompanyList;
    assert.equal(list.companies.find(company=>company.ticker==="ORCL")!.tracked,true);
    assert.equal(list.companies.find(company=>company.ticker==="ORCL.A")!.tracked,false);
    for(const ticker of ["ORCL","ORCL.A"]){
      const company=list.companies.find(company=>company.ticker===ticker)!;
      assert.equal(company.latestPeriodEnd,"2026-08-31");assert.equal(company.lastUpdatedAt,publishedAt);
      const detail=await (await handleFinancialAdminRequest(f.request(`companies/${ticker}`),env)).json() as FinancialMaintenanceCompanyDetail;
      assert.deepEqual(detail.company,company);
      assert.ok(detail.periods.find(period=>period.periodEnd==="2026-08-31")!.metrics.some(metric=>metric.value!==null));
      if(ticker==="ORCL.A")assert.equal(detail.periods[0].status,"missing");
    }
    assert.deepEqual(guard.attemptedWrites,[]);assert.equal(env.SEC_AI_TICKERS,"ORCL");assert.equal(env.SEC_DATA_TICKERS,"ORCL");
  } finally { f.database.close(); }
});

test("history-only and legacy-only companies appear with obtained periods and invalid supplementary history cannot hide them",async()=>{
  const f=await fixture();
  try {
    const history={schemaVersion:"revenue-history.v1",ticker:"HIST",updatedAt:"2026-09-15T00:00:00.000Z",quarters:[historyFromSnapshot(completeOrclFixture.quarters[0])!]};
    const cache=f.database.raw.prepare("INSERT INTO sec_cache(cache_key,payload,fetched_at) VALUES(?,?,?)");
    cache.run("sec:revenue-history:v1:0001341439",JSON.stringify(history),history.updatedAt);
    cache.run("sec:business-flow:v2:LEGACY",JSON.stringify({...completeOrclFixture,ticker:"LEGACY"}),completeOrclFixture.fetchedAt);
    cache.run("sec:revenue-history:v1:0000000001","invalid-json","2026-12-01");
    cache.run("sec:business-flow:v2:BROKEN",JSON.stringify({ticker:"BROKEN"}),"2026-12-01");
    const list=await (await handleFinancialAdminRequest(f.request("companies"),f.env)).json() as FinancialMaintenanceCompanyList;
    for(const ticker of ["HIST","LEGACY"]){
      const company=list.companies.find(company=>company.ticker===ticker)!;assert.ok(company);
      assert.equal(company.latestPeriodEnd,"2026-08-31");
      const detail=await (await handleFinancialAdminRequest(f.request(`companies/${ticker}`),f.env)).json() as FinancialMaintenanceCompanyDetail;
      assert.deepEqual(detail.company,company);assert.equal(detail.periods[0].periodEnd,"2026-08-31");
    }
    assert.equal(list.companies.find(company=>company.ticker==="HIST")!.lastUpdatedAt,history.updatedAt);
    assert.equal(list.companies.find(company=>company.ticker==="BROKEN")!.lastUpdatedAt,null);
  } finally { f.database.close(); }
});

test("companies with only successfully archived original statements appear without claiming quarterly summary data", async()=>{
  const f=await fixture();
  try {
    const cache=f.database.raw.prepare("INSERT INTO sec_cache(cache_key,payload,fetched_at) VALUES(?,?,?)");
    const archive=(id:string,ticker:string,reportDate:string,archivedAt:string,statements:object|undefined)=>{
      const documentId=id.repeat(64),source={ticker,form:"10-Q",reportDate,filedAt:archivedAt.slice(0,10),accessionNumber:"0001193125-26-389274",documentUrl:"https://www.sec.gov/Archives/edgar/data/1341439/report.htm"};
      cache.run(`sec:disclosure-audit:v1:${ticker}:${documentId}`,JSON.stringify({documentId,ticker,source,archivedAt,statements}),archivedAt);
    };
    archive("a","TABLES","2026-05-31","2026-06-12T00:00:00.000Z",{status:"extracted",tables:3});
    archive("b","TABLES","2026-08-31","2026-09-12T00:00:00.000Z",{status:"extracted",tables:5});
    archive("c","TABLES","2026-11-30","2026-12-12T00:00:00.000Z",{status:"not_located",tables:0});
    archive("d","TABLES","2027-02-28","2027-03-12T00:00:00.000Z",undefined);
    archive("e","EMPTY","2026-11-30","2026-12-12T00:00:00.000Z",{status:"extracted",tables:0});
    cache.run("sec:disclosure-audit:v1:BROKEN:bad","invalid-json","2027-03-12T00:00:00.000Z");
    const guard=new ReadOnlyGuardDatabase(f.database);let queries=0;
    const env={...f.env,DB:{prepare(sql:string){queries++;return guard.prepare(sql);}} as unknown as D1Database};
    const response=await handleFinancialAdminRequest(f.request("companies"),env);assert.equal(response.status,200);assert.equal(queries,1);
    const list=await response.json() as FinancialMaintenanceCompanyList,company=list.companies.find(item=>item.ticker==="TABLES")!;
    assert.ok(company);assert.equal(company.latestPeriodEnd,"2026-08-31");assert.equal(company.lastUpdatedAt,"2026-09-12T00:00:00.000Z");
    assert.equal(list.companies.some(item=>item.ticker==="EMPTY"||item.ticker==="BROKEN"),false);
    const detail=await (await handleFinancialAdminRequest(f.request("companies/TABLES"),env)).json() as FinancialMaintenanceCompanyDetail;
    assert.deepEqual(detail.company,company);assert.deepEqual(detail.periods,[]);assert.equal(detail.documents.length,4);
    assert.deepEqual(guard.attemptedWrites,[]);
  } finally { f.database.close(); }
});

test("original statement metadata and successful snapshot or history metadata retain the newest available period and time", async()=>{
  const f=await fixture();
  try {
    const publishedAt="2026-10-01T00:00:00.000Z",historyAt="2026-11-01T00:00:00.000Z";
    f.database.raw.prepare("INSERT INTO financial_complete_versions VALUES(?,?,?,?,?,?)").run("published","0001341439","ORCL",1,JSON.stringify({...completeOrclFixture,fetchedAt:publishedAt}),publishedAt);
    f.database.raw.prepare("INSERT INTO financial_complete_current VALUES(?,?,?)").run("0001341439","published",1);
    const cache=f.database.raw.prepare("INSERT INTO sec_cache(cache_key,payload,fetched_at) VALUES(?,?,?)");
    cache.run("sec:revenue-history:v1:0001341439",JSON.stringify({schemaVersion:"revenue-history.v1",ticker:"ORCL",updatedAt:historyAt,
      quarters:[historyFromSnapshot(completeOrclFixture.quarters[0])!]}),historyAt);
    const archive=(id:string,reportDate:string,archivedAt:string)=>cache.run(`sec:disclosure-audit:v1:ORCL:${id.repeat(64)}`,JSON.stringify({
      ticker:"ORCL",documentId:id.repeat(64),source:{ticker:"ORCL",form:"10-Q",reportDate},archivedAt,statements:{status:"extracted",tables:2},
    }),archivedAt);
    archive("a","2026-05-31","2026-09-12T00:00:00.000Z");
    const read=async()=>((await (await handleFinancialAdminRequest(f.request("companies"),f.env)).json()) as FinancialMaintenanceCompanyList).companies.find(item=>item.ticker==="ORCL")!;
    const prior=await read();assert.equal(prior.latestPeriodEnd,"2026-08-31");assert.equal(prior.lastUpdatedAt,historyAt);
    archive("b","2026-11-30","2026-12-12T00:00:00.000Z");
    const latest=await read();assert.equal(latest.latestPeriodEnd,"2026-11-30");assert.equal(latest.lastUpdatedAt,"2026-12-12T00:00:00.000Z");
  } finally { f.database.close(); }
});

test("a failed history refresh preserves the timestamp of successfully obtained data",async()=>{
  const f=await fixture();
  try {
    const previous="2026-09-15T00:00:00.000Z",now=new Date("2026-10-01T00:00:00.000Z"),cik="0001341439";
    const history={schemaVersion:"revenue-history.v1",ticker:"ORCL",updatedAt:previous,quarters:[historyFromSnapshot(completeOrclFixture.quarters[0])!]};
    const cache=f.database.raw.prepare("INSERT INTO sec_cache(cache_key,payload,fetched_at) VALUES(?,?,?)");
    cache.run(`sec:revenue-history:v1:${cik}`,JSON.stringify(history),previous);
    cache.run(`sec:revenue-history-cursor:v1:${cik}`,JSON.stringify({version:HISTORY_VERSION,ticker:"ORCL",industry:"standard",documents:[{
      url:"https://www.sec.gov/Archives/edgar/data/1341439/000119312526389274/orcl.htm",accession:"0001193125-26-389274",filedAt:"2026-09-11",periodEnd:"2026-08-31",form:"10-Q",
    }],index:0,facts:[],issues:[],startedAt:now.toISOString()}),now.toISOString());
    const result=await runHistoryStep(f.env.DB!,{async read(){throw new Error("source temporarily unavailable");}},{ticker:"ORCL",cik},now,1);
    assert.equal(result.retry?.attempts,1);
    const stored=f.database.raw.prepare("SELECT payload,fetched_at FROM sec_cache WHERE cache_key=?").get(`sec:revenue-history:v1:${cik}`)!;
    assert.equal(JSON.parse(stored.payload as string).updatedAt,previous);assert.equal(stored.fetched_at,previous);
    const detail=await (await handleFinancialAdminRequest(f.request("companies/ORCL"),f.env)).json() as FinancialMaintenanceCompanyDetail;
    assert.equal(detail.company.lastUpdatedAt,previous);assert.equal(detail.company.latestPeriodEnd,"2026-08-31");
  } finally { f.database.close(); }
});

test("runner persists progress across invocations, backs up before mutations and reports partial extraction", async()=>{
  const f=await fixture();
  try {
    const id=crypto.randomUUID();await f.action("ORCL",id);
    await new FinancialMaintenanceStore(f.env.DB!).db.prepare("INSERT INTO sec_cache(cache_key,payload,fetched_at) VALUES(?,?,?)")
      .bind("sec:revenue-history:v1:0001341439",JSON.stringify({old:true}),new Date().toISOString()).run();
    let historySteps=0;
    const deps:MaintenanceDependencies={
      reader:()=>({async read(){throw new Error("must use injected operations");}}),
      discover:async()=>({cik:"0001341439",tickers:["ORCL"],name:"Oracle",industry:"unknown"}),
      collect:async(env,job)=>{
        assert.ok(f.objects.has(`financial-maintenance-backups/${id}.json`));
        await env.DB!.prepare("UPDATE financial_collection_jobs SET status='unavailable',reasons_json='[\"MISSING_DISCLOSURE\"]',lease_token=NULL,lease_until=NULL WHERE job_id=?").bind(job.id).run();
        return {published:false,reasons:["MISSING_DISCLOSURE"]};
      },
      history:async()=>({ticker:"ORCL",documents:1,finished:++historySteps===2,quarters:4,issues:[]}),
    };
    for(let i=0;i<5;i++)assert.equal((await runFinancialMaintenanceTick(f.env,deps)).processed,true);
    const task=await new FinancialMaintenanceStore(f.env.DB!).get(id);assert.equal(task!.status,"partial");
    assert.match(task!.issues_json,/MISSING_DISCLOSURE/);assert.match(task!.issues_json,/NO_ARCHIVED_DISCLOSURES/);
    const backup=JSON.parse(f.objects.get(`financial-maintenance-backups/${id}.json`)!);assert.equal(backup.caches[0].payload,JSON.stringify({old:true}));
    assert.equal(await claimJob(f.env.DB!),null,"normal collection sweep never steals the admin-owned job");
  } finally { f.database.close(); }
});

test("provider failures are redacted, retried at most three times and remain visible after refresh", async()=>{
  const f=await fixture();
  try {
    const id=crypto.randomUUID();await f.action("ORCL",id);
    const deps={reader:()=>({async read(){throw new Error("no");}}),discover:async()=>{throw new Error("secret=do-not-leak");}} as unknown as MaintenanceDependencies;
    for(let i=0;i<3;i++){
      f.database.raw.prepare("UPDATE financial_maintenance_tasks SET next_attempt_at=? WHERE task_id=?").run(new Date(0).toISOString(),id);
      await runFinancialMaintenanceTick(f.env,deps);
    }
    const response=await handleFinancialAdminRequest(f.request(`tasks/${id}`),f.env),body=await response.text();
    assert.match(body,/"status":"failed"/);assert.match(body,/SOURCE_TEMPORARILY_UNAVAILABLE/);assert.doesNotMatch(body,/do-not-leak/);
  } finally { f.database.close(); }
});

test("one-off analysis scope requires the matching authenticated task and cannot bypass global AI-off", async()=>{
  const f=await fixture();
  try {
    const id=crypto.randomUUID(),env={...f.env,SEC_AI_ENABLED:"true"};
    await handleFinancialAdminRequest(f.request("companies/ORCL/actions",{method:"POST",body:JSON.stringify({action:"analyze",requestId:id})}),env);
    const instance=`financial-admin-${id}`;
    f.database.raw.prepare("UPDATE financial_maintenance_tasks SET stage='analysis_dispatch',state_json=? WHERE task_id=?").run(JSON.stringify({workflowId:instance}),id);
    const params={ticker:"ORCL",requestedBy:"manual" as const,maintenanceTaskId:id};
    const scoped=await maintenanceAnalysisEnvironment(env,params,instance);
    assert.equal(scoped.SEC_AI_TICKERS,"ORCL");assert.equal(env.SEC_TRACKED_TICKERS,"MSFT");
    await assert.rejects(()=>maintenanceAnalysisEnvironment(f.env,params,instance),/DENIED/);
    await assert.rejects(()=>maintenanceAnalysisEnvironment(env,{...params,ticker:"AAPL"},instance),/DENIED/);
    await assert.rejects(()=>maintenanceAnalysisEnvironment(env,params,"different-workflow"),/DENIED/);
  } finally { f.database.close(); }
});

test("a concurrent Cron with no claim still skips normal collection while a maintenance lease or retry exists", async()=>{
  const f=await fixture();
  try {
    await f.action();const store=new FinancialMaintenanceStore(f.env.DB!);assert.ok(await store.claim(new Date()));
    assert.deepEqual(await runFinancialMaintenanceTick(f.env),{processed:true});
    f.database.raw.prepare("UPDATE financial_maintenance_tasks SET status='queued',lease_token=NULL,lease_until=NULL,next_attempt_at=?").run(new Date(Date.now()+120_000).toISOString());
    assert.deepEqual(await runFinancialMaintenanceTick(f.env),{processed:true});
  } finally { f.database.close(); }
});

test("three crashed leases terminate the same extraction step without endless replay", async()=>{
  const f=await fixture();
  try {
    const id=crypto.randomUUID();await f.action("ORCL",id);const store=new FinancialMaintenanceStore(f.env.DB!);let now=new Date();
    for(let i=0;i<3;i++){assert.ok(await store.claim(now));now=new Date(now.getTime()+MAINTENANCE_LEASE_MS+1);}
    assert.equal(await store.claim(now),null);const row=await store.get(id);assert.equal(row!.status,"failed");assert.equal(row!.error_code,"LEASE_EXPIRED");
  } finally { f.database.close(); }
});

test("ambiguous analysis dispatch retains its id and active lock across repeated provider outages", async()=>{
  const f=await fixture();
  try {
    const id=crypto.randomUUID();const env={...f.env,SEC_AI_ENABLED:"true"};
    await handleFinancialAdminRequest(f.request("companies/ORCL/actions",{method:"POST",body:JSON.stringify({action:"analyze",requestId:id})}),env);
    const store=new FinancialMaintenanceStore(env.DB!);
    f.database.raw.prepare("UPDATE financial_maintenance_tasks SET stage='analysis_dispatch',state_json=? WHERE task_id=?").run(JSON.stringify({workflowId:`financial-admin-${id}`}),id);
    for(let i=0;i<4;i++){
      f.database.raw.prepare("UPDATE financial_maintenance_tasks SET next_attempt_at=?").run(new Date(0).toISOString());
      const row=(await store.claim(new Date()))!;await store.failStep(row,new Date());
    }
    const row=await store.get(id);assert.equal(row!.status,"queued");assert.equal(row!.error_code,"WORKFLOW_STATUS_UNAVAILABLE");
    assert.equal((await f.action()).status,409);
    const cancel=await handleFinancialAdminRequest(f.request(`tasks/${id}/cancel`,{method:"POST"}),env);assert.equal(cancel.status,409);
  } finally { f.database.close(); }
});

test("different share classes serialize one CIK cursor, contention does not exhaust retries and both finish", async()=>{
  const f=await fixture();
  try {
    const first=crypto.randomUUID(),second=crypto.randomUUID(),cik="0001652044",cursorKey=`sec:revenue-history-cursor:v1:${cik}`;
    await f.action("GOOG",first);await f.action("GOOGL",second);
    for(const ticker of ["GOOG","GOOGL"])f.database.raw.prepare("INSERT INTO sec_cache(cache_key,payload,fetched_at) VALUES(?,?,?)")
      .run(`sec:disclosure-audit:v1:${ticker}:fixture`,JSON.stringify({ticker,coverage:{unsupported:0,unknownTaxonomy:0}}),new Date().toISOString());
    const historyCalls:string[]=[];
    const deps:MaintenanceDependencies={
      reader:()=>({async read(){throw new Error("unused");}}),
      discover:async(ticker)=>({cik,tickers:[ticker],name:"Alphabet",industry:"unknown"}),
      collect:async(env,job)=>{
        await env.DB!.prepare("UPDATE financial_collection_jobs SET status='succeeded',lease_token=NULL,lease_until=NULL WHERE job_id=?").bind(job.id).run();
        return {published:true,reasons:[]};
      },
      history:async(db,_reader,target)=>{
        const old=await db.prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(cursorKey).first<{payload:string}>();
        const cursor=old?JSON.parse(old.payload) as {ticker:string;index:number}:{ticker:target.ticker,index:0};
        assert.equal(cursor.ticker,target.ticker,"another share class must finish before this cursor changes owners");
        cursor.index++;historyCalls.push(target.ticker);
        await db.prepare("INSERT INTO sec_cache(cache_key,payload,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload")
          .bind(cursorKey,JSON.stringify(cursor),new Date().toISOString()).run();
        return {ticker:target.ticker,documents:1,finished:cursor.index===2,quarters:cursor.index,issues:[]};
      },
    };
    const due=(id:string)=>f.database.raw.prepare("UPDATE financial_maintenance_tasks SET next_attempt_at=? WHERE task_id=?").run(new Date(0).toISOString(),id);
    due(first);await runFinancialMaintenanceTick(f.env,deps);
    const store=new FinancialMaintenanceStore(f.env.DB!);assert.equal((await store.get(first))!.cik,cik);
    f.database.raw.prepare("INSERT INTO sec_cache(cache_key,payload,fetched_at) VALUES(?,?,?)").run(cursorKey,JSON.stringify({ticker:"GOOG",index:0}),new Date().toISOString());
    for(let i=0;i<4;i++){
      due(second);await runFinancialMaintenanceTick(f.env,deps);
      const waiting=(await store.get(second))!;assert.equal(waiting.status,"queued");assert.equal(waiting.stage,"waiting_issuer");assert.equal(waiting.attempt,0);assert.equal(waiting.cik,null);
      assert.equal(JSON.parse(waiting.state_json).waitingCik,cik);
      assert.equal((f.database.raw.prepare("SELECT payload FROM sec_cache WHERE cache_key=?").get(cursorKey) as {payload:string}).payload,JSON.stringify({ticker:"GOOG",index:0}));
    }
    for(let i=0;i<4;i++)await runFinancialMaintenanceTick(f.env,deps);
    assert.equal((await store.get(first))!.status,"succeeded");
    due(second);for(let i=0;i<5;i++)await runFinancialMaintenanceTick(f.env,deps);
    assert.equal((await store.get(second))!.status,"succeeded");
    assert.deepEqual(historyCalls,["GOOG","GOOG","GOOGL","GOOGL"]);
    assert.equal((await store.get(second))!.cik,cik);assert.equal(await store.hasActiveTasks(),false);
  } finally { f.database.close(); }
});

test("a successful historical source retry clears only resolved issues before completing maintenance", async()=>{
  const f=await fixture();
  try {
    const id=crypto.randomUUID(),resolved="0001341439-26-000001:SOURCE_TEMPORARILY_UNAVAILABLE";await f.action("ORCL",id);
    f.database.raw.prepare("UPDATE financial_maintenance_tasks SET stage='history',state_json=?,issues_json=? WHERE task_id=?")
      .run(JSON.stringify({cik:"0001341439"}),JSON.stringify([resolved]),id);
    f.database.raw.prepare("INSERT INTO sec_cache(cache_key,payload,fetched_at) VALUES(?,?,?)")
      .run("sec:disclosure-audit:v1:ORCL:fixture",JSON.stringify({ticker:"ORCL",coverage:{unsupported:0,unknownTaxonomy:0}}),new Date().toISOString());
    const deps={reader:()=>({async read(){throw new Error("unused");}}),history:async()=>({ticker:"ORCL",documents:1,finished:true,quarters:4,issues:[],resolvedIssues:[resolved]})} as unknown as MaintenanceDependencies;
    await runFinancialMaintenanceTick(f.env,deps);await runFinancialMaintenanceTick(f.env,deps);
    const task=await new FinancialMaintenanceStore(f.env.DB!).get(id);assert.deepEqual(JSON.parse(task!.issues_json),[]);assert.equal(task!.status,"succeeded");
  } finally { f.database.close(); }
});

test("waiting for an analysis Workflow preserves its task lock but cannot starve ordinary data sweeps", async()=>{
  const f=await fixture();
  try {
    const id=crypto.randomUUID();await f.action("ORCL",id);
    f.database.raw.prepare("UPDATE financial_maintenance_tasks SET stage='analysis_wait',state_json=?,next_attempt_at=? WHERE task_id=?")
      .run(JSON.stringify({workflowId:`financial-admin-${id}`}),new Date(Date.now()+120_000).toISOString(),id);
    assert.deepEqual(await runFinancialMaintenanceTick(f.env),{processed:true,blocksDataSweep:false});
    f.database.raw.prepare("UPDATE financial_maintenance_tasks SET next_attempt_at=? WHERE task_id=?").run(new Date(0).toISOString(),id);
    f.env.SEC_ANALYSIS_WORKFLOW.get=async()=>({async status(){return {status:"running"};}});
    const polled=await runFinancialMaintenanceTick(f.env);
    assert.equal(polled.processed,true);assert.equal(polled.blocksDataSweep,false);
    assert.equal((await f.action()).status,409,"the same company's maintenance lock is retained");
    await f.action("MSFT");
    const claimed=await new FinancialMaintenanceStore(f.env.DB!).claim(new Date());assert.ok(claimed);
    assert.deepEqual(await runFinancialMaintenanceTick(f.env),{processed:true},"a real data lease still protects the shared cursor");
  } finally { f.database.close(); }
});

test("a share class waiting on an analysis owner never blocks ordinary sweeps, but active data still does", async()=>{
  const f=await fixture();
  try {
    const owner=crypto.randomUUID(),waiter=crypto.randomUUID(),cik="0001652044";
    await f.action("GOOG",owner);await f.action("GOOGL",waiter);
    f.database.raw.prepare("UPDATE financial_maintenance_tasks SET cik=?,stage='analysis_wait',state_json=?,next_attempt_at=? WHERE task_id=?")
      .run(cik,JSON.stringify({cik,workflowId:`financial-admin-${owner}`}),new Date(Date.now()+300_000).toISOString(),owner);
    const deps={reader:()=>({async read(){throw new Error("unused");}}),discover:async(ticker:string)=>({cik,tickers:[ticker],name:"Alphabet",industry:"unknown"})} as unknown as MaintenanceDependencies;
    const waitingTick=await runFinancialMaintenanceTick(f.env,deps);
    assert.equal(waitingTick.blocksDataSweep,false);
    const store=new FinancialMaintenanceStore(f.env.DB!),waiting=(await store.get(waiter))!;
    assert.equal(waiting.stage,"waiting_issuer");assert.equal(waiting.cik,null);assert.equal(JSON.parse(waiting.state_json).waitingCik,cik);
    assert.deepEqual(await runFinancialMaintenanceTick(f.env,deps),{processed:true,blocksDataSweep:false},"backoff waiting must not block normal collection");
    assert.equal((await store.get(owner))!.cik,cik,"analysis owner retains its issuer lock");
    assert.equal(f.objects.size,0,"waiter did not enter backup/reset or collection");
    f.database.raw.prepare("UPDATE financial_maintenance_tasks SET stage='history' WHERE task_id=?").run(owner);
    assert.deepEqual(await runFinancialMaintenanceTick(f.env,deps),{processed:true},"a data owner still blocks normal cursor writes");
    f.database.raw.prepare("UPDATE financial_maintenance_tasks SET stage='analysis_wait' WHERE task_id=?").run(owner);
    const fresh=crypto.randomUUID();await f.action("MSFT",fresh);
    assert.equal(await store.hasActiveDataTasks(),true,"new identify must block until issuer ownership is known");
  } finally { f.database.close(); }
});
