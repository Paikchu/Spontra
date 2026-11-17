/** Local producer → finish → immutable publication → real read-handler journey. No model or production access. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: "local:cloudflare-workers", shortCircuit: true };
  if (specifier.startsWith("@/")) specifier = `${root}/${specifier.slice(2)}`;
  try { return next(specifier, context); } catch (error) { if (error.code === "ERR_MODULE_NOT_FOUND" && !/\.[a-z]+$/.test(specifier)) return next(`${specifier}.ts`, context); throw error; }
}, load(url, context, next) {
  if (url === "local:cloudflare-workers") return { format: "module", source: "export class DurableObject {} export class WorkerEntrypoint {} export class WorkflowEntrypoint {}", shortCircuit: true };
  // Rendering is independently exercised by Chromium; this synthetic pass fixture closes the producer's rendering boundary.
  if (url.endsWith("/artifact/qa.ts")) return { format: "module", source: "export const visualPasses=()=>true; export const reviewRendering=async()=>({scores:null,issues:[],shots:[],covered:{},errors:[]});", shortCircuit: true };
  if (/\.(css|txt|html)(\?raw)?$/.test(url)) return { format: "module", source: `export default ${JSON.stringify(readFileSync(new URL(url), "utf8"))}`, shortCircuit: true };
  return next(url, context);
} });
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error("No network in local filing-impact acceptance"); };
const { filingLoader } = await import(`${root}/workers/analysis/src/filing-analysis/recipe.ts`);
const { periodicTools, PERIODIC_BLOCKS } = await import(`${root}/workers/analysis/src/filing-analysis/periodic.ts`);
const { filingSemanticInput, filingSemanticRequest, filingSemanticSchema, SEMANTIC_AUDIT_SYSTEM } = await import(`${root}/workers/analysis/src/filing-analysis/semantic-audit.ts`);
const { saveVersion, publishStatements, readArtifactVersion, readPublishedArtifact, readArtifactEdition, previewToken, readPreview } = await import(`${root}/workers/analysis/src/artifact/store.ts`);
const { saveFilingImpact, readFilingImpact } = await import(`${root}/workers/analysis/src/filing-analysis/impact-publication.ts`);
const { handleMapRead } = await import(`${root}/workers/analysis/src/read-api/router.ts`);
const { loadFilingDetail, handle } = await import(`${root}/apps/business-site/worker/index.ts`);
const { sha256 } = await import(`${root}/workers/analysis/src/sha256.ts`);
const sqlite = new DatabaseSync(":memory:");
for (const file of readdirSync(`${root}/workers/analysis/migrations`).filter(file => file.endsWith(".sql")).sort()) sqlite.exec(readFileSync(`${root}/workers/analysis/migrations/${file}`, "utf8"));
class Statement {
  constructor(query) { this.query = query; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() { return sqlite.prepare(this.query).get(...this.values) ?? null; }
  async all() { return { results: sqlite.prepare(this.query).all(...this.values) }; }
  async run() { const value = sqlite.prepare(this.query).run(...this.values); return { success: true, meta: { changes: Number(value.changes) } }; }
}
const db = { prepare: query => new Statement(query), batch: async statements => { sqlite.exec("BEGIN"); try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec("COMMIT"); return results; } catch (error) { sqlite.exec("ROLLBACK"); throw error; } } };
const bodies = new Map();
const env = { DB: db, SEC_FILINGS: { get: async (key, options) => bodies.has(key) ? { text: async () => bodies.get(key), arrayBuffer: async () => { const all = new TextEncoder().encode(bodies.get(key)); const bytes = options?.range ? all.slice(options.range.offset, options.range.offset + options.range.length) : all; return bytes.buffer; } } : null, put: async (key, value) => { bodies.set(key, value); } }, REPORT_ADMIN_PASSWORD: "synthetic-local-preview-key" };
const checks = [];
const check = (name, value) => { assert.ok(value, name); checks.push({ name, status: "pass" }); };
const ticker = "SYNTH", accession = "0000000001-26-000001", periodEnd = "2026-09-30";
const filing = { ticker, cik: "1", cikNumber: 1, companyName: "Synthetic", accessionNumber: accession, form: "10-Q", filingDate: "2026-11-12", reportDate: periodEnd, documentUrl: "https://example.invalid/synthetic", indexUrl: "https://example.invalid/index", primaryDocument: "synthetic.htm", description: "Synthetic", items: "" };
const facts = [[16400,"USDmillions"],[50,"bps"],[1,"years"]].map(([value, unit], i) => ({ factId: `f${String(i + 1).padStart(14,"0")}`, passageId: "source-block", ordinal: i, row: null, col: null, label: `Synthetic disclosed ${i}`, concept: null, dimensions: "", periodStart: null, periodEnd, periodMonths: 0, value, shown: String(value), unit, tagged: false }));
const snapshot = { format: "filing-material.index.v2", ref: { ticker, accession, version: "synthetic-impact-v1" }, filing: { ticker, accession, cik: "1", companyName: "Synthetic", form: "10-Q", filedAt: filing.filingDate, reportDate: periodEnd, documentUrl: filing.documentUrl }, documents: [], blocks: [{ id: "source-block", documentId: "synthetic-document", title: "Original synthetic evidence", path: [], kind: "paragraph", storage: "inline", text: "Synthetic static debt sensitivity. Principal 16400 USD millions, 50 basis points, one year. Debt-reset timing and hedge overlap remain unknown; this is not future net interest expense.", sourceUrl: filing.documentUrl }], tables: [], facts, toc: [], coverage: { duplicates: [] } };
snapshot.markdown = { key: "synthetic-markdown", bytes: snapshot.blocks[0].text.length, chars: snapshot.blocks[0].text.length };
snapshot.blocks[0].range = { anchorOffset: 0, offset: 0, length: snapshot.markdown.bytes };
bodies.set(snapshot.markdown.key, snapshot.blocks[0].text);
bodies.set(`sec-materials/v1/${ticker}/${accession}/${snapshot.ref.version}/index.json`, JSON.stringify(snapshot));
const spec = { ticker, filing, shadow: true, shadowModel: "gpt-6.1-sol", shadowEffort: "max", profile: "periodic", mode: "rewrite", material: snapshot.ref, sessionId: "synthetic-impact-publication", jobId: "synthetic-impact", jobVersion: "synthetic", requestedBy: "manual" };
const loaded = await filingLoader(spec, env);
const state = loaded.recipe.open(loaded.input);
const tools = loaded.recipe.tools(state);
const call = async (name, args) => { const tool = tools.find(tool => tool.name === name); return tool.execute(tool.parameters.parse(args), { state, signal: new AbortController().signal, recipe: loaded.recipe.id, stage: async (_name, work) => work() }); };
await call("read_filing_markdown", {});
const periodic = periodicTools({ env, ticker, filing, snapshot, runId: spec.sessionId });
for (const fact of facts) await periodic.resolve(fact.factId, state);
const calculated = await call("compute_investment_impact", { calculation: { kind: "interest", currency: "USD", debts: [{ principal: 16400000000, rateType: "floating", rateChange: 0.005, repricingYears: 1 }] }, inputs: ["principal","rateChange","repricingYears"].map((field, i) => ({ path: `debts.0.${field}`, sourceId: facts[i].factId, basis: "fact", rationale: "Synthetic source with disclosed units" })) });
assert.equal(calculated.error, false);
const result = JSON.parse(calculated.observation);
const chain = { id: "funding", priorAssumption: "Initial baseline", newEvidence: "Synthetic disclosed floating balance", revisedAssumption: "A static +50bp sensitivity requires hedge and reset reconciliation", financialEffect: "Static pre-tax sensitivity is 82000000 USD; future net cash interest is not established", valuationEffect: "No event share-price estimate without matched models, tax, shares and cash timing", quantificationStatus: "sensitivity_only", sourceIds: ["source-block"], computationRefs: [result.id], missingInputs: ["Hedge overlap and debt-reset dates", "Tax, economic shares and a per-share valuation model"], counterEvidence: "Hedges may offset part of exposure", verification: "Reconcile dated debt and hedge schedules", window: "Synthetic one-year static window" };
assert.equal((await call("record_investment_impact", chain)).error ?? false, false);
// Old resumed fact lacks unit; the publication must recover the printed unit from this exact frozen snapshot.
delete state.periodic.facts[facts[0].factId].unit;
state.composer.blocks = PERIODIC_BLOCKS.map(id => ({ id, title: id === "summary" ? "Synthetic funding sensitivity" : `Synthetic ${id}`, html: `<h2>Synthetic ${id}</h2><p>Local synthetic disclosure and uncertainty only.</p>`, sources: ["source-block"], state: "passed" }));
state.composer.researchContext = { asOf: "2026-11-17T00:00:00.000Z", mappingVersions: [], reports: [], uses: [], gaps: [] };
const audit = await filingSemanticInput({ env, snapshot, required: PERIODIC_BLOCKS }, state);
const evidenceHash = await sha256(JSON.stringify({ evidence: audit.evidence, aliases: audit.aliases }));
const policyHash = await sha256(`${SEMANTIC_AUDIT_SYSTEM}\n${JSON.stringify(filingSemanticSchema(audit))}`);
const requestHash = await sha256(JSON.stringify(await filingSemanticRequest(audit)));
const digest = await sha256(JSON.stringify({ model: null, policyHash, evidenceHash, requestHash }));
const answer = { verdict: "pass", complete: true, summary: "Synthetic cached independent-review fixture, not a financial opinion", issues: [], computations: audit.computations.map(computation => ({ id: computation.id, status: "holds", problem: "Synthetic static calculation with explicit units", sources: ["source-block"] })) };
bodies.set(`filing-semantic-audits/${ticker}/${accession}/${digest}.json`, JSON.stringify({ digest, answer }));
const finished = await call("finish", {});
check("actual filingLoader finish reaches validated shadow using complete cached semantic receipt", !finished.error && state.composer.phase === "published");
const validated = JSON.parse(bodies.get(`research-shadow/${spec.sessionId}/validated.json`));
const id = `filing-report:${ticker}:${accession}`;
const impact = await readFilingImpact(env, id, validated.version, validated.hash);
check("onShadow persisted exact immutable impact before validation receipt", !!impact && impact.artifact.hash === validated.hash && impact.validation.kind === "technical");
check("printed million unit recovered despite missing resumed fact metadata", impact.sources.find(source => source.id === facts[0].factId)?.unit === "USDmillions");
check("base calculation preserves 16.4bn dollars and 82m sensitivity", impact.calculations[result.id].provenance.calculation.debts[0].principal === 16400000000 && impact.calculations[result.id].values.pretaxInterestChange === 82000000);
check("per-share event result remains absent with specific gaps", impact.priceEffect.eventChange === null && impact.priceEffect.referenceQuote === null && impact.priceEffect.missingInputs.length === 3);
const replay = await saveFilingImpact(env, { spec, version: validated.version, hash: validated.hash, work: validated.work });
check("identical save replays stable result and generatedAt", replay.resultId === impact.resultId && replay.generatedAt === impact.generatedAt);
const changed = structuredClone(validated.work); changed.periodic.investmentChains[0].financialEffect = "Unreviewed different outcome";
await assert.rejects(saveFilingImpact(env, { spec, version: validated.version, hash: validated.hash, work: changed }), /different immutable/);
check("different work cannot overwrite the exact edition", (await readFilingImpact(env, id, validated.version, validated.hash)).resultId === impact.resultId);
const legacy = structuredClone(validated.work); delete legacy.periodic.impactComputations[result.id].provenance;
await assert.rejects(saveFilingImpact(env, { spec, version: validated.version, hash: validated.hash, work: legacy }), /Recompute/);
check("legacy impact without machine-checked units is not exported as quantified", (await readFilingImpact(env, id, validated.version, validated.hash)).resultId === impact.resultId);
const impactObjectKey = `filing-impacts/${ticker}/${accession}/v${validated.version}/${impact.resultId.slice("filing-impact:".length)}.json`;
const originalImpactBytes = bodies.get(impactObjectKey), tampered = JSON.parse(originalImpactBytes);
tampered.calculations[result.id].values.pretaxInterestChange = 82;
bodies.set(impactObjectKey, JSON.stringify(tampered));
check("read rejects tampered structured calculation bytes", await readFilingImpact(env, id, validated.version, validated.hash) === null);
bodies.set(impactObjectKey, originalImpactBytes);
check("draft is not exposed through published exact edition reader", await readArtifactEdition(env, id, validated.version) === null);
const token = await previewToken(env, "filing-report", ticker, accession, validated.version);
const preview = await readPreview(env, token);
check("signed preview reads same result and says preview", preview.filingImpact.resultId === impact.resultId && preview.filingImpactState === "preview");
check("forged and expired previews denied", await readPreview(env, `${token}a`) === null && await readPreview(env, token, Date.now() + 3600000) === null);
sqlite.prepare("UPDATE analysis_artifacts SET published_version=?,published_hash=?,published_at=? WHERE artifact_id=?").run(validated.version, validated.hash, impact.generatedAt, id);
sqlite.prepare("UPDATE analysis_artifact_versions SET status='published' WHERE artifact_id=? AND version=?").run(id, validated.version);
sqlite.prepare("INSERT INTO financial_company_settings(ticker,enabled,updated_at) VALUES(?,1,?)").run(ticker, impact.generatedAt);
for (const feature of ["filings","findings","tree","valuation"]) sqlite.prepare("INSERT INTO business_feature_settings(ticker,feature,generate,display,updated_at) VALUES(?,?,1,1,?)").run(ticker, feature, impact.generatedAt);
const { D1SecRepository } = await import(`${root}/workers/analysis/src/sec/d1.ts`);
await new D1SecRepository(db).upsertFilingIndex(filing);
const path = `/api/v1/companies/${ticker}/filings/${accession}`;
const exact = `?artifactVersion=${validated.version}&artifactHash=${validated.hash}`;
const read = async query => { const response = await handleMapRead(new Request(`https://local.invalid${path}${query}`), env); return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.json() }; };
const publicRead = await read(exact);
check("actual read handler serves exact published impact", publicRead.status === 200 && publicRead.body.artifact?.filingImpact?.resultId === impact.resultId);
check("quantitative dependency reads cannot be pinned by a cache", publicRead.headers["cache-control"] === "no-store");
sqlite.prepare("INSERT INTO public_research_dependencies(owner_id,owner_version,source_report_id,source_version,claim_id,ticker,status) VALUES(?,?,?,?,?,?,'review_required')").run("company", `${id}:v${validated.version}`, "synthetic-revoked-source", "old", "rate", ticker);
const staleRead = await read(exact);
check("real read preserves exact source result while marking dependent outputs for review", staleRead.body.artifact?.researchFreshness === "review_required" && staleRead.body.artifact.filingImpact.resultId === impact.resultId);
sqlite.prepare("DELETE FROM public_research_dependencies WHERE owner_version=?").run(`${id}:v${validated.version}`);
check("wrong hash and incomplete identity reject without fallback", (await read(`?artifactVersion=${validated.version}&artifactHash=${"0".repeat(64)}`)).status === 404 && (await read(`?artifactVersion=${validated.version}`)).status === 404);
const old = await readArtifactVersion(env, id, validated.version);
const failedEnv = { ...env, DB: { ...db, batch: async statements => {
  if (statements.some(statement => statement.query.includes("UPDATE analysis_artifacts SET published_version"))) throw new Error("Injected atomic publication failure");
  return db.batch(statements);
} } };
const normal = await filingLoader({ ...spec, shadow: false, sessionId: "synthetic-normal-failed", jobId: "synthetic-normal-failed" }, failedEnv);
const normalState = structuredClone(state); normalState.composer.phase = "compose"; normalState.composer.published = null;
const normalFinish = normal.recipe.tools(normalState).find(tool => tool.name === "finish");
await assert.rejects(normalFinish.execute({}, { state: normalState, signal: new AbortController().signal, recipe: normal.recipe.id, stage: async (_name, work) => work() }), /Injected atomic publication failure/);
const orphan = sqlite.prepare("SELECT version,hash,status FROM analysis_artifact_versions WHERE artifact_id=? ORDER BY version DESC LIMIT 1").get(id);
check("actual normal finish failure leaves an unpublished draft and no publication proof", orphan.status === "draft" && !sqlite.prepare("SELECT 1 FROM analysis_artifact_checks WHERE artifact_id=? AND version=? AND stage='publication'").get(id, orphan.version));
check("failed normal candidate is not exposed despite a known source hash", (await read(`?artifactVersion=${orphan.version}&artifactHash=${orphan.hash}`)).status === 404);
const sidecarFailEnv = { ...env, SEC_FILINGS: { ...env.SEC_FILINGS, put: async (key, value) => {
  if (key.startsWith("filing-impacts/")) throw new Error("Injected onPublish sidecar failure");
  return env.SEC_FILINGS.put(key, value);
} } };
const sidecarFail = await filingLoader({ ...spec, shadow: false, sessionId: "synthetic-sidecar-failed", jobId: "synthetic-sidecar-failed" }, sidecarFailEnv);
const sidecarFailState = structuredClone(state); sidecarFailState.composer.phase = "compose"; sidecarFailState.composer.published = null;
await assert.rejects(sidecarFail.recipe.tools(sidecarFailState).find(tool => tool.name === "finish").execute({}, { state: sidecarFailState, signal: new AbortController().signal, recipe: sidecarFail.recipe.id, stage: async (_name, work) => work() }), /Injected onPublish sidecar failure/);
const sidecarOrphan = sqlite.prepare("SELECT version,hash,status FROM analysis_artifact_versions WHERE artifact_id=? ORDER BY version DESC LIMIT 1").get(id);
check("onPublish sidecar failure leaves no public version or proof", sidecarOrphan.status === "draft" && (await read(`?artifactVersion=${sidecarOrphan.version}&artifactHash=${sidecarOrphan.hash}`)).status === 404 && !sqlite.prepare("SELECT 1 FROM analysis_artifact_checks WHERE artifact_id=? AND version=? AND stage='publication'").get(id, sidecarOrphan.version));
const translated = structuredClone(old); translated.document.lang = "zh-CN"; translated.html = translated.html.replaceAll("Local synthetic disclosure and uncertainty only.", "仅限本地合成披露与不确定性。"); translated.hash = await sha256(`${translated.html}\n${translated.css}`);
bodies.set("local-translation", JSON.stringify(translated));
sqlite.prepare("INSERT INTO analysis_artifact_translations(artifact_id,source_version,source_hash,locale,translator_version,status,completed,total,r2_key,hash,updated_at) VALUES(?,?,?,'zh-CN','fixture','ready',1,1,?,?,?)").run(id, validated.version, validated.hash, "local-translation", translated.hash, impact.generatedAt);
const zh = await readArtifactEdition(env, id, validated.version, "zh-CN");
check("translation displays its own HTML hash but retains canonical same result", zh.hash !== validated.hash && zh.sourceHash === validated.hash && zh.filingImpact.resultId === impact.resultId);
const later = await saveVersion(env, { ...old.document, title: "Later unrelated edition", blocks: old.document.blocks.map(block => ({ ...block, html: block.html + "<p>Later evidence.</p>" })) }, old.css, "published", "local-later");
check("saveVersion publication intent alone never marks a row public", sqlite.prepare("SELECT status FROM analysis_artifact_versions WHERE artifact_id=? AND version=?").get(id, later.version).status === "draft");
await db.batch(publishStatements(env, "filing-report", ticker, accession, later.version, later.hash, [], impact.generatedAt));
check("superseded exact history retains old result after current changes", (await read(exact)).body.artifact?.filingImpact?.resultId === impact.resultId);
check("legacy current receives committed exact proof when replaced", !!sqlite.prepare("SELECT 1 FROM analysis_artifact_checks WHERE artifact_id=? AND version=? AND stage='publication' AND json_extract(result,'$.hash')=?").get(id, validated.version, validated.hash));
check("later success does not turn a failed candidate into readable history", (await read(`?artifactVersion=${orphan.version}&artifactHash=${orphan.hash}`)).status === 404);
check("later publication does not expose the onPublish-failed orphan", (await read(`?artifactVersion=${sidecarOrphan.version}&artifactHash=${sidecarOrphan.hash}`)).status === 404);
// Old pre-fix orphan rows may already say superseded. Only a server-owned private snapshot keeps that compatibility.
sqlite.prepare("UPDATE analysis_artifact_versions SET status='superseded' WHERE artifact_id=? AND version=?").run(id, orphan.version);
check("unknown legacy superseded row denied publicly, private snapshot reader remains compatible", (await read(`?artifactVersion=${orphan.version}&artifactHash=${orphan.hash}`)).status === 404 && !!await readArtifactEdition(env, id, orphan.version));
check("current edition without sidecar never borrows old bridge", (await readPublishedArtifact(env, "filing-report", ticker, accession)).filingImpact === null);
const drafts = await saveVersion(env, { ...old.document, blocks: old.document.blocks.map(block => ({ ...block, html: block.html + "<p>Unpublished candidate.</p>" })) }, old.css, "draft", "local-private");
check("public handler denies exact draft even with known hash", (await read(`?artifactVersion=${drafts.version}&artifactHash=${drafts.hash}`)).status === 404);
const fetcher = async input => handleMapRead(new Request(String(input)), env);
const bff = await loadFilingDetail(ticker, accession, null, fetcher, null, { artifactVersion: String(validated.version), artifactHash: validated.hash });
check("actual business BFF preserves exact result", bff.artifact.filingImpact.resultId === impact.resultId);
const bffResponse = await handle(new Request(`https://local.invalid/api/business/v1/companies/${ticker}/filings/${accession}${exact}`), { PUBLIC_READ_LIMIT: { limit: async () => ({ success: true }) } }, { waitUntil() {} }, fetcher, null);
check("business handler exact edition is no-store", bffResponse.status === 200 && bffResponse.headers.get("cache-control").includes("no-store"));
const otherFiling = { ...filing, accessionNumber: "0000000001-26-000002", filingDate: "2026-11-13", documentUrl: "https://example.invalid/second" };
await new D1SecRepository(db).upsertFilingIndex(otherFiling);
const other = await saveVersion(env, { ...old.document, subject: otherFiling.accessionNumber, title: "Synthetic second filing", blocks: [{ id: "summary", title: "Synthetic second filing", html: "<h2>Synthetic second filing</h2><p>Different accession selected in the sidebar.</p>", sources: [], state: "passed" }] }, old.css, "published", "local-second");
await db.batch(publishStatements(env, "filing-report", ticker, otherFiling.accessionNumber, other.version, other.hash, [], impact.generatedAt));
const artifact = publicRead.body.artifact;
writeFileSync("/tmp/spontra-filing-impact-fixture.json", JSON.stringify({ artifact, translated: zh, preview, token, detail: publicRead.body, result: impact, selection: { accession, version: String(validated.version), hash: validated.hash }, otherFiling: { accession: otherFiling.accessionNumber, title: "Synthetic second filing", version: other.version, hash: other.hash }, stale: staleRead.body.artifact }, null, 2));
check("no network or model operation was attempted", networkCalls === 0);
writeFileSync("/tmp/spontra-filing-impact-publication-journey.json", JSON.stringify({ at: new Date().toISOString(), scope: "Synthetic local SQLite/object-store and real producer/read handlers; cached synthetic semantic verdict and render boundary fixture, not a real independent model review", modelCalls: 0, networkCalls, productionWrites: 0, checks }, null, 2));
console.log(JSON.stringify({ checks: checks.length, evidence: "/tmp/spontra-filing-impact-publication-journey.json", fixture: "/tmp/spontra-filing-impact-fixture.json" }));
if (process.argv.includes("--serve")) {
  const { createServer } = await import("node:http");
  createServer(async (request, response) => {
    try {
      const result = await handle(new Request(`http://127.0.0.1:8796${request.url}`), { PUBLIC_READ_LIMIT: { limit: async () => ({ success: true }) } }, { waitUntil() {} }, fetcher, null);
      response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(await result.text());
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  }).listen(8796, "127.0.0.1", () => console.log("Local real read handlers listening on 8796"));
}
