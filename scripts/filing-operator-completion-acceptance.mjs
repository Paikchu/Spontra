/**
 * Authenticated local operator journey. Real handler → proxy → named AdminGateway → named TaskRunner →
 * normal tools → composer stages → actual Chromium CDP/ArtifactFrame → validated, unpublished shadow.
 * Model HTTP responses are SYNTHETIC. This verifies gates and persistence, never investment/image quality.
 * No production access, real model credentials, author model, commit or deployment.
 */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, basename } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const require = createRequire(new URL("../node_modules/wrangler/package.json", import.meta.url));
const { build } = require("esbuild"), { WebSocket, WebSocketServer } = require("ws");
const root = resolve(new URL("..", import.meta.url).pathname);
const scratch = await mkdtemp(resolve(tmpdir(), "spontra-filing-operator-"));
const shotsDirectory = resolve(scratch, "screenshots");
await mkdir(shotsDirectory);
const sha = value => createHash("sha256").update(value).digest("hex");
const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const clone = value => structuredClone(value), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const at = "2026-01-02T00:00:00.000Z", ticker = "SYNTHETIC", accession = "0000000001-26-000001";
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sourceId = n => `shadow-${ticker}-${accession}-${uuid(n)}`;
const operationId = n => `shadow-${ticker}-${accession}-operator-${uuid(n)}`;
const blockIds = ["summary", "highlights", "risks", "overlooked", "versus-prior", "what-to-watch"];
const filing = { ticker, accessionNumber: accession, form: "10-Q", filingDate: "2026-01-01", reportDate: "2025-12-31", companyName: "Synthetic local fixture", cik: "0000000001", primaryDocument: "synthetic.htm", documentUrl: "https://example.invalid/synthetic.htm", indexUrl: "https://example.invalid/index" };
const material = { ticker, accession, version: "synthetic-immutable-operator-v1" };
const originalQuote = "The static sensitivity is 41000000 USD for the quarter and 123000000 USD for nine months. Hedge netting is not established.";
const evidenceText = "SYNTHETIC LOCAL ORIGINAL ONLY. " + originalQuote + " Fixed-rate coupons are unchanged. Static annualization is an illustration, not a forward net-interest forecast. No price target is established.";
const markdown = `# Original evidence\n\n${evidenceText}\n`, textOffset = markdown.indexOf(evidenceText);
const materialBase = `sec-materials/v1/${ticker}/${accession}/${material.version}`;
const factIds = ["f00000000000001", "f00000000000002"];
const facts = factIds.map((factId, i) => ({ factId, passageId: "source-block", ordinal: i, row: null, col: null, label: i ? "Nine-month static interest sensitivity" : "Quarter static interest sensitivity", concept: null, dimensions: "", periodStart: i ? "2025-04-01" : "2025-10-01", periodEnd: "2025-12-31", periodMonths: i ? 9 : 3, value: i ? 123000000 : 41000000, shown: i ? "123000000" : "41000000", unit: "USD", tagged: false }));
const snapshot = { format: "filing-material.index.v2", ref: material, filing: { ticker, accession, cik: filing.cik, form: filing.form, filedAt: filing.filingDate, reportDate: filing.reportDate, companyName: filing.companyName, primaryDocument: filing.primaryDocument, documentUrl: filing.documentUrl, indexUrl: filing.indexUrl }, createdAt: at, documents: [], blocks: [{ id: "source-block", documentId: "synthetic-source", filename: "synthetic.htm", sourceUrl: filing.documentUrl, title: "Original evidence", path: [], kind: "paragraph", tableId: null, locator: { start: 0, end: evidenceText.length, page: null }, storage: "inline", text: evidenceText, range: { anchorOffset: 0, offset: textOffset, length: evidenceText.length, chars: evidenceText.length, sha256: sha(evidenceText) } }], tables: [], facts, markdown: { key: `${materialBase}/filing.md`, bytes: Buffer.byteLength(markdown), chars: markdown.length }, toc: [{ anchor: "source-block", title: "Original evidence", chars: evidenceText.length, offset: 0 }], coverage: { expectedDocuments: 0, archivedDocuments: 0, documents: [], sourceBlocks: 1, retainedBlocks: 1, duplicates: [], excluded: [], tableCells: 0, checkedCells: 0, issues: [] } };
const oldNote = { id: "E7", section: "source-block", ordinal: -1, statement: "Old misleading future net cost; correction must replace this exact note", quote: "SYNTHETIC LOCAL ORIGINAL ONLY.", facts: [factIds[0]], origin: "session" };
const oldComputed = { id: "c1", label: "Obsolete unsupported forecast", formula: `${factIds[0]}*4`, inputs: { [factIds[0]]: 41000000 }, value: 164000000, unit: "USD" };
const state = { composer: { artifact: { kind: "filing-report", ticker, subject: accession, title: "Unvalidated synthetic filing", lang: "en" }, blocks: blockIds.map(id => ({ id, title: `Original ${id}`, html: `<h2>Original ${id}</h2><p>Unvalidated old content.</p>`, sources: ["c1"], state: "draft" })), charts: {}, sources: { "source-block": { title: "Synthetic original", url: filing.documentUrl, kind: "sec" }, c1: { title: "Old calculation", url: null, kind: "data" } }, open: { risks: [{ block: "risks", kind: "content", severity: "major", key: "old-open", problem: "Old unresolved finding" }] }, ladder: {}, hidden: [], phase: "compose", turns: 40, published: null, rounds: { content: 2, render: 0 }, log: [] }, candidates: [], hits: [], used: { searches: 3, webReads: 2 }, web: {}, read: ["source-block"], periodic: { leads: [{ id: "L1", source: "session", priority: "high", question: "Synthetic hedge overlap?", why: "No forecast without reconciliation", refs: ["source-block"] }], evidence: Array.from({ length: 6 }, (_, i) => ({ ...oldNote, id: `E${i + 1}`, statement: "Synthetic prior evidence retained" })).concat([oldNote]), computed: { c1: oldComputed }, facts: {}, texts: { "source-block": evidenceText }, materials: [material], markdownRead: false, tablesFound: false, tablesRead: [], investmentChains: [{ id: "chain-1", priorAssumption: "Old", newEvidence: "Old", revisedAssumption: "Old", financialEffect: "Old forecast", valuationEffect: "Old unsupported value", quantificationStatus: "sensitivity_only", sourceIds: ["source-block"], computationRefs: ["c1"], missingInputs: ["Hedge overlap"], counterEvidence: "Old", verification: "Old", window: "Old" }], impactComputations: {} } };
const publicResearch = { asOf: at, mappingVersions: [], reports: [{ report: { reportId: "synthetic-macro", version: sha("synthetic-frozen-macro-v1"), type: "macro", title: "Synthetic pinned macro", asOf: at, scope: { description: "Synthetic local scope" }, freshnessStatus: "fresh", claims: [{ id: "macro-claim-1", kind: "fact", title: "Synthetic background", statement: "Synthetic background does not establish company net interest", sourceIds: [], observationIds: [] }], sources: [], observations: [] }, exposures: [], applicability: "requires_company_review" }], gaps: [] };
const spec = n => ({ ticker, filing, profile: "periodic", sessionId: sourceId(n), jobId: sourceId(n), jobVersion: "shadow.v1", requestedBy: "manual", material, mode: "resume", checkpoint: "synthetic-prior-checkpoint", shadow: true, shadowModel: "gpt-6.1-sol", shadowEffort: "max", publicResearch });
const runs = Array.from({ length: 22 }, (_, i) => { const n = i + 1; return { runId: sourceId(n), ticker, accession, createdAt: at, baseVersion: 6, callsReserved: 40, maxCalls: 40, parentRunId: sourceId(1000 + n), continuation: { checkpointHash: sha(`synthetic-parent-${n}`), parentCallsReserved: 140, parentMaxCalls: 140, cumulativeMaxCalls: 180, reason: "Synthetic exhausted continuation" }, spec: spec(n) }; });
const parents = runs.map((run, i) => ({ ...run, runId: run.parentRunId, callsReserved: 140, maxCalls: 140, parentRunId: undefined, continuation: undefined, spec: { ...spec(1001 + i), mode: "rewrite" } }));
const fixture = { at, ticker, accession, state, runs, parents };
const checks = [], outbound = [], blockedOutbound = [], browserTelemetry = [], screenshots = [];
let transportMode = "pass", mf, chrome, chromeEndpoint, transportRelease, transportHeld;
const check = (name, ok, detail) => { if (!ok) throw new Error(`${name}: ${JSON.stringify(detail)}`); checks.push({ name, status: "passed", ...(detail === undefined ? {} : { detail }) }); console.log(`PASS ${name}`); };

// The only browser substitute is its Cloudflare connection endpoint; every CDP command goes to real Chromium.
const browserServer = createServer((request, response) => {
  browserTelemetry.push({ method: request.method, path: request.url });
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(request.url.startsWith("/v1/sessions") ? { sessions: [{ sessionId: "local-chromium" }] } : { sessionId: "local-chromium" }));
});
const sockets = new Set(), socketServer = new WebSocketServer({ noServer: true });
browserServer.on("upgrade", (request, socket, head) => socketServer.handleUpgrade(request, socket, head, client => {
  const remote = new WebSocket(chromeEndpoint); sockets.add(client); sockets.add(remote);
  const queued = [], commands = new Map(); let pageWidth = null;
  remote.on("open", () => queued.splice(0).forEach(message => remote.send(message)));
  client.on("message", raw => {
    const message = raw.toString(), body = JSON.parse(message);
    if (body.id) commands.set(body.id, { method: body.method, params: body.params, pageWidth });
    if (body.method === "Emulation.setDeviceMetricsOverride") pageWidth = body.params.width;
    if (transportMode === "missing-viewport" && body.method === "Emulation.setDeviceMetricsOverride" && body.params.width === 390) {
      client.send(JSON.stringify({ id: body.id, sessionId: body.sessionId, error: { code: -32000, message: "Synthetic injection: mobile viewport unavailable" } }));
      return;
    }
    if (remote.readyState === WebSocket.OPEN) remote.send(message); else queued.push(message);
  });
  remote.on("message", async raw => {
    const message = raw.toString(), body = JSON.parse(message), command = commands.get(body.id);
    if (command?.method === "Page.captureScreenshot" && body.result?.data) {
      const bytes = Buffer.from(body.result.data, "base64"), filename = `shot-${String(screenshots.length + 1).padStart(3, "0")}.jpg`;
      screenshots.push({ file: resolve(shotsDirectory, filename), sha256: sha(bytes), bytes: bytes.length, mode: transportMode, clip: command.params.clip });
      await writeFile(resolve(shotsDirectory, filename), bytes);
    }
    if (client.readyState === WebSocket.OPEN) client.send(message);
  });
  const close = () => { client.close(); remote.close(); sockets.delete(client); sockets.delete(remote); };
  client.on("close", close); remote.on("close", close); client.on("error", close); remote.on("error", close);
}));

const frameBundle = resolve(scratch, "artifact-frame.js"), hostBundle = resolve(scratch, "host.js");
await build({ entryPoints: [resolve(root, "apps/business-site/src/artifact-frame/main.ts")], outfile: frameBundle, bundle: true, format: "iife", platform: "browser", target: "es2022", alias: { "@": root }, loader: { ".woff2": "dataurl" } });
const hostEntry = resolve(scratch, "host.tsx");
await writeFile(hostEntry, `import React from ${JSON.stringify(resolve(root, "node_modules/react/index.js"))};import{createRoot}from ${JSON.stringify(resolve(root, "node_modules/react-dom/client.js"))};import{ArtifactFrame}from ${JSON.stringify(resolve(root, "apps/business-site/src/ArtifactFrame.tsx"))};fetch('/preview?token='+encodeURIComponent(new URL(location.href).searchParams.get('artifact-preview')||'')).then(r=>r.json()).then(artifact=>{document.documentElement.className=localStorage.getItem('business-map-theme')||'light';createRoot(document.getElementById('report')).render(<ArtifactFrame artifact={artifact} showLanguage={false}/>);});`);
await build({ entryPoints: [hostEntry], outfile: hostBundle, bundle: true, format: "iife", platform: "browser", target: "es2022", jsx: "automatic", alias: { "@": root }, nodePaths: [resolve(root, "node_modules")], loader: { ".woff2": "dataurl" } });
let request;
const pageServer = createServer(async (incoming, response) => {
  try {
    const url = new URL(incoming.url, "http://localhost");
    if (url.pathname === "/preview") {
      const preview = await request("/fixture/preview?token=" + encodeURIComponent(url.searchParams.get("token")));
      response.writeHead(preview.status, { "content-type": "application/json" }); response.end(JSON.stringify(preview.body)); return;
    }
    if (["/host.js", "/host.css", "/artifact-frame.js", "/artifact-frame.css"].includes(url.pathname)) {
      response.writeHead(200, { "content-type": url.pathname.endsWith("css") ? "text/css" : "text/javascript" }); response.end(await readFile(resolve(scratch, basename(url.pathname)))); return;
    }
    if (url.pathname === "/artifact-frame") {
      response.writeHead(200, { "content-type": "text/html" }); response.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/artifact-frame.css"></head><body><script src="/artifact-frame.js"></script></body></html>'); return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/artifact-frame.css"><link rel="stylesheet" href="/host.css"><style>html,body{height:100%;overflow:hidden}aside{position:fixed;inset:0 auto 0 0;width:240px}main{position:fixed;inset:0 0 0 240px;overflow:auto;padding:24px}iframe{display:block;width:100%;border:0}@media(max-width:600px){aside{width:36px}main{left:36px;padding:12px}}</style></head><body><aside>Synthetic local shell</aside><main><section class="lens" id="report"></section></main><script src="/host.js"></script></body></html>');
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
await new Promise(resolve => browserServer.listen(0, "127.0.0.1", resolve));
await new Promise(resolve => pageServer.listen(0, "127.0.0.1", resolve));
const browserAddress = `127.0.0.1:${browserServer.address().port}`, pageOrigin = `http://127.0.0.1:${pageServer.address().port}`;

const workerPath = resolve(scratch, "worker.ts"), bundlePath = resolve(scratch, "worker.mjs");
await writeFile(workerPath, `
import{TaskRunner}from ${JSON.stringify(resolve(root, "workers/analysis/src/durable-runs/runner.ts"))};
import{handleReportAdminRequest}from ${JSON.stringify(resolve(root, "workers/analysis/src/admin/reports.ts"))};
import{handleAdminRequest}from ${JSON.stringify(resolve(root, "apps/admin/worker/index.ts"))};
import{createAdminSession}from ${JSON.stringify(resolve(root, "workers/analysis/src/admin/auth.ts"))};
import{packState}from ${JSON.stringify(resolve(root, "workers/analysis/src/pi/state.ts"))};
import{saveVersion,readPreview}from ${JSON.stringify(resolve(root, "workers/analysis/src/artifact/store.ts"))};
import{readPublishedArtifact}from ${JSON.stringify(resolve(root, "workers/analysis/src/artifact/store.ts"))};
import{D1SecRepository}from ${JSON.stringify(resolve(root, "workers/analysis/src/sec/d1.ts"))};
import{getPublicFiling}from ${JSON.stringify(resolve(root, "workers/analysis/src/sec/public-api.ts"))};
import{judge}from ${JSON.stringify(resolve(root, "workers/analysis/src/artifact/openai.ts"))};
import{reserveFilingOperatorReview}from ${JSON.stringify(resolve(root, "workers/analysis/src/filing-analysis/operator-completion.ts"))};
export{AdminGateway}from ${JSON.stringify(resolve(root, "workers/analysis/src/index.ts"))};
export class CompletionRunner extends TaskRunner{
  constructor(ctx,env){const sql=ctx.storage.sql,f=JSON.parse(env.FIXTURE),own=ctx.id.name?.replace(/^FILING:/,''),source=[...f.runs,...f.parents].find(run=>run.runId===own);
    sql.exec("CREATE TABLE IF NOT EXISTS fixture_dispatches(kind TEXT,operation_id TEXT)");
    if(source){sql.exec("CREATE TABLE IF NOT EXISTS pi_bindings(conversation TEXT PRIMARY KEY,session TEXT NOT NULL,operation_id TEXT NOT NULL,kind TEXT NOT NULL,spec TEXT NOT NULL,state TEXT NOT NULL,started_at INTEGER NOT NULL,turns INTEGER NOT NULL DEFAULT 0,quiet INTEGER NOT NULL DEFAULT 0,last_round INTEGER NOT NULL DEFAULT 0,capped INTEGER NOT NULL DEFAULT 0,finished INTEGER NOT NULL DEFAULT 0,asked TEXT,round TEXT,active INTEGER NOT NULL DEFAULT 1,spent INTEGER NOT NULL DEFAULT 0,startup TEXT,reserved_at INTEGER)");sql.exec("INSERT OR IGNORE INTO pi_bindings VALUES('synthetic-source','synthetic-session',?,'filing',?,?,0,40,0,0,1,0,NULL,NULL,0,1234,NULL,NULL)",source.runId+':shadow',JSON.stringify(source.spec),packState(f.state));}
    super(ctx,env);
  }
  async start(kind,id,params,createdAt){this.ctx.storage.sql.exec("INSERT INTO fixture_dispatches VALUES(?,?)",kind,id);return super.start(kind,id,params,createdAt);}
  async startSession(kind,spec,opening,operationId){this.ctx.storage.sql.exec("INSERT INTO fixture_dispatches VALUES(?,?)",kind,operationId);throw Error('Any operator Pi author dispatch is forbidden in this journey');}
  fixtureSnapshot(){const sql=this.ctx.storage.sql,tables=sql.exec("SELECT name FROM sqlite_master WHERE type='table'").toArray().map(r=>r.name);return{tables,dispatches:sql.exec('SELECT * FROM fixture_dispatches').toArray(),sessions:tables.includes('pi_bindings')?sql.exec('SELECT operation_id,spec,state,active,capped,finished,startup FROM pi_bindings').toArray():[],run:tables.includes('run')?sql.exec('SELECT * FROM run').toArray():[],steps:tables.includes('steps')?sql.exec('SELECT * FROM steps').toArray():[]};}
  fixtureMutateSource(columns){for(const[key,value]of Object.entries(columns)){if(!['active','capped','finished','startup','spec'].includes(key))throw Error('Fixture column not allowed');this.ctx.storage.sql.exec('UPDATE pi_bindings SET '+key+'=?',value);}return true;}
  fixtureEvict(){this.ctx.abort('Synthetic local cold restart');}
}
export default{async fetch(request,env){const url=new URL(request.url),f=JSON.parse(env.FIXTURE),id=url.searchParams.get('id'),stub=()=>env.TASK_RUNS.get(env.TASK_RUNS.idFromName((url.searchParams.get('kind')||'FILING')+':'+id));
 if(url.pathname==='/fixture/auth')return Response.json({token:await createAdminSession(env.REPORT_ADMIN_PASSWORD)});
 if(url.pathname==='/fixture/snapshot')return Response.json(await stub().fixtureSnapshot());
 if(url.pathname==='/fixture/advance'){await stub().advance();return Response.json(await stub().fixtureSnapshot());}
 if(url.pathname==='/fixture/evict'){await stub().fixtureEvict();return Response.json({evicted:true});}
 if(url.pathname==='/fixture/mutate-source')return Response.json(await stub().fixtureMutateSource(await request.json()));
 if(url.pathname==='/fixture/preview')return Response.json(await readPreview(env,url.searchParams.get('token')||''));
 if(url.pathname==='/fixture/read-public')return Response.json({filing:await getPublicFiling(new D1SecRepository(env.DB),f.ticker,f.accession),artifact:await readPublishedArtifact(env,'filing-report',f.ticker,f.accession)});
 if(url.pathname==='/fixture/index-filing'){await new D1SecRepository(env.DB).upsertFilingIndex(f.runs[0].spec.filing);return Response.json({indexed:true});}
 if(url.pathname==='/fixture/review-request'){try{return Response.json(await judge({...env,MODEL_REQUEST_GATE:()=>reserveFilingOperatorReview(env,id,url.searchParams.get('lease'))},{stage:'fixture-gate',system:'Synthetic local gate transport only',text:'{"fixture":true}',schema:{type:'object',properties:{ok:{type:'boolean'}}},maxRetries:Number(url.searchParams.get('retries')||0),ledger:{kind:'synthetic-acceptance',ticker:f.ticker,runId:id}}));}catch(error){return Response.json({error:String(error)},{status:503});}}
 if(url.pathname==='/fixture/public'){let saved;for(let n=1;n<=6;n++)saved=await saveVersion(env,{schema:'analysis-artifact.v1',kind:'filing-report',ticker:f.ticker,subject:f.accession,lang:'en',title:'Stable public fixture',blocks:[{id:'summary',title:'Stable public fixture',html:'<h2>Stable public fixture</h2><p>Synthetic existing public content.</p>',sources:[],state:'passed'}],charts:[],sources:[]},'','draft','synthetic-baseline');await env.DB.prepare('UPDATE analysis_artifacts SET published_version=?,published_hash=?,published_at=? WHERE artifact_id=?').bind(saved.version,saved.hash,f.at,'filing-report:'+f.ticker+':'+f.accession).run();return Response.json(saved);}
 if(url.pathname.startsWith('/api/admin/'))return handleAdminRequest(request,{...env,ASSETS:{fetch:()=>new Response('Not found',{status:404})}});
 if(url.pathname.startsWith('/admin/'))return handleReportAdminRequest(request,env);
 return new Response('Not found',{status:404});
}};
`);

function completion(body, answer) {
  const text = JSON.stringify(answer), usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  if (!body.stream) return Response.json({ id: "synthetic-local", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage });
  const chunk = { id: "synthetic-local", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}
async function modelTransport(incoming) {
  const url = new URL(incoming.url);
  if (!["api.deepseek.com", "api.openai.com"].includes(url.hostname)) { blockedOutbound.push(incoming.url); return new Response("Production and external network forbidden", { status: 599 }); }
  const body = await incoming.json(), system = body.messages?.[0]?.content || "";
  const content = body.messages?.find(message => message.role === "user")?.content;
  const text = Array.isArray(content) ? content.find(part => part.type === "text")?.text : content;
  const input = JSON.parse(text || "{}"), stage = /local gate transport/.test(system) ? "gate" : /independent publication auditor/.test(system) ? "semantic" : /design reviewer/.test(system) ? "visual" : "content";
  outbound.push({ stage, mode: transportMode, model: body.model, streaming: body.stream === true, block: input.block?.id ?? null, images: Array.isArray(content) ? content.filter(part => part.type === "image_url").length : 0, input });
  if (transportMode === "hold-content" && stage === "content") { transportHeld?.(); await new Promise(resolve => { transportRelease = resolve; }); }
  if (transportMode === "visual-unavailable" && stage === "visual" || transportMode === "retry-cap") return Response.json({ error: { message: "Synthetic provider transport failure" } }, { status: 500, headers: { "retry-after-ms": "1" } });
  if (stage === "gate") return completion(body, { ok: true });
  if (stage === "content" && transportMode === "malformed-content") return completion(body, {});
  if (stage === "content" && transportMode === "malformed-content-issue") return completion(body, { issues: [{}] });
  if (stage === "content") return completion(body, { issues: transportMode === "content-fail" ? [{ quote: input.block.sentences[0].text, problem: "Synthetic injected unsupported claim", replacement: "DELETE", suggestion: "Synthetic injection only", severity: "major" }] : [] });
  if (stage === "visual") return completion(body, { scores: { layout: 9, hierarchy: 9, density: 9, consistency: 9, readability: 9 }, issues: [] });
  const computations = input.computations.map(item => ({ id: item.id, status: "holds", problem: "Synthetic provider receipt: exact pinned arithmetic and stated static basis", sources: ["source-block"] }));
  return completion(body, { verdict: transportMode === "semantic-fail" ? "fail" : "pass", complete: true, summary: "SYNTHETIC independent-provider transport response, not real investment review", computations, issues: transportMode === "semantic-fail" ? [{ block: "summary", quote: "Synthetic static sensitivity", problem: "Synthetic injected semantic failure", replacement: "DELETE", suggestion: "Synthetic injection only", sources: ["source-block"], evidence: originalQuote }] : [] });
}

const reportPath = id => `/admin/reports/${ticker}/${accession}/shadow/${id}`;
const runnerPath = id => `/fixture/snapshot?id=${id}&kind=FILING_OPERATOR_COMPLETION_WORKFLOW`;
let db, bucket, token, publicBaseline;
const jsonRow = async key => { const row = await db.prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(key).first(); return row ? JSON.parse(row.payload) : null; };
const opRow = id => jsonRow(`filing-operator:${id}`);
const rawRow = key => db.prepare("SELECT * FROM sec_cache WHERE cache_key=?").bind(key).first();
const send = (n, op, plan, options = {}) => request((options.proxy ? reportPath(sourceId(n)).replace("/admin/", "/api/admin/") : reportPath(sourceId(n))) + "/operator-complete", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json", "idempotency-key": uuid(op), ...(options.proxy ? { origin: "http://localhost" } : {}), ...options.headers }, body: JSON.stringify(plan) });
const planFor = async n => {
  const exported = await request(reportPath(sourceId(n)) + "/checkpoint", { headers: { authorization: "Bearer " + token } });
  if (exported.status !== 200) throw Error("Source checkpoint unavailable: " + JSON.stringify(exported));
  return { schemaVersion: "filing-operator-plan.v1", sourceRunId: sourceId(n), expectedCheckpointHash: exported.body.checkpointHash, expectedPublicVersion: publicBaseline.version, expectedPublicHash: publicBaseline.hash, author: { model: "gpt-6.1-sol", effort: "max", runId: `synthetic-external-sol-author-${n}`, promptVersion: "synthetic-operator-completion.v1" }, reason: "Synthetic local acceptance: replace outdated arithmetic with independently checked static illustration; never publish", pinnedReads: [{ tool: "read_filing_markdown", args: { maxChars: 48000 } }, { tool: "query_facts", args: {} }], computeCalls: [{ expectedResultId: "c2", args: { label: "Static quarter sensitivity annualized for illustration only", formula: `${factIds[0]}*4`, unit: "USD" }, expected: { value: 164000000, unit: "USD", tolerance: 0 } }, { expectedResultId: "c3", args: { label: "Static nine-month sensitivity normalized to a year for illustration only", formula: `${factIds[1]}/3*4`, unit: "USD" }, expected: { value: 164000000, unit: "USD", tolerance: 0 } }], oldToNew: { c1: "c2" }, evidenceCorrections: [{ id: "E7", expectedOldHash: sha(stable(oldNote)), section: "source-block", quote: originalQuote, statement: "Static disclosed sensitivity has unresolved hedge netting; annualization is illustrative and is not a future net-interest forecast", facts: factIds }], closeLeads: { leads: [{ id: "L1", verdict: "open", finding: "Synthetic pinned source does not establish hedge overlap; retain this specific uncertainty", evidence: ["source-block"] }] }, researchUses: [{ reportId: "synthetic-macro", version: publicResearch.reports[0].report.version, claimId: "macro-claim-1", decision: "rejected", reason: "Synthetic static company sensitivity does not establish a macro-driven future net cost; debt reset and hedge overlaps remain unresolved", companySources: ["source-block"], financialVariable: "cashInterest" }], investmentChains: [{ id: "chain-1", priorAssumption: "An obsolete net cost forecast was unsupported", newEvidence: originalQuote, revisedAssumption: "Use the disclosed static sensitivity without double deducting hedges", financialEffect: "Synthetic illustrative static annualization is 164000000 USD; actual future net cash interest is not established", valuationEffect: "No target price without tax, share count, dated debt resets and hedge reconciliation", quantificationStatus: "sensitivity_only", sourceIds: ["source-block"], computationRefs: ["c2", "c3"], missingInputs: ["Debt reset dates, net hedge treatment, tax, economic shares and a valuation model"], counterEvidence: "Hedges and debt balances can change", verification: "Read next dated original debt and hedge disclosure", window: "Synthetic illustration only" }], charts: [{ id: "static-comparison", title: "Synthetic static annualization illustration", type: "bar", aspect: "wide", series: [{ label: "Illustration only; no forward forecast", points: [{ period: "2025-09-30", ref: "c2" }, { period: "2025-12-31", ref: "c3" }] }] }], blocks: blockIds.map((id, i) => ({ id, html: `<h2>Synthetic ${id === "summary" ? "static sensitivity" : id} case ${n}</h2><p>Synthetic static sensitivity is an illustration; future net interest and a price target remain unestablished. <cite data-source="source-block">Pinned original evidence</cite>.</p><p>Static illustration: <data value="164000000" data-ref="c2">164000000</data> USD. Hedge netting remains unresolved.</p>${i === 1 ? '<figure data-chart="static-comparison"></figure>' : ""}` })) };
};
async function drive(id, { terminal = true, limit = 160 } = {}) {
  let saved;
  for (let n = 0; n < limit; n++) {
    saved = await opRow(id);
    if (saved && ["validated", "failed", "unknown"].includes(saved.status)) return saved;
    await request(`/fixture/advance?id=${id}&kind=FILING_OPERATOR_COMPLETION_WORKFLOW`);
    if (!terminal) return opRow(id);
    await pause(30);
  }
  throw Error("Operator task did not reach a terminal receipt: " + JSON.stringify(saved));
}
async function startHeld(n) {
  transportMode = "hold-content";
  let arrived, timer;
  const held = new Promise((resolve, reject) => { arrived = resolve; timer = setTimeout(() => reject(Error("Synthetic content transport was not reached")), 20000); });
  transportHeld = arrived;
  const plan = await planFor(n), answer = await send(n, 100 + n, plan);
  check(`interruption fixture ${n} is admitted through the real endpoint`, answer.status === 202, answer);
  const progress = drive(answer.body.runId).then(value => ({ value }), error => ({ error: String(error) }));
  await held; clearTimeout(timer); transportHeld = undefined;
  const row = await opRow(answer.body.runId);
  check(`interruption fixture ${n} persists its phase marker before HTTP completion`, row.status === "running" && row.phase.name === "content:summary" && row.phase.status === "started" && row.phase.beforeStateRef && row.reviewCalls === 1, { phase: row.phase, calls: row.reviewCalls });
  transportMode = "pass";
  return { runId: answer.body.runId, plan, progress, lease: row.phase.leaseToken };
}

try {
  chrome = spawn(process.env.CHROMIUM_PATH || "/usr/bin/chromium", ["--headless", "--no-sandbox", "--disable-dev-shm-usage", "--remote-debugging-port=0", `--user-data-dir=${resolve(scratch, "chrome")}`], { stdio: ["ignore", "ignore", "pipe"] });
  chromeEndpoint = await new Promise((resolve, reject) => { let stderr = ""; const timer = setTimeout(() => reject(Error("Local Chromium CDP startup timeout")), 20000); chrome.once("error", reject); chrome.stderr.on("data", bytes => { stderr += bytes; const found = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr); if (found) { clearTimeout(timer); resolve(found[1]); } }); });
  await build({ entryPoints: [workerPath], outfile: bundlePath, bundle: true, format: "esm", platform: "node", target: "es2022", conditions: ["workerd", "worker", "browser"], external: ["cloudflare:*", "node:*"], banner: { js: "import {createRequire as localCreateRequire} from 'node:module'; const require=localCreateRequire('/local-worker.mjs');" }, loader: { ".css": "text", ".txt": "text" }, plugins: [{ name: "local-axe-text", setup(bundle) { bundle.onLoad({ filter: /\/axe\.min\.js$/ }, async ({ path }) => ({ contents: await readFile(path, "utf8"), loader: "text" })); } }] });
  mf = new Miniflare(convertV4MiniflareOptions({ name: "filing-operator-acceptance", modules: true, modulesRoot: scratch, scriptPath: bundlePath, compatibilityDate: "2026-08-26", compatibilityFlags: ["nodejs_compat"], durableObjects: { TASK_RUNS: { className: "CompletionRunner", useSQLite: true } }, serviceBindings: { SPONTRA_ANALYSIS: { name: "filing-operator-acceptance", entrypoint: "AdminGateway" }, BROWSER: { external: { address: browserAddress } } }, d1Databases: { DB: "filing-operator-acceptance" }, r2Buckets: ["SEC_FILINGS"], bindings: { FIXTURE: JSON.stringify(fixture), REPORT_ADMIN_PASSWORD: "synthetic-local-only", DEEPSEEK_API_KEY: "synthetic-local-only", OPENAI_API_KEY: "synthetic-local-only", OPENAI_REVIEW_MODEL: "gpt-6.1-sol", BUSINESS_SITE_ORIGIN: pageOrigin }, outboundService: modelTransport }));
  request = async (path, options = {}) => { const response = await mf.dispatchFetch("http://localhost" + path, options), body = await response.text(); try { return { status: response.status, body: JSON.parse(body) }; } catch { return { status: response.status, body }; } };
  ({ DB: db, SEC_FILINGS: bucket } = await mf.getBindings());
  for (const file of ["0001_normal_doctor_strange.sql", "0002_flat_blockbuster.sql", "0003_neat_toro.sql", "0004_silky_may_parker.sql", "0005_fresh_bloodaxe.sql", "0019_pipeline_events.sql", "0049_analysis_artifacts.sql", "0023_ai_usage.sql", "0032_ai_tool_settings.sql", "0060_public_research.sql"]) for (const statement of (await readFile(resolve(root, "workers/analysis/migrations", file), "utf8")).replace(/--[^\n]*/g, "").split(";").map(value => value.trim()).filter(Boolean)) await db.prepare(statement).run();
  for (const statement of ["CREATE TABLE financial_company_settings(ticker TEXT PRIMARY KEY,enabled INTEGER)", "CREATE TABLE business_feature_settings(ticker TEXT,feature TEXT,generate INTEGER)", "ALTER TABLE ai_usage ADD COLUMN user_hash TEXT", "ALTER TABLE ai_usage ADD COLUMN conversation_id TEXT"]) await db.prepare(statement).run();
  await bucket.put(`${materialBase}/index.json`, JSON.stringify(snapshot)); await bucket.put(snapshot.markdown.key, markdown);
  for (const run of [...parents, ...runs]) {
    await db.prepare("INSERT INTO sec_cache VALUES(?,?,?)").bind(`research-shadow:${run.runId}`, JSON.stringify(run), at).run();
    await bucket.put(`research-shadow/${run.runId}/failed.json`, JSON.stringify({ status: "failed", reason: "Synthetic naturally exhausted original session", at }));
  }
  for (let i = 0; i < parents.length; i++) await db.prepare("INSERT INTO sec_cache VALUES(?,?,?)").bind(`research-shadow:${parents[i].runId}:resume`, JSON.stringify({ parentRunId: parents[i].runId, runId: runs[i].runId, requestId: uuid(i + 1), status: "dispatched" }), at).run();
  token = (await request("/fixture/auth")).body.token;
  publicBaseline = (await request("/fixture/public")).body;
  check("fixture has an immutable sixth public version", publicBaseline.version === 6 && /^[a-f0-9]{64}$/.test(publicBaseline.hash), publicBaseline);
  const plan = await planFor(1), originals = await Promise.all([rawRow(`research-shadow:${sourceId(1)}`), rawRow(`research-shadow:${parents[0].runId}`), bucket.get(`research-shadow/${sourceId(1)}/failed.json`).then(object => object.text())]);
  check("unauthenticated direct mutation is refused", (await request(reportPath(sourceId(1)) + "/operator-complete", { method: "POST", body: "{}" })).status === 401);
  check("proxy requires same-origin mutation", (await send(1, 101, plan, { proxy: true, headers: { origin: "https://other.invalid" } })).status === 403);
  check("completion mutation is POST only", (await request(reportPath(sourceId(1)).replace("/admin/", "/api/admin/") + "/operator-complete")).status === 404);
  check("UUID idempotency key is mandatory", (await send(1, 101, plan, { headers: { "idempotency-key": "invalid" } })).status === 400);
  for (const [name, edit] of [["client-passed receipt", p => { p.receipt = { success: true }; }], ["client-passed state", p => { p.state = clone(state); }], ["model override", p => { p.author.model = "different"; }], ["duplicate required block", p => { p.blocks[5] = clone(p.blocks[0]); }], ["malformed checkpoint hash", p => { p.expectedCheckpointHash = "wrong"; }]]) { const input = clone(plan); edit(input); const answer = await send(1, 101, input); check(name + " is refused before dispatch", [400, 409].includes(answer.status), answer); }
  const wrongSource = clone(plan); wrongSource.sourceRunId = sourceId(2);
  check("path and source identity mismatch is refused", (await send(1, 101, wrongSource)).status === 409);
  const wrongCheckpoint = clone(plan); wrongCheckpoint.expectedCheckpointHash = "f".repeat(64);
  check("exact checkpoint hash is required", (await send(1, 101, wrongCheckpoint)).status === 409);
  const wrongPublic = clone(plan); wrongPublic.expectedPublicHash = "f".repeat(64);
  check("exact current public hash is required", (await send(1, 101, wrongPublic)).status === 409);
  const parentPlan = { ...clone(plan), sourceRunId: parents[0].runId };
  const parentCheckpoint = await request(reportPath(parents[0].runId) + "/checkpoint", { headers: { authorization: "Bearer " + token } });
  parentPlan.expectedCheckpointHash = parentCheckpoint.body.checkpointHash;
  const parentAnswer = await request(reportPath(parents[0].runId) + "/operator-complete", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json", "idempotency-key": uuid(101) }, body: JSON.stringify(parentPlan) });
  check("old parent cannot bypass its existing continuation child", parentAnswer.status === 409, parentAnswer);
  check("invalid admissions caused zero model requests", outbound.length === 0, outbound.length);
  const started = await send(1, 101, plan, { proxy: true });
  check("real proxy and named AdminGateway dispatch the deterministic TaskRunner", started.status === 202 && started.body.runId === operationId(101), started);
  const success = await drive(started.body.runId);
  check("actual stages produce validated unpublished shadow", success.status === "validated", success);
  const status = await request(reportPath(operationId(101)), { headers: { authorization: "Bearer " + token } });
  check("normal authenticated shadow GET exposes validated artifact and preview", status.status === 200 && status.body.status === "validated_shadow" && status.body.artifact && status.body.previewToken, { status: status.status, state: status.body.status });
  check("shadow GET reports actual independent HTTP usage and explicit external authorship", status.body.callsReserved === 8 && status.body.maxCalls === 12 && status.body.generation.author.model === "gpt-6.1-sol" && status.body.independentReview.planHash === success.planHash, { callsReserved: status.body.callsReserved, maxCalls: status.body.maxCalls, author: status.body.generation?.author });
  check("twelve-call review allowance includes six content semantic and visual requests", success.maxReviewCalls === 12 && success.reviewCalls === 8 && outbound.filter(row => row.stage === "content").length === 6 && outbound.filter(row => row.stage === "semantic").length === 1 && outbound.filter(row => row.stage === "visual").length === 1, { max: success.maxReviewCalls, spent: success.reviewCalls, stages: outbound.map(row => row.stage) });
  const runner = (await request(runnerPath(operationId(101)))).body;
  check("operator task never opens a Pi author session", runner.sessions.length === 0 && runner.dispatches.length === 1 && runner.dispatches[0].kind === "FILING_OPERATOR_COMPLETION_WORKFLOW", runner.dispatches);
  check("author token and cost usage remain unknown", JSON.stringify(success).includes('"tokens":null') && JSON.stringify(success).includes('"cost":null'), success.authorUsage);
  const validated = JSON.parse(await (await bucket.get(success.validatedKey)).text());
  const current = validated.work.periodic;
  check("normal compute tool appends results while retaining original history", JSON.stringify(current.computed.c1) === JSON.stringify(oldComputed) && current.computed.c2.value === 164000000 && current.computed.c3.value === 164000000, current.computed);
  const document = status.body.artifact.document ?? status.body.artifact;
  check("retired calculation is absent from report chart and chain references", !JSON.stringify({ blocks: document.blocks, charts: document.charts, chains: current.investmentChains, chartRefs: current.chartRefs }).includes('"c1"'));
  check("E7 correction is checked against the real pinned quotation and hash", current.evidence.find(note => note.id === "E7").quote === originalQuote && current.evidence.find(note => note.id === "E7").statement === plan.evidenceCorrections[0].statement);
  check("normal tools recorded corrected lead without hiding uncertainty", current.leads[0].verdict === "open" && current.leads[0].finding === plan.closeLeads.leads[0].finding);
  check("frozen macro decision and exact version are recorded through normal research tools", validated.researchUses[0].version === publicResearch.reports[0].report.version && validated.researchUses[0].decision === "rejected" && document.researchContext.reports[0].version === publicResearch.reports[0].report.version);
  const rendering = success.stages.render.receipt;
  check("strict rendering receipt measures and screenshots every block at every required viewport", rendering.visualReviewed && ["1440x900 light", "390x844 light", "1280x800 dark"].every(viewport => blockIds.every(id => rendering.measured[viewport]?.includes(id) && rendering.covered[viewport]?.includes(id))), { measured: rendering.measured, covered: rendering.covered, shots: rendering.shots });
  const contentBeforeReplay = outbound.length, replay = await send(1, 101, plan);
  check("exact operator replay returns durable receipt without rerunning stages", replay.status === 202 && replay.body.replay && outbound.length === contentBeforeReplay, replay);
  check("same UUID changed plan cannot replace admitted work", (await send(1, 101, { ...clone(plan), reason: "Conflicting correction" })).status === 409);
  check("second UUID cannot claim the same lineage", (await send(1, 102, plan)).status === 409);
  check("operator shadow cannot recursively resume", (await request(reportPath(operationId(101)) + "/resume", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json", "idempotency-key": uuid(201) }, body: JSON.stringify({ expectedCheckpointHash: plan.expectedCheckpointHash, reason: "Forbidden recursive resume" }) })).status === 409);
  check("no self approval is implicit in completion", !await jsonRow(`research-shadow:${operationId(101)}:review`) && (await request(reportPath(operationId(101)) + "/promote", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: "{}" })).status >= 400);
  const finalPublic = await db.prepare("SELECT published_version,published_hash FROM analysis_artifacts WHERE artifact_id=?").bind(`filing-report:${ticker}:${accession}`).first();
  check("public pointer and original 140/40 ledgers remain byte identical", finalPublic.published_version === 6 && finalPublic.published_hash === publicBaseline.hash && JSON.stringify(await rawRow(`research-shadow:${sourceId(1)}`)) === JSON.stringify(originals[0]) && JSON.stringify(await rawRow(`research-shadow:${parents[0].runId}`)) === JSON.stringify(originals[1]) && await (await bucket.get(`research-shadow/${sourceId(1)}/failed.json`)).text() === originals[2]);

  for (const [n, mode, expectedStage] of [[2, "content-fail", "content"], [3, "semantic-fail", "semantic"], [4, "missing-viewport", "render"], [5, "visual-unavailable", "render"], [21, "malformed-content", "content"], [22, "malformed-content-issue", "content"]]) {
    transportMode = mode;
    const negativePlan = await planFor(n), answer = await send(n, 100 + n, negativePlan), result = await drive(answer.body.runId);
    check(mode + " fails the real composer stage", ["failed", "unknown"].includes(result.status) && !await bucket.get(`research-shadow/${answer.body.runId}/validated.json`) && JSON.stringify(result).includes(expectedStage), result);
    const read = await request(reportPath(answer.body.runId), { headers: { authorization: "Bearer " + token } });
    check(mode + " cannot expose a validated artifact or preview", !read.body.previewToken && !read.body.artifact && read.body.status !== "validated_shadow", { status: read.status, state: read.body.status });
  }
  check("malformed provider content responses stop before semantic or visual review", ["malformed-content", "malformed-content-issue"].every(mode => outbound.filter(row => row.mode === mode).length === 1 && outbound.filter(row => row.mode === mode).every(row => row.stage === "content")));
  transportMode = "pass";
  const noCapPlan = await planFor(7);
  await request(`/fixture/mutate-source?id=${sourceId(7)}`, { method: "POST", body: JSON.stringify({ capped: 0 }) });
  check("inactive source without natural budget exhaustion is refused", (await send(7, 107, noCapPlan)).status === 409);
  const validatedSourcePlan = await planFor(8); await bucket.put(`research-shadow/${sourceId(8)}/validated.json`, '{"synthetic":true}');
  check("already validated source cannot be completed again", (await send(8, 108, validatedSourcePlan)).status === 409);
  const activePlan = await planFor(9); await request(`/fixture/mutate-source?id=${sourceId(9)}`, { method: "POST", body: JSON.stringify({ active: 1 }) });
  check("active source cannot be mistaken for a naturally ended failure", (await send(9, 109, activePlan)).status === 409);
  const mismatchPlan = await planFor(10); await request(`/fixture/mutate-source?id=${sourceId(10)}`, { method: "POST", body: JSON.stringify({ spec: JSON.stringify({ ...spec(10), material: { ...material, version: "different-immutable-material" } }) }) });
  check("changed saved source specification cannot be silently rebound", (await send(10, 110, mismatchPlan)).status === 409);
  const badQuotePlan = await planFor(12); badQuotePlan.evidenceCorrections[0].quote = "This quotation does not exist in the immutable material.";
  const badQuote = await send(12, 112, badQuotePlan), badQuoteResult = await drive(badQuote.body.runId);
  check("E7 missing original quote fails through the actual revise_evidence tool", ["failed", "unknown"].includes(badQuoteResult.status) && !badQuoteResult.validatedKey, badQuoteResult);
  const retiredPlan = await planFor(13); retiredPlan.investmentChains[0].computationRefs.push("c1");
  const retired = await send(13, 113, retiredPlan), retiredResult = await drive(retired.body.runId);
  check("reachable retired calculation fails without provider review", ["failed", "unknown"].includes(retiredResult.status) && !retiredResult.validatedKey, retiredResult);
  const racingPlan = await planFor(16); racingPlan.evidenceCorrections[0].quote = "Synthetic invalid quote; this local run must not call a provider.";
  const racing = await Promise.all([send(16, 116, racingPlan), send(16, 116, racingPlan)]);
  check("simultaneous identical admissions return one durable claim and exact replay", racing.every(answer => answer.status === 202) && racing.filter(answer => answer.body.replay).length === 1 && racing.every(answer => answer.body.runId === operationId(116)), racing);
  await drive(operationId(116));
  const racingRunner = (await request(runnerPath(operationId(116)))).body;
  check("simultaneous admission never dispatches a second deterministic task", racingRunner.dispatches.length === 1, racingRunner.dispatches);
  // Exercise the actual production request gate through the actual OpenAI SDK while a real content phase is live.
  const cap = await startHeld(6), gatePath = item => `/fixture/review-request?id=${item.runId}&lease=${item.lease}`;
  const beforeWrongLease = outbound.length;
  check("wrong phase lease sends no provider HTTP", (await request(gatePath(cap).replace(cap.lease, uuid(999)))).status === 503 && outbound.length === beforeWrongLease);
  for (let n = 0; n < 9; n++) check(`actual independent SDK request ${n + 1} shares operator gate`, (await request(gatePath(cap))).status === 200);
  const retryBefore = outbound.length;
  transportMode = "retry-cap";
  const retried = await request(gatePath(cap) + "&retries=2");
  check("provider HTTP failures and automatic SDK retries consume the last two slots exactly", retried.status === 503 && (await opRow(cap.runId)).reviewCalls === 12 && outbound.length === retryBefore + 2, { status: retried.status, calls: (await opRow(cap.runId)).reviewCalls, httpSent: outbound.length - retryBefore });
  transportMode = "pass"; transportRelease(); await cap.progress;
  const capResult = await opRow(cap.runId);
  check("next content phase fails at twelve without validating or replaying the author", capResult.status === "failed" && capResult.reviewCalls === 12 && !capResult.validatedKey, { status: capResult.status, calls: capResult.reviewCalls, phase: capResult.phase.name });
  const afterCap = outbound.length;
  await request(gatePath(cap) + "&retries=2"); await request(`/fixture/advance?id=${cap.runId}&kind=FILING_OPERATOR_COMPLETION_WORKFLOW`);
  check("post-cap SDK retries and task replay send zero additional HTTP", outbound.length === afterCap && (await opRow(cap.runId)).reviewCalls === 12);

  const concurrent = await startHeld(17);
  for (let n = 0; n < 10; n++) await request(gatePath(concurrent));
  const concurrentBefore = outbound.length;
  const contenders = await Promise.all(Array.from({ length: 8 }, () => request(gatePath(concurrent))));
  check("concurrent independent SDK clients cannot overspend the final shared slot", contenders.filter(answer => answer.status === 200).length === 1 && (await opRow(concurrent.runId)).reviewCalls === 12 && outbound.length === concurrentBefore + 1, { successful: contenders.filter(answer => answer.status === 200).length, httpSent: outbound.length - concurrentBefore });
  transportRelease(); await concurrent.progress;

  const expired = await startHeld(14), expiryCalls = outbound.length;
  await db.prepare("UPDATE sec_cache SET payload=json_set(payload,'$.phase.expiresAt',0) WHERE cache_key=?").bind(`filing-operator:${expired.runId}`).run();
  const expiredView = await request(reportPath(expired.runId), { headers: { authorization: "Bearer " + token } });
  check("expired in-flight phase is visibly unknown before its provider returns", expiredView.body.status === "unknown" && expiredView.body.leaseExpired === true && !expiredView.body.previewToken, expiredView.body);
  transportRelease(); await expired.progress;
  const expiredRow = await opRow(expired.runId);
  check("late provider success after phase timeout cannot become a completed or validated receipt", expiredRow.status === "unknown" && !expiredRow.validatedKey && expiredRow.phase.status === "unknown" && !expiredRow.stages["content:summary"], { status: expiredRow.status, phase: expiredRow.phase });
  await request(`/fixture/advance?id=${expired.runId}&kind=FILING_OPERATOR_COMPLETION_WORKFLOW`);
  check("expired phase re-entry never repeats billable work", outbound.length === expiryCalls);

  const crashed = await startHeld(15), crashCalls = outbound.length;
  await request(`/fixture/evict?id=${crashed.runId}&kind=FILING_OPERATOR_COMPLETION_WORKFLOW`).catch(() => null);
  transportRelease(); await crashed.progress;
  // A cold real task replay sees the durable start marker and refuses to send its request again.
  await request(`/fixture/advance?id=${crashed.runId}&kind=FILING_OPERATOR_COMPLETION_WORKFLOW`);
  const crashRow = await opRow(crashed.runId);
  check("cold restart preserves unknown outcome and never repeats the interrupted HTTP", crashRow.status === "unknown" && !crashRow.validatedKey && outbound.length === crashCalls, { status: crashRow.status, phase: crashRow.phase });
  const crashReplay = await send(15, 115, crashed.plan);
  check("repeated client submit after crash keeps its single durable lineage claim", crashReplay.status === 202 && crashReplay.body.replay && crashReplay.body.dispatchRetried === false && outbound.length === crashCalls);

  const stopped = await startHeld(20), stoppedCalls = outbound.length;
  const stopReceipt = await request(reportPath(stopped.runId) + "/stop", { method: "POST", headers: { authorization: "Bearer " + token } });
  transportRelease(); await stopped.progress;
  const stoppedRow = await opRow(stopped.runId);
  check("explicit stop fences a late successful response without another HTTP call", stopReceipt.status === 200 && stopReceipt.body.status === "stopped" && stoppedRow.status === "failed" && !stoppedRow.validatedKey && outbound.length === stoppedCalls, { receipt: stopReceipt.body, status: stoppedRow.status });

  const changedBase = await startHeld(18), changedBaseCalls = outbound.length;
  const currentArtifactId = `filing-report:${ticker}:${accession}`, changedHash = "f".repeat(64);
  await db.prepare("UPDATE analysis_artifact_versions SET hash=? WHERE artifact_id=? AND version=6").bind(changedHash, currentArtifactId).run();
  await db.prepare("UPDATE analysis_artifacts SET published_hash=? WHERE artifact_id=?").bind(changedHash, currentArtifactId).run();
  const changedView = await request(reportPath(changedBase.runId), { headers: { authorization: "Bearer " + token } });
  check("same version with changed actual public hash is reported as changed", changedView.body.publicReportUnchanged === false);
  const changedAdmissionPlan = await planFor(19), changedAdmission = await send(19, 119, changedAdmissionPlan);
  check("actual public hash change blocks a newly submitted plan despite unchanged version", changedAdmission.status === 409, changedAdmission);
  transportRelease(); await changedBase.progress;
  const changedRow = await opRow(changedBase.runId);
  check("same-version hash replacement fences an in-flight phase before validation", ["failed", "unknown"].includes(changedRow.status) && !changedRow.validatedKey && outbound.length === changedBaseCalls, { status: changedRow.status, phase: changedRow.phase });
  await db.prepare("UPDATE analysis_artifact_versions SET hash=? WHERE artifact_id=? AND version=6").bind(publicBaseline.hash, currentArtifactId).run();
  await db.prepare("UPDATE analysis_artifacts SET published_hash=? WHERE artifact_id=?").bind(publicBaseline.hash, currentArtifactId).run();

  const authorReview = await request(reportPath(operationId(101)) + "/promote", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ expectedHash: success.hash, reviewer: plan.author.runId, reviewNotes: "Forbidden author self approval", approvedChainIds: ["chain-1"] }) });
  check("external author cannot self-approve public promotion", authorReview.status === 400, authorReview);
  const beforeExplicitHuman = await db.prepare("SELECT published_version,published_hash FROM analysis_artifacts WHERE artifact_id=?").bind(`filing-report:${ticker}:${accession}`).first();
  check("all failed interrupted and capped operations preserve the original public pointer", beforeExplicitHuman.published_version === 6 && beforeExplicitHuman.published_hash === publicBaseline.hash);
  const validationBytes = await (await bucket.get(success.validatedKey)).text(), corrupted = JSON.parse(validationBytes);
  corrupted.operator.planHash = "0".repeat(64); await bucket.put(success.validatedKey, JSON.stringify(corrupted));
  const corruptRead = await request(reportPath(operationId(101)), { headers: { authorization: "Bearer " + token } });
  check("a changed validation object cannot impersonate a valid source-bound receipt", corruptRead.status === 409 && !corruptRead.body.previewToken && !corruptRead.body.artifact, corruptRead);
  await bucket.put(success.validatedKey, validationBytes);
  await request("/fixture/index-filing");
  const promoted = await request(reportPath(operationId(101)) + "/promote", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ expectedHash: success.hash, reviewer: "synthetic-independent-human-local-only", reviewNotes: "SYNTHETIC isolated acceptance approval; this is not user sign-off or a real report publication", approvedChainIds: ["chain-1"] }) });
  check("explicit independent synthetic reviewer may promote only the exact validated shadow", promoted.status === 200 && promoted.body.status === "published" && promoted.body.hash === success.hash, promoted);
  const publicRead = await request("/fixture/read-public"), summaryRow = await db.prepare("SELECT payload FROM sec_filing_summaries WHERE ticker=? AND accession_number=?").bind(ticker, accession).first(), summary = summaryRow ? JSON.parse(summaryRow.payload) : null;
  check("public summary accurately labels operator external authorship and exact provenance", summary?.source === "external" && summary.generatedBy === "operator" && summary.generation.planHash === success.planHash && summary.generation.checkpointHash === success.checkpointHash && summary.generation.author.model === "gpt-6.1-sol", summary?.generation);
  check("actual public filing and artifact read functions return the complete reviewed edition", publicRead.status === 200 && publicRead.body.artifact.hash === success.hash && publicRead.body.artifact.html.includes("Synthetic static sensitivity") && publicRead.body.filing.filing.summary.report.includes("Synthetic static sensitivity"), { status: publicRead.status, artifactHash: publicRead.body.artifact?.hash, filing: publicRead.body.filing?.filing });
  const review = await jsonRow(`research-shadow:${operationId(101)}:review`);
  check("explicit local human review receipt persists separately from operator validation", review?.reviewer === "synthetic-independent-human-local-only" && review.hash === success.hash && review.approvedChainIds.includes("chain-1"), review);
  check("no production or other outbound endpoint was contacted", blockedOutbound.length === 0, blockedOutbound);
  check("actual browser screenshots were sent to the visual provider transport", screenshots.length >= 18 && outbound.find(row => row.mode === "pass" && row.stage === "visual")?.images >= 18 && browserTelemetry.some(row => row.path.startsWith("/v1/sessions")), { captured: screenshots.length, reviewedImages: outbound.find(row => row.mode === "pass" && row.stage === "visual")?.images });
  const results = { at: new Date().toISOString(), environment: "Isolated local Miniflare D1/R2/SQLite TaskRunner, actual ArtifactFrame and actual Chromium through the real qa.ts CDP protocol", synthetic: { material: true, providerResponses: true, browserProtocol: false, parentCheckpoints: true, userSignoff: false }, actualModelCalls: 0, productionAccess: false, scratch, screenshots, checks, transports: outbound.map(({ input, ...rest }) => rest), browserTelemetry, notVerified: ["Real author generation quality", "Real independent model semantic and visual judgement quality", "Production deployment", "Real human investment review and production promotion", "Full production React business-page shell; local shell renders the actual ArtifactFrame component"] };
  const resultFile = resolve(root, "docs/acceptance/discovery/results/filing-operator-completion.json");
  await mkdir(resolve(root, "docs/acceptance/discovery/results"), { recursive: true }); await writeFile(resultFile, JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify({ resultFile, checks: checks.length, syntheticProviderHttpCalls: outbound.length, actualModelCalls: 0, screenshots: screenshots.length, scratch }));
} finally {
  transportRelease?.();
  if (mf) await mf.dispose();
  for (const socket of sockets) socket.terminate(); socketServer.close(); browserServer.closeAllConnections(); pageServer.closeAllConnections();
  await Promise.all([new Promise(resolve => browserServer.close(resolve)), new Promise(resolve => pageServer.close(resolve))]);
  if (chrome) { chrome.kill("SIGKILL"); await once(chrome, "exit").catch(() => undefined); }
}
