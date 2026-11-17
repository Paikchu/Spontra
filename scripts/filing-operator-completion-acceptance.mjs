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
import { spawn, execFileSync } from "node:child_process";
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
const reviewerQuote = "Synthetic static sensitivity is an illustration; future net interest and a price target remain unestablished.";
const reviewerReplacement = "Static sensitivity is illustrative; future net interest and a price target remain unestablished.";
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
const runs = Array.from({ length: 36 }, (_, i) => { const n = i + 1; return { runId: sourceId(n), ticker, accession, createdAt: at, baseVersion: 6, callsReserved: 40, maxCalls: 40, parentRunId: sourceId(1000 + n), continuation: { checkpointHash: sha(`synthetic-parent-${n}`), parentCallsReserved: 140, parentMaxCalls: 140, cumulativeMaxCalls: 180, reason: "Synthetic exhausted continuation" }, spec: spec(n) }; });
const parents = runs.map((run, i) => ({ ...run, runId: run.parentRunId, callsReserved: 140, maxCalls: 140, parentRunId: undefined, continuation: undefined, spec: { ...spec(1001 + i), mode: "rewrite" } }));
const fixture = { at, ticker, accession, state, runs, parents };
const checks = [], outbound = [], blockedOutbound = [], browserTelemetry = [], screenshots = [];
let transportMode = "pass", mf, chrome, chromeEndpoint, transportRelease, transportHeld;
let slowR2Key = null, slowR2Release, slowR2EnteredResolve, slowR2EnteredAt = null, slowR2Evidence = null;
const recoveryMode = process.env.SPONTRA_PREPARATION_RECOVERY_ACCEPTANCE === "1";
const visualContractMode = process.env.SPONTRA_VISUAL_REVIEW_CONTRACT_ACCEPTANCE === "1";
const contentCorrectionMode = process.env.SPONTRA_CONTENT_REVIEWER_CORRECTION_ACCEPTANCE === "1";
const visualViewports = ["1440x900 light", "390x844 light", "1280x800 dark"];
const visualScores = { layout: 9, hierarchy: 9, density: 9, consistency: 9, readability: 9 };
const visualContractCases = [
  { name: "visual-contract-schema", passes: true, verdict: { scores: visualScores, issues: [] } },
  { name: "visual-contract-invalid", passes: false, verdict: { scores: visualScores, issues: [
    { block: "all", severity: "major", viewport: visualViewports[0], problem: "Synthetic unknown block", suggestion: "Synthetic contract injection" },
    { block: "summary", severity: "minor", viewport: "desktop", problem: "Synthetic unknown viewport", suggestion: "Synthetic contract injection" },
    { block: "*", severity: "major", viewport: "all", problem: "Synthetic two invalid identifiers", suggestion: "Synthetic contract injection" },
    { block: "risks", severity: "minor", viewport: visualViewports[1], problem: "Synthetic valid issue retained in raw", suggestion: "Synthetic contract injection" },
  ] } },
  { name: "visual-contract-low-score", passes: false, verdict: { scores: { layout: 5, hierarchy: 6, density: 6, consistency: 8, readability: 5 }, issues: [] } },
  { name: "visual-contract-major", passes: false, verdict: { scores: visualScores, issues: [{ block: "summary", severity: "major", viewport: visualViewports[0], problem: "Synthetic major layout issue", suggestion: "Synthetic contract injection only" }] } },
  { name: "visual-contract-valid84", passes: true, verdict: { scores: { layout: 8, hierarchy: 9, density: 8, consistency: 8, readability: 9 }, issues: [] } },
];
const recoveryHolds = new Map(), recoveryStorageWrites = [], recoveryReadReturns = [];
const legacyOperator = recoveryMode ? { commit: execFileSync("git", ["rev-parse", "82a0"], { cwd: root, encoding: "utf8" }).trim(), source: execFileSync("git", ["show", "82a0:workers/analysis/src/filing-analysis/operator-completion.ts"], { cwd: root, encoding: "utf8" }) } : null;
const legacyExecutionId = `shadow-${ticker}-${accession}-operator-fix-${uuid(432)}`;
const historicalOperatorPlugin = { name: "actual-82a0-operator-callback", setup(bundle) {
  bundle.onResolve({ filter: /^fixture:operator-82a0$/ }, () => ({ path: "operator-82a0.ts", namespace: "historical-operator" }));
  bundle.onLoad({ filter: /.*/, namespace: "historical-operator" }, () => ({ contents: legacyOperator.source, loader: "ts", resolveDir: resolve(root, "workers/analysis/src/filing-analysis") }));
  bundle.onLoad({ filter: /\/durable-runs\/tasks\.ts$/ }, async ({ path }) => {
    const contents = await readFile(path, "utf8"), original = /async FILING_OPERATOR_COMPLETION_WORKFLOW\(params,\{env:raw,step,id\}\)\{return executeFilingOperatorCompletion\(params,\{env:await companyPolicyEnvironment\(raw\),step,executionId:id\}\);\},/;
    if (!original.test(contents)) throw Error("The current task mapper changed; cannot transparently select the legacy implementation");
    return { contents: `import{executeFilingOperatorCompletion as executeActual82a0}from'fixture:operator-82a0';\n` + contents.replace(original, `async FILING_OPERATOR_COMPLETION_WORKFLOW(params,{env:raw,step,id}){const legacy=id===${JSON.stringify(legacyExecutionId)};await raw.DB.prepare('INSERT OR IGNORE INTO fixture_execution_implementations(execution_id,implementation,source_sha) VALUES(?,?,?)').bind(id,legacy?'82a0':'current',legacy?${JSON.stringify(sha(legacyOperator.source))}:null).run();const env=await companyPolicyEnvironment(raw);return legacy?executeActual82a0(params,{env,step}):executeFilingOperatorCompletion(params,{env,step,executionId:id});},`), loader: "ts", resolveDir: resolve(root, "workers/analysis/src/durable-runs") };
  });
} };
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
import{AsyncLocalStorage}from 'node:async_hooks';
import{D1SecRepository}from ${JSON.stringify(resolve(root, "workers/analysis/src/sec/d1.ts"))};
import{getPublicFiling}from ${JSON.stringify(resolve(root, "workers/analysis/src/sec/public-api.ts"))};
import{judge}from ${JSON.stringify(resolve(root, "workers/analysis/src/artifact/openai.ts"))};
import{reserveFilingOperatorReview}from ${JSON.stringify(resolve(root, "workers/analysis/src/filing-analysis/operator-completion.ts"))};
import{filingOperatorHarness}from ${JSON.stringify(resolve(root, "workers/analysis/src/filing-analysis/recipe.ts"))};
import{executeFilingOperatorCompletion as executeCurrentOperator}from ${JSON.stringify(resolve(root, "workers/analysis/src/filing-analysis/operator-completion.ts"))};
import{companyPolicyEnvironment}from ${JSON.stringify(resolve(root, "workers/analysis/src/financial-data/company-policy.ts"))};
import{unpackState}from ${JSON.stringify(resolve(root, "workers/analysis/src/pi/state.ts"))};
import{withPreparedMaterialReadCache,readFilingMarkdown}from ${JSON.stringify(resolve(root, "workers/analysis/src/filing-material/read.ts"))};
import{AdminGateway as RealAdminGateway}from ${JSON.stringify(resolve(root, "workers/analysis/src/index.ts"))};
// Only R2 transport latency is injected. The real get completes before its response is deliberately held.
const delayedR2=(env,owner='default')=>({...env,SEC_FILINGS:new Proxy(env.SEC_FILINGS,{get(bucket,name){if(name==='get')return async(...args)=>{const object=await bucket.get(...args);await env.R2_READ_GATE.fetch('https://fixture-r2-gate.invalid/after-read',{method:'POST',body:JSON.stringify({method:'get',key:args[0],found:!!object,owner})});if(${JSON.stringify(recoveryMode)})await env.R2_READ_GATE.fetch('https://fixture-r2-gate.invalid/returned-read',{method:'POST',body:JSON.stringify({method:'get-returned',key:args[0],owner})});return object;};if(name==='put'&&${JSON.stringify(recoveryMode)})return async(...args)=>{const result=await bucket.put(...args);await env.R2_READ_GATE.fetch('https://fixture-r2-gate.invalid/after-write',{method:'POST',body:JSON.stringify({method:'put',key:args[0],owner})});return result;};const value=Reflect.get(bucket,name);return typeof value==='function'?value.bind(bucket):value;}})});
const timingScope=new AsyncLocalStorage(),nativeSetTimeout=globalThis.setTimeout;
if(${JSON.stringify(recoveryMode)})globalThis.setTimeout=(callback,delay,...args)=>{const active=timingScope.getStore();if(delay===660000&&active?.fixtureAcceleratesPreparation()){active.fixtureTimerMarker(delay,1000);return nativeSetTimeout(callback,1000,...args);}return nativeSetTimeout(callback,delay,...args);};
export class AdminGateway extends RealAdminGateway{constructor(ctx,env){super(ctx,delayedR2(env,'gateway'));}}
export class CompletionRunner extends TaskRunner{
  constructor(ctx,env){env=delayedR2(env,ctx.id.name);const sql=ctx.storage.sql,f=JSON.parse(env.FIXTURE),own=ctx.id.name?.replace(/^FILING:/,''),source=[...f.runs,...f.parents].find(run=>run.runId===own);
    sql.exec("CREATE TABLE IF NOT EXISTS fixture_dispatches(kind TEXT,operation_id TEXT)");
    sql.exec("CREATE TABLE IF NOT EXISTS fixture_timer_events(requested INTEGER,effective INTEGER)");
    if(source){sql.exec("CREATE TABLE IF NOT EXISTS pi_bindings(conversation TEXT PRIMARY KEY,session TEXT NOT NULL,operation_id TEXT NOT NULL,kind TEXT NOT NULL,spec TEXT NOT NULL,state TEXT NOT NULL,started_at INTEGER NOT NULL,turns INTEGER NOT NULL DEFAULT 0,quiet INTEGER NOT NULL DEFAULT 0,last_round INTEGER NOT NULL DEFAULT 0,capped INTEGER NOT NULL DEFAULT 0,finished INTEGER NOT NULL DEFAULT 0,asked TEXT,round TEXT,active INTEGER NOT NULL DEFAULT 1,spent INTEGER NOT NULL DEFAULT 0,startup TEXT,reserved_at INTEGER)");sql.exec("INSERT OR IGNORE INTO pi_bindings VALUES('synthetic-source','synthetic-session',?,'filing',?,?,0,40,0,0,1,0,NULL,NULL,0,1234,NULL,NULL)",source.runId+':shadow',JSON.stringify(source.spec),packState(f.state));}
    super(ctx,env);
  }
  async start(kind,id,params,createdAt){this.ctx.storage.sql.exec("INSERT INTO fixture_dispatches VALUES(?,?)",kind,id);return super.start(kind,id,params,createdAt);}
  async startSession(kind,spec,opening,operationId){this.ctx.storage.sql.exec("INSERT INTO fixture_dispatches VALUES(?,?)",kind,operationId);throw Error('Any operator Pi author dispatch is forbidden in this journey');}
  async advance(){return timingScope.run(this,()=>super.advance());}
  fixtureAcceleratesPreparation(){return ${JSON.stringify([432, 436].map(n => `FILING_OPERATOR_COMPLETION_WORKFLOW:shadow-${ticker}-${accession}-operator-fix-${uuid(n)}`))}.includes(this.ctx.id.name)&&this.state.step==='operator:corrections';}
  fixtureTimerMarker(requested,effective){this.ctx.storage.sql.exec('INSERT INTO fixture_timer_events VALUES(?,?)',requested,effective);}
  fixtureSnapshot(){const sql=this.ctx.storage.sql,tables=sql.exec("SELECT name FROM sqlite_master WHERE type='table'").toArray().map(r=>r.name);return{tables,dispatches:sql.exec('SELECT * FROM fixture_dispatches').toArray(),timers:sql.exec('SELECT * FROM fixture_timer_events').toArray(),sessions:tables.includes('pi_bindings')?sql.exec('SELECT operation_id,spec,state,active,capped,finished,startup FROM pi_bindings').toArray():[],run:tables.includes('run')?sql.exec('SELECT * FROM run').toArray():[],steps:tables.includes('steps')?sql.exec('SELECT * FROM steps').toArray():[]};}
  fixtureMutateSource(columns){for(const[key,value]of Object.entries(columns)){if(!['active','capped','finished','startup','spec'].includes(key))throw Error('Fixture column not allowed');this.ctx.storage.sql.exec('UPDATE pi_bindings SET '+key+'=?',value);}return true;}
  fixtureEvict(){this.ctx.abort('Synthetic local cold restart');}
}
export default{async fetch(request,rawEnv){const env=delayedR2(rawEnv),url=new URL(request.url),f=JSON.parse(env.FIXTURE),id=url.searchParams.get('id'),stub=()=>env.TASK_RUNS.get(env.TASK_RUNS.idFromName((url.searchParams.get('kind')||'FILING')+':'+id));
 if(url.pathname==='/fixture/auth')return Response.json({token:await createAdminSession(env.REPORT_ADMIN_PASSWORD)});
 if(url.pathname==='/fixture/snapshot')return Response.json(await stub().fixtureSnapshot());
 if(url.pathname==='/fixture/advance'){await stub().advance();return Response.json(await stub().fixtureSnapshot());}
 if(url.pathname==='/fixture/run-status')return Response.json(await stub().status());
 if(url.pathname==='/fixture/stale-execution'){try{await executeCurrentOperator({runId:id},{env:await companyPolicyEnvironment(env),executionId:url.searchParams.get('execution'),step:{do(){throw Error('Stale execution reached a task step');},sleep(){throw Error('Stale execution reached sleep');},waitFor(){throw Error('Stale execution reached wait');}}});return Response.json({accepted:true});}catch(error){return Response.json({error:String(error)},{status:409});}}
 if(url.pathname==='/fixture/evict'){await stub().fixtureEvict();return Response.json({evicted:true});}
 if(url.pathname==='/fixture/mutate-source')return Response.json(await stub().fixtureMutateSource(await request.json()));
 if(url.pathname==='/fixture/preview')return Response.json(await readPreview(env,url.searchParams.get('token')||''));
 if(url.pathname==='/fixture/read-public')return Response.json({filing:await getPublicFiling(new D1SecRepository(env.DB),f.ticker,f.accession),artifact:await readPublishedArtifact(env,'filing-report',f.ticker,f.accession)});
 if(url.pathname==='/fixture/index-filing'){await new D1SecRepository(env.DB).upsertFilingIndex(f.runs[0].spec.filing);return Response.json({indexed:true});}
 if(url.pathname==='/fixture/review-request'){try{return Response.json(await judge({...env,MODEL_REQUEST_GATE:async()=>{const record=JSON.parse((await env.DB.prepare('SELECT payload FROM sec_cache WHERE cache_key=?').bind('filing-operator:'+id).first()).payload);await reserveFilingOperatorReview(env,id,url.searchParams.get('lease'),url.searchParams.get('execution')||record.executionId||id);}},{stage:'fixture-gate',system:'Synthetic local gate transport only',text:'{"fixture":true}',schema:{type:'object',properties:{ok:{type:'boolean'}}},maxRetries:Number(url.searchParams.get('retries')||0),ledger:{kind:'synthetic-acceptance',ticker:f.ticker,runId:id}}));}catch(error){return Response.json({error:String(error)},{status:503});}}
 if(url.pathname==='/fixture/material-range-cache'){
   const row=JSON.parse((await env.DB.prepare('SELECT payload FROM sec_cache WHERE cache_key=?').bind('filing-operator:'+id).first()).payload),saved=await(await env.SEC_FILINGS.get(row.stateRef.key)).text(),reads=[];
   const tracked={...env,MODEL_REQUEST_GATE:async()=>{throw Error('Cache read acceptance forbids model calls');},SEC_FILINGS:new Proxy(env.SEC_FILINGS,{get(bucket,name){if(name==='get')return async(...args)=>{const entry={key:args[0],range:args[1]?.range??null,arrayBuffers:0,texts:0};reads.push(entry);const object=await bucket.get(...args);if(!object)return null;return new Proxy(object,{get(object,method){if(method==='arrayBuffer')return()=>{entry.arrayBuffers++;return object.arrayBuffer();};if(method==='text')return()=>{entry.texts++;return object.text();};const value=Reflect.get(object,method,object);return typeof value==='function'?value.bind(object):value;}});};const value=Reflect.get(bucket,name,bucket);return typeof value==='function'?value.bind(bucket):value;}})};
   const active=unpackState(saved),summary=active.composer.blocks.find(block=>block.id==='summary');summary.title='Cache read journey';summary.html='<h2>Cache read journey</h2><p>HEDGE evidence search.</p><p><data value="164000000" data-ref="c2">164000000</data> USD.</p>';summary.sources=['c2'];summary.state='draft';active.composer.passed={};
   const refuseShadow=async()=>{throw Error('Read acceptance cannot validate or publish');},harness=await filingOperatorHarness(tracked,row.spec,active,refuseShadow),ranges=()=>reads.filter(read=>read.range);
   const first=await harness.contentInput(active,'summary'),firstReads=ranges().length,second=await harness.contentInput(active,'summary'),secondReads=ranges().length-firstReads;
   const fresh=await filingOperatorHarness(tracked,row.spec,structuredClone(active),refuseShadow),beforeFresh=ranges().length,third=await fresh.contentInput(fresh.state,'summary'),freshReads=ranges().length-beforeFresh;
   const material=JSON.parse(await(await tracked.SEC_FILINGS.get('sec-materials/v1/'+row.spec.material.ticker+'/'+row.spec.material.accession+'/'+row.spec.material.version+'/index.json')).text()),alias=structuredClone(material);alias.ref.version+='-alias';
   const cacheEnv=withPreparedMaterialReadCache(tracked,[material,alias]),beforeCross=ranges().length,page=await readFilingMarkdown(cacheEnv,material),aliasPage=await readFilingMarkdown(cacheEnv,alias),crossReads=ranges().length-beforeCross;
   const retry=structuredClone(material);retry.ref.version+='-recovery';retry.markdown.key+='.cache-recovery';const retryEnv=withPreparedMaterialReadCache(tracked,[retry]),beforeRetry=ranges().length;let firstFailure='';try{await readFilingMarkdown(retryEnv,retry);}catch(error){firstFailure=String(error);}
   const originalMarkdown=await(await env.SEC_FILINGS.get(material.markdown.key)).text();await env.SEC_FILINGS.put(retry.markdown.key,originalMarkdown);const recovered=await readFilingMarkdown(retryEnv,retry),recoveryReads=ranges().length-beforeRetry;
   const indexKey='sec-materials/v1/'+row.spec.material.ticker+'/'+row.spec.material.accession+'/'+row.spec.material.version+'/index.json';
   return Response.json({firstReads,secondReads,freshReads,crossReads,recoveryReads,firstFailure,indexReads:reads.filter(read=>read.key===indexKey).length,bodyEqual:JSON.stringify(first.body)===JSON.stringify(second.body)&&JSON.stringify(first.body)===JSON.stringify(third.body),inputHashes:[first.inputHash,second.inputHash,third.inputHash],blockHashes:[first.blockHash,second.blockHash,third.blockHash],foundSourceIds:first.payload.found.map(source=>source.id),crossTextEqual:page.text===aliasPage.text&&page.text===originalMarkdown,recovered:recovered.text===originalMarkdown,eachRangeObjectConsumedOnce:reads.filter(read=>read.range).every(read=>read.arrayBuffers<=1),reads});
 }
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
  outbound.push({ stage, mode: transportMode, model: body.model, streaming: body.stream === true, block: input.block?.id ?? null, images: Array.isArray(content) ? content.filter(part => part.type === "image_url").length : 0, input, ...(visualContractMode && stage === "visual" ? { system, schema: body.response_format?.json_schema?.schema } : {}) });
  if (transportMode === "hold-content" && stage === "content") { transportHeld?.(); await new Promise(resolve => { transportRelease = resolve; }); }
  if (transportMode === "visual-unavailable" && stage === "visual" || transportMode === "retry-cap") return Response.json({ error: { message: "Synthetic provider transport failure" } }, { status: 500, headers: { "retry-after-ms": "1" } });
  if (stage === "gate") return completion(body, { ok: true });
  if (stage === "content" && transportMode === "malformed-content") return completion(body, {});
  if (stage === "content" && transportMode === "malformed-content-issue") return completion(body, { issues: [{}] });
  if (stage === "content" && transportMode === "content-correction-source") return completion(body, { issues: [
    { quote: reviewerQuote, problem: "Synthetic bounded content issue", replacement: reviewerReplacement, severity: "major" },
    { quote: "Hedge netting remains unresolved.", problem: "not covered: synthetic author methodology advice", severity: "minor" },
    { quote: "future net interest and a price target remain unestablished", problem: "not covered: synthetic research assumption advice", severity: "minor" },
    { quote: "Synthetic static sensitivity is an illustration", problem: "not covered: synthetic investment test advice", severity: "minor" },
  ] });
  if (stage === "content" && transportMode === "content-correction-source") return completion(body, { issues: [
    { quote: reviewerQuote, problem: "Synthetic single major with an actual plain reviewer correction", replacement: reviewerReplacement, severity: "major" },
    ...["Hedge netting remains unresolved.", "future net interest and a price target remain unestablished", "Synthetic static sensitivity is an illustration"].map(quote => ({ quote, problem: "not covered: synthetic author-method advice only", suggestion: "Synthetic advisory point only", severity: "minor" })),
  ] });
  if (stage === "content") return completion(body, { issues: transportMode === "content-fail" ? [{ quote: input.block.sentences[0].text, problem: "Synthetic injected unsupported claim", replacement: "DELETE", suggestion: "Synthetic injection only", severity: "major" }] : [] });
  if (stage === "visual") return completion(body, visualContractMode ? visualContractCases.find(item => item.name === transportMode).verdict : { scores: { layout: 9, hierarchy: 9, density: 9, consistency: 9, readability: 9 }, issues: [] });
  const computations = input.computations.map(item => ({ id: item.id, status: "holds", problem: "Synthetic provider receipt: exact pinned arithmetic and stated static basis", sources: ["source-block"] }));
  return completion(body, { verdict: ["semantic-fail", "semantic-noquote"].includes(transportMode) ? "fail" : "pass", complete: true, summary: "SYNTHETIC independent-provider transport response, not real investment review", computations, issues: ["semantic-fail", "semantic-noquote"].includes(transportMode) ? [{ block: "summary", quote: transportMode === "semantic-noquote" ? "" : reviewerQuote, problem: "Synthetic injected semantic failure", replacement: reviewerReplacement, suggestion: "Synthetic injection only", sources: ["source-block"], evidence: originalQuote }] : [] });
}

const reportPath = id => `/admin/reports/${ticker}/${accession}/shadow/${id}`;
const runnerPath = id => `/fixture/snapshot?id=${id}&kind=FILING_OPERATOR_COMPLETION_WORKFLOW`;
let db, bucket, token, publicBaseline;
let correctionPublication;
const jsonRow = async key => { const row = await db.prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(key).first(); return row ? JSON.parse(row.payload) : null; };
const opRow = id => jsonRow(`filing-operator:${id}`);
const rawRow = key => db.prepare("SELECT * FROM sec_cache WHERE cache_key=?").bind(key).first();
const send = (n, op, plan, options = {}) => request((options.proxy ? reportPath(sourceId(n)).replace("/admin/", "/api/admin/") : reportPath(sourceId(n))) + "/operator-complete", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json", "idempotency-key": uuid(op), ...(options.proxy ? { origin: "http://localhost" } : {}), ...options.headers }, body: JSON.stringify(plan) });
const sendCorrection = (runId, operation, input, options = {}) => request((options.proxy ? reportPath(runId).replace("/admin/", "/api/admin/") : reportPath(runId)) + "/apply-reviewer-corrections", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json", "idempotency-key": uuid(operation), ...(options.proxy ? { origin: "http://localhost" } : {}), ...options.headers }, body: JSON.stringify(input) });
const sendPreparationRecovery = (runId, operation, input, options = {}) => request((options.proxy ? reportPath(runId).replace("/admin/", "/api/admin/") : reportPath(runId)) + "/recover-preparation", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json", "idempotency-key": uuid(operation), ...(options.proxy ? { origin: "http://localhost" } : {}), ...options.headers }, body: JSON.stringify(input) });
const planFor = async n => {
  const exported = await request(reportPath(sourceId(n)) + "/checkpoint", { headers: { authorization: "Bearer " + token } });
  if (exported.status !== 200) throw Error("Source checkpoint unavailable: " + JSON.stringify(exported));
  return { schemaVersion: "filing-operator-plan.v1", sourceRunId: sourceId(n), expectedCheckpointHash: exported.body.checkpointHash, expectedPublicVersion: publicBaseline.version, expectedPublicHash: publicBaseline.hash, author: { model: "gpt-6.1-sol", effort: "max", runId: `synthetic-external-sol-author-${n}`, promptVersion: "synthetic-operator-completion.v1" }, reason: "Synthetic local acceptance: replace outdated arithmetic with independently checked static illustration; never publish", pinnedReads: [{ tool: "read_filing_markdown", args: { maxChars: 48000 } }, { tool: "query_facts", args: {} }], computeCalls: [{ expectedResultId: "c2", args: { label: "Static quarter sensitivity annualized for illustration only", formula: `${factIds[0]}*4`, unit: "USD" }, expected: { value: 164000000, unit: "USD", tolerance: 0 } }, { expectedResultId: "c3", args: { label: "Static nine-month sensitivity normalized to a year for illustration only", formula: `${factIds[1]}/3*4`, unit: "USD" }, expected: { value: 164000000, unit: "USD", tolerance: 0 } }], oldToNew: { c1: "c2" }, evidenceCorrections: [{ id: "E7", expectedOldHash: sha(stable(oldNote)), section: "source-block", quote: originalQuote, statement: "Static disclosed sensitivity has unresolved hedge netting; annualization is illustrative and is not a future net-interest forecast", facts: factIds }], closeLeads: { leads: [{ id: "L1", verdict: "open", finding: "Synthetic pinned source does not establish hedge overlap; retain this specific uncertainty", evidence: ["source-block"] }] }, researchUses: [{ reportId: "synthetic-macro", version: publicResearch.reports[0].report.version, claimId: "macro-claim-1", decision: "rejected", reason: "Synthetic static company sensitivity does not establish a macro-driven future net cost; debt reset and hedge overlaps remain unresolved", companySources: ["source-block"], financialVariable: "cashInterest" }], investmentChains: [{ id: "chain-1", priorAssumption: "An obsolete net cost forecast was unsupported", newEvidence: originalQuote, revisedAssumption: "Use the disclosed static sensitivity without double deducting hedges", financialEffect: "Synthetic illustrative static annualization is 164000000 USD; actual future net cash interest is not established", valuationEffect: "No target price without tax, share count, dated debt resets and hedge reconciliation", quantificationStatus: "sensitivity_only", sourceIds: ["source-block"], computationRefs: ["c2", "c3"], missingInputs: ["Debt reset dates, net hedge treatment, tax, economic shares and a valuation model"], counterEvidence: "Hedges and debt balances can change", verification: "Read next dated original debt and hedge disclosure", window: "Synthetic illustration only" }], charts: [{ id: "static-comparison", title: "Synthetic static annualization illustration", type: "bar", aspect: "wide", series: [{ label: "Illustration only; no forward forecast", points: [{ period: "2025-09-30", ref: "c2" }, { period: "2025-12-31", ref: "c3" }] }] }], blocks: blockIds.map((id, i) => ({ id, html: `<h2>Synthetic ${id === "summary" ? "static sensitivity" : id} case ${n}</h2><p>Synthetic static sensitivity is an illustration; future net interest and a price target remain unestablished. <cite data-source="source-block">Pinned original evidence</cite>.</p><p>Static illustration: <data value="164000000" data-ref="c2">164000000</data> USD. Hedge netting remains unresolved.</p>${i === 1 ? '<figure data-chart="static-comparison"></figure>' : ""}` })) };
};
async function drive(id, { terminal = true, limit = 160, executionId = id } = {}) {
  let saved;
  for (let n = 0; n < limit; n++) {
    saved = await opRow(id);
    if (saved && ["validated", "failed", "unknown"].includes(saved.status)) return saved;
    await request(`/fixture/advance?id=${executionId}&kind=FILING_OPERATOR_COMPLETION_WORKFLOW`);
    if (!terminal) return opRow(id);
    await pause(30);
  }
  throw Error("Operator task did not reach a terminal receipt: " + JSON.stringify(saved));
}
async function runVisualContractJourney() {
  const cases = [];
  for (const [index, fixed] of visualContractCases.entries()) {
    const n = index + 1, before = outbound.length, firstShot = screenshots.length;
    transportMode = fixed.name;
    const admitted = await send(n, 100 + n, await planFor(n), { proxy: true });
    check(fixed.name + " admits only the fixed synthetic fixture through the actual proxy", admitted.status === 202, admitted);
    const run = await drive(admitted.body.runId), receipt = run.stages?.render?.receipt;
    const requests = outbound.slice(before), visual = requests.filter(item => item.stage === "visual");
    check(fixed.name + " reaches real composer render with one synthetic visual HTTP and no retry", requests.length === 8 && requests.filter(item => item.stage === "content").length === 6 && requests.filter(item => item.stage === "semantic").length === 1 && visual.length === 1 && run.reviewCalls === 8, requests.map(({ stage, mode }) => ({ stage, mode })));
    check(fixed.name + " sends actual block and viewport enums in the provider JSON schema", JSON.stringify(visual[0].schema?.properties?.issues?.items?.properties?.block?.enum) === JSON.stringify(blockIds) && JSON.stringify(visual[0].schema?.properties?.issues?.items?.properties?.viewport?.enum) === JSON.stringify(visualViewports), visual[0].schema);
    check(fixed.name + " prompts for the same exact sets and forbids all wildcards and aliases", visual[0].system.includes(JSON.stringify(blockIds)) && visual[0].system.includes(JSON.stringify(visualViewports)) && visual[0].system.includes("never use all, *, aliases or combined identifiers"), visual[0].system);
    check(fixed.name + " actually measures and sends screenshots of every block at all three viewports", receipt && visual[0].images >= 18 && screenshots.length - firstShot >= 18 && visualViewports.every(viewport => blockIds.every(id => receipt.measured?.[viewport]?.includes(id) && receipt.covered?.[viewport]?.includes(id) && visual[0].input.blockMap.some(part => part.block === id && part.viewport === viewport))), { images: visual[0].images, shots: screenshots.length - firstShot, measured: receipt?.measured, covered: receipt?.covered });
    check(fixed.name + " retains the complete parsed visual verdict in the durable composer receipt", JSON.stringify(receipt?.visualVerdict) === JSON.stringify(fixed.verdict), receipt?.visualVerdict);
    const persistedCheck = await db.prepare("SELECT result FROM analysis_artifact_checks WHERE artifact_id=? AND version=? AND stage='render' ORDER BY created_at DESC LIMIT 1").bind(`filing-report:${ticker}:${accession}`, receipt.draft.version).first();
    const storedQa = persistedCheck ? JSON.parse(persistedCheck.result) : null;
    check(fixed.name + " independently stores the same complete raw verdict in the actual artifact QA record", JSON.stringify(storedQa?.visualVerdict) === JSON.stringify(fixed.verdict) && JSON.stringify(storedQa?.invalidVisualIdentifiers) === JSON.stringify(receipt.invalidVisualIdentifiers), storedQa?.visualVerdict);
    if (fixed.name === "visual-contract-invalid") {
      const expectedInvalid = fixed.verdict.issues.slice(0, 3).map((issue, issueIndex) => ({ issue: issueIndex, block: issue.block, viewport: issue.viewport, unknownBlock: !blockIds.includes(issue.block), unknownViewport: !visualViewports.includes(issue.viewport) }));
      check("invalid visual IDs preserve all four original issues and every offending position without remapping", receipt.visualVerdict.issues.length === 4 && receipt.visualIdentifiersValid === false && JSON.stringify(receipt.invalidVisualIdentifiers) === JSON.stringify(expectedInvalid) && !receipt.issues.some(issue => issue.problem.startsWith("Synthetic unknown") || issue.problem === "Synthetic two invalid identifiers"), receipt.invalidVisualIdentifiers);
      check("invalid visual IDs cannot satisfy strict completion even with all nine scores", receipt.visualReviewed === false && /unknown block or viewport/.test(receipt.unavailable), { visualReviewed: receipt.visualReviewed, unavailable: receipt.unavailable, scores: receipt.scores });
    } else {
      check(fixed.name + " marks exact identifiers valid without inventing invalid locations", receipt.visualIdentifiersValid === true && receipt.invalidVisualIdentifiers.length === 0 && receipt.visualReviewed === true, { valid: receipt.visualIdentifiersValid, invalid: receipt.invalidVisualIdentifiers, reviewed: receipt.visualReviewed });
    }
    if (fixed.name === "visual-contract-low-score") {
      const score = Object.entries({ layout: .25, hierarchy: .25, density: .2, consistency: .15, readability: .15 }).reduce((sum, [key, weight]) => sum + receipt.scores[key] * weight * 10, 0);
      check("valid IDs do not turn the fixed 59 score into a visual pass", Math.round(score) === 59 && receipt.success === false && /score threshold/.test(receipt.observation), { weightedScore: score, scores: receipt.scores, observation: receipt.observation });
    }
    if (fixed.name === "visual-contract-major") check("valid IDs and nine scores cannot override a real major visual issue", receipt.success === false && receipt.issues.some(issue => issue.kind === "visual" && issue.severity === "major" && issue.block === "summary" && issue.viewport === visualViewports[0]), receipt.issues);
    check(fixed.name + " enforces the final composer and shadow gate", receipt.success === fixed.passes && run.status === (fixed.passes ? "validated" : "failed") && (fixed.passes ? Boolean(run.validatedKey) : !run.validatedKey), { status: run.status, success: receipt.success, validatedKey: run.validatedKey });
    const read = await request(reportPath(admitted.body.runId), { headers: { authorization: "Bearer " + token } });
    check(fixed.name + " exposes a validated preview only for the two genuine local passing receipts", fixed.passes ? read.status === 200 && read.body.status === "validated_shadow" && Boolean(read.body.previewToken) : !read.body.previewToken && !read.body.artifact && read.body.status !== "validated_shadow", { status: read.status, bodyStatus: read.body.status, preview: Boolean(read.body.previewToken) });
    cases.push({ name: fixed.name, fixedResponse: fixed.verdict, runId: admitted.body.runId, status: run.status, reviewCalls: run.reviewCalls, receipt, artifactQa: storedQa, request: visual[0], screenshots: screenshots.slice(firstShot) });
  }
  const pointer = await db.prepare("SELECT published_version,published_hash FROM analysis_artifacts WHERE artifact_id=?").bind(`filing-report:${ticker}:${accession}`).first();
  check("visual contract acceptance preserves the exact public version and hash without promotion", pointer.published_version === 6 && pointer.published_hash === publicBaseline.hash, pointer);
  check("fixed visual contract acceptance never contacts production or any external provider", blockedOutbound.length === 0, blockedOutbound);
  return { cases, pointer };
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
async function reviewerCorrectionInput(runId) {
  const row = await opRow(runId);
  return { expectedPlanHash: row.planHash, expectedFailedStateHash: row.stateRef.hash, expectedSemanticReceiptHash: sha(JSON.stringify(row.stages.semantic.receipt)), expectedPublicVersion: publicBaseline.version, expectedPublicHash: publicBaseline.hash };
}
async function startSemanticFailure(n, mode = "semantic-fail") {
  transportMode = mode;
  const plan = await planFor(n), answer = await send(n, 100 + n, plan);
  check(`reviewer correction source ${n} is admitted normally`, answer.status === 202, answer);
  const row = await drive(answer.body.runId);
  check(`reviewer correction source ${n} has six real content reviews and one failed semantic review`, row.status === "failed" && row.phase.name === "semantic" && row.reviewCalls === 7 && !row.validatedKey, { status: row.status, phase: row.phase.name, reviewCalls: row.reviewCalls });
  transportMode = "pass";
  return { runId: answer.body.runId, plan, row, input: await reviewerCorrectionInput(answer.body.runId) };
}
async function rejectReviewerCorrection(name, runId, input, options = {}) {
  const before = outbound.length, answer = await sendCorrection(runId, options.operation ?? 301, input, options);
  check(name, [400, 409, 413].includes(answer.status) && outbound.length === before, { status: answer.status, error: answer.body.error, newProviderHttp: outbound.length - before });
  return answer;
}
async function failDeferredCorrection(name, source, input, operation) {
  const before = outbound.length, oldLedger = await rawRow(`filing-operator:${source.runId}`);
  const admission = await sendCorrection(source.runId, operation, input, { proxy: true });
  check(name + " is claimed through the real proxy before heavy validation", admission.status === 202, admission);
  const failed = await drive(admission.body.runId), view = await request(reportPath(admission.body.runId), { headers: { authorization: "Bearer " + token } });
  check(name + " fails the durable non-billable phase before any provider HTTP", failed.status === "failed" && failed.reviewCalls === 0 && failed.reviewCallsInherited === 7 && !failed.validatedKey && outbound.length === before && view.body.status === "failed" && !view.body.previewToken && !view.body.artifact && JSON.stringify(await rawRow(`filing-operator:${source.runId}`)) === JSON.stringify(oldLedger), { status: failed.status, phase: failed.phase?.name, error: failed.error, newCalls: failed.reviewCalls, inherited: failed.reviewCallsInherited, providerHttp: outbound.length - before });
  return failed;
}
async function withMutatedFailedState(runId, edit, work) {
  const original = await rawRow(`filing-operator:${runId}`), row = JSON.parse(original.payload);
  const state = JSON.parse(await (await bucket.get(row.stateRef.key)).text()); edit(state);
  const body = JSON.stringify(state), hash = sha(body), ref = { key: `filing-operator/${runId}/fault-fixture/${hash}.json`, hash };
  await bucket.put(ref.key, body);
  row.stateRef = ref; row.stages.semantic.afterStateRef = ref; row.phase.afterStateRef = ref;
  await db.prepare("UPDATE sec_cache SET payload=? WHERE cache_key=?").bind(JSON.stringify(row), original.cache_key).run();
  try { return await work(await reviewerCorrectionInput(runId)); }
  finally { await db.prepare("UPDATE sec_cache SET payload=?,fetched_at=? WHERE cache_key=?").bind(original.payload, original.fetched_at, original.cache_key).run(); }
}
async function startHeldReviewerCorrection(n, correctionNumber) {
  const source = await startSemanticFailure(n);
  let arrived, timer;
  const held = new Promise((resolve, reject) => { arrived = resolve; timer = setTimeout(() => reject(Error("Reviewer correction never reached its changed-block transport")), 20000); });
  transportMode = "hold-content"; transportHeld = arrived;
  const answer = await sendCorrection(source.runId, correctionNumber, source.input);
  check(`bounded reviewer correction ${n} is admitted without a new author plan`, answer.status === 202, answer);
  const progress = drive(answer.body.runId).then(value => ({ value }), error => ({ error: String(error) }));
  await held; clearTimeout(timer); transportHeld = undefined; transportMode = "pass";
  const row = await opRow(answer.body.runId);
  check(`reviewer correction ${n} marks its changed-block phase before sending`, row.phase.name === "content:summary" && row.phase.status === "started" && row.reviewCalls === 1 && row.reviewCallsInherited === 7, { phase: row.phase.name, calls: row.reviewCalls, inherited: row.reviewCallsInherited });
  return { source, runId: answer.body.runId, row, lease: row.phase.leaseToken, progress };
}

async function runSlowR2AdmissionJourney() {
  const source = await startSemanticFailure(31), sourceLedger = await rawRow(`filing-operator:${source.runId}`);
  const usage = await db.prepare("SELECT * FROM ai_usage WHERE run_id=? AND stage='artifact-review-highlights' AND outcome='ok' LIMIT 1").bind(source.runId).first();
  await db.prepare("UPDATE ai_usage SET model='incompatible-synthetic-model' WHERE id=?").bind(usage.id).run();
  let timer;
  const seen = new Promise((resolve, reject) => { slowR2EnteredResolve = resolve; timer = setTimeout(() => reject(Error("The delayed real R2 failed-state read never began")), 45000); });
  slowR2Key = source.row.stateRef.key; slowR2EnteredAt = null;
  const httpBefore = outbound.length, startedAt = Date.now();
  try {
    const admission = await sendCorrection(source.runId, 331, source.input, { proxy: true }), proxyElapsedMs = Date.now() - startedAt;
    check("slow R2 evidence cannot make real proxy admission cross its unchanged thirty-second timeout", admission.status === 202 && proxyElapsedMs < 30000, { status: admission.status, proxyElapsedMs, proxyTimeoutMs: 30000 });
    const progress = drive(admission.body.runId).then(value => ({ value }), error => ({ error: String(error) }));
    const read = await seen; clearTimeout(timer);
    check("durable correction waits on an actual completed R2 get response before any model HTTP", read.found && read.key === source.row.stateRef.key && (await opRow(admission.body.runId)).reviewCalls === 0 && outbound.length === httpBefore, { key: read.key, found: read.found, enteredAt: read.enteredAt, providerHttp: outbound.length - httpBefore });
    const replayStart = Date.now(), replay = await sendCorrection(source.runId, 331, source.input, { proxy: true }), replayElapsedMs = Date.now() - replayStart;
    const runner = (await request(runnerPath(admission.body.runId))).body;
    check("exact replay during the delayed read returns quickly without a second dispatch", replay.status === 202 && replay.body.replay && replay.body.dispatchRetried === false && replayElapsedMs < 30000 && runner.dispatches.length === 1 && outbound.length === httpBefore, { replayElapsedMs, dispatches: runner.dispatches.length });
    await pause(Math.max(0, 31500 - (Date.now() - read.enteredAt)));
    const releasedAt = Date.now(), heldMs = releasedAt - read.enteredAt;
    slowR2Key = null; slowR2Release(); await progress;
    const failed = await drive(admission.body.runId, { limit: 1000 }), publicPointer = await db.prepare("SELECT published_version,published_hash FROM analysis_artifacts WHERE artifact_id=?").bind(`filing-report:${ticker}:${accession}`).first();
    check("more than thirty seconds of R2 latency ends in a non-billable proof failure with the old seven and public six intact", heldMs >= 31500 && failed.status === "failed" && failed.reviewCalls === 0 && failed.reviewCallsInherited === 7 && !failed.validatedKey && outbound.length === httpBefore && publicPointer.published_version === 6 && publicPointer.published_hash === publicBaseline.hash && JSON.stringify(await rawRow(`filing-operator:${source.runId}`)) === JSON.stringify(sourceLedger), { heldMs, proxyElapsedMs, replayElapsedMs, status: failed.status, phase: failed.phase?.name, newCalls: failed.reviewCalls, inherited: failed.reviewCallsInherited, publicPointer });
    slowR2Evidence = { runId: admission.body.runId, sourceRunId: source.runId, failedStateKey: read.key, actualR2ObjectFound: read.found, enteredAt: new Date(read.enteredAt).toISOString(), releasedAt: new Date(releasedAt).toISOString(), heldMs, proxyElapsedMs, replayElapsedMs, unchangedProxyTimeoutMs: 30000, status: failed.status, phase: failed.phase?.name, originalCalls: 7, addedCalls: 0, dispatches: runner.dispatches.length, providerHttp: outbound.length - httpBefore, publicPointer };
  } finally {
    clearTimeout(timer); slowR2Key = null; slowR2EnteredResolve = undefined; slowR2Release?.();
    await db.prepare("UPDATE ai_usage SET model=? WHERE id=?").bind(usage.model, usage.id).run();
  }
}

async function runDeferredProofFailures() {
  const mismatchedModel = await startSemanticFailure(28);
  const usage = await db.prepare("SELECT * FROM ai_usage WHERE run_id=? AND stage='artifact-review-highlights' AND outcome='ok' LIMIT 1").bind(mismatchedModel.runId).first();
  check("reusable original content has an actual successful model usage row", Boolean(usage?.id), { id: usage?.id, model: usage?.model, reasoning: usage?.reasoning });
  await db.prepare("UPDATE ai_usage SET model='incompatible-synthetic-model' WHERE id=?").bind(usage.id).run();
  try { await failDeferredCorrection("mismatched historical model usage", mismatchedModel, mismatchedModel.input, 328); }
  finally { await db.prepare("UPDATE ai_usage SET model=? WHERE id=?").bind(usage.model, usage.id).run(); }
  const changedHtml = await startSemanticFailure(29);
  await withMutatedFailedState(changedHtml.runId, work => { work.composer.blocks.find(block => block.id === "highlights").html += "<p>Changed input outside the reviewer's summary correction.</p>"; }, changed => failDeferredCorrection("changed peer HTML fingerprint", changedHtml, changed, 329));
  const changedEvidence = await startSemanticFailure(30);
  await withMutatedFailedState(changedEvidence.runId, work => { work.periodic.texts["source-block"] += " New synthetic evidence outside the reviewed input."; }, changed => failDeferredCorrection("changed source evidence fingerprint", changedEvidence, changed, 330));
  await runSlowR2AdmissionJourney();
}

async function runCorrectionInterruptionBoundaries() {
  const capped = await startHeldReviewerCorrection(24, 324), originalCappedSource = await rawRow(`filing-operator:${capped.source.runId}`);
  const cappedHttp = outbound.length - 1;
  for (let n = 0; n < 4; n++) check(`inherited-seven correction shares remaining review slot ${n + 1}`, (await request(`/fixture/review-request?id=${capped.runId}&lease=${capped.lease}`)).status === 200);
  const exhausted = await request(`/fixture/review-request?id=${capped.runId}&lease=${capped.lease}&retries=2`);
  check("correction cannot spend more than the five slots remaining from the original twelve", exhausted.status === 503 && (await opRow(capped.runId)).reviewCalls === 5 && (await opRow(capped.runId)).reviewCallsInherited === 7 && outbound.length - cappedHttp === 5, { newCalls: (await opRow(capped.runId)).reviewCalls, inherited: 7, httpSent: outbound.length - cappedHttp });
  transportRelease(); await capped.progress;
  const cappedRow = await opRow(capped.runId);
  check("correction with seven inherited plus five new requests fails before another semantic HTTP", cappedRow.status === "failed" && !cappedRow.validatedKey && cappedRow.reviewCallsInherited + cappedRow.reviewCalls === 12 && outbound.length - cappedHttp === 5 && JSON.stringify(await rawRow(`filing-operator:${capped.source.runId}`)) === JSON.stringify(originalCappedSource), { status: cappedRow.status, total: cappedRow.reviewCallsInherited + cappedRow.reviewCalls, phase: cappedRow.phase.name });

  const crashed = await startHeldReviewerCorrection(25, 325), crashHttp = outbound.length;
  await request(`/fixture/evict?id=${crashed.runId}&kind=FILING_OPERATOR_COMPLETION_WORKFLOW`).catch(() => null);
  transportRelease(); await crashed.progress;
  await request(`/fixture/advance?id=${crashed.runId}&kind=FILING_OPERATOR_COMPLETION_WORKFLOW`);
  const crashedRow = await opRow(crashed.runId);
  check("reviewer-correction cold restart leaves unknown without replaying the billed changed-block review", crashedRow.status === "unknown" && !crashedRow.validatedKey && crashedRow.reviewCallsInherited === 7 && crashedRow.reviewCalls === 1 && outbound.length === crashHttp, { status: crashedRow.status, inherited: crashedRow.reviewCallsInherited, newCalls: crashedRow.reviewCalls });

  const expired = await startHeldReviewerCorrection(26, 326), expiredHttp = outbound.length;
  await db.prepare("UPDATE sec_cache SET payload=json_set(payload,'$.phase.expiresAt',0) WHERE cache_key=?").bind(`filing-operator:${expired.runId}`).run();
  transportRelease(); await expired.progress;
  const expiredRow = await opRow(expired.runId);
  check("late reviewer-correction success after expired lease cannot pass the completion fence", expiredRow.status === "unknown" && !expiredRow.validatedKey && !expiredRow.stages["content:summary"] && outbound.length === expiredHttp, { status: expiredRow.status, phase: expiredRow.phase.name });

  const stopped = await startHeldReviewerCorrection(27, 327), stoppedHttp = outbound.length;
  const stop = await request(reportPath(stopped.runId) + "/stop", { method: "POST", headers: { authorization: "Bearer " + token } });
  transportRelease(); await stopped.progress;
  const stoppedRow = await opRow(stopped.runId);
  check("explicit stop fences an in-flight reviewer correction and preserves inherited budget", stop.status === 200 && stop.body.status === "stopped" && stoppedRow.status === "failed" && !stoppedRow.validatedKey && stoppedRow.reviewCallsInherited === 7 && stoppedRow.reviewCalls === 1 && outbound.length === stoppedHttp);
}
async function preparationIdentity(runId) {
  const raw = await rawRow(`filing-operator:${runId}`), row = JSON.parse(raw.payload);
  return { expectedRecordHash: sha(raw.payload), expectedPlanHash: row.planHash, expectedPreparationStateHash: row.stages.corrections?.afterStateRef?.hash ?? row.stateRef?.hash ?? "0".repeat(64), expectedPublicVersion: publicBaseline.version, expectedPublicHash: publicBaseline.hash };
}
async function rejectPreparation(name, runId, input, operation = 801, options = {}) {
  const before = outbound.length, answer = await sendPreparationRecovery(runId, operation, input, options);
  check(name, [400, 409, 413].includes(answer.status) && outbound.length === before, { status: answer.status, error: answer.body.error, providerHttp: outbound.length - before });
  return answer;
}
async function holdPreparation(n, correctionNumber) {
  const source = await startSemanticFailure(n), runId = `shadow-${ticker}-${accession}-operator-fix-${uuid(correctionNumber)}`, owner = `FILING_OPERATOR_COMPLETION_WORKFLOW:${runId}`;
  let arrived, timer;
  const seen = new Promise((resolve, reject) => { arrived = resolve; timer = setTimeout(() => reject(Error("Actual preparation did not reach the held R2 material read")), 15000); });
  const hold = { runId, owner, arrived, released: false }; recoveryHolds.set(owner, hold);
  const admitted = await sendCorrection(source.runId, correctionNumber, source.input);
  check(`preparation ${correctionNumber} starts through the real correction endpoint`, admitted.status === 202 && admitted.body.runId === runId, admitted);
  const progress = drive(runId).then(value => ({ value }), error => ({ error: String(error) }));
  const read = await seen; clearTimeout(timer);
  const row = await opRow(runId);
  check(`preparation ${correctionNumber} completes corrections and holds a real R2 read before any billing`, read.found && row.phase.name === "prepare" && row.phase.status === "started" && row.stages.corrections.status === "done" && row.reviewCalls === 0 && row.reviewCallsInherited === 7, { phase: row.phase.name, status: row.phase.status, calls: row.reviewCalls, inherited: row.reviewCallsInherited, readKey: read.key });
  return { runId, owner, source, hold, progress };
}
async function waitNativePreparationTimeout(target) {
  await target.progress;
  let row, status;
  for (let n = 0; n < 200; n++) {
    row = await opRow(target.runId); status = await request(`/fixture/run-status?id=${target.runId}&kind=FILING_OPERATOR_COMPLETION_WORKFLOW`);
    if (row.status === "unknown" && ["errored", "terminated"].includes(status.body.status)) break;
    await pause(25);
  }
  const runner = (await request(runnerPath(target.runId))).body;
  check("native RunStep timeout produces the exact unbilled unknown record and a genuinely errored old runner", row.status === "unknown" && row.phase.name === "prepare" && row.phase.status === "unknown" && row.phase.expiresAt === 0 && row.error === "step operator:prepare timed out after 660s" && row.reviewCalls === 0 && row.reviewCallsInherited === 7 && status.body.status === "errored" && runner.steps.some(step => step.name === "operator:corrections" && JSON.parse(step.record).done) && runner.timers.some(timer => timer.requested === 660000 && timer.effective === 1000), { error: row.error, status: row.status, runnerStatus: status.body.status, timers: runner.timers, waitedRealElevenMinutes: false });
  return { row, runner, status: status.body.status, input: await preparationIdentity(target.runId) };
}
async function runRecoveredPreparationCase(n, correctionNumber, operation, { capped = false } = {}) {
  const target = await holdPreparation(n, correctionNumber), earlyInput = await preparationIdentity(target.runId);
  await rejectPreparation("active preparation cannot be recovered or duplicated", target.runId, earlyInput, operation);
  const ended = await waitNativePreparationTimeout(target), sourceLedger = await rawRow(`filing-operator:${target.source.runId}`), originalRaw = await rawRow(`filing-operator:${target.runId}`), originalFailure = await (await bucket.get(`research-shadow/${target.runId}/failed.json`)).text();
  const implementation = await db.prepare("SELECT * FROM fixture_execution_implementations WHERE execution_id=?").bind(target.runId).first();
  check("old timeout executes the requested actual production implementation", implementation.implementation === (correctionNumber === 432 ? "82a0" : "current") && (correctionNumber !== 432 || implementation.source_sha === sha(legacyOperator.source)), implementation);
  if (!capped) {
    const path = reportPath(target.runId) + "/recover-preparation";
    check("preparation recovery requires admin authentication", (await request(path, { method: "POST", body: "{}" })).status === 401);
    check("preparation recovery proxy enforces same origin", (await sendPreparationRecovery(target.runId, operation, ended.input, { proxy: true, headers: { origin: "https://other.invalid" } })).status === 403);
    check("preparation recovery proxy is POST only", (await request(path.replace("/admin/", "/api/admin/"))).status === 404);
    check("preparation recovery requires a UUID", (await sendPreparationRecovery(target.runId, operation, ended.input, { headers: { "idempotency-key": "invalid" } })).status === 400);
    for (const field of ["expectedRecordHash", "expectedPlanHash", "expectedPreparationStateHash", "expectedPublicHash"]) await rejectPreparation(`preparation recovery binds exact ${field}`, target.runId, { ...ended.input, [field]: "f".repeat(64) }, operation);
    await rejectPreparation("preparation recovery binds exact public version", target.runId, { ...ended.input, expectedPublicVersion: 5 }, operation);
    for (const field of ["html", "plan", "state", "executionId", "maxCalls"]) await rejectPreparation(`preparation recovery rejects client ${field}`, target.runId, { ...ended.input, [field]: "Untrusted input" }, operation);
    await rejectPreparation("preparation recovery identity is bounded to eight KiB", target.runId, { ...ended.input, padding: "x".repeat(9000) }, operation);
  }
  let paidArrived, timer;
  const paid = new Promise((resolve, reject) => { paidArrived = resolve; timer = setTimeout(() => reject(Error("Recovered execution did not reach its one changed-block review")), 20000); });
  transportMode = "hold-content"; transportHeld = paidArrived;
  const beforeRecoveryHttp = outbound.length, shadowRowsBefore = (await db.prepare("SELECT COUNT(*) n FROM sec_cache WHERE cache_key LIKE 'research-shadow:%' AND cache_key NOT LIKE '%:resume'").first()).n;
  const admitted = await Promise.all([sendPreparationRecovery(target.runId, operation, ended.input, { proxy: true }), sendPreparationRecovery(target.runId, operation, ended.input, { proxy: true })]);
  const executionId = `${target.runId}-preparation-recovery`;
  check("explicit recovery claims once with the same operation and a new execution id", admitted.every(answer => answer.status === 202 && answer.body.runId === target.runId && answer.body.executionId === executionId) && admitted.filter(answer => answer.body.replay).length === 1, admitted);
  const progress = drive(target.runId, { executionId, limit: 400 }).then(value => ({ value }), error => ({ error: String(error) }));
  await paid; clearTimeout(timer); transportHeld = undefined; transportMode = "pass";
  const active = await opRow(target.runId), activeRaw = await rawRow(`filing-operator:${target.runId}`), newRunner = (await request(runnerPath(executionId))).body;
  check("recovery inherits completed corrections and the original seven without creating another shadow or author", active.executionId === executionId && active.reviewCalls === 1 && active.reviewCallsInherited === 7 && active.phase.name === "content:summary" && JSON.stringify(active.stages.corrections) === JSON.stringify(ended.row.stages.corrections) && JSON.parse(newRunner.run[0].params).runId === target.runId && newRunner.dispatches.length === 1 && newRunner.sessions.length === 0 && (await db.prepare("SELECT COUNT(*) n FROM sec_cache WHERE cache_key LIKE 'research-shadow:%' AND cache_key NOT LIKE '%:resume'").first()).n === shadowRowsBefore, { runId: target.runId, executionId, newCalls: active.reviewCalls, inherited: active.reviewCallsInherited, dispatches: newRunner.dispatches.length });
  check("recovery archives the exact timed-out record and original failure bytes", await (await bucket.get(active.preparationRecovery.recordRef.key)).text() === originalRaw.payload && await (await bucket.get(active.preparationRecovery.failureRef.key)).text() === originalFailure && active.preparationRecovery.stateRef.hash === ended.row.stages.corrections.afterStateRef.hash && active.planHash === ended.row.planHash);
  const stale = await request(`/fixture/stale-execution?id=${target.runId}&execution=${target.runId}`);
  check("current task rejects a stale execution bootstrap without entering any step or mutating the active row", stale.status === 409 && /execution/i.test(stale.body.error) && !/reached a task step/.test(stale.body.error) && JSON.stringify(await rawRow(`filing-operator:${target.runId}`)) === JSON.stringify(activeRaw), stale);
  const staleGate = await request(`/fixture/review-request?id=${target.runId}&lease=${active.phase.leaseToken}&execution=${target.runId}&retries=2`);
  check("old epoch cannot reserve or send even with the new active lease", staleGate.status === 503 && outbound.length === beforeRecoveryHttp + 1 && JSON.stringify(await rawRow(`filing-operator:${target.runId}`)) === JSON.stringify(activeRaw));
  const versionsBefore = (await db.prepare("SELECT * FROM analysis_artifact_versions ORDER BY version").all()).results, lateAt = Date.now();
  target.hold.released = true; target.hold.release();
  await pause(750);
  const lateWrites = recoveryStorageWrites.filter(write => write.owner === target.owner && write.at >= lateAt), afterLate = await rawRow(`filing-operator:${target.runId}`);
  check("actual late preparation callback reaches its state-write boundary without altering the new active row lease or common timeout receipt", target.hold.returnedAt >= lateAt && recoveryReadReturns.some(read=>read.owner===target.owner&&read.key===target.hold.read.key&&read.at>=lateAt) && lateWrites.length > 0 && JSON.stringify(afterLate) === JSON.stringify(activeRaw) && await (await bucket.get(`research-shadow/${target.runId}/failed.json`)).text() === originalFailure && JSON.stringify((await db.prepare("SELECT * FROM analysis_artifact_versions ORDER BY version").all()).results) === JSON.stringify(versionsBefore) && outbound.length === beforeRecoveryHttp + 1 && lateWrites.every(write => write.key.includes("/states/")), { implementation: implementation.implementation, returnedAt: target.hold.returnedAt, immutableUnreferencedStateWrites: lateWrites, activeExecutionId: active.executionId, activeLease: active.phase.leaseToken });
  const replayBefore = outbound.length, replay = await sendPreparationRecovery(target.runId, operation, ended.input);
  check("exact recovery replay never dispatches a second execution", replay.status === 202 && replay.body.replay && replay.body.dispatchRetried === false && (await request(runnerPath(executionId))).body.dispatches.length === 1 && outbound.length === replayBefore);
  await rejectPreparation("a different UUID cannot recover the same preparation again", target.runId, ended.input, operation + 1);
  await rejectPreparation("a changed identity cannot replace a recovery claim", target.runId, { ...ended.input, expectedRecordHash: "e".repeat(64) }, operation);
  if (capped) {
    for (let n = 0; n < 4; n++) await request(`/fixture/review-request?id=${target.runId}&lease=${active.phase.leaseToken}&execution=${executionId}`);
    const blocked = await request(`/fixture/review-request?id=${target.runId}&lease=${active.phase.leaseToken}&execution=${executionId}&retries=2`);
    check("recovered execution still shares twelve total requests with its inherited seven", blocked.status === 503 && (await opRow(target.runId)).reviewCalls === 5 && outbound.length === beforeRecoveryHttp + 5);
  }
  transportRelease(); await progress;
  const final = await drive(target.runId, { executionId, limit: 400 });
  if (capped) check("recovered preparation cannot reset a consumed twelve-request allowance", final.status === "failed" && final.reviewCalls === 5 && final.reviewCallsInherited === 7 && !final.validatedKey && outbound.length === beforeRecoveryHttp + 5, { status: final.status, total: final.reviewCalls + final.reviewCallsInherited });
  else {
    const sent = outbound.slice(beforeRecoveryHttp);
    check("legacy preparation recovery completes only three new reviews and retains seven inherited calls", final.status === "validated" && final.runId === target.runId && final.executionId === executionId && final.reviewCalls === 3 && final.reviewCallsInherited === 7 && sent.length === 3 && sent[0].stage === "content" && sent[0].block === "summary" && sent[1].stage === "semantic" && sent[2].stage === "visual", { status: final.status, newCalls: final.reviewCalls, inherited: final.reviewCallsInherited, stages: sent.map(row => ({ stage: row.stage, block: row.block })) });
    const preview = await request(reportPath(target.runId), { headers: { authorization: "Bearer " + token } });
    check("same recovered shadow is readable as validated and still requires independent human approval", preview.status === 200 && preview.body.status === "validated_shadow" && preview.body.previewToken && preview.body.callsReserved === 10 && !await jsonRow(`research-shadow:${target.runId}:review`));
    const self = await request(reportPath(target.runId) + "/promote", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ expectedHash: final.hash, reviewer: final.spec.operatorCompletion.author.runId, reviewNotes: "Forbidden self approval", approvedChainIds: ["chain-1"] }) });
    check("preparation recovery does not grant author self-approval or public promotion", self.status === 400);
  }
  const pointer = await db.prepare("SELECT published_version,published_hash FROM analysis_artifacts WHERE artifact_id=?").bind(`filing-report:${ticker}:${accession}`).first();
  check("recovery and late callbacks preserve original failed seven and public six", JSON.stringify(await rawRow(`filing-operator:${target.source.runId}`)) === JSON.stringify(sourceLedger) && pointer.published_version === 6 && pointer.published_hash === publicBaseline.hash);
  return { runId: target.runId, oldImplementation: implementation, oldRunnerStatus: ended.status, executionId, timerAcceleration: ended.runner.timers, originalCalls: 7, addedCalls: final.reviewCalls, status: final.status, lateUnreferencedStateWrites: lateWrites, oldCallbackReturnedAt: target.hold.returnedAt, publicPointer: pointer };
}
async function runPreparationRecoveryJourney() {
  const recovered = await runRecoveredPreparationCase(32, 432, 801);
  const paid = await startHeldReviewerCorrection(33, 433); await db.prepare("UPDATE sec_cache SET payload=json_set(payload,'$.phase.expiresAt',0) WHERE cache_key=?").bind(`filing-operator:${paid.runId}`).run(); transportRelease(); await paid.progress;
  const paidRow = await drive(paid.runId);
  check("paid unknown fixture reflects one real reserved provider HTTP", paidRow.status === "unknown" && paidRow.reviewCalls === 1);
  await rejectPreparation("paid or non-prepare unknown work cannot recover preparation", paid.runId, await preparationIdentity(paid.runId), 803);
  const bad = await startSemanticFailure(34), usage = await db.prepare("SELECT * FROM ai_usage WHERE run_id=? AND stage='artifact-review-highlights' AND outcome='ok' LIMIT 1").bind(bad.runId).first(); await db.prepare("UPDATE ai_usage SET model='incompatible-synthetic-model' WHERE id=?").bind(usage.id).run();
  const failed = await failDeferredCorrection("failed proof recovery fixture", bad, bad.input, 434); await rejectPreparation("a deterministic failed proof is not an unknown preparation timeout", failed.runId, await preparationIdentity(failed.runId), 804); await db.prepare("UPDATE ai_usage SET model=? WHERE id=?").bind(usage.model, usage.id).run();
  const stopped = await startHeldReviewerCorrection(35, 435); await request(reportPath(stopped.runId) + "/stop", { method: "POST", headers: { authorization: "Bearer " + token } }); transportRelease(); await stopped.progress; await drive(stopped.runId);
  await rejectPreparation("explicitly stopped work cannot recover preparation", stopped.runId, await preparationIdentity(stopped.runId), 805);
  const currentCapped = await runRecoveredPreparationCase(36, 436, 806, { capped: true });
  check("preparation recovery journey sends no production or external research requests", blockedOutbound.length === 0, blockedOutbound);
  return { recovered, currentCapped, historicalSource: { commit: legacyOperator.commit, sha256: sha(legacyOperator.source), sourcePath: "workers/analysis/src/filing-analysis/operator-completion.ts" }, timerSimulation: "Only local native setTimeout(660000) in the targeted old prepare invocation is accelerated to 1000ms; no passed receipts or terminal statuses are injected" };
}

async function runReviewerCorrectionJourney() {
  const runId = operationId(103), source = await opRow(runId), input = await reviewerCorrectionInput(runId);
  const originalLedger = await rawRow(`filing-operator:${runId}`);
  const originalState = await (await bucket.get(source.stateRef.key)).text();
  const originalPlan = await (await bucket.get(source.planKey)).text();
  const originalFailure = await (await bucket.get(`research-shadow/${runId}/failed.json`)).text();
  check("reviewer correction starts from the real failed seven-request semantic operation", source.status === "failed" && source.reviewCalls === 7 && source.phase.name === "semantic" && source.stages.semantic.receipt.issues.length === 1 && source.stages.semantic.receipt.issues[0].quote === reviewerQuote, { runId, calls: source.reviewCalls, issues: source.stages.semantic.receipt.issues });
  const path = reportPath(runId) + "/apply-reviewer-corrections";
  check("reviewer correction requires admin authentication", (await request(path, { method: "POST", body: "{}" })).status === 401);
  check("reviewer correction proxy requires same-origin mutation", (await sendCorrection(runId, 301, input, { proxy: true, headers: { origin: "https://other.invalid" } })).status === 403);
  check("reviewer correction proxy is POST only", (await request(path.replace("/admin/", "/api/admin/"))).status === 404);
  check("reviewer correction UUID is mandatory", (await sendCorrection(runId, 301, input, { headers: { "idempotency-key": "invalid" } })).status === 400);
  for (const key of ["html", "plan", "quote", "issues", "state", "blocks", "author", "maxCalls"]) await rejectReviewerCorrection(`reviewer correction rejects client ${key} before any provider request`, runId, { ...input, [key]: key === "html" ? "<p>Untrusted replacement</p>" : "Untrusted extra input" });
  await rejectReviewerCorrection("reviewer correction rejects bodies over eight KiB", runId, { ...input, padding: "x".repeat(9000) });
  for (const key of ["expectedPlanHash", "expectedFailedStateHash", "expectedSemanticReceiptHash", "expectedPublicHash"]) await rejectReviewerCorrection(`reviewer correction binds exact ${key}`, runId, { ...input, [key]: "f".repeat(64) });
  await rejectReviewerCorrection("reviewer correction binds exact public version", runId, { ...input, expectedPublicVersion: 5 });
  await rejectReviewerCorrection("content failure cannot be relabeled as a correctable semantic failure", operationId(102), input);
  const withoutQuote = await startSemanticFailure(23, "semantic-noquote");
  await rejectReviewerCorrection("semantic failure without a supported exact quote is not correctable", withoutQuote.runId, withoutQuote.input);

  await runDeferredProofFailures();
  check("all rejected correction attempts preserve the exact failed source ledger", JSON.stringify(await rawRow(`filing-operator:${runId}`)) === JSON.stringify(originalLedger));

  transportMode = "reviewer-correction-pass";
  const correctionHttpStart = outbound.length;
  const simultaneous = await Promise.all([sendCorrection(runId, 301, input, { proxy: true }), sendCorrection(runId, 301, input, { proxy: true })]);
  check("simultaneous exact reviewer corrections claim once with an exact replay", simultaneous.every(answer => answer.status === 202) && simultaneous.filter(answer => answer.body.replay).length === 1 && simultaneous.every(answer => answer.body.runId === `shadow-${ticker}-${accession}-operator-fix-${uuid(301)}`), simultaneous);
  const fixedId = simultaneous[0].body.runId, fixed = await drive(fixedId), newHttp = outbound.slice(correctionHttpStart);
  check("reviewer correction validates using exactly one new content one semantic and one visual HTTP", fixed.status === "validated" && fixed.reviewCallsInherited === 7 && fixed.reviewCalls === 3 && fixed.maxReviewCalls === 12 && newHttp.length === 3 && newHttp[0].stage === "content" && newHttp[0].block === "summary" && newHttp[1].stage === "semantic" && newHttp[2].stage === "visual", { status: fixed.status, inherited: fixed.reviewCallsInherited, newCalls: fixed.reviewCalls, http: newHttp.map(({ stage, block }) => ({ stage, block })) });
  const fixedGet = await request(reportPath(fixedId), { headers: { authorization: "Bearer " + token } });
  check("reviewer correction GET distinguishes three new requests and ten cumulative requests", fixedGet.status === 200 && fixedGet.body.status === "validated_shadow" && fixedGet.body.reviewCalls === 3 && fixedGet.body.reviewCallsInherited === 7 && fixedGet.body.callsReserved === 10, { status: fixedGet.status, callsReserved: fixedGet.body.callsReserved, newReviewCalls: fixedGet.body.reviewCalls, inherited: fixedGet.body.reviewCallsInherited });
  const saved = JSON.parse(await (await bucket.get(fixed.validatedKey)).text()), failedWork = JSON.parse(originalState);
  const fixedState = JSON.parse(await (await bucket.get(fixed.stateRef.key)).text());
  const summary = fixedState.composer.blocks.find(block => block.id === "summary");
  check("server applies only the semantic reviewer's stored plain-text replacement", summary.html.includes(reviewerReplacement) && !summary.html.includes(reviewerQuote) && fixed.correction.changedBlocks.join(",") === "summary" && fixed.planHash === source.planHash && JSON.stringify(fixedState.periodic.computed) === JSON.stringify(failedWork.periodic.computed));
  const reused = [];
  for (const id of blockIds.filter(id => id !== "summary")) {
    const receipt = fixed.stages[`content:${id}`]?.receipt, proof = receipt?.reusedFrom, previous = source.stages[`content:${id}`];
    const actualUsage = proof ? await db.prepare("SELECT id FROM ai_usage WHERE run_id=? AND stage=? AND model=? AND reasoning=? AND at=? AND outcome='ok'").bind(proof.usage.runId, proof.usage.stage, proof.usage.model, proof.usage.reasoning, proof.usage.at).first() : null;
    check(`unchanged ${id} is reused only with matching actual input block source and model-usage proofs`, receipt?.success && proof?.sourceRunId === runId && proof.sourcePhase === `content:${id}` && proof.beforeStateRef.hash === previous.beforeStateRef.hash && proof.receiptHash === sha(JSON.stringify(previous.receipt)) && receipt.inputHash === proof.inputHash && receipt.blockHash === proof.blockHash && /^[a-f0-9]{64}$/.test(proof.inputHash) && proof.usage.outcome === "ok" && Boolean(actualUsage) && !newHttp.some(row => row.stage === "content" && row.block === id) && fixedState.composer.blocks.find(block => block.id === id).html === failedWork.composer.blocks.find(block => block.id === id).html, { inputHash: proof?.inputHash, blockHash: proof?.blockHash, sourceRunId: proof?.sourceRunId, reconstruction: proof?.reconstruction, usageId: actualUsage?.id });
    reused.push({ block: id, ...proof });
  }
  check("corrected full semantic audit actually sees the revised summary and all original blocks", newHttp[1].input.report.length === 6 && newHttp[1].input.report.find(block => block.id === "summary").text.includes(reviewerReplacement));
  check("corrected strict rendering still covers every block at every required viewport", fixed.stages.render.receipt.visualReviewed && ["1440x900 light", "390x844 light", "1280x800 dark"].every(viewport => blockIds.every(id => fixed.stages.render.receipt.measured[viewport]?.includes(id) && fixed.stages.render.receipt.covered[viewport]?.includes(id))));
  check("corrected edition exposes exact original-plan and reviewer-correction provenance", saved.operator.reviewerCorrection.sourceOperatorRunId === runId && saved.operator.reviewerCorrection.semanticReceiptHash === input.expectedSemanticReceiptHash && saved.operator.reviewerCorrection.reviewCallsInherited === 7 && fixedGet.body.generation.planHash === source.planHash);
  const fixedRunner = (await request(runnerPath(fixedId))).body;
  check("reviewer correction creates one deterministic task without a new author session", fixedRunner.dispatches.length === 1 && fixedRunner.sessions.length === 0, fixedRunner.dispatches);
  const replayBefore = outbound.length, replay = await sendCorrection(runId, 301, input);
  check("exact correction replay performs zero extra model requests", replay.status === 202 && replay.body.replay && replay.body.dispatchRetried === false && outbound.length === replayBefore, replay.body);
  await rejectReviewerCorrection("different UUID cannot request a second correction", runId, input, { operation: 302 });
  await rejectReviewerCorrection("same UUID cannot replace the correction identity", runId, { ...input, expectedFailedStateHash: "e".repeat(64) });
  await rejectReviewerCorrection("corrected operator cannot recursively request another correction", fixedId, input, { operation: 303 });
  const authorApproval = await request(reportPath(fixedId) + "/promote", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ expectedHash: fixed.hash, reviewer: source.spec.operatorCompletion.author.runId, reviewNotes: "Forbidden correction author self-approval", approvedChainIds: ["chain-1"] }) });
  check("reviewer correction does not permit author self-approval or automatic publication", authorApproval.status === 400 && !await jsonRow(`research-shadow:${fixedId}:review`) && (await db.prepare("SELECT published_version FROM analysis_artifacts WHERE artifact_id=?").bind(`filing-report:${ticker}:${accession}`).first()).published_version === 6);
  check("successful correction preserves the old failed-seven ledger plan state and failure bytes", JSON.stringify(await rawRow(`filing-operator:${runId}`)) === JSON.stringify(originalLedger) && await (await bucket.get(source.stateRef.key)).text() === originalState && await (await bucket.get(source.planKey)).text() === originalPlan && await (await bucket.get(`research-shadow/${runId}/failed.json`)).text() === originalFailure);
  transportMode = "pass";
  await runCorrectionInterruptionBoundaries();
  return { runId: fixedId, row: fixed, originalRunId: runId, originalCalls: 7, addedCalls: 3, totalCalls: 10, reused };
}
async function withChangedFailedState(runId, change, work) {
  const original = await rawRow(`filing-operator:${runId}`), row = JSON.parse(original.payload);
  const state = JSON.parse(await (await bucket.get(row.stateRef.key)).text());
  change(state, row);
  const bytes = JSON.stringify(state), hash = sha(bytes), ref = { key: `filing-operator/${runId}/fixture-faults/${hash}.json`, hash };
  await bucket.put(ref.key, bytes);
  row.stateRef = ref; row.stages.semantic.afterStateRef = ref; row.phase.afterStateRef = ref;
  await db.prepare("UPDATE sec_cache SET payload=? WHERE cache_key=?").bind(JSON.stringify(row), original.cache_key).run();
  try { return await work(await reviewerCorrectionInput(runId)); }
  finally { await db.prepare("UPDATE sec_cache SET payload=?,fetched_at=? WHERE cache_key=?").bind(original.payload, original.fetched_at, original.cache_key).run(); }
}

async function contentCorrectionInput(runId) {
  const row = await opRow(runId);
  return { expectedPlanHash: row.planHash, expectedFailedStateHash: row.stateRef.hash, expectedContentBlockId: "summary", expectedContentReceiptHash: sha(JSON.stringify(row.stages["content:summary"].receipt)), expectedPublicVersion: publicBaseline.version, expectedPublicHash: publicBaseline.hash };
}
async function contentFailure(n) {
  transportMode = "content-correction-source";
  const admitted = await send(n, 100 + n, await planFor(n), { proxy: true }), row = await drive(admitted.body.runId);
  check(`content source ${n} has a completed actual one-request failure and no later audit`, admitted.status === 202 && row.status === "failed" && row.reviewCalls === 1 && row.phase.name === "content:summary" && row.stages["content:summary"].receipt.issues.filter(issue => issue.severity === "major").length === 1 && !row.stages.semantic && !row.stages.render, { status: row.status, reviewCalls: row.reviewCalls, phase: row.phase.name });
  transportMode = "pass";
  return { runId: admitted.body.runId, row, input: await contentCorrectionInput(admitted.body.runId) };
}
async function withContentLedger(source, edit, work) {
  const original = await rawRow(`filing-operator:${source.runId}`), row = JSON.parse(original.payload);
  edit(row); row.phase.receipt = clone(row.stages["content:summary"].receipt);
  await db.prepare("UPDATE sec_cache SET payload=? WHERE cache_key=?").bind(JSON.stringify(row), original.cache_key).run();
  try { return await work(await contentCorrectionInput(source.runId)); }
  finally { await db.prepare("UPDATE sec_cache SET payload=?,fetched_at=? WHERE cache_key=?").bind(original.payload, original.fetched_at, original.cache_key).run(); }
}
async function runContentCorrectionJourney() {
  const source = await contentFailure(10), original = await rawRow(`filing-operator:${source.runId}`), originalState = await (await bucket.get(source.row.stateRef.key)).text(), originalFailure = await (await bucket.get(`research-shadow/${source.runId}/failed.json`)).text();
  for (const key of ["expectedPlanHash", "expectedFailedStateHash", "expectedContentReceiptHash", "expectedPublicHash"]) await rejectReviewerCorrection(`content correction binds ${key}`, source.runId, { ...source.input, [key]: "f".repeat(64) }, { operation: 410 });
  await rejectReviewerCorrection("content correction binds its exact failed block", source.runId, { ...source.input, expectedContentBlockId: "risks" }, { operation: 410 });
  await rejectReviewerCorrection("content correction accepts no arbitrary HTML", source.runId, { ...source.input, html: "<p>Untrusted replacement</p>" }, { operation: 410 });
  await rejectReviewerCorrection("content failure cannot use the legacy semantic identity", source.runId, { ...source.input, expectedContentBlockId: undefined, expectedContentReceiptHash: undefined, expectedSemanticReceiptHash: source.input.expectedContentReceiptHash }, { operation: 410 });
  for (const [name, edit] of [
    ["multiple major issues", row => row.stages["content:summary"].receipt.issues.push(clone(row.stages["content:summary"].receipt.issues[0]))],
    ["markup reviewer replacement", row => { row.stages["content:summary"].receipt.issues[0].replacement = "<p>replacement</p>"; }],
    ["missing reviewer replacement", row => { delete row.stages["content:summary"].receipt.issues[0].replacement; }],
    ["deletion reviewer replacement", row => { row.stages["content:summary"].receipt.issues[0].replacement = "DELETE"; }],
    ["insufficient inherited budget", row => { row.reviewCalls = 5; }],
    ["unknown operation", row => { row.status = "unknown"; }],
    ["paused operation", row => { row.status = "paused"; }],
    ["unavailable rather than completed review", row => { row.stages["content:summary"].receipt.unavailable = "Synthetic unavailable"; }],
    ["missing actual request identity", row => { delete row.stages["content:summary"].receipt.inputHash; }],
  ]) await withContentLedger(source, edit, input => rejectReviewerCorrection(`content correction rejects ${name}`, source.runId, input, { operation: 410 }));
  await bucket.put(`research-shadow/${source.runId}/failed.json`, JSON.stringify({ status: "stopped" }));
  try { await rejectReviewerCorrection("stopped content operation cannot be corrected", source.runId, source.input, { operation: 410 }); } finally { await bucket.put(`research-shadow/${source.runId}/failed.json`, originalFailure); }
  const artifactId = `filing-report:${ticker}:${accession}`;
  await db.prepare("UPDATE analysis_artifacts SET published_version=5 WHERE artifact_id=?").bind(artifactId).run();
  try { await rejectReviewerCorrection("content correction requires current public CAS", source.runId, source.input, { operation: 410 }); } finally { await db.prepare("UPDATE analysis_artifacts SET published_version=6 WHERE artifact_id=?").bind(artifactId).run(); }
  const before = outbound.length, admission = await sendCorrection(source.runId, 410, source.input, { proxy: true });
  check("exact failed content is admitted by the existing real proxy", admission.status === 202 && admission.body.sourcePhase === "content:summary" && admission.body.contentReceiptHash === source.input.expectedContentReceiptHash, admission);
  const fixed = await drive(admission.body.runId), added = outbound.slice(before), work = JSON.parse(await (await bucket.get(fixed.stateRef.key)).text()), oldWork = JSON.parse(originalState), correctedWork = JSON.parse(await (await bucket.get(fixed.stages.corrections.afterStateRef.key)).text());
  check("content correction uses six fresh actual content audits followed by full semantic and visual", fixed.status === "validated" && added.length === 8 && added.filter(call => call.stage === "content").length === 6 && added[6].stage === "semantic" && added[7].stage === "visual" && fixed.reviewCalls === 8 && fixed.reviewCallsInherited === 1 && fixed.reviewCalls + fixed.reviewCallsInherited === 9, added.map(call => ({ stage: call.stage, block: call.block })));
  check("five unreviewed blocks receive no invented reuse receipts", fixed.stages.prepare.receipt.reusedContent.length === 0 && blockIds.every(id => fixed.stages[`content:${id}`].receipt.success && !fixed.stages[`content:${id}`].receipt.reusedFrom));
  check("correction changes only the one actual plain reviewer quote", correctedWork.composer.blocks.find(block => block.id === "summary").html === oldWork.composer.blocks.find(block => block.id === "summary").html.replace(reviewerQuote, reviewerReplacement) && blockIds.filter(id => id !== "summary").every(id => JSON.stringify(correctedWork.composer.blocks.find(block => block.id === id)) === JSON.stringify(oldWork.composer.blocks.find(block => block.id === id))) && JSON.stringify({ ...correctedWork, composer: null }) === JSON.stringify({ ...oldWork, composer: null }));
  check("old major and minor receipt stays immutable with its spent request", JSON.stringify(await rawRow(`filing-operator:${source.runId}`)) === JSON.stringify(original) && await (await bucket.get(source.row.stateRef.key)).text() === originalState && JSON.parse(original.payload).stages["content:summary"].receipt.issues.length === 4);
  check("correction does not repeat original tools or claim a new author plan", !fixed.stages.tools && fixed.planHash === source.row.planHash && fixed.spec.operatorCompletion.reviewerCorrection.sourcePhase === "content:summary" && fixed.spec.operatorCompletion.reviewerCorrection.contentReceiptHash === source.input.expectedContentReceiptHash && !fixed.spec.operatorCompletion.reviewerCorrection.semanticReceiptHash);
  const runner = (await request(runnerPath(fixed.runId))).body;
  check("content correction has one task and zero author sessions", runner.dispatches.length === 1 && runner.sessions.length === 0, runner.dispatches);
  const replayCalls = outbound.length, replay = await sendCorrection(source.runId, 410, source.input);
  check("content correction exact replay never redispatches or sends HTTP", replay.status === 202 && replay.body.replay && replay.body.dispatchRetried === false && outbound.length === replayCalls && (await request(runnerPath(fixed.runId))).body.dispatches.length === 1);
  await rejectReviewerCorrection("content correction rejects another UUID", source.runId, source.input, { operation: 411 });
  await rejectReviewerCorrection("content correction rejects recursive child corrections", fixed.runId, source.input, { operation: 412 });
  const self = await request(reportPath(fixed.runId) + "/promote", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ expectedHash: fixed.hash, reviewer: source.row.spec.operatorCompletion.author.runId, reviewNotes: "Synthetic forbidden self approval", approvedChainIds: ["chain-1"] }) });
  check("content correction cannot self-approve or change the public report", self.status === 400 && (await db.prepare("SELECT published_version FROM analysis_artifacts WHERE artifact_id=?").bind(artifactId).first()).published_version === 6);
  for (const [n, mode, expectedPhase] of [[11, "semantic-fail", "semantic"], [12, "visual-unavailable", "render"]]) {
    const failedSource = await contentFailure(n); transportMode = mode;
    const admitted = await sendCorrection(failedSource.runId, 400 + n, failedSource.input), rejected = await drive(admitted.body.runId);
    check(`content correction cannot skip failed full ${expectedPhase}`, admitted.status === 202 && rejected.status === "failed" && rejected.phase.name === expectedPhase && !rejected.validatedKey && (expectedPhase === "semantic" ? !rejected.stages.render : !rejected.stages.shadow));
  }
  const semantic = await startSemanticFailure(14), originalSemantic = await rawRow(`filing-operator:${semantic.runId}`), hashless = JSON.parse(originalSemantic.payload);
  delete hashless.stages["content:highlights"].receipt.inputHash;
  await db.prepare("UPDATE sec_cache SET payload=? WHERE cache_key=?").bind(JSON.stringify(hashless), originalSemantic.cache_key).run();
  try { await rejectReviewerCorrection("changed prompt cannot reuse a hashless original content receipt", semantic.runId, semantic.input, { operation: 414 }); }
  finally { await db.prepare("UPDATE sec_cache SET payload=?,fetched_at=? WHERE cache_key=?").bind(originalSemantic.payload, originalSemantic.fetched_at, originalSemantic.cache_key).run(); }
  const beforeSemantic = outbound.length, legacyAdmission = await sendCorrection(semantic.runId, 414, semantic.input), legacy = await drive(legacyAdmission.body.runId);
  check("legacy semantic correction still reuses only its actual matching successful request inputs", legacyAdmission.status === 202 && legacy.status === "validated" && legacy.reviewCalls === 3 && legacy.reviewCallsInherited === 7 && outbound.length - beforeSemantic === 3 && legacy.stages.prepare.receipt.reusedContent.length === 5 && legacy.spec.operatorCompletion.reviewerCorrection.semanticReceiptHash === semantic.input.expectedSemanticReceiptHash);
  check("all content correction scenarios preserve the public base", (await db.prepare("SELECT published_version FROM analysis_artifacts WHERE artifact_id=?").bind(artifactId).first()).published_version === 6 && blockedOutbound.length === 0);
  return { sourceRunId: source.runId, correctedRunId: fixed.runId, originalReviewCalls: 1, freshReviewCalls: 8, totalReviewCalls: 9, semanticCompatibility: { sourceRunId: semantic.runId, correctedRunId: legacy.runId, inherited: 7, fresh: 3 }, finalState: { digest: work.composer.operatorValidation.digest, renderPassed: fixed.stages.render.receipt.success } };
}
async function runContentCorrectionBudget() {
  const source = await contentFailure(15), old = await rawRow(`filing-operator:${source.runId}`), entered = new Promise(resolve => { transportHeld = resolve; });
  transportMode = "hold-content";
  const admission = await sendCorrection(source.runId, 415, source.input), progress = drive(admission.body.runId, { limit: 1000 });
  await Promise.race([entered, progress.then(() => { throw Error("Content budget fixture ended before the actual held provider request"); })]);
  const active = await opRow(admission.body.runId), before = outbound.length;
  for (let i = 0; i < 11; i++) {
    const answer = await request(`/fixture/review-request?id=${admission.body.runId}&lease=${active.phase.leaseToken}&retries=0`);
    check(`inherited-one budget request ${i + 1} observes the shared twelve-send cap`, i < 10 ? answer.status === 200 : answer.status === 503, { status: answer.status });
  }
  transportMode = "pass"; transportRelease();
  const failed = await progress;
  check("one inherited plus eleven actual new HTTP sends exhausts twelve without another content or later audit", admission.status === 202 && failed.status === "failed" && failed.reviewCalls === 11 && failed.reviewCallsInherited === 1 && outbound.length - before === 10 && !failed.stages.semantic && !failed.stages.render && !failed.validatedKey, { status: failed.status, own: failed.reviewCalls, inherited: failed.reviewCallsInherited });
  check("budget exhaustion preserves the original failed-one ledger", JSON.stringify(await rawRow(`filing-operator:${source.runId}`)) === JSON.stringify(old));
  const semantic = await startSemanticFailure(16), originalSemantic = await rawRow(`filing-operator:${semantic.runId}`), hashless = JSON.parse(originalSemantic.payload);
  delete hashless.stages["content:highlights"].receipt.inputHash;
  await db.prepare("UPDATE sec_cache SET payload=? WHERE cache_key=?").bind(JSON.stringify(hashless), originalSemantic.cache_key).run();
  try { await rejectReviewerCorrection("a hashless historical content input cannot be reused as the changed review prompt", semantic.runId, semantic.input, { operation: 416 }); }
  finally { await db.prepare("UPDATE sec_cache SET payload=?,fetched_at=? WHERE cache_key=?").bind(originalSemantic.payload, originalSemantic.fetched_at, originalSemantic.cache_key).run(); }
  return { sourceRunId: source.runId, correctedRunId: failed.runId, inherited: 1, added: 11, total: 12 };
}

try {
  chrome = spawn(process.env.CHROMIUM_PATH || "/usr/bin/chromium", ["--headless", "--no-sandbox", "--disable-dev-shm-usage", "--remote-debugging-port=0", `--user-data-dir=${resolve(scratch, "chrome")}`], { stdio: ["ignore", "ignore", "pipe"] });
  chromeEndpoint = await new Promise((resolve, reject) => { let stderr = ""; const timer = setTimeout(() => reject(Error("Local Chromium CDP startup timeout")), 20000); chrome.once("error", reject); chrome.stderr.on("data", bytes => { stderr += bytes; const found = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr); if (found) { clearTimeout(timer); resolve(found[1]); } }); });
  await build({ entryPoints: [workerPath], outfile: bundlePath, bundle: true, format: "esm", platform: "node", target: "es2022", conditions: ["workerd", "worker", "browser"], external: ["cloudflare:*", "node:*"], banner: { js: "import {createRequire as localCreateRequire} from 'node:module'; const require=localCreateRequire('/local-worker.mjs');" }, loader: { ".css": "text", ".txt": "text" }, plugins: [{ name: "local-axe-text", setup(bundle) { bundle.onLoad({ filter: /\/axe\.min\.js$/ }, async ({ path }) => ({ contents: await readFile(path, "utf8"), loader: "text" })); } }, ...(recoveryMode ? [historicalOperatorPlugin] : [])] });
  mf = new Miniflare(convertV4MiniflareOptions({ name: "filing-operator-acceptance", modules: true, modulesRoot: scratch, scriptPath: bundlePath, compatibilityDate: "2026-08-26", compatibilityFlags: ["nodejs_compat"], durableObjects: { TASK_RUNS: { className: "CompletionRunner", useSQLite: true } }, serviceBindings: { SPONTRA_ANALYSIS: { name: "filing-operator-acceptance", entrypoint: "AdminGateway" }, BROWSER: { external: { address: browserAddress } }, R2_READ_GATE: async incoming => {
      const read = await incoming.json();
      if (read.method === "put") recoveryStorageWrites.push({ ...read, at: Date.now() });
      if (read.method === "get-returned") recoveryReadReturns.push({ ...read, at: Date.now() });
      if (read.method === "get" && recoveryMode && recoveryHolds.has(read.owner) && read.key.endsWith("/index.json")) {
        const hold = recoveryHolds.get(read.owner), current = await opRow(hold.runId);
        if (!hold.released && current?.phase?.name === "prepare" && current.status === "running") {
          hold.enteredAt = Date.now(); hold.read = read; hold.arrived?.(read);
          await new Promise(resolve => { hold.release = resolve; }); hold.returnedAt = Date.now();
        }
      }
      if (slowR2Key && read.key === slowR2Key) { slowR2EnteredAt ??= Date.now(); slowR2EnteredResolve?.({ ...read, enteredAt: slowR2EnteredAt }); await new Promise(resolve => { slowR2Release = resolve; }); }
      return Response.json({ allowed: true });
    } }, d1Databases: { DB: "filing-operator-acceptance" }, r2Buckets: ["SEC_FILINGS"], bindings: { FIXTURE: JSON.stringify(fixture), REPORT_ADMIN_PASSWORD: "synthetic-local-only", DEEPSEEK_API_KEY: "synthetic-local-only", OPENAI_API_KEY: "synthetic-local-only", OPENAI_REVIEW_MODEL: "gpt-6.1-sol", BUSINESS_SITE_ORIGIN: pageOrigin }, outboundService: modelTransport }));
  request = async (path, options = {}) => { const response = await mf.dispatchFetch("http://localhost" + path, options), body = await response.text(); try { return { status: response.status, body: JSON.parse(body) }; } catch { return { status: response.status, body }; } };
  ({ DB: db, SEC_FILINGS: bucket } = await mf.getBindings());
  for (const file of ["0001_normal_doctor_strange.sql", "0002_flat_blockbuster.sql", "0003_neat_toro.sql", "0004_silky_may_parker.sql", "0005_fresh_bloodaxe.sql", "0019_pipeline_events.sql", "0049_analysis_artifacts.sql", "0023_ai_usage.sql", "0032_ai_tool_settings.sql", "0060_public_research.sql"]) for (const statement of (await readFile(resolve(root, "workers/analysis/migrations", file), "utf8")).replace(/--[^\n]*/g, "").split(";").map(value => value.trim()).filter(Boolean)) await db.prepare(statement).run();
  for (const statement of ["CREATE TABLE financial_company_settings(ticker TEXT PRIMARY KEY,enabled INTEGER)", "CREATE TABLE business_feature_settings(ticker TEXT,feature TEXT,generate INTEGER)", "ALTER TABLE ai_usage ADD COLUMN user_hash TEXT", "ALTER TABLE ai_usage ADD COLUMN conversation_id TEXT", "CREATE TABLE fixture_execution_implementations(execution_id TEXT PRIMARY KEY,implementation TEXT NOT NULL,source_sha TEXT)"]) await db.prepare(statement).run();
  await bucket.put(`${materialBase}/index.json`, JSON.stringify(snapshot)); await bucket.put(snapshot.markdown.key, markdown);
  for (const run of [...parents, ...runs]) {
    await db.prepare("INSERT INTO sec_cache VALUES(?,?,?)").bind(`research-shadow:${run.runId}`, JSON.stringify(run), at).run();
    await bucket.put(`research-shadow/${run.runId}/failed.json`, JSON.stringify({ status: "failed", reason: "Synthetic naturally exhausted original session", at }));
  }
  for (let i = 0; i < parents.length; i++) await db.prepare("INSERT INTO sec_cache VALUES(?,?,?)").bind(`research-shadow:${parents[i].runId}:resume`, JSON.stringify({ parentRunId: parents[i].runId, runId: runs[i].runId, requestId: uuid(i + 1), status: "dispatched" }), at).run();
  token = (await request("/fixture/auth")).body.token;
  publicBaseline = (await request("/fixture/public")).body;
  check("fixture has an immutable sixth public version", publicBaseline.version === 6 && /^[a-f0-9]{64}$/.test(publicBaseline.hash), publicBaseline);
  if (contentCorrectionMode) {
    const budgetOnly = process.env.SPONTRA_CONTENT_CORRECTION_BUDGET_ONLY === "1";
    const contentCorrection = budgetOnly ? await runContentCorrectionBudget() : await runContentCorrectionJourney(), resultFile = resolve(root, budgetOnly ? "docs/acceptance/discovery/results/filing-content-reviewer-correction-budget.json" : "docs/acceptance/discovery/results/filing-content-reviewer-correction.json");
    const results = { at: new Date().toISOString(), scope: "single-actual-content-reviewer-correction-with-shared-twelve-request-limit", environment: "Actual proxy, named AdminGateway, TaskRunner, source tools, composer stages and Chromium; provider transport only is synthetic", synthetic: { fixedMaterials: true, providerResponses: true, passedReceipts: false, userSignoff: false }, actualModelCalls: 0, productionAccess: false, contentCorrection, checks, transports: outbound.map(({ input, ...rest }) => rest), screenshots, scratch, notVerified: ["Real provider investment or visual quality", "Production correction or deployment", "Human approval"] };
    await writeFile(resultFile, JSON.stringify(results, null, 2) + "\n");
    console.log(JSON.stringify({ resultFile, checks: checks.length, syntheticProviderHttpCalls: outbound.length, screenshots: screenshots.length, actualModelCalls: 0 }));
  } else if (visualContractMode) {
    const visualContract = await runVisualContractJourney();
    const resultFile = resolve(root, "docs/acceptance/discovery/results/filing-visual-review-contract.json");
    const implementation = {};
    for (const name of ["qa.ts", "compose.ts"]) implementation[name] = sha(await readFile(resolve(root, "workers/analysis/src/artifact", name)));
    const results = { at: new Date().toISOString(), scope: "five-fixed-synthetic-visual-contract-responses-only", environment: "Actual local proxy, named AdminGateway and TaskRunner, actual composer stages and QA, actual Chromium and ArtifactFrame; provider transport only is synthetic", synthetic: { fixedMaterials: true, fixedReportHtml: true, providerResponses: true, passedReceipts: false, userSignoff: false }, actualModelCalls: 0, productionAccess: false, implementation, visualContract, checks, transports: outbound.map(({ input, ...rest }) => rest), screenshots, browserTelemetry, scratch, notVerified: ["Actual provider investment or image judgement quality", "Production report rerender, correction, recovery or publication", "Full production business-page shell", "Repeating historical 171, 47, 54 or 72 journeys"] };
    await writeFile(resultFile, JSON.stringify(results, null, 2) + "\n");
    console.log(JSON.stringify({ resultFile, checks: checks.length, fixedCases: visualContract.cases.length, syntheticProviderHttpCalls: outbound.length, actualModelCalls: 0, screenshots: screenshots.length, scratch }));
  } else if (recoveryMode) {
    const preparationRecovery = await runPreparationRecoveryJourney(), baselineFile = resolve(root, "docs/acceptance/discovery/results/filing-reviewer-correction-material-cache.json"), baselineBytes = await readFile(baselineFile, "utf8"), baseline = JSON.parse(baselineBytes);
    const resultFile = resolve(root, "docs/acceptance/discovery/results/filing-reviewer-preparation-recovery.json"), implementations = (await db.prepare("SELECT * FROM fixture_execution_implementations ORDER BY execution_id").all()).results;
    const results = { at: new Date().toISOString(), scope: "explicit-single-unbilled-preparation-recovery-with-actual-82a0-late-callback", environment: "Real handlers/proxy/named AdminGateway/TaskRunner/native RunStep/composer/current recovery implementation plus the complete historical 82a0 operator module", synthetic: { material: true, providerResponses: true, timerAcceleration: true, passedReceipts: false, finalRunnerStatus: false, userSignoff: false }, actualModelCalls: 0, productionAccess: false, preparationRecovery, implementations, checks, transports: outbound.map(({ input, ...rest }) => rest), screenshots, recoveryReadReturns, recoveryStorageWrites, scratch, baselineAcceptance: { file: basename(baselineFile), at: baseline.at, sha256: sha(baselineBytes), checks: baseline.checks.length }, notVerified: ["Real provider investment and visual judgement", "Production recovery or deployment", "Waiting an actual eleven-minute wall-clock timeout", "Repeating the historical full or cache journeys on this run"] };
    await writeFile(resultFile, JSON.stringify(results, null, 2) + "\n");
    console.log(JSON.stringify({ resultFile, scope: results.scope, checks: checks.length, syntheticProviderHttpCalls: outbound.length, actualModelCalls: 0, screenshots: screenshots.length }));
  } else if (process.env.SPONTRA_ASYNC_PROOF_ONLY === "1") {
    const cacheMode = process.env.SPONTRA_MATERIAL_RANGE_CACHE_ACCEPTANCE === "1";
    await runDeferredProofFailures();
    await runCorrectionInterruptionBoundaries();
    const finalPointer = await db.prepare("SELECT published_version,published_hash FROM analysis_artifacts WHERE artifact_id=?").bind(`filing-report:${ticker}:${accession}`).first();
    check("all asynchronous proof budget and interruption failures preserve the exact public version and hash", finalPointer.published_version === 6 && finalPointer.published_hash === publicBaseline.hash, finalPointer);
    check("narrow async proof journey contacts no production or other outbound endpoint", blockedOutbound.length === 0, blockedOutbound);
    let materialRangeCache;
    if (cacheMode) {
      const beforeHttp = outbound.length, beforeLedger = await rawRow(`filing-operator:${operationId(128)}`), read = await request(`/fixture/material-range-cache?id=${operationId(128)}`);
      check("cache read journey uses the actual operator content-input harness and pinned material search", read.status === 200 && read.body.firstReads > 0 && read.body.foundSourceIds.includes("source-block"), read);
      materialRangeCache = read.body;
      check("repeated contentInput in one harness reuses bytes without another R2 range get", materialRangeCache.secondReads === 0, materialRangeCache.secondReads);
      check("cached and fresh actual provider bodies and full input/block hashes are identical", materialRangeCache.bodyEqual && new Set(materialRangeCache.inputHashes).size === 1 && new Set(materialRangeCache.blockHashes).size === 1, { inputHashes: materialRangeCache.inputHashes, blockHashes: materialRangeCache.blockHashes });
      check("a fresh operator harness performs its own index and byte-range reads", materialRangeCache.freshReads > 0 && materialRangeCache.indexReads >= 2, { freshReads: materialRangeCache.freshReads, indexReads: materialRangeCache.indexReads });
      check("distinct prepared refs sharing an immutable object keep their range reads separate", materialRangeCache.crossReads === 2 && materialRangeCache.crossTextEqual, { crossReads: materialRangeCache.crossReads, textEqual: materialRangeCache.crossTextEqual });
      check("a missing material range is not retained as a successful cache result", /MATERIAL_MARKDOWN_MISSING/.test(materialRangeCache.firstFailure) && materialRangeCache.recoveryReads === 2 && materialRangeCache.recovered, { firstFailure: materialRangeCache.firstFailure, recoveryReads: materialRangeCache.recoveryReads });
      check("R2 bodies are consumed once while cache reads leave model requests and stored research unchanged", materialRangeCache.eachRangeObjectConsumedOnce && outbound.length === beforeHttp && JSON.stringify(await rawRow(`filing-operator:${operationId(128)}`)) === JSON.stringify(beforeLedger));
    }
    const resultFile = resolve(root, cacheMode ? "docs/acceptance/discovery/results/filing-reviewer-correction-material-cache.json" : "docs/acceptance/discovery/results/filing-reviewer-correction-async-admission.json");
    const baselineFile = resolve(root, cacheMode ? "docs/acceptance/discovery/results/filing-reviewer-correction-async-admission.json" : "docs/acceptance/discovery/results/filing-operator-completion.json");
    const previousBytes = await readFile(baselineFile, "utf8"), previous = JSON.parse(previousBytes);
    const results = { at: new Date().toISOString(), scope: cacheMode ? "prepared-material-range-cache-and-async-proof-budget-interruption" : "async-proof-admission-and-budget-interruption-only", environment: "Real proxy, named AdminGateway, named TaskRunner, actual tools and actual local R2 get with controlled latency", synthetic: { material: true, providerResponses: true, parentCheckpoints: true, userSignoff: false }, actualModelCalls: 0, productionAccess: false, slowR2Admission: slowR2Evidence, ...(materialRangeCache ? { materialRangeCache } : {}), checks, transports: outbound.map(({ input, ...rest }) => rest), screenshots: [], scratch, baselineAcceptance: { file: basename(baselineFile), at: previous.at, sha256: sha(previousBytes), checks: previous.checks.length }, notVerified: ["Real provider investment/visual judgement", "Production request/deployment", "Full wide journey repeated on this run"] };
    await writeFile(resultFile, JSON.stringify(results, null, 2) + "\n");
    console.log(JSON.stringify({ resultFile, scope: results.scope, checks: checks.length, syntheticProviderHttpCalls: outbound.length, actualModelCalls: 0, slowR2Admission: slowR2Evidence }));
  } else {
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
  const reviewerCorrection = await runReviewerCorrectionJourney();
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
  const results = { at: new Date().toISOString(), environment: "Isolated local Miniflare D1/R2/SQLite TaskRunner, actual ArtifactFrame and actual Chromium through the real qa.ts CDP protocol", synthetic: { material: true, providerResponses: true, browserProtocol: false, parentCheckpoints: true, userSignoff: false }, actualModelCalls: 0, productionAccess: false, slowR2Admission: slowR2Evidence, reviewerCorrection: { runId: reviewerCorrection.runId, originalRunId: reviewerCorrection.originalRunId, originalCalls: reviewerCorrection.originalCalls, addedCalls: reviewerCorrection.addedCalls, totalCalls: reviewerCorrection.totalCalls, reused: reviewerCorrection.reused }, scratch, screenshots, checks, transports: outbound.map(({ input, ...rest }) => rest), browserTelemetry, notVerified: ["Real author generation quality", "Real independent model semantic and visual judgement quality", "Production deployment", "Real human investment review and production promotion", "Full production React business-page shell; local shell renders the actual ArtifactFrame component"] };
  const resultFile = resolve(root, "docs/acceptance/discovery/results/filing-operator-completion.json");
  await mkdir(resolve(root, "docs/acceptance/discovery/results"), { recursive: true }); await writeFile(resultFile, JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify({ resultFile, checks: checks.length, syntheticProviderHttpCalls: outbound.length, actualModelCalls: 0, screenshots: screenshots.length, scratch }));
  }
} finally {
  transportRelease?.(); slowR2Release?.();
  for (const hold of recoveryHolds.values()) { hold.released = true; hold.release?.(); }
  if (mf) await mf.dispose();
  for (const socket of sockets) socket.terminate(); socketServer.close(); browserServer.closeAllConnections(); pageServer.closeAllConnections();
  await Promise.all([new Promise(resolve => browserServer.close(resolve)), new Promise(resolve => pageServer.close(resolve))]);
  if (chrome) { chrome.kill("SIGKILL"); await once(chrome, "exit").catch(() => undefined); }
}
