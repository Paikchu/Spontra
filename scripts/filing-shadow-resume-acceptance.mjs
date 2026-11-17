/** Operator journey in a real local Cloudflare runtime. All model transports are synthetic and isolated. */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const require = createRequire(new URL("../node_modules/wrangler/package.json", import.meta.url)), { build } = require("esbuild");
const root = resolve(new URL("..", import.meta.url).pathname), scratch = await mkdtemp(resolve(tmpdir(), "spontra-shadow-resume-"));
const sha = value => createHash("sha256").update(value).digest("hex");
const ticker = "SYNTHETIC", accession = "0000000001-26-000001", at = "2026-01-02T00:00:00.000Z";
const uuid = number => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const id = number => `shadow-${ticker}-${accession}-${uuid(number)}`;
const sourceText = `${"SYNTHETIC ORIGINAL EVIDENCE ONLY. ".repeat(4000)}FULL-EVIDENCE-TAIL`;
const filing = { ticker, accessionNumber: accession, form: "10-Q", filingDate: "2026-11-12", reportDate: "2026-09-30", companyName: "Synthetic fixture", documentUrl: "https://example.invalid/filing" };
const material = { ticker, accession, version: "synthetic-immutable-material" };
const publicResearch = { asOf: at, mappingVersions: ["synthetic-mapping-v1"], reports: [{ report: { reportId: "synthetic-macro", version: "synthetic-macro-v1", title: "Synthetic macro", asOf: at, claims: [{ id: "claim-1", title: "Synthetic claim", statement: "Synthetic evidence only", sourceIds: [], observationIds: [] }], sources: [], observations: [] }, exposures: [], applicability: "requires_company_review" }], gaps: [{ kind: "industry", industryId: "synthetic", reason: "Synthetic only" }] };
const composer = { artifact: { kind: "filing-report", ticker, subject: accession, title: "Unvalidated synthetic draft", lang: "en" }, blocks: ["summary", "versus-prior", "overlooked", "quality", "risks", "what-to-watch"].map(blockId => ({ id: blockId, title: `Synthetic ${blockId}`, html: `<h2>Synthetic ${blockId}</h2><p>Unvalidated synthetic evidence.</p>`, sources: ["source-1"], state: "draft" })), charts: {}, sources: { "source-1": { title: "Synthetic original", url: null, kind: "sec" } }, open: { risks: [{ block: "risks", kind: "content", severity: "major", key: "synthetic-open-issue", problem: "Unvalidated fixture only" }] }, ladder: {}, hidden: [], phase: "compose", turns: 135, published: null, rounds: { content: 2, render: 0 }, log: [] };
const state = { composer, candidates: [], hits: [], used: { searches: 3, webReads: 2 }, web: { "source-1": sourceText }, read: ["source-1"], periodic: { texts: { "source-1": sourceText }, facts: {}, investmentChains: [{ id: "chain-1", financialEffect: "Old unvalidated calculation", computationRefs: ["impact1"] }], impactComputations: { impact1: { id: "impact1", calculatorVersion: "impact.calc.v1", values: { pretaxInterestChange: 82 }, status: "calculated" } } } };
const spec = number => ({ ticker, filing, profile: "periodic", sessionId: id(number), jobId: id(number), jobVersion: "shadow.v1", requestedBy: "manual", material, mode: "rewrite", shadow: true, shadowModel: "deepseek-v4-pro", shadowEffort: "max", publicResearch });
const parent = number => ({ runId: id(number), ticker, accession, createdAt: at, baseVersion: 6, callsReserved: 140, maxCalls: 140, spec: spec(number) });
const fixture = { ticker, accession, at, parents: Array.from({ length: 18 }, (_, n) => parent(n + 1)), state, failDispatchId: id(103), loopParentId: id(15) };
const workerPath = resolve(scratch, "worker.ts"), bundlePath = resolve(scratch, "worker.mjs");
await writeFile(workerPath, `
import {TaskRunner} from ${JSON.stringify(resolve(root, "workers/analysis/src/durable-runs/runner.ts"))};
import {handleReportAdminRequest} from ${JSON.stringify(resolve(root, "workers/analysis/src/admin/reports.ts"))};
import {handleAdminRequest} from ${JSON.stringify(resolve(root, "apps/admin/worker/index.ts"))};
import {createAdminSession} from ${JSON.stringify(resolve(root, "workers/analysis/src/admin/auth.ts"))};
import {packState} from ${JSON.stringify(resolve(root, "workers/analysis/src/pi/state.ts"))};
import {filingLoader} from ${JSON.stringify(resolve(root, "workers/analysis/src/filing-analysis/recipe.ts"))};
import {shadowResumeEnvironment} from ${JSON.stringify(resolve(root, "workers/analysis/src/filing-analysis/shadow-budget.ts"))};
import {callWorkerSecModel} from ${JSON.stringify(resolve(root, "workers/analysis/src/operations.ts"))};
import {judge} from ${JSON.stringify(resolve(root, "workers/analysis/src/artifact/openai.ts"))};
import {piModels} from ${JSON.stringify(resolve(root, "workers/analysis/src/pi/model.ts"))};
import {installProviderRequestGate} from ${JSON.stringify(resolve(root, "workers/analysis/src/pi/request-budget.ts"))};
import {openPeriodic} from ${JSON.stringify(resolve(root, "workers/analysis/src/filing-analysis/periodic.ts"))};
import {freezeCompanyResearch,saveCompanyResearchExposure} from ${JSON.stringify(resolve(root,"workers/analysis/src/public-research/context.ts"))};
import {savePublicResearchDraft,reviewPublicResearch,publishPublicResearch} from ${JSON.stringify(resolve(root,"workers/analysis/src/public-research/store.ts"))};
import {publicResearchTools} from ${JSON.stringify(resolve(root,"workers/analysis/src/company-research/context-tools.ts"))};
export {AdminGateway} from ${JSON.stringify(resolve(root, "workers/analysis/src/index.ts"))};
export class ResumeRunner extends TaskRunner {
  constructor(ctx,env) {
    const sql=ctx.storage.sql,f=JSON.parse(env.FIXTURE),ownId=ctx.id.name?.replace(/^FILING:/,""),p=f.parents.find(p=>p.runId===ownId),number=f.parents.indexOf(p)+1;
    sql.exec("CREATE TABLE IF NOT EXISTS resume_telemetry(hook TEXT)");
    sql.exec("CREATE TABLE IF NOT EXISTS resume_dispatch(spec TEXT,opening TEXT,operation_id TEXT)");
    sql.exec("CREATE TABLE IF NOT EXISTS pi_bindings(conversation TEXT PRIMARY KEY,session TEXT NOT NULL,operation_id TEXT NOT NULL,kind TEXT NOT NULL,spec TEXT NOT NULL,state TEXT NOT NULL,started_at INTEGER NOT NULL,turns INTEGER NOT NULL DEFAULT 0,quiet INTEGER NOT NULL DEFAULT 0,last_round INTEGER NOT NULL DEFAULT 0,capped INTEGER NOT NULL DEFAULT 0,finished INTEGER NOT NULL DEFAULT 0,asked TEXT,round TEXT,active INTEGER NOT NULL DEFAULT 1,spent INTEGER NOT NULL DEFAULT 0,startup TEXT,reserved_at INTEGER)");
    if(p) {
      const saved=structuredClone(f.state),savedSpec=structuredClone(p.spec);saved.periodic={...openPeriodic(),...saved.periodic};
      saved.syntheticMap=new Map([["source-1","map-tail"]]);saved.syntheticSet=new Set(["source-1"]);
      if(number===6)savedSpec.material.version="wrong-version";
      if(number===7)saved.composer.artifact.subject="wrong-accession";
      sql.exec("INSERT OR IGNORE INTO pi_bindings VALUES('parent-conversation','parent-session',?,'filing',?,?,0,135,0,0,?,?,NULL,NULL,?,650915,?,NULL)",number===5?p.runId+":wrong":p.runId+":shadow",JSON.stringify(savedSpec),packState(saved),number===10?0:1,number===11?1:0,number===2?1:0,number===12?'{}':null);
      if(number===4)sql.exec("INSERT OR IGNORE INTO pi_bindings VALUES('another-active','another-active',?,'filing',?,?,0,1,0,0,0,0,NULL,NULL,1,0,NULL,NULL)",p.runId+":other",JSON.stringify(p.spec),packState(saved));
    }
    super(ctx,env);
  }
  async initializeOnly(){await this.__unsafe_ensureInitialized();return this.snapshot();}
  evict(){this.ctx.abort("Local fixture cold restart");}
  async startSession(kind,spec,opening,operationId){
    this.ctx.storage.sql.exec("INSERT INTO resume_dispatch VALUES(?,?,?)",JSON.stringify(spec),opening,operationId);
    if(spec.sessionId===JSON.parse(this.env.FIXTURE).failDispatchId)throw Error("Synthetic dispatch acknowledgement failure");
    return super.startSession(kind,spec,opening,operationId);
  }
  snapshot(){const sql=this.ctx.storage.sql;return {sessions:sql.exec("SELECT operation_id,kind,spec,state,active,capped,finished,startup FROM pi_bindings").toArray(),dispatches:sql.exec("SELECT * FROM resume_dispatch").toArray(),telemetry:sql.exec("SELECT * FROM resume_telemetry").toArray(),tables:sql.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").toArray()};}
  wrongIdentity(runId,spec){return this.readFilingShadowSession(runId,spec);}
  replaceParent(spec,state){this.ctx.storage.sql.exec("UPDATE pi_bindings SET spec=?,state=? WHERE operation_id=?",JSON.stringify(spec),packState(state),spec.sessionId+":shadow");return true;}
}
export default {async fetch(request,env){
  const url=new URL(request.url),f=JSON.parse(env.FIXTURE),runId=url.searchParams.get("id")??f.parents[0].runId,stub=()=>env.TASK_RUNS.get(env.TASK_RUNS.idFromName("FILING:"+runId));
  if(url.pathname==="/fixture/auth")return Response.json({token:await createAdminSession(env.REPORT_ADMIN_PASSWORD)});
  if(url.pathname==="/fixture/exposure"){await saveCompanyResearchExposure(env,await request.json());return Response.json({saved:true});}
  if(url.pathname==="/fixture/public"){
    const input=await request.json(),draft=input.draft,saved=await savePublicResearchDraft(env,draft);
    if(input.mode!=="draft")await reviewPublicResearch(env,draft.reportId,saved.version,{mode:"human",reviewer:"synthetic-independent",reviewedAt:input.reviewedAt,authorRunId:draft.authorRunId,claimChecks:draft.claims.map(claim=>({claimId:claim.id,supported:true,notes:"Synthetic local evidence verified"})),conclusion:"approved",notes:"Synthetic fixture review only, not user sign-off"},input.reviewedAt);
    return Response.json(input.mode==="publish"?await publishPublicResearch(env,draft.reportId,saved.version,input.expectedCurrentVersion??null,input.publishedAt):saved);
  }
  if(url.pathname==="/fixture/context-parent"){
    const context=await freezeCompanyResearch(env,f.ticker,"2026-01-10T00:00:00.000Z"),p=structuredClone(f.parents.find(parent=>parent.runId===runId)),saved=structuredClone(f.state),macro=context.reports[0].report;
    p.spec.publicResearch=context;saved.periodic={...openPeriodic(),...saved.periodic};saved.publicResearchRead=true;
    saved.publicClaimsRead=[macro.reportId+":"+macro.version+":"+macro.claims[0].id];
    saved.researchUses=[{reportId:macro.reportId,version:macro.version,claimId:macro.claims[0].id,decision:"adopted",reason:"Synthetic company debt reprices under the dated contract",companySources:["source-1"],financialVariable:"cashInterest"}];
    saved.composer.sources.public1c1={title:"Synthetic original macro ordinal",url:null,kind:"data"};
    saved.composer.researchContext={asOf:context.asOf,mappingVersions:context.mappingVersions,reports:context.reports.map(({report})=>({reportId:report.reportId,version:report.version,title:report.title,asOf:report.asOf,type:report.type,scope:report.scope.description})),gaps:context.gaps,uses:saved.researchUses};
    await stub().replaceParent(p.spec,saved);await env.DB.prepare("UPDATE sec_cache SET payload=? WHERE cache_key=?").bind(JSON.stringify(p),"research-shadow:"+runId).run();return Response.json({parent:p,state:saved});
  }
  if(url.pathname==="/fixture/industry-gate"){
    const run=JSON.parse((await env.DB.prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind("research-shadow:"+runId).first()).payload),loaded=await filingLoader(run.spec,env),active=loaded.recipe.open(loaded.input),tools=loaded.recipe.tools(loaded.input),industry=run.spec.publicResearch.reports.at(-1).report;
    const call=async(name,args={})=>{const tool=tools.find(tool=>tool.name===name);return tool.execute(tool.parameters.parse(args),{state:active,signal:new AbortController().signal,recipe:"synthetic-context-gate",stage:async(_name,work)=>work()});};
    const initial={read:active.publicResearchRead,hasMetadata:!!active.composer.researchContext,uses:structuredClone(active.researchUses),claimsRead:structuredClone(active.publicClaimsRead),macroSource:structuredClone(active.composer.sources.public1c1)};
    const unreadFinish=await call("finish"),index=await call("read_public_research"),undecidedFinish=await call("finish");
    const decision={reportId:industry.reportId,version:industry.version,claimId:industry.claims[0].id,decision:"rejected",reason:"Synthetic company contract has fixed capacity pricing, so this industry demand channel does not establish its current cash interest.",companySources:["source-1"],financialVariable:"cashInterest"};
    const beforeRead=await call("record_public_research_use",decision),claim=await call("read_public_research",{reportId:industry.reportId,claimId:industry.claims[0].id}),readOnlyFinish=await call("finish"),recorded=await call("record_public_research_use",decision);
    const precheck=publicResearchTools(run.spec.publicResearch).precheck(active);loaded.hydrate?.(active);
    return Response.json({initial,unreadFinish,index,undecidedFinish,beforeRead,claim,readOnlyFinish,recorded,precheck,metadata:active.composer.researchContext,readAfterHydrate:active.publicResearchRead,uses:active.researchUses,claimsRead:active.publicClaimsRead,macroSource:active.composer.sources.public1c1,newIndustrySource:active.composer.sources.public2c1});
  }
  if(url.pathname==="/fixture/snapshot")return Response.json(await stub().snapshot());
  if(url.pathname==="/fixture/init")return Response.json(await stub().initializeOnly());
  if(url.pathname==="/fixture/recover"){await stub().recoverPiSessions();return Response.json({recovered:true});}
  if(url.pathname==="/fixture/evict"){try{await stub().evict();}catch{}return Response.json({evicted:true});}
  if(url.pathname==="/fixture/wrong"){try{const expected=structuredClone(f.parents[0].spec);expected.material.version="forged-material";return Response.json(await stub().wrongIdentity(runId,expected));}catch(error){return Response.json({error:String(error)},{status:409});}}
  if(url.pathname==="/fixture/loader"||url.pathname==="/fixture/request") {
    const row=await env.DB.prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind("research-shadow:"+runId).first(),run=JSON.parse(row.payload);
    try {
      const loaded=await filingLoader(run.spec,env),opened=loaded.recipe.open(loaded.input);
      if(url.pathname==="/fixture/loader")return Response.json({packed:packState(opened),turnBudget:loaded.recipe.budget.turns,model:loaded.model,effort:loaded.effort});
      const scoped=await shadowResumeEnvironment(env,run.spec),kind=url.searchParams.get("kind")??"pi";
      if(kind==="judge")return Response.json({result:await judge(scoped,{stage:"synthetic-review",system:"Synthetic local check",text:"Synthetic",schema:{type:"object",properties:{ok:{type:"boolean"}},required:["ok"],additionalProperties:false},maxRetries:Number(url.searchParams.get("retries")??0),ledger:{kind:"synthetic-review",runId}})});
      if(kind==="worker")return Response.json({result:await callWorkerSecModel({...scoped,AI_ENDPOINTS:JSON.stringify([{name:run.spec.shadowModel,url:"https://fixture-model.invalid/v1",apiKey:"synthetic-local-only",thinkingLevel:"max"}])},fetch,"synthetic-block-review","Synthetic",{},run.spec.shadowModel,20000,{runId})});
      const models=piModels(env,[run.spec.shadowModel]);installProviderRequestGate(models,async()=>async()=>{if(!await loaded.reserve(opened,Date.now()))throw Error("Synthetic scoped Pi request blocked");});
      const model=models.getModel("spontra",run.spec.shadowModel),answer=await models.completeSimple(model,{messages:[{role:"user",content:"Synthetic isolated main transport",timestamp:1}]},{sessionId:runId,maxRetries:Number(url.searchParams.get("retries")??0),maxRetryDelayMs:1});
      return Response.json({stopReason:answer.stopReason,error:answer.errorMessage??null});
    }catch(error){return Response.json({error:String(error)},{status:409});}
  }
  if(url.pathname.startsWith("/api/admin/"))return handleAdminRequest(request,{...env,ASSETS:{fetch:()=>new Response("Not found",{status:404})}});
  if(url.pathname.startsWith("/admin/"))return handleReportAdminRequest(request,env);
  return new Response("Not found",{status:404});
}};
`);
await build({ entryPoints: [workerPath], outfile: bundlePath, bundle: true, format: "esm", platform: "node", target: "es2022", conditions: ["workerd", "worker", "browser"], external: ["cloudflare:*", "node:*"], banner: { js: "import {createRequire as localRequire} from 'node:module'; const require=localRequire('/shadow-worker.mjs');" }, loader: { ".css": "text", ".txt": "text" }, plugins: [{ name: "observe-real-pi-actions", setup(bundle) {
  bundle.onLoad({ filter: /\/pi\/host\.ts$/ }, async ({ path }) => {
    let contents = await readFile(path, "utf8");
    for (const hook of ["restore", "mountModels", "ensureStarted", "recoverEnded"]) contents = contents.replace(new RegExp("^(\\s*(?:private )?async " + hook + "\\([^\\n]*\\{)$", "m"), '$1 this.agent.sql.exec("INSERT INTO resume_telemetry VALUES(?)",' + JSON.stringify(hook) + ');');
    return { contents, loader: "ts" };
  });
  bundle.onLoad({ filter: /\/axe\.min\.js$/ }, async ({ path }) => ({ contents: await readFile(path, "utf8"), loader: "text" }));
  bundle.onLoad({ filter: /\/filing-analysis\/recipe\.ts$/ }, async ({ path }) => ({ contents: (await readFile(path,"utf8")).replace("afterRun: async (s) => {", 'afterRun: async (s) => { await env.DB!.prepare("INSERT INTO resume_endings(run_id) VALUES(?)").bind(spec.sessionId).run();'), loader: "ts" }));
} }] });

const requests = [], forbidden = [];
let failTransport = false;
const options = convertV4MiniflareOptions({ name: "shadow-resume-acceptance", modules: true, modulesRoot: scratch, scriptPath: bundlePath, compatibilityDate: "2026-08-26", compatibilityFlags: ["nodejs_compat"], durableObjects: { TASK_RUNS: { className: "ResumeRunner", useSQLite: true } }, serviceBindings: { SPONTRA_ANALYSIS: { name: "shadow-resume-acceptance", entrypoint: "AdminGateway" } }, d1Databases: { DB: "shadow-resume-acceptance" }, r2Buckets: ["SEC_FILINGS"], bindings: { FIXTURE: JSON.stringify(fixture), REPORT_ADMIN_PASSWORD: "synthetic-local-only", DEEPSEEK_API_KEY: "synthetic-local-only", OPENAI_API_KEY: "synthetic-local-only", OPENAI_REVIEW_MODEL: "gpt-6.1-sol", PI_MODEL_BASE_URL: "https://fixture-model.invalid/v1" }, outboundService: async request => {
  const url = new URL(request.url);
  if (!["fixture-model.invalid", "api.openai.com"].includes(url.hostname)) { forbidden.push(request.url); return new Response("External network forbidden", { status: 599 }); }
  const body = await request.json(); requests.push({ host: url.hostname, model: body.model, streaming: body.stream === true });
  if (failTransport) return Response.json({ error: { message: "Synthetic transport failure" } }, { status: 500, headers: { "retry-after-ms": "1" } });
  if (!body.stream) return Response.json({ id: "synthetic", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: '{"ok":true}' }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } });
  const loop = JSON.stringify(body).includes(fixture.loopParentId), text = '{"ok":true}', tool = { index: 0, id: "synthetic-" + requests.length, type: "function", function: { name: "outline", arguments: "{}" } };
  if (loop) await new Promise(resolve => setTimeout(resolve, 5));
  const chunk = { id: "synthetic-" + requests.length, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: loop ? { role: "assistant", tool_calls: [tool] } : { role: "assistant", content: text }, finish_reason: null }] };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: loop ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
} });
const mf = new Miniflare(options), checks = [];
const check = (name, ok, detail) => { if (!ok) throw new Error(name + ": " + JSON.stringify(detail)); checks.push({ name, status: "passed", ...(detail === undefined ? {} : { detail }) }); };
const request = async (path, init = {}) => { const response = await mf.dispatchFetch("http://localhost" + path, init), text = await response.text(); let body; try { body = JSON.parse(text); } catch { body = text; } return { status: response.status, body }; };
const path = number => `/admin/reports/${ticker}/${accession}/shadow/${id(number)}`;
const proxy = number => path(number).replace("/admin/", "/api/admin/");
const snapshot = runId => request(`/fixture/snapshot?id=${runId}`);
async function waitEnded(runId) {
  let last;
  for (let attempt = 0; attempt < 400; attempt++) {
    const saved = (await snapshot(runId)).body;
    last=saved;
    if (saved.sessions.length && saved.sessions.every(row => row.active === 0)) return saved;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error("Synthetic child did not end within 20 seconds: " + runId + " " + JSON.stringify(last.sessions.map(({active,capped,finished,startup})=>({active,capped,finished,startup}))));
}
try {
  const { DB, SEC_FILINGS } = await mf.getBindings();
  for (const statement of ["CREATE TABLE sec_cache(cache_key TEXT PRIMARY KEY,payload TEXT NOT NULL,fetched_at TEXT NOT NULL)", "CREATE TABLE analysis_artifacts(artifact_id TEXT PRIMARY KEY,published_version INTEGER)", "CREATE TABLE financial_company_settings(ticker TEXT PRIMARY KEY,enabled INTEGER)", "CREATE TABLE business_feature_settings(ticker TEXT,feature TEXT,generate INTEGER)", "CREATE TABLE ai_tool_settings(tool TEXT PRIMARY KEY,model TEXT,effort TEXT,updated_at TEXT)", "CREATE TABLE resume_endings(run_id TEXT)"]) await DB.prepare(statement).run();
  const researchMigration=await readFile(resolve(root,"workers/analysis/migrations/0060_public_research.sql"),"utf8");
  for(const statement of researchMigration.replace(/--[^\n]*/g,"").split(";").map(value=>value.trim()).filter(Boolean))await DB.prepare(statement).run();
  const usage = await readFile(resolve(root, "workers/analysis/migrations/0023_ai_usage.sql"), "utf8");
  for (const statement of usage.replace(/--[^\n]*/g, "").split(";").map(value => value.trim()).filter(Boolean)) await DB.prepare(statement).run();
  for (const name of ["user_hash", "conversation_id"]) await DB.prepare(`ALTER TABLE ai_usage ADD COLUMN ${name} TEXT`).run();
  await DB.prepare("INSERT INTO analysis_artifacts VALUES(?,6)").bind(`filing-report:${ticker}:${accession}`).run();
  await SEC_FILINGS.put(`sec-materials/v1/${ticker}/${accession}/${material.version}/index.json`, JSON.stringify({ ref: material, format: "filing-material.index.v2", filing: { ticker, accession, form: filing.form, reportDate: filing.reportDate }, documents: [], blocks: [], tables: [], facts: [], toc: [], coverage: { duplicates: [] } }));
  for (const p of fixture.parents) {
    await DB.prepare("INSERT INTO sec_cache VALUES(?,?,?)").bind("research-shadow:" + p.runId, JSON.stringify(p), at).run();
    const number = fixture.parents.indexOf(p) + 1;
    if (number !== 9) await SEC_FILINGS.put(`research-shadow/${p.runId}/failed.json`, JSON.stringify({ status: number === 3 ? "stopped" : "failed", reason: "Synthetic original receipt", at }));
    if (number === 8) await SEC_FILINGS.put(`research-shadow/${p.runId}/validated.json`, '{"synthetic":true}');
  }
  const { body: { token } } = await request("/fixture/auth"), headers = { authorization: "Bearer " + token };
  const send = (number, continuationNumber, body, extraHeaders = {}) => request(path(number) + "/resume", { method: "POST", headers: { ...headers, "content-type": "application/json", "idempotency-key": uuid(continuationNumber), ...extraHeaders }, body: JSON.stringify(body) });
  const originalD1 = await DB.prepare("SELECT * FROM sec_cache WHERE cache_key=?").bind("research-shadow:" + id(1)).first(), originalFailure = await (await SEC_FILINGS.get(`research-shadow/${id(1)}/failed.json`)).text();
  check("admin authentication required", (await request(path(1) + "/checkpoint")).status === 401);
  const before = (await snapshot(id(1))).body;
  await request(`/fixture/evict?id=${id(1)}`);
  const first = await request(path(1) + "/checkpoint", { headers }), second = await request(path(1) + "/checkpoint", { headers });
  check("cold authenticated GET exports unvalidated complete state", first.status === 200 && first.body.readOnly && first.body.reviewStatus === "unvalidated" && !first.body.published, first.status);
  check("checkpoint includes six blocks and full evidence tail", JSON.parse(first.body.checkpoint.state).composer.blocks.length === 6 && first.body.checkpoint.state.includes("FULL-EVIDENCE-TAIL"));
  check("Map and Set state tags preserved", first.body.checkpoint.state.includes('"__pi":"map"') && first.body.checkpoint.state.includes('"__pi":"set"'));
  check("hash covers every checkpoint byte and stays stable", first.body.checkpointHash === sha(JSON.stringify(first.body.checkpoint)) && JSON.stringify(first) === JSON.stringify(second));
  const initialized = (await request(`/fixture/init?id=${id(1)}`)).body;
  check("cold read and explicit initialization never mount restore start recover or change SQL sessions", initialized.telemetry.length === 0 && JSON.stringify(initialized.sessions) === JSON.stringify(before.sessions), initialized.telemetry);
  check("checkpoint reads send zero model requests", requests.length === 0, requests.length);
  const viaProxy = await request(proxy(1) + "/checkpoint");
  check("real admin proxy and service-bound AdminGateway preserve complete checkpoint", viaProxy.status === 200 && JSON.stringify(viaProxy.body) === JSON.stringify(first.body), viaProxy.status);
  check("checkpoint GET did not write D1 or R2 archive", (await DB.prepare("SELECT COUNT(*) n FROM sec_cache").first()).n === fixture.parents.length && (await SEC_FILINGS.list({ prefix: `research-shadow/${id(1)}/checkpoints/` })).objects.length === 0);
  for (const [number, label] of [[2,"active session"],[3,"stopped receipt"],[4,"another active session"],[5,"wrong operation id"],[6,"changed stored specification"],[7,"wrong saved artifact identity"],[8,"validated shadow"],[9,"missing failed receipt"]]) {
    const answer = await request(path(number) + "/checkpoint", { headers }); check(label + " checkpoint refused", answer.status === 409, answer);
  }
  check("rejected active and mismatched reads never start models or recovery", requests.length === 0 && (await snapshot(id(2))).body.telemetry.length === 0 && (await snapshot(id(4))).body.telemetry.length === 0);
  check("RPC rejects caller-provided wrong material", (await request(`/fixture/wrong?id=${id(1)}`)).status === 409);
  check("checkpoint is GET only", (await request(path(1) + "/checkpoint", { headers, method: "POST" })).status === 405);
  check("resume is POST only", (await request(path(1) + "/resume", { headers })).status === 405);
  check("proxy rejects mutation of checkpoint", (await request(proxy(1) + "/checkpoint", { method: "POST", headers: { origin: "http://localhost" } })).status === 404);
  check("proxy rejects resume GET and cross-origin POST", (await request(proxy(1) + "/resume")).status === 404 && (await request(proxy(1) + "/resume", { method: "POST", headers: { origin: "https://other.invalid" } })).status === 403);
  const input = { expectedCheckpointHash: first.body.checkpointHash, reason: "Synthetic exact saved-state continuation" };
  check("UUID is mandatory", (await send(1, 101, input, { "idempotency-key": "not-a-uuid" })).status === 400);
  check("empty reason and extra model override refused", (await send(1, 101, { ...input, reason: " " })).status === 400 && (await send(1, 101, { ...input, model: "different" })).status === 400);
  check("stale checkpoint hash refused", (await send(1, 101, { ...input, expectedCheckpointHash: "f".repeat(64) })).status === 409);
  for (const [number, label] of [[10,"inactive but not capped"],[11,"finished recipe"],[12,"pending startup"]]) {
    const exported = await request(path(number) + "/checkpoint", { headers });
    check(label + " read stays available", exported.status === 200, exported);
    const refused = await send(number, 100 + number, { ...input, expectedCheckpointHash: exported.body.checkpointHash });
    check(label + " cannot be mistaken for natural budget exhaustion", refused.status === 409, refused);
  }
  const started = await request(proxy(1) + "/resume", { method: "POST", headers: { origin: "http://localhost", "idempotency-key": uuid(101), "content-type": "application/json" }, body: JSON.stringify(input) });
  check("authenticated proxy dispatches one bounded continuation", started.status === 202 && started.body.status === "dispatched", started);
  const childRow = JSON.parse((await DB.prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind("research-shadow:" + id(101)).first()).payload);
  check("child fixes maxCalls40 and records parent140 plus cumulative180", childRow.maxCalls === 40 && childRow.parentRunId === id(1) && childRow.continuation.parentCallsReserved === 140 && childRow.continuation.parentMaxCalls === 140 && childRow.continuation.cumulativeMaxCalls === 180);
  const expectedSpec = { ...spec(1), mode: "resume", checkpoint: childRow.spec.checkpoint, checkpointHash: input.expectedCheckpointHash, sessionId: id(101), jobId: id(101) };
  check("original filing model effort public research material and base version remain frozen", JSON.stringify(childRow.spec) === JSON.stringify(expectedSpec) && childRow.baseVersion === 6);
  const loader = await request(`/fixture/loader?id=${id(101)}`);
  check("real recipe opens full original packed state with forty-turn budget", loader.status === 200 && loader.body.packed === first.body.checkpoint.state && loader.body.turnBudget === 40 && loader.body.model === spec(1).shadowModel && loader.body.effort === "max", { status: loader.status, turns: loader.body.turnBudget });
  const ended = await waitEnded(id(101));
  check("ordinary SDK completion invokes recipe afterRun exactly once", (await DB.prepare("SELECT COUNT(*) n FROM resume_endings WHERE run_id=?").bind(id(101)).first()).n === 1);
  const opening = JSON.parse(ended.dispatches[0].opening);
  check("actual Pi dispatch uses resume and targeted repair instructions", ended.dispatches.length === 1 && opening.mode === "resume" && opening.repairs.length === 6 && opening.repairs.join(" ").includes("net-interest forecast") && opening.saved.blocks.length === 6 && opening.operatorReason === input.reason && opening.saved.openIssues.risks.length === 1);
  const replayed = await send(1, 101, input);
  check("exact retry returns receipt without redispatch", replayed.status === 202 && replayed.body.replay && replayed.body.dispatchRetried === false && (await snapshot(id(101))).body.dispatches.length === 1);
  check("same UUID with changed reason and second UUID refused", (await send(1, 101, { ...input, reason: "Different operation" })).status === 409 && (await send(1, 102, input)).status === 409);
  check("child cannot itself be resumed", (await send(101, 201, input)).status === 409);
  const getCalls = async runId => JSON.parse((await DB.prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind("research-shadow:" + runId).first()).payload).callsReserved;
  const mainStart = await getCalls(id(101)), sendCount = requests.length;
  check("independent OpenAI review uses same allowance", (await request(`/fixture/request?id=${id(101)}&kind=judge`)).status === 200 && await getCalls(id(101)) === mainStart + 1);
  check("block-review transport uses same allowance", (await request(`/fixture/request?id=${id(101)}&kind=worker`)).status === 200 && await getCalls(id(101)) === mainStart + 2);
  check("both real auxiliary clients sent to local synthetic transports", requests.length === sendCount + 2 && requests.slice(-2).some(row => row.host === "api.openai.com"));
  while (await getCalls(id(101)) < 39) await request(`/fixture/request?id=${id(101)}&kind=pi`);
  const beforeConcurrent = requests.length;
  await Promise.all(Array.from({ length: 8 }, (_, n) => request(`/fixture/request?id=${id(101)}&kind=${n % 2 ? "judge" : "pi"}`)));
  check("concurrent main and audit transports cannot exceed final shared slot", await getCalls(id(101)) === 40 && requests.length === beforeConcurrent + 1, { calls: await getCalls(id(101)), newHttpRequests: requests.length - beforeConcurrent });
  const cappedRequests = requests.length;
  await request(`/fixture/request?id=${id(101)}&kind=worker`); await request(`/fixture/request?id=${id(101)}&kind=judge&retries=2`); await request(`/fixture/request?id=${id(101)}&kind=pi&retries=2`);
  check("post-cap clients and SDK retries send no additional HTTP", requests.length === cappedRequests && await getCalls(id(101)) === 40);
  const parentRetry = await request(path(13) + "/checkpoint", { headers }), retryInput = { ...input, expectedCheckpointHash: parentRetry.body.checkpointHash };
  await send(13, 113, retryInput); await waitEnded(id(113));
  while (await getCalls(id(113)) < 39) await request(`/fixture/request?id=${id(113)}&kind=pi`);
  const retryBefore = requests.length; failTransport = true;
  await request(`/fixture/request?id=${id(113)}&kind=judge&retries=2`); failTransport = false;
  check("failed provider response consumes last slot and automatic retry is blocked", requests.length === retryBefore + 1 && await getCalls(id(113)) === 40);
  const failing = await request(path(14) + "/checkpoint", { headers }), failInput = { ...input, expectedCheckpointHash: failing.body.checkpointHash };
  const failed = await send(14, 103, failInput), failedAgain = await send(14, 103, failInput);
  check("dispatch failure keeps durable claim and replay never retries", failed.status === 503 && failed.body.status === "dispatch_failed" && failedAgain.status === 503 && failedAgain.body.replay && (await snapshot(id(103))).body.dispatches.length === 1, failed);
  check("failed dispatch preserves a child failure receipt", (JSON.parse(await (await SEC_FILINGS.get(`research-shadow/${id(103)}/failed.json`)).text())).status === "failed");
  check("failed dispatch parent cannot claim a second child", (await send(14, 104, failInput)).status === 409);
  const looping = await request(path(15) + "/checkpoint", { headers }), loopInput = { ...input, expectedCheckpointHash: looping.body.checkpointHash };
  const loopStarted = await send(15, 115, loopInput);
  check("budget-exhaustion journey starts the actual Pi session", loopStarted.status === 202, loopStarted);
  await request(`/fixture/request?id=${id(115)}&kind=judge`);
  await request(`/fixture/request?id=${id(115)}&kind=worker`);
  let loopState;
  for (let attempt = 0; attempt < 400; attempt++) {
    loopState = (await snapshot(id(115))).body;
    if (loopState.sessions.some(session => session.capped)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  check("actual shared HTTP exhaustion persists capped before any extra provider send", await getCalls(id(115)) === 40 && loopState.sessions.some(session => session.capped === 1 && session.finished === 0), loopState.sessions.map(({ active, capped, finished }) => ({ active, capped, finished })));
  await request(`/fixture/recover?id=${id(115)}`);
  const loopEnded = await waitEnded(id(115));
  check("actual exhausted session ends inactive capped unfinished with no pending startup", loopEnded.sessions.every(session => session.active === 0 && session.capped === 1 && session.finished === 0 && session.startup === null));
  await Promise.all([request(`/fixture/recover?id=${id(115)}`), request(`/fixture/recover?id=${id(115)}`)]);
  check("concurrent recovery and SDK completion do not repeat afterRun", (await DB.prepare("SELECT COUNT(*) n FROM resume_endings WHERE run_id=?").bind(id(115)).first()).n === 1);
  const loopCheckpoint = await request(path(115) + "/checkpoint", { headers });
  check("actual exhausted child still exports full saved work but cannot continue twice", loopCheckpoint.status === 200 && loopCheckpoint.body.checkpoint.session.capped && loopCheckpoint.body.checkpoint.state.includes("FULL-EVIDENCE-TAIL") && (await send(115, 215, { ...input, expectedCheckpointHash: loopCheckpoint.body.checkpointHash })).status === 409, loopCheckpoint.status);
  const race = await request(path(16) + "/checkpoint", { headers }), raceInput = { ...input, expectedCheckpointHash: race.body.checkpointHash };
  const raced = await Promise.all([send(16, 116, raceInput), send(16, 117, raceInput)]);
  check("racing different UUIDs claim exactly one child", raced.filter(result => result.status === 202).length === 1 && raced.filter(result => result.status === 409).length === 1, raced.map(row => row.status));
  await waitEnded(raced.find(row => row.status === 202).body.runId);
  const archived = await (await SEC_FILINGS.get(childRow.spec.checkpoint)).text();
  await SEC_FILINGS.put(childRow.spec.checkpoint, archived.replace("FULL-EVIDENCE-TAIL", "TAMPERED-EVIDENCE-TAIL"));
  const tampered = await request(`/fixture/loader?id=${id(101)}`);
  check("loader independently refuses checkpoint archive tampering", tampered.status === 409 && tampered.body.error.includes("FILING_CHECKPOINT_HASH_MISMATCH"), tampered);
  await SEC_FILINGS.put(childRow.spec.checkpoint, archived);
  check("original parent cache including 140-call ledger stays byte-identical", JSON.stringify(await DB.prepare("SELECT * FROM sec_cache WHERE cache_key=?").bind("research-shadow:" + id(1)).first()) === JSON.stringify(originalD1));
  check("original failed receipt remains byte-identical", await (await SEC_FILINGS.get(`research-shadow/${id(1)}/failed.json`)).text() === originalFailure);
  check("public report pointer remains version six", (await DB.prepare("SELECT published_version FROM analysis_artifacts").first()).published_version === 6);
  const contextExcerpt="Synthetic public evidence: disclosed financing and industry capacity require company-specific contract review.",contextSource={id:"public-source",canonicalId:"synthetic-original",uri:"https://example.com/synthetic-public",title:"Synthetic original",locator:"paragraph 1",excerpt:contextExcerpt,contentHash:sha(contextExcerpt),revision:"synthetic-v1",publishedAt:at,availableAt:at,collectedAt:at,observationPeriod:{start:"2026-01-01",end:"2026-01-01"},usage:"public",authorization:"Synthetic local acceptance only"};
  const contextDraft=(type,reportId,asOf=at)=>({schemaVersion:"public-research.v1",reportId,type,title:"Synthetic "+type,language:"en",scope:{regions:["US"],currency:"USD",industryId:type==="industry"?"synthetic-cloud":null,description:"Synthetic local scope"},asOf,generatedAt:asOf,validUntil:"2099-01-01T00:00:00.000Z",inputFingerprint:sha(reportId+asOf),modelVersion:"synthetic-no-model",promptVersion:"fixture",toolVersion:"fixture",coverage:"limited",missingInputs:["Synthetic evidence only"],changes:["Synthetic first version"],summary:"Synthetic scope validation only",sources:[contextSource],observations:[],claims:[{id:"claim-1",kind:"fact",title:"Synthetic "+type+" claim",statement:"Synthetic source describes a dated "+type+" transmission channel.",sourceIds:[contextSource.id],observationIds:[],premiseClaimIds:[],assumptions:[],impactChannels:["Synthetic source to company contract review"],counterEvidence:["Company contract terms can differ"],verification:"Inspect company contract evidence",shockId:type+"-shock",financialVariable:"cashInterest"}],dependencies:[],scenarios:[{name:"base",assumptions:["Synthetic local scope only"],claimIds:["claim-1"]}],authorRunId:"synthetic-"+reportId,sections:[{id:"transmission",title:"Synthetic transmission",claimIds:["claim-1"]}]});
  const macroDraft=contextDraft("macro","synthetic-context-macro"),macroPublished=(await request("/fixture/public",{method:"POST",body:JSON.stringify({mode:"publish",draft:macroDraft,reviewedAt:"2026-01-03T00:00:00.000Z",publishedAt:"2026-01-04T00:00:00.000Z"})})).body;
  check("G5 real publication store supplies a reviewed macro fixture",Boolean(macroPublished.version),macroPublished);
  const emptyMappingParent=(await request(`/fixture/context-parent?id=${id(18)}`)).body,emptyMappingCheckpoint=await request(path(18)+"/checkpoint",{headers}),emptyMappingParentRow=await DB.prepare("SELECT * FROM sec_cache WHERE cache_key=?").bind("research-shadow:"+id(18)).first();
  const newMappingInput={...input,expectedCheckpointHash:emptyMappingCheckpoint.body.checkpointHash,includePublishedIndustry:true};
  check("G5 original no-mapping parent is retained for explicit exposure addition",emptyMappingParent.parent.spec.publicResearch.mappingVersions.length===0&&emptyMappingParent.parent.spec.publicResearch.gaps.some(gap=>gap.reason==="uncovered: no verified business exposure mapping"));
  const exposure={id:"synthetic-cloud-exposure",version:"v1",companyId:ticker,segmentId:null,industryId:"synthetic-cloud",relation:"industry",regions:["US"],validFrom:at,validUntil:null,source:contextSource,weight:null,weightBasis:null,status:"verified"};
  check("G5 evidenced exposure mapping saved through real handler",(await request("/fixture/exposure",{method:"POST",body:JSON.stringify(exposure)})).status===200);
  const contextParent=(await request(`/fixture/context-parent?id=${id(17)}`)).body;
  const contextBefore=await request(path(17)+"/checkpoint",{headers}),contextParentRow=await DB.prepare("SELECT * FROM sec_cache WHERE cache_key=?").bind("research-shadow:"+id(17)).first(),contextSessionBefore=(await snapshot(id(17))).body.sessions;
  const industryInput={...input,expectedCheckpointHash:contextBefore.body.checkpointHash,includePublishedIndustry:true};
  check("G5 parent starts with exact macro and mapped uncovered industry",contextParent.parent.spec.publicResearch.reports.length===1&&contextParent.parent.spec.publicResearch.reports[0].report.version===macroPublished.version&&contextParent.parent.spec.publicResearch.gaps.some(gap=>gap.kind==="industry"&&gap.industryId==="synthetic-cloud"));
  check("G5 absent industry cannot silently produce same-scope child",(await send(17,217,industryInput)).status===409);
  const industryDraft={...contextDraft("industry","synthetic-context-industry","2026-01-10T00:00:00.000Z"),dependencies:[{reportId:macroPublished.reportId,version:macroPublished.version,claimId:"claim-1",ownerClaimIds:["claim-1"]}]};
  const industrySaved=(await request("/fixture/public",{method:"POST",body:JSON.stringify({mode:"draft",draft:industryDraft})})).body;
  check("G5 unpublished industry draft is refused",Boolean(industrySaved.version)&&(await send(17,217,industryInput)).status===409);
  await request("/fixture/public",{method:"POST",body:JSON.stringify({mode:"review",draft:industryDraft,reviewedAt:"2026-01-11T00:00:00.000Z"})});
  check("G5 reviewed but unpublished industry is refused",(await send(17,217,industryInput)).status===409);
  const industryPublished=(await request("/fixture/public",{method:"POST",body:JSON.stringify({mode:"publish",draft:industryDraft,reviewedAt:"2026-01-11T00:00:00.000Z",publishedAt:"2026-02-01T00:00:00.000Z"})})).body;
  check("G5 real industry publication includes exact macro dependency",Boolean(industryPublished.version)&&industryPublished.dependencies[0].version===macroPublished.version,industryPublished);
  await DB.prepare("UPDATE public_research_reports SET freshness='stale' WHERE report_id=?").bind(industryPublished.reportId).run();
  check("G5 stale published industry refused",(await send(17,217,industryInput)).status===409);
  await DB.prepare("UPDATE public_research_reports SET freshness='valid' WHERE report_id=?").bind(industryPublished.reportId).run();
  await DB.prepare("INSERT INTO public_research_claim_invalidations VALUES(?,?,?)").bind(industryPublished.reportId,industryPublished.version,"claim-1").run();
  check("G5 invalidated industry claim refused",(await send(17,217,industryInput)).status===409);
  await DB.prepare("DELETE FROM public_research_claim_invalidations WHERE report_id=?").bind(industryPublished.reportId).run();
  const changedExposure={...exposure,version:"v2",validFrom:"2026-02-01T00:00:00.000Z"};
  await request("/fixture/exposure",{method:"POST",body:JSON.stringify(changedExposure)});
  const changedMapping=await send(17,217,industryInput);
  check("G5 changed exposure mapping refused",changedMapping.status===409&&changedMapping.body.error.includes("mapping changed"),changedMapping);
  await DB.prepare("DELETE FROM company_research_exposures WHERE exposure_id=? AND version='v2'").bind(exposure.id).run();
  await DB.prepare("UPDATE public_research_versions SET published_at='2099-01-01T00:00:00.000Z' WHERE report_id=?").bind(industryPublished.reportId).run();
  check("G5 future publication refused",(await send(17,217,industryInput)).status===409);
  await DB.prepare("UPDATE public_research_versions SET published_at=? WHERE report_id=?").bind(industryPublished.publishedAt,industryPublished.reportId).run();
  await DB.prepare("INSERT INTO public_research_claim_invalidations VALUES(?,?,?)").bind(macroPublished.reportId,macroPublished.version,"claim-1").run();
  const revokedParentClaim=await send(17,217,industryInput);
  check("G5 previously adopted parent claim must remain valid",revokedParentClaim.status===409&&revokedParentClaim.body.error.includes("parent claim is no longer"),revokedParentClaim);
  await DB.prepare("DELETE FROM public_research_claim_invalidations WHERE report_id=?").bind(macroPublished.reportId).run();
  check("G5 rejected admissions create no continuation claim",!await DB.prepare("SELECT 1 FROM sec_cache WHERE cache_key=?").bind("research-shadow:"+id(17)+":resume").first());
  const replaceExposure=async(value)=>DB.prepare("UPDATE company_research_exposures SET status=?,body_json=? WHERE exposure_id=? AND version='v1'").bind(value.status,JSON.stringify(value),value.id).run();
  await replaceExposure({...exposure,status:"disputed"});
  check("G5 unverified new exposure cannot be appended",(await send(18,218,newMappingInput)).status===409);
  check("G5 removing an existing verified mapping is refused",(await send(17,217,industryInput)).status===409);
  await replaceExposure({...exposure,source:{...contextSource,availableAt:"2099-01-01T00:00:00.000Z"}});
  check("G5 future-available new exposure cannot be appended",(await send(18,218,newMappingInput)).status===409);
  await replaceExposure({...exposure,source:{...contextSource,collectedAt:"2099-01-01T00:00:00.000Z"}});
  check("G5 future-collected evidence cannot authorize a mapping",(await send(18,218,newMappingInput)).status===409);
  await replaceExposure({...exposure,source:{...contextSource,contentHash:"f".repeat(64)}});
  const badMappingHash=await send(18,218,newMappingInput);
  check("G5 new exposure must match its original excerpt hash",badMappingHash.status===409&&badMappingHash.body.error.includes("matching source hash"),badMappingHash);
  await replaceExposure({...exposure,source:{...contextSource,excerpt:""}});
  check("G5 new exposure without original evidence is refused",(await send(18,218,newMappingInput)).status===409);
  await replaceExposure(exposure);
  const newerMacroDraft={...macroDraft,title:"Synthetic newer macro presentation",asOf:"2026-10-01T00:00:00.000Z",generatedAt:"2026-10-01T00:00:00.000Z",inputFingerprint:sha("newer-presentation")};
  const newerMacro=(await request("/fixture/public",{method:"POST",body:JSON.stringify({mode:"publish",draft:newerMacroDraft,reviewedAt:"2026-10-02T00:00:00.000Z",publishedAt:"2026-10-03T00:00:00.000Z",expectedCurrentVersion:macroPublished.version})})).body;
  check("G5 newer macro fixture is available without changing original adopted claim",Boolean(newerMacro.version)&&newerMacro.version!==macroPublished.version,newerMacro.version);
  const included=await send(17,217,industryInput);
  check("G5 explicit industry option admits one child",included.status===202&&included.body.includePublishedIndustry&&included.body.status==="dispatched",included);
  await waitEnded(id(217));
  const expandedChild=JSON.parse((await DB.prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind("research-shadow:"+id(217)).first()).payload),expanded=expandedChild.spec.publicResearch,parentContext=contextParent.parent.spec.publicResearch;
  check("G5 original macro report body ordinal and exact version remain unchanged",JSON.stringify(expanded.reports.slice(0,parentContext.reports.length))===JSON.stringify(parentContext.reports)&&expanded.reports[0].report.version===macroPublished.version&&expanded.reports[0].report.version!==newerMacro.version);
  check("G5 industry appended with verified exposure and unchanged mapping",expanded.reports.length===2&&expanded.reports[1].report.version===industryPublished.version&&expanded.reports[1].exposures[0].version==="v1"&&JSON.stringify(expanded.mappingVersions)===JSON.stringify(parentContext.mappingVersions));
  check("G5 receipt binds both context hashes and exact added publication",included.body.parentContextHash===sha(JSON.stringify(parentContext))&&included.body.newContextHash===sha(JSON.stringify(expanded))&&included.body.addedIndustryReports[0].version===industryPublished.version&&included.body.addedIndustryReports[0].publishedAt===industryPublished.publishedAt&&included.body.childContextAsOf===expanded.asOf&&expanded.frozenAt>=expanded.asOf&&industryPublished.publishedAt<=expanded.asOf,included.body);
  check("G5 still uses original material model base version and forty-call allowance",expandedChild.spec.material.version===material.version&&expandedChild.spec.shadowModel===spec(17).shadowModel&&expandedChild.baseVersion===6&&expandedChild.maxCalls===40&&expandedChild.continuation.cumulativeMaxCalls===180);
  const contextCallsBefore=requests.length,gate=await request(`/fixture/industry-gate?id=${id(217)}`);
  check("G5 new recipe requires rereading context while preserving old decisions and claim reads",gate.status===200&&gate.body.initial.read===false&&!gate.body.initial.hasMetadata&&JSON.stringify(gate.body.initial.uses)===JSON.stringify(contextParent.state.researchUses)&&JSON.stringify(gate.body.initial.claimsRead)===JSON.stringify(contextParent.state.publicClaimsRead),gate.status);
  check("G5 real finish refuses unread incremental context",gate.body.unreadFinish.error&&gate.body.unreadFinish.observation.includes("Read the frozen public research"));
  check("G5 real finish refuses missing new industry decision",gate.body.undecidedFinish.error&&gate.body.undecidedFinish.observation.includes(industryPublished.reportId));
  check("G5 unread industry claim cannot receive a decision",gate.body.beforeRead.error===true);
  check("G5 claim read retains old source ordinal and assigns appended ordinal",JSON.parse(gate.body.claim.observation).sourceId==="public2c1"&&JSON.stringify(gate.body.macroSource)===JSON.stringify(gate.body.initial.macroSource)&&gate.body.newIndustrySource.title.includes(industryPublished.version));
  check("G5 reading industry claim alone still cannot finish",gate.body.readOnlyFinish.error&&gate.body.readOnlyFinish.observation.includes(industryPublished.reportId));
  check("G5 explicit new applicability decision clears context gate and survives hydrate",!gate.body.recorded.error&&gate.body.precheck===null&&gate.body.readAfterHydrate===true&&gate.body.metadata.reports.length===2&&gate.body.metadata.asOf===expanded.asOf&&gate.body.uses.length===2);
  check("G5 context and finish refusal checks are read-only model-free",requests.length===contextCallsBefore);
  check("G5 replay cannot switch industry scope under same UUID",(await send(17,217,{...industryInput,includePublishedIndustry:false})).status===409&&(await send(1,101,{...input,includePublishedIndustry:true})).status===409);
  const industryReplay=await send(17,217,industryInput);
  check("G5 exact true replay returns original audited receipt without redispatch",industryReplay.status===202&&industryReplay.body.replay&&industryReplay.body.newContextHash===included.body.newContextHash&&(await snapshot(id(217))).body.dispatches.length===1);
  check("G5 parent D1 original packed session and checkpoint stay byte-identical",JSON.stringify(await DB.prepare("SELECT * FROM sec_cache WHERE cache_key=?").bind("research-shadow:"+id(17)).first())===JSON.stringify(contextParentRow)&&JSON.stringify((await snapshot(id(17))).body.sessions)===JSON.stringify(contextSessionBefore)&&JSON.stringify((await request(path(17)+"/checkpoint",{headers})).body)===JSON.stringify(contextBefore.body));
  check("G5 immutable resume checkpoint still contains only original parent context",JSON.parse(await (await SEC_FILINGS.get(expandedChild.spec.checkpoint)).text()).spec.publicResearch.reports.length===1);
  const mappingIncluded=await send(18,218,newMappingInput);
  check("G5 explicit new verified ID can extend an empty parent mapping",mappingIncluded.status===202&&mappingIncluded.body.addedMappingVersions.length===1&&mappingIncluded.body.addedMappingVersions[0]===exposure.id+":v1",mappingIncluded);
  await waitEnded(id(218));
  const mappingChild=JSON.parse((await DB.prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind("research-shadow:"+id(218)).first()).payload),newMappingContext=mappingChild.spec.publicResearch;
  check("G5 appended mapping keeps original macro ordinal and carries unknown weight with original evidence",newMappingContext.reports[0].report.version===macroPublished.version&&newMappingContext.reports[1].report.version===industryPublished.version&&newMappingContext.reports[1].exposures[0].weight===null&&newMappingContext.reports[1].exposures[0].source.contentHash===sha(newMappingContext.reports[1].exposures[0].source.excerpt)&&newMappingContext.mappingVersions[0]===exposure.id+":v1");
  check("G5 only the resolved no-verified-mapping coverage gap disappears",!newMappingContext.gaps.some(gap=>gap.reason==="uncovered: no verified business exposure mapping")&&newMappingContext.reports[1].report.coverage==="limited"&&newMappingContext.reports[1].report.missingInputs.length>0);
  check("G5 mapping extension audit hashes bind original empty context and new complete context",mappingIncluded.body.parentContextHash===sha(JSON.stringify(emptyMappingParent.parent.spec.publicResearch))&&mappingIncluded.body.newContextHash===sha(JSON.stringify(newMappingContext))&&JSON.stringify(mappingChild.spec.shadowContextExtension.addedMappingVersions)===JSON.stringify(mappingIncluded.body.addedMappingVersions)&&mappingChild.maxCalls===40);
  check("G5 empty-mapping parent and original checkpoint remain byte-identical",JSON.stringify(await DB.prepare("SELECT * FROM sec_cache WHERE cache_key=?").bind("research-shadow:"+id(18)).first())===JSON.stringify(emptyMappingParentRow)&&JSON.stringify((await request(path(18)+"/checkpoint",{headers})).body)===JSON.stringify(emptyMappingCheckpoint.body));
  check("no production or other external requests", forbidden.length === 0, forbidden);
  const output = resolve(process.argv[2] ?? "docs/acceptance/discovery/results/filing-shadow-resume.json");
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(output, JSON.stringify({ at: new Date().toISOString(), scope: "Synthetic local Miniflare operator journey: actual admin/proxy/AdminGateway, TaskRunner/PiHost SQL and real Pi start, filing recipe, publication store and exposure mapping, D1/R2, installed Pi provider and OpenAI/block-review clients against intercepted synthetic HTTP only", checks, checkpoint: { characters: first.body.checkpoint.state.length, hash: first.body.checkpointHash, blocks: 6, sourceTailPreserved: true }, incrementalIndustry:{parentContextHash:included.body.parentContextHash,newContextHash:included.body.newContextHash,childContextAsOf:included.body.childContextAsOf,addedIndustryReports:included.body.addedIndustryReports,originalMacroVersion:macroPublished.version,newerMacroVersionIntentionallyExcluded:newerMacro.version,parentUnchanged:true,sourceOrdinalsPreserved:true,contextGateModelCalls:0}, budget: { parentCalls: 140, childMaximumCalls: 40, cumulativeReservationCeiling: 180, syntheticProviderHttpSends: requests.length, paidCalls: 0, scope: "Parent: original Pi-provider reservation scope, unchanged. Child: all provider HTTP sends including independent reviews, retries and compaction transport. Token usage records are separate and are not monetary invoices." }, limitations: ["No production call, real model generation, promotion, user sign-off, commit or deployment", "Cloudflare Access is not configured in the isolated local fixture", "Legacy parent eligibility must still be verified by production storage-only export; inactive alone is insufficient", "Semantic/render publication quality remains protected by the existing finish path and is not supplied by synthetic responses"] }, null, 2) + "\n");
  console.log(JSON.stringify({ passed: checks.length, paidCalls: 0, evidence: output }));
} finally { await mf.dispose(); }
