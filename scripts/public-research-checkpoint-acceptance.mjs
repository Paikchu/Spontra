/** Local operator journey against the real admin handler, R2 and TaskRunner/PiHost SQL. Never calls a model. */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const require = createRequire(new URL("../node_modules/wrangler/package.json", import.meta.url));
const { build } = require("esbuild");
const root = resolve(new URL("..", import.meta.url).pathname), scratch = await mkdtemp(resolve(tmpdir(), "spontra-checkpoint-"));
const sha = value => createHash("sha256").update(value).digest("hex");
const runId = `public-${"a".repeat(40)}`, activeId = `public-${"b".repeat(40)}`, normalId = `public-${"c".repeat(40)}`, mismatchId = `public-${"d".repeat(40)}`;
const at = "2026-01-02T00:00:00.000Z", fingerprint = sha("synthetic checkpoint journey only");
const excerpt = `${"SYNTHETIC SOURCE ONLY. ".repeat(700)}COMPLETE-TAIL-SOURCE-EXCERPT`;
const source = { id: "source-1", canonicalId: "synthetic", uri: "https://example.com/synthetic", title: "Synthetic original", locator: "Final paragraph", excerpt, contentHash: sha(excerpt), revision: "synthetic-v1", publishedAt: at, availableAt: at, collectedAt: at, observationPeriod: { start: "2026-01-01", end: "2026-01-01" }, usage: "public", authorization: "Local acceptance only" };
const draft = { schemaVersion: "public-research.v1", reportId: "synthetic-industry", type: "industry", title: "Synthetic unpublished industry draft", language: "en", scope: { regions: ["US"], currency: "USD", industryId: "synthetic-cloud", description: "Synthetic scope" }, asOf: at, generatedAt: at, validUntil: "2099-01-01T00:00:00.000Z", inputFingerprint: fingerprint, modelVersion: "no-model-called", promptVersion: "fixture", toolVersion: "fixture", coverage: "limited", missingInputs: ["Synthetic data is not a real report"], changes: ["Synthetic first draft"], summary: "Synthetic full-content stopped-run export", sources: [source], observations: [], claims: Array.from({ length: 19 }, (_, i) => ({ id: `claim-${i}`, kind: "fact", title: `Synthetic claim ${i}`, statement: `Synthetic conclusion ${i}: source states fixture data.`, sourceIds: [source.id], observationIds: [], premiseClaimIds: [], assumptions: [], impactChannels: ["Synthetic transmission only"], counterEvidence: ["No real issuer evidence"], verification: "Read synthetic source", shockId: `shock-${i}`, financialVariable: "synthetic" })), dependencies: [], scenarios: [{ name: "base", assumptions: ["Fixture only"], claimIds: ["claim-0"] }], authorRunId: runId, sections: [{ id: "funding", title: "Synthetic funding", claimIds: Array.from({ length: 19 }, (_, i) => `claim-${i}`) }] };
const baseSpec = { runId, reportId: draft.reportId, inputFingerprint: fingerprint, asOf: at, startedAt: at };
const notes = [{ conclusions: ["Synthetic demand evidence"], gaps: ["Synthetic-only scope"], sources: [source] }];
const fixture = { runId, activeId, normalId, mismatchId, draft, run: baseSpec, notes, at };
const workerPath = resolve(scratch, "worker.ts"), bundlePath = resolve(scratch, "worker.mjs");

await writeFile(workerPath, `
import { TaskRunner } from ${JSON.stringify(resolve(root, "workers/analysis/src/durable-runs/runner.ts"))};
import { handlePublicResearchAdminRequest } from ${JSON.stringify(resolve(root, "workers/analysis/src/public-research/admin.ts"))};
import { publicResearchCheckpoint, savePublicResearchCheckpoint } from ${JSON.stringify(resolve(root, "workers/analysis/src/public-research/checkpoint.ts"))};
import { createAdminSession } from ${JSON.stringify(resolve(root, "workers/analysis/src/admin/auth.ts"))};
import { packState } from ${JSON.stringify(resolve(root, "workers/analysis/src/pi/state.ts"))};
import { handleAdminRequest } from ${JSON.stringify(resolve(root, "apps/admin/worker/index.ts"))};
export { AdminGateway } from ${JSON.stringify(resolve(root, "workers/analysis/src/index.ts"))};
export class CheckpointRunner extends TaskRunner {
  constructor(ctx, env) {
    const sql=ctx.storage.sql, f=JSON.parse(env.FIXTURE), id=ctx.id.name?.split(":").at(-1), normal=id===f.normalId;
    sql.exec("CREATE TABLE IF NOT EXISTS checkpoint_telemetry (hook TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS run (k INTEGER PRIMARY KEY,kind TEXT,id TEXT,params TEXT,created_at INTEGER,status TEXT,error TEXT,output TEXT,updated_at INTEGER,wake_id TEXT,wake_at INTEGER)");
    sql.exec("CREATE TABLE IF NOT EXISTS pi_bindings (conversation TEXT PRIMARY KEY,session TEXT,operation_id TEXT,kind TEXT,spec TEXT,state TEXT,started_at INTEGER,turns INTEGER,quiet INTEGER,last_round INTEGER,capped INTEGER,finished INTEGER,asked TEXT,round TEXT,active INTEGER,spent INTEGER,startup TEXT,reserved_at INTEGER)");
    sql.exec("CREATE TABLE IF NOT EXISTS pi_trail (conversation TEXT,seq INTEGER,entry TEXT,PRIMARY KEY(conversation,seq))");
    sql.exec("CREATE TABLE IF NOT EXISTS steps (name TEXT PRIMARY KEY,record TEXT)");
    if([f.runId,f.activeId,f.normalId,f.mismatchId].includes(id)) {
      const run={...f.run,runId:id}, spec={run,stage:id===f.mismatchId?"review":"synthesis",notes:f.notes}, storedDraft={...f.draft,authorRunId:id};
      sql.exec("INSERT OR IGNORE INTO run VALUES(1,'PUBLIC_RESEARCH_WORKFLOW',?,?,0,?,NULL,NULL,0,NULL,NULL)",id,JSON.stringify(run),normal?"running":"terminated");
      if(!normal) {
        sql.exec("INSERT OR IGNORE INTO pi_bindings VALUES('synthetic-conversation','synthetic-session',?,'public-research',?,?,0,5,0,0,0,1,NULL,NULL,?,1234,NULL,NULL)",id+":synthesis",JSON.stringify(spec),packState({submitted:true,notes:null,sources:[f.draft.sources[0]],draft:storedDraft,review:null}),id===f.activeId?1:0);
        sql.exec("INSERT OR IGNORE INTO pi_trail VALUES('synthetic-conversation',0,?)",JSON.stringify({action:"submit_report",input:JSON.stringify(storedDraft).slice(0,4000),observation:'{"saved":true,"claims":19}'}));
      }
    }
    // No key and no model transport in this isolated runtime. D1 is used only by the real HTTP handler.
    super(ctx,{...env,DB:undefined});
  }
  async initializeOnly() { await this.__unsafe_ensureInitialized(); return this.snapshot(); }
  snapshot() { const sql=this.ctx.storage.sql;return {run:sql.exec("SELECT * FROM run").toArray(),sessions:sql.exec("SELECT operation_id,active,state FROM pi_bindings").toArray(),steps:sql.exec("SELECT * FROM steps").toArray(),telemetry:sql.exec("SELECT * FROM checkpoint_telemetry").toArray(),tables:sql.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").toArray()}; }
}
export default {async fetch(request,env) {
  const url=new URL(request.url), f=JSON.parse(env.FIXTURE), id=url.searchParams.get("id")??f.runId;
  const stub=()=>env.TASK_RUNS.get(env.TASK_RUNS.idFromName("PUBLIC_RESEARCH_WORKFLOW:"+id));
  if(url.pathname==="/fixture/auth")return Response.json({token:await createAdminSession(env.REPORT_ADMIN_PASSWORD)});
  if(url.pathname==="/fixture/initialize")return Response.json(await stub().initializeOnly());
  if(url.pathname==="/fixture/snapshot")return Response.json(await stub().snapshot());
  if(url.pathname==="/fixture/report")return Response.json(await stub().report());
  if(url.pathname==="/fixture/terminate"){await stub().terminate();return Response.json({terminated:true});}
  if(url.pathname==="/fixture/wrong-run"){try{return Response.json(await stub().readPublicResearchSession(f.normalId,"synthesis"));}catch(error){return Response.json({error:String(error)},{status:400});}}
  if(url.pathname==="/fixture/archive") {
    const checkpoint=publicResearchCheckpoint(f.run,"synthesis",{submitted:true,draft:f.draft},{notes:f.notes});
    const first=await savePublicResearchCheckpoint(env,checkpoint), before=(await env.SEC_FILINGS.get(first.key)).uploaded.toISOString();
    const second=await savePublicResearchCheckpoint(env,checkpoint), after=(await env.SEC_FILINGS.get(first.key)).uploaded.toISOString();
    return Response.json({first,second,before,after,checkpoint});
  }
  if(url.pathname==="/fixture/enrichment")return Response.json(publicResearchCheckpoint({...f.run,runId:f.normalId},"synthesis",{submitted:false,draft:null},{notes:f.notes,draft:f.draft}));
  if(url.pathname==="/fixture/missing-output")return Response.json(publicResearchCheckpoint(f.run,"synthesis",undefined,{notes:f.notes}));
  if(url.pathname.startsWith("/api/admin/"))return handleAdminRequest(request,{...env,ASSETS:{fetch:()=>new Response("Not found",{status:404})}});
  if(url.pathname.startsWith("/admin/"))return handlePublicResearchAdminRequest(request,env);
  return new Response("Not found",{status:404});
}};
`);

await build({ entryPoints: [workerPath], outfile: bundlePath, bundle: true, format: "esm", platform: "node", target: "es2022", conditions: ["workerd", "worker", "browser"], external: ["cloudflare:*", "node:*"], banner:{js:"import { createRequire as checkpointCreateRequire } from 'node:module'; const require=checkpointCreateRequire('/checkpoint-worker.mjs');"}, loader: { ".css": "text", ".txt": "text" }, plugins: [{ name: "local-observe-pi-actions", setup(bundle) {
  bundle.onLoad({ filter: /\/pi\/host\.ts$/ }, async ({ path }) => {
    let text=await readFile(path,"utf8");
    for(const hook of ["restore", "mountModels", "ensureStarted", "recoverEnded"])text=text.replace(new RegExp("^(\\s*(?:private )?async "+hook+"\\([^\\n]*\\{)$","m"), '$1 this.agent.sql.exec("INSERT INTO checkpoint_telemetry VALUES(?)",'+JSON.stringify(hook)+');');
    return {contents:text,loader:"ts"};
  });
  bundle.onLoad({filter:/\/axe\.min\.js$/},async({path})=>({contents:await readFile(path,"utf8"),loader:"text"}));
} }] });

const outbound=[];
const mf=new Miniflare(convertV4MiniflareOptions({name:"checkpoint-acceptance",modules:true,modulesRoot:scratch,scriptPath:bundlePath,compatibilityDate:"2026-08-26",compatibilityFlags:["nodejs_compat"],durableObjects:{TASK_RUNS:{className:"CheckpointRunner",useSQLite:true}},serviceBindings:{SPONTRA_ANALYSIS:{name:"checkpoint-acceptance",entrypoint:"AdminGateway"}},d1Databases:{DB:"checkpoint-acceptance"},r2Buckets:["SEC_FILINGS"],bindings:{FIXTURE:JSON.stringify(fixture),REPORT_ADMIN_PASSWORD:"isolated-acceptance-only"},outboundService:request=>{outbound.push(request.url);return new Response("Network forbidden in local checkpoint journey",{status:599});}}));
const checks=[];
const check=(name,ok,detail)=>{if(!ok)throw new Error(name+": "+JSON.stringify(detail));checks.push({name,status:"passed",...(detail===undefined?{}:{detail})});};
const request=async(path,options={})=>{const response=await mf.dispatchFetch("http://localhost"+path,options),text=await response.text();let body;try{body=JSON.parse(text);}catch{body=text;}return {status:response.status,body};};
try {
  const {DB,SEC_FILINGS}=await mf.getBindings();
  const migration=await readFile(resolve(root,"workers/analysis/migrations/0060_public_research.sql"),"utf8");
  for(const sql of migration.replace(/--[^\n]*/g,"").split(";").map(sql=>sql.trim()).filter(Boolean))await DB.prepare(sql).run();
  await DB.prepare("CREATE TABLE financial_company_settings(ticker TEXT PRIMARY KEY,enabled INTEGER)").run();
  await DB.prepare("CREATE TABLE business_feature_settings(ticker TEXT,feature TEXT,generate INTEGER)").run();
  const aiMigration=await readFile(resolve(root,"workers/analysis/migrations/0032_ai_tool_settings.sql"),"utf8");
  for(const sql of aiMigration.replace(/--[^\n]*/g,"").split(";").map(sql=>sql.trim()).filter(Boolean))await DB.prepare(sql).run();
  for(const id of [runId,activeId,normalId,mismatchId])await DB.prepare("INSERT INTO public_research_runs(run_id,report_id,input_fingerprint,state,params_json,calls_reserved,max_calls,max_tokens,created_at,updated_at) VALUES(?,?,?,?,?,63,96,2000000,?,?)").bind(id,draft.reportId,sha(id),id===normalId?"running":"stopped",JSON.stringify({...baseSpec,runId:id}),at,at).run();
  // The admission fingerprint must agree with the exact saved synthesis, just as in production.
  await DB.prepare("UPDATE public_research_runs SET input_fingerprint=? WHERE run_id=?").bind(fingerprint,runId).run();
  await DB.prepare("INSERT INTO public_research_reports VALUES(?,?,?,?,'valid',?)").bind(draft.reportId,"industry","synthetic-cloud","stable-published-version",at).run();
  const {body:{token}}=await request("/fixture/auth"),headers={authorization:"Bearer "+token};
  const url="/admin/public-research/runs/"+runId+"/checkpoints/synthesis";
  check("authentication required",(await request(url)).status===401);
  const before=(await request("/fixture/initialize")).body;
  check("terminated cold startup never opens/restores Pi",before.telemetry.length===0,before.telemetry);
  const ledgerBefore=(await DB.prepare("SELECT * FROM public_research_runs ORDER BY run_id").all()).results,pointerBefore=(await DB.prepare("SELECT * FROM public_research_reports").all()).results;
  const first=await request(url,{headers}),second=await request(url,{headers});
  check("full legacy stopped synthesis exported",first.status===200&&first.body.checkpoint.draft.claims.length===19,first.status);
  check("source tail beyond 4000 characters survives",JSON.stringify(first.body.checkpoint).length>4000&&first.body.checkpoint.draft.sources[0].excerpt.endsWith("COMPLETE-TAIL-SOURCE-EXCERPT"));
  check("full source excerpt hash matches",sha(first.body.checkpoint.draft.sources[0].excerpt)===source.contentHash);
  check("checkpoint hash covers complete exported content",sha(JSON.stringify(first.body.checkpoint))===first.body.contentHash);
  check("repeat reads are byte-equivalent",JSON.stringify(first)===JSON.stringify(second));
  check("export explicitly stopped and unreviewed",first.body.state==="stopped"&&first.body.runnerStatus==="terminated"&&first.body.reviewStatus==="unreviewed"&&first.body.published===false);
  const proxyUrl=url.replace("/admin/","/api/admin/"),proxied=await request(proxyUrl),proxiedAgain=await request(proxyUrl);
  check("real admin proxy and service-bound AdminGateway export complete stopped checkpoint",proxied.status===200&&JSON.stringify(proxied.body)===JSON.stringify(first.body),proxied);
  check("proxy export repeated reads identical",JSON.stringify(proxied)===JSON.stringify(proxiedAgain));
  check("proxy rejects checkpoint POST",(await request(proxyUrl,{method:"POST",headers:{origin:"http://localhost"}})).status===404);
  check("proxy rejects checkpoint DELETE",(await request(proxyUrl,{method:"DELETE"})).status===405);
  check("proxy rejects unknown checkpoint stage",(await request(proxyUrl.replace("synthesis","unknown"))).status===404);
  check("proxy rejects invalid checkpoint run identity",(await request(proxyUrl.replace(runId,"public-short"))).status===404);
  check("proxy rejects extra checkpoint path segments",(await request(proxyUrl+"/extra")).status===404);
  check("proxy rejects unrelated five-segment public research path",(await request(proxyUrl.replace("checkpoints","other"))).status===404);
  check("proxy retains URL size limit",(await request(proxyUrl+"?padding="+"a".repeat(2100))).status===413);
  check("unknown stage refused",(await request(url.replace("synthesis","unknown"),{headers})).status===400);
  check("unknown run refused",(await request(url.replace(runId,`public-${"e".repeat(40)}`),{headers})).status===404);
  check("cross-run storage RPC refused",(await request("/fixture/wrong-run")).status===400);
  check("active stage refused",(await request(url.replace(runId,activeId),{headers})).status===400);
  check("wrong stored stage refused",(await request(url.replace(runId,mismatchId),{headers})).status===400);
  check("non-stopped legacy run refused before RPC",(await request(url.replace(runId,normalId),{headers})).status===409);
  check("checkpoint is GET only",(await request(url,{headers,method:"POST"})).status===405);
  check("checkpoint is not publicly reachable",(await request(url.replace("/admin/","/api/v1/"))).status===404);
  const after=(await request("/fixture/snapshot")).body;
  check("storage snapshot unchanged by exports",JSON.stringify(before)===JSON.stringify(after));
  check("run ledger and call reservations unchanged",JSON.stringify(ledgerBefore)===JSON.stringify((await DB.prepare("SELECT * FROM public_research_runs ORDER BY run_id").all()).results));
  check("published pointer unchanged",JSON.stringify(pointerBefore)===JSON.stringify((await DB.prepare("SELECT * FROM public_research_reports").all()).results));
  check("export creates no draft version",(await DB.prepare("SELECT COUNT(*) n FROM public_research_versions").first()).n===0);
  const archive=(await request("/fixture/archive")).body;
  check("archive is immutable and idempotent",archive.first.contentHash===archive.second.contentHash&&archive.before===archive.after);
  const archived=await request(url,{headers});
  check("stage archive preferred to legacy RPC",archived.status===200&&archived.body.source==="stage-archive"&&archived.body.contentHash===archive.first.contentHash);
  check("archive read does not touch stopped session",JSON.stringify(after)===JSON.stringify((await request("/fixture/snapshot")).body));
  check("failed enrichment does not relabel parent draft",(await request("/fixture/enrichment")).body.draft===null);
  const absent=(await request("/fixture/missing-output")).body;
  check("absent output stays explicit unsubmitted/no draft",absent.stageSubmitted===false&&absent.draft===null);
  await SEC_FILINGS.put(archive.first.key,"tampered checkpoint");
  check("tampered archive fails closed without session fallback",(await request(url,{headers})).status===400);
  const report=await request("/fixture/report");
  check("stopped report remains readable without opening Pi",report.status===200&&report.body.status==="terminated");
  check("repeat terminate remains safe",(await request("/fixture/terminate")).status===200);
  check("report and terminate do not restore Pi",(await request("/fixture/snapshot")).body.telemetry.length===0);
  const normal=await request("/fixture/initialize?id="+normalId);
  check("non-terminated lifecycle still restores Pi normally",normal.status===200&&normal.body.telemetry.some(item=>item.hook==="restore")&&normal.body.telemetry.some(item=>item.hook==="mountModels"),normal.body.telemetry);
  check("no outbound request or model call",outbound.length===0,outbound);
  const output=resolve(process.argv[2]??"/tmp/spontra-public-research-checkpoint-acceptance.json");
  await mkdir(resolve(output,".."),{recursive:true});
  await writeFile(output,JSON.stringify({at:new Date().toISOString(),scope:"Local Cloudflare runtime, synthetic 19-claim stopped run; real admin site handler/proxy, service-bound AdminGateway, authenticated analysis handler, R2 and TaskRunner/PiHost SQL; no model/provider/production calls",checks,export:{runId,stage:"synthesis",characters:JSON.stringify(first.body.checkpoint).length,claims:19,contentHash:first.body.contentHash,sourceContentHash:source.contentHash},limitations:["Production stopped-run export remains for post-deployment read-only verification","Cloudflare Access is not configured in this isolated local runtime","Local instrumentation observes PiHost restore/mount/start/recover entry, not external provider invoices"]},null,2)+"\n");
  console.log(JSON.stringify({passed:checks.length,evidence:output}));
} finally {await mf.dispose();}
