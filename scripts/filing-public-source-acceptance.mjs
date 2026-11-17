/** Actual local tools → HTML/chain → independent-audit input → finish/sidecar journey. Synthetic cached verdict; zero model/network calls. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: "local:cloudflare-workers", shortCircuit: true };
  try { return next(specifier, context); } catch (error) { if (error.code === "ERR_MODULE_NOT_FOUND" && specifier.startsWith(".") && !/\.[a-z]+$/.test(specifier)) return next(`${specifier}.ts`, context); throw error; }
}, load(url, context, next) {
  if (url === "local:cloudflare-workers") return { format: "module", source: "export class DurableObject {} export class WorkerEntrypoint {} export class WorkflowEntrypoint {}", shortCircuit: true };
  if (url.endsWith("/artifact/qa.ts")) return { format: "module", source: "export const VIEWPORTS=[]; export const visualPasses=()=>true; export const reviewRendering=async()=>({scores:null,issues:[],shots:[],covered:{},errors:[]});", shortCircuit: true };
  if (/\.(css|txt|html)(\?raw)?$/.test(url)) return { format: "module", source: `export default ${JSON.stringify(readFileSync(new URL(url), "utf8"))}`, shortCircuit: true };
  return next(url, context);
} });
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error("Network forbidden in local public-source acceptance"); };
const { filingLoader } = await import(`${root}/workers/analysis/src/filing-analysis/recipe.ts`);
const { PERIODIC_BLOCKS } = await import(`${root}/workers/analysis/src/filing-analysis/periodic.ts`);
const { filingSemanticInput, filingSemanticRequest, filingSemanticSchema, SEMANTIC_AUDIT_SYSTEM } = await import(`${root}/workers/analysis/src/filing-analysis/semantic-audit.ts`);
const { frozenPublicResearchSource } = await import(`${root}/workers/analysis/src/company-research/context-tools.ts`);
const { saveFilingImpact, readFilingImpact } = await import(`${root}/workers/analysis/src/filing-analysis/impact-publication.ts`);
const { sha256 } = await import(`${root}/workers/analysis/src/sha256.ts`);
const sqlite = new DatabaseSync(":memory:");
for (const file of readdirSync(`${root}/workers/analysis/migrations`).filter(file => file.endsWith(".sql")).sort()) sqlite.exec(readFileSync(`${root}/workers/analysis/migrations/${file}`, "utf8"));
class Statement {
  constructor(query) { this.query = query; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() { return sqlite.prepare(this.query).get(...this.values) ?? null; }
  async all() { return { results: sqlite.prepare(this.query).all(...this.values) }; }
  async run() { const result = sqlite.prepare(this.query).run(...this.values); return { success: true, meta: { changes: Number(result.changes) } }; }
}
const db = { prepare: query => new Statement(query), batch: async statements => { sqlite.exec("BEGIN"); try { const out = []; for (const statement of statements) out.push(await statement.run()); sqlite.exec("COMMIT"); return out; } catch (error) { sqlite.exec("ROLLBACK"); throw error; } } };
const bodies = new Map(), reads = [];
const env = { DB: db, REPORT_ADMIN_PASSWORD: "local-synthetic-source-preview", SEC_FILINGS: {
  async get(key, options) {
    reads.push(key); if (!bodies.has(key)) return null;
    return { text: async () => bodies.get(key), arrayBuffer: async () => { const all = new TextEncoder().encode(bodies.get(key)); return (options?.range ? all.slice(options.range.offset, options.range.offset + options.range.length) : all).buffer; } };
  }, async put(key, value) { bodies.set(key, value); },
} };
const checks = [], check = (name, value) => { assert.ok(value, name); checks.push({ name, status: "pass" }); };
const ticker = "SYNTH", accession = "0000000001-26-000001";
const filing = { ticker, cik: "1", cikNumber: 1, companyName: "Synthetic", accessionNumber: accession, form: "10-Q", filingDate: "2026-11-12", reportDate: "2026-09-30", documentUrl: "https://example.invalid/company", indexUrl: "https://example.invalid/index", primaryDocument: "synthetic.htm", description: "Synthetic", items: "" };
const companyText = "Synthetic company disclosure: floating debt reprices under its contract; existing fixed coupons remain fixed.";
const snapshot = { format: "filing-material.index.v2", ref: { ticker, accession, version: "local-public-source-v1" }, filing: { ticker, accession, cik: "1", companyName: "Synthetic", form: "10-Q", filedAt: filing.filingDate, reportDate: filing.reportDate, documentUrl: filing.documentUrl }, documents: [], blocks: [{ id: "company-evidence", documentId: "synthetic-company", title: "Company contract", path: ["Debt"], kind: "paragraph", storage: "inline", text: companyText, sourceUrl: filing.documentUrl, range: { anchorOffset: 0, offset: 0, length: companyText.length } }], facts: [], tables: [], toc: [], coverage: { duplicates: [] }, markdown: { key: "local-company-markdown", bytes: companyText.length, chars: companyText.length } };
bodies.set(snapshot.markdown.key, companyText); bodies.set(`sec-materials/v1/${ticker}/${accession}/${snapshot.ref.version}/index.json`, JSON.stringify(snapshot));
const claim = { id: "rate-reset", kind: "fact", title: "Synthetic repricing channel", statement: "Synthetic public fact: interest exposure depends on contractual repricing.", sourceIds: ["source-rate"], observationIds: ["rate"], premiseClaimIds: [], assumptions: [], impactChannels: ["contract reset -> cash interest"], counterEvidence: ["Existing fixed coupons do not reset."], verification: "Inspect company debt-reset terms.", shockId: "rate-reset", financialVariable: "interest" };
const excerpt = "Frozen version-one synthetic source: contract rate is 5 percent.";
const source = { id: "source-rate", canonicalId: "synthetic-official-rate", uri: "https://example.invalid/frozen-rate-v1", title: "Frozen official rate source", locator: "Synthetic paragraph 1", excerpt, contentHash: await sha256(excerpt), publishedAt: "2026-11-15T00:00:00Z", availableAt: "2026-11-15T00:00:00Z", collectedAt: "2026-11-15T01:00:00Z", observationPeriod: { start: "2026-11-15", end: "2026-11-15" }, revision: "1", usage: "public", authorization: "Synthetic local fixture only" };
const report = { schemaVersion: "public-research.v1", reportId: "synthetic-macro", version: "frozen-macro-v1", type: "macro", title: "Synthetic macro baseline", scope: { regions: ["US"], currency: "USD", industryId: null, description: "Synthetic funding context" }, asOf: "2026-11-15T02:00:00Z", publishedAt: "2026-11-15T03:00:00Z", freshnessStatus: "valid", claims: [claim], claimStates: { "rate-reset": "valid" }, sources: [source], observations: [{ id: "rate", sourceId: source.id, label: "Synthetic rate", status: "observed", value: 5, unit: "percent", currency: null, period: { start: "2026-11-15", end: "2026-11-15" }, definition: "Synthetic fixture", basis: "actual", missingReason: null }] };
const industry = { ...report, reportId: "synthetic-industry", version: "frozen-industry-v1", type: "industry", title: "Synthetic industry funding", scope: { ...report.scope, industryId: "synthetic-cloud" } };
const context = { ticker, asOf: "2026-11-17T00:00:00Z", frozenAt: "2026-11-17T00:00:00Z", mappingVersions: [], reports: [report, industry].map(report => ({ report, exposures: [], applicability: "requires_company_review" })), gaps: [] };
const spec = { ticker, filing, shadow: true, profile: "periodic", mode: "rewrite", publicResearch: context, material: snapshot.ref, sessionId: "synthetic-public-source", jobId: "synthetic-public-source", jobVersion: "synthetic", requestedBy: "manual" };
const loaded = await filingLoader(spec, env), state = loaded.recipe.open(loaded.input);
const tools = loaded.recipe.tools(state);
const call = async (name, args) => { const tool = tools.find(tool => tool.name === name); return tool.execute(tool.parameters.parse(args), { state, signal: new AbortController().signal, recipe: loaded.recipe.id, stage: async (_name, run) => run() }); };
await call("read_filing_markdown", {}); await call("read_public_research", {});
for (const report of [context.reports[0].report, context.reports[1].report]) {
  assert.equal((await call("read_public_research", { reportId: report.reportId, claimId: claim.id })).error ?? false, false);
  assert.equal((await call("record_public_research_use", { reportId: report.reportId, version: report.version, claimId: claim.id, decision: "adopted", reason: "The disclosed floating company contract requires reset evidence; fixed coupons remain fixed.", companySources: ["company-evidence"], financialVariable: report.type === "macro" ? "cash-interest" : "funding-gap" })).error ?? false, false);
}
check("actual read/record tools register both frozen public sources without copying texts into state", !!state.composer.sources.public1c1 && !!state.composer.sources.public2c1 && !state.web.public1c1 && !state.periodic.texts.public1c1);
const chain = { id: "funding", priorAssumption: "Initial baseline", newEvidence: "Frozen public evidence and the company floating contract", revisedAssumption: "Check contractual reset terms", financialEffect: "Direction only, no amount established", valuationEffect: "No price change without tax, shares and matched models", quantificationStatus: "not_quantifiable", sourceIds: ["company-evidence", "public1c1", "public2c1"], computationRefs: [], missingInputs: ["Contractual reset dates, taxes, economic shares and a valuation model"], counterEvidence: "Existing fixed coupons do not reset", verification: "Reconcile company reset terms", window: "Next contractual reset" };
assert.equal((await call("record_investment_impact", chain)).error ?? false, false);
state.composer.blocks = PERIODIC_BLOCKS.map(id => ({ id, title: `Synthetic ${id}`, html: `<h2>Synthetic ${id}</h2><p>Company contract terms determine exposure.${id === "summary" ? '<cite data-source="public1c1">Frozen macro evidence</cite>' : id === "highlights" ? '<cite data-source="public2c1">Frozen industry evidence</cite>' : ""}</p>`, sources: ["company-evidence"], state: "passed" }));
const deps = { env, snapshot, required: PERIODIC_BLOCKS, publicResearch: context };
const audit = await filingSemanticInput(deps, state), request = await filingSemanticRequest(audit);
for (const [id, version] of [["public1c1", "frozen-macro-v1"], ["public2c1", "frozen-industry-v1"]]) {
  const supplied = JSON.parse(request.sources.find(source => source.id === id).text);
  check(`${id} HTML and chain carry exact frozen claim, original source and observation`, supplied.version === version && supplied.sources[0].uri === source.uri && supplied.observations[0].value === 5 && request.investmentChains[0].sourceIds.includes(id));
}
const blockSource = structuredClone(state); blockSource.composer.blocks[0].sources.push("public1c1");
check("block.sources citation uses the same frozen bytes", (await filingSemanticInput(deps, blockSource)).sources.find(source => source.id === "public1c1").text === frozenPublicResearchSource(context, "public1c1").text);
const restored = JSON.parse(JSON.stringify(state));
check("JSON state and frozen spec restore keeps identical semantic sources", JSON.stringify((await filingSemanticInput({ ...deps, publicResearch: JSON.parse(JSON.stringify(context)) }, restored)).sources) === JSON.stringify(audit.sources));
state.web.public1c1 = JSON.stringify({ version: "forged-live-v99", observation: 99 }); state.periodic.texts.public2c1 = state.web.public1c1;
check("same-name cached or later text cannot replace frozen public evidence", JSON.stringify((await filingSemanticInput(deps, state)).sources) === JSON.stringify(audit.sources));
for (const variant of ["missing-frozen-context", "unknown-source", "unknown-claim", "wrong-version", "wrong-url-version", "reordered-ordinal"]) {
  const candidate = structuredClone(state), activeDeps = { ...deps, publicResearch: structuredClone(context) };
  if (variant === "missing-frozen-context") delete activeDeps.publicResearch;
  if (variant === "unknown-source") { candidate.composer.blocks[0].sources.push("public99c1"); candidate.web.public99c1 = "forged cached source"; }
  if (variant === "unknown-claim") { candidate.composer.blocks[0].sources.push("public1c99"); candidate.periodic.texts.public1c99 = "forged cached claim"; }
  if (variant === "wrong-version") candidate.composer.researchContext.reports[0].version = "unreviewed-v99";
  if (variant === "wrong-url-version") candidate.composer.sources.public1c1.url = "https://example.invalid/research/synthetic-macro?version=unreviewed-v99#claim-rate-reset";
  if (variant === "reordered-ordinal") activeDeps.publicResearch.reports.reverse();
  await assert.rejects(filingSemanticInput(activeDeps, candidate), /frozen research ordinal and version/);
  checks.push({ name: `${variant} fails closed despite cached text`, status: "pass" });
}
const finalAudit = await filingSemanticInput(deps, state);
const evidenceHash = await sha256(JSON.stringify({ evidence: finalAudit.evidence, aliases: finalAudit.aliases }));
const policyHash = await sha256(`${SEMANTIC_AUDIT_SYSTEM}\n${JSON.stringify(filingSemanticSchema(finalAudit))}`), requestHash = await sha256(JSON.stringify(await filingSemanticRequest(finalAudit)));
const digest = await sha256(JSON.stringify({ model: null, policyHash, evidenceHash, requestHash }));
bodies.set(`filing-semantic-audits/${ticker}/${accession}/${digest}.json`, JSON.stringify({ digest, answer: { verdict: "pass", complete: true, summary: "Complete synthetic cached verdict, not real financial review", issues: [], computations: [] } }));
const finished = await call("finish", {});
check("actual finish consumes the complete frozen public evidence without a model call", !finished.error && state.composer.phase === "published");
const validated = JSON.parse(bodies.get(`research-shadow/${spec.sessionId}/validated.json`));
const id = `filing-report:${ticker}:${accession}`, impact = await readFilingImpact(env, id, validated.version, validated.hash);
for (const publicId of ["public1c1", "public2c1"]) check(`${publicId} sidecar stores exactly the independent audit's frozen source bytes`, impact.sources.find(source => source.id === publicId).text === finalAudit.sources.find(source => source.id === publicId).text);
const wrongSpec = structuredClone(spec); wrongSpec.publicResearch.reports[0].report.version = "later-live-v99";
await assert.rejects(saveFilingImpact(env, { spec: wrongSpec, version: validated.version, hash: validated.hash, work: validated.work }), /frozen research ordinal and version/);
check("wrong spec version cannot alter a saved sidecar", (await readFilingImpact(env, id, validated.version, validated.hash)).resultId === impact.resultId);
const unknownWork = structuredClone(validated.work); unknownWork.periodic.investmentChains[0].sourceIds.push("public99c1"); unknownWork.web.public99c1 = "forged cached source";
await assert.rejects(saveFilingImpact(env, { spec, version: validated.version, hash: validated.hash, work: unknownWork }), /frozen research ordinal and version/);
check("unknown public source cannot be published from cached text", (await readFilingImpact(env, id, validated.version, validated.hash)).resultId === impact.resultId);
check("only material/artifact/sidecar paths were read, never live public reports", reads.every(key => !key.startsWith("public-research/")) && networkCalls === 0);
const result = { at: new Date().toISOString(), scope: "Actual local filing tools, HTML/chain semantic request, finish and immutable sidecar; synthetic sources and cached semantic/render verdicts, no real financial approval", modelCalls: 0, networkCalls, productionWrites: 0, checks };
writeFileSync("/tmp/spontra-filing-public-source-journey.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify({ checks: checks.length, evidence: "/tmp/spontra-filing-public-source-journey.json" }));
