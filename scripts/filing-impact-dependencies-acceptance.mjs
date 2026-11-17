/** Real local filing producer -> nested typed compute -> finish -> immutable sidecar. No model or production access. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: "local:cloudflare-workers", shortCircuit: true };
  if (specifier.startsWith("@/")) specifier = `${root}/${specifier.slice(2)}`;
  try { return next(specifier, context); } catch (error) { if (error.code === "ERR_MODULE_NOT_FOUND" && !/\.[a-z]+$/.test(specifier)) return next(`${specifier}.ts`, context); throw error; }
}, load(url, context, next) {
  if (url === "local:cloudflare-workers") return { format: "module", source: "export class DurableObject {} export class WorkerEntrypoint {} export class WorkflowEntrypoint {}", shortCircuit: true };
  // This journey exercises the producer and data publication; rendering has its own browser journey.
  if (url.endsWith("/artifact/qa.ts")) return { format: "module", source: "export const VIEWPORTS=['desktop','mobile']; export const visualPasses=()=>true; export const reviewRendering=async()=>({scores:null,issues:[],shots:[],covered:{},errors:[]});", shortCircuit: true };
  if (/\.(css|txt|html)(\?raw)?$/.test(url)) return { format: "module", source: `export default ${JSON.stringify(readFileSync(new URL(url), "utf8"))}`, shortCircuit: true };
  return next(url, context);
} });
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error("No network in local filing-impact dependency acceptance"); };
const { filingLoader } = await import(`${root}/workers/analysis/src/filing-analysis/recipe.ts`);
const { periodicTools, PERIODIC_BLOCKS } = await import(`${root}/workers/analysis/src/filing-analysis/periodic.ts`);
const { filingSemanticInput, filingSemanticRequest, filingSemanticSchema, SEMANTIC_AUDIT_SYSTEM } = await import(`${root}/workers/analysis/src/filing-analysis/semantic-audit.ts`);
const { readFilingImpact, saveFilingImpact } = await import(`${root}/workers/analysis/src/filing-analysis/impact-publication.ts`);
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
const env = { DB: db, SEC_FILINGS: { get: async (key, options) => bodies.has(key) ? { text: async () => bodies.get(key), arrayBuffer: async () => { const all = new TextEncoder().encode(bodies.get(key)); return (options?.range ? all.slice(options.range.offset, options.range.offset + options.range.length) : all).buffer; } } : null, put: async (key, value) => { bodies.set(key, value); } } };
env.REPORT_ADMIN_PASSWORD = "synthetic-local-dependency-preview-key";
const checks = [], check = (name, passed, detail) => { assert.ok(passed, `${name}${detail ? `: ${JSON.stringify(detail)}` : ""}`); checks.push({ name, status: "pass", ...(detail ? { detail } : {}) }); };
const ticker = "SYNTH", accession = "0000000001-26-000003", periodEnd = "2026-09-30";
const filing = { ticker, cik: "1", cikNumber: 1, companyName: "Synthetic", accessionNumber: accession, form: "10-Q", filingDate: "2026-11-12", reportDate: periodEnd, documentUrl: "https://example.invalid/dependencies", indexUrl: "https://example.invalid/index", primaryDocument: "synthetic.htm", description: "Synthetic", items: "" };
const facts = [[3661, "USDmillions"], [82, "USD"], [50, "bps"], [1, "years"]].map(([value, unit], i) => ({ factId: `f${String(i + 1).padStart(14, "0")}`, passageId: "source-block", ordinal: i, row: null, col: null, label: `Synthetic typed source ${i}`, concept: null, dimensions: "", periodStart: null, periodEnd, periodMonths: 0, value, shown: String(value), unit, tagged: false }));
const snapshot = { format: "filing-material.index.v2", ref: { ticker, accession, version: "synthetic-impact-dependencies-v1" }, filing: { ticker, accession, cik: "1", companyName: "Synthetic", form: "10-Q", filedAt: filing.filingDate, reportDate: periodEnd, documentUrl: filing.documentUrl }, documents: [], blocks: [{ id: "source-block", documentId: "synthetic-document", title: "Synthetic original units", path: [], kind: "paragraph", storage: "inline", text: "SYNTHETIC acceptance data only: revenue 3661 USD millions, abandoned result input 82 USD, 50 bps and one year. Assumed fractions are illustrative, not a forecast.", sourceUrl: filing.documentUrl }], tables: [], facts, toc: [], coverage: { duplicates: [] } };
snapshot.markdown = { key: "synthetic-dependency-markdown", bytes: snapshot.blocks[0].text.length, chars: snapshot.blocks[0].text.length };
snapshot.blocks[0].range = { anchorOffset: 0, offset: 0, length: snapshot.markdown.bytes };
bodies.set(snapshot.markdown.key, snapshot.blocks[0].text);
bodies.set(`sec-materials/v1/${ticker}/${accession}/${snapshot.ref.version}/index.json`, JSON.stringify(snapshot));
const spec = { ticker, filing, shadow: true, shadowModel: "gpt-6.1-sol", shadowEffort: "max", profile: "periodic", mode: "rewrite", material: snapshot.ref, sessionId: "synthetic-impact-dependencies", jobId: "synthetic-impact-dependencies", jobVersion: "synthetic", requestedBy: "manual" };
const loaded = await filingLoader(spec, env), state = loaded.recipe.open(loaded.input);
const call = async (name, args, active = state) => { const tool = loaded.recipe.tools(active).find(tool => tool.name === name); return tool.execute(tool.parameters.parse(args), { state: active, signal: new AbortController().signal, recipe: loaded.recipe.id, stage: async (_name, work) => work() }); };
await call("read_filing_markdown", {});
const periodic = periodicTools({ env, ticker, filing, snapshot, runId: spec.sessionId });
for (const fact of facts) await periodic.resolve(fact.factId, state);
const compute = async (formula, unit) => { const reply = await call("compute", { formula, unit, label: `Synthetic ${formula}` }); assert.ok(!reply.error, reply.observation); return JSON.parse(reply.observation); };
const first = await compute(`${facts[0].factId} * 0.24`, "USDmillions");
const second = await compute(`${first.id} * 0.5`, "USD");
const final = await compute(`${second.id} / 2`, "USD");
const unused = await compute(`${facts[1].factId} * 1`, "USD");
const unusedImpactReply = await call("compute_investment_impact", { calculation: { kind: "interest", currency: "USD", debts: [{ principal: 3661000000, rateType: "floating", rateChange: 0.005, repricingYears: 1 }] }, inputs: ["principal", "rateChange", "repricingYears"].map((field, i) => ({ path: `debts.0.${field}`, sourceId: facts[[0, 2, 3][i]].factId, basis: "fact", rationale: "Synthetic abandoned sensitivity" })) });
assert.ok(!unusedImpactReply.error, unusedImpactReply.observation);
const unusedImpact = JSON.parse(unusedImpactReply.observation);
delete state.periodic.impactComputations[unusedImpact.id].provenance;
const chain = { id: "synthetic-generic-bridge", priorAssumption: "Synthetic initial baseline", newEvidence: "Source unit is 3661 USD millions", revisedAssumption: "Illustrative fractions only; no forecast", financialEffect: "Nested arithmetic produces 219660000 USD", valuationEffect: "No matched valuation or event price model", quantificationStatus: "sensitivity_only", sourceIds: ["source-block"], computationRefs: [final.id], missingInputs: ["An economic transmission model, tax, shares and matched before/after valuation"], counterEvidence: "Illustrative fractions have no economic evidence", verification: "Replace assumptions with dated original evidence", window: "Synthetic Q3 static illustration" };
assert.ok(!(await call("record_investment_impact", chain)).error);
state.composer.blocks = PERIODIC_BLOCKS.map(id => ({ id, title: `Synthetic ${id}`, html: `<h2>Synthetic ${id}</h2><p>Local synthetic dependency evidence.</p>`, sources: ["source-block"], state: "passed" }));
state.composer.researchContext = { asOf: "2026-11-17T00:00:00.000Z", mappingVersions: [], reports: [], uses: [], gaps: [] };
const restored = JSON.parse(JSON.stringify(state));
const audit = await filingSemanticInput({ env, snapshot, required: PERIODIC_BLOCKS }, restored);
check("actual producer computes nested mixed-scale dependency in base dollars", first.value === 878.64 && second.value === 439320000 && final.value === 219660000);
check("semantic request includes all reachable computations and original typed fact after JSON restore", [first.id, second.id, final.id].every(id => audit.computations.some(computation => computation.id === id)) && audit.facts.some(fact => fact.factId === facts[0].factId && fact.unit === "USDmillions"));
check("semantic request excludes abandoned arithmetic and old no-contract impact", !audit.computations.some(computation => [unused.id, unusedImpact.id].includes(computation.id)));
for (const [name, change, expected] of [
  ["missing nested dependency", active => { delete active.periodic.computed[first.id]; }, /no typed original source/],
  ["tampered nested value", active => { active.periodic.computed[first.id].value = 82; }, /differs from typed source replay/],
  ["cyclic nested dependency", active => { active.periodic.computed[first.id].formula = `${final.id} * 4`; active.periodic.computed[first.id].inputs = { [final.id]: final.value }; }, /cyclic calculation dependency/],
]) {
  const broken = structuredClone(restored); change(broken);
  const reply = await call("finish", {}, broken);
  check(`actual finish rejects ${name} before semantic or sidecar publication`, reply.error && expected.test(reply.observation) && !bodies.has(`research-shadow/${spec.sessionId}/validated.json`), reply.observation);
}
const evidenceHash = await sha256(JSON.stringify({ evidence: audit.evidence, aliases: audit.aliases }));
const policyHash = await sha256(`${SEMANTIC_AUDIT_SYSTEM}\n${JSON.stringify(filingSemanticSchema(audit))}`);
const requestHash = await sha256(JSON.stringify(await filingSemanticRequest(audit)));
const digest = await sha256(JSON.stringify({ model: null, policyHash, evidenceHash, requestHash }));
const answer = { verdict: "pass", complete: true, summary: "Synthetic cached semantic pass for a local producer journey; not financial or human approval", issues: [], computations: audit.computations.map(computation => ({ id: computation.id, status: "holds", problem: "Synthetic nested arithmetic with explicit original units", sources: ["source-block"] })) };
bodies.set(`filing-semantic-audits/${ticker}/${accession}/${digest}.json`, JSON.stringify({ digest, answer }));
const finished = await call("finish", {}, restored);
check("actual loader finish creates validated shadow using cached synthetic complete receipt", !finished.error && restored.composer.phase === "published", finished.observation);
const validated = JSON.parse(bodies.get(`research-shadow/${spec.sessionId}/validated.json`)), id = `filing-report:${ticker}:${accession}`;
const impact = await readFilingImpact(env, id, validated.version, validated.hash);
check("sidecar exports every transitive generic computation", [first.id, second.id, final.id].every(id => !!impact?.arithmetic[id]), { expected: [first.id, second.id, final.id], actual: Object.keys(impact?.arithmetic ?? {}) });
check("sidecar includes original source value units period and URL", impact.sources.some(source => source.id === facts[0].factId && source.value === 3661 && source.unit === "USDmillions" && source.periodEnd === periodEnd && source.url === filing.documentUrl));
check("sidecar raw input and base-normalized intermediate receipt remain restorable", impact.arithmetic[first.id].provenance.rawInputs[facts[0].factId].unit === "USDmillions" && impact.arithmetic[first.id].provenance.effectiveInputs[facts[0].factId].value === 3661000000 && impact.arithmetic[second.id].provenance.rawInputs[first.id].value === 878.64 && impact.arithmetic[second.id].inputs[first.id] === 878640000);
check("unreachable arithmetic impact and their unrelated facts are not exported", !impact.arithmetic[unused.id] && !impact.calculations[unusedImpact.id] && !impact.sources.some(source => [unused.id, unusedImpact.id, facts[1].factId, facts[2].factId, facts[3].factId].includes(source.id)));
check("shadow retains abandoned history without endorsing it", !!validated.work.periodic.computed[unused.id] && !!validated.work.periodic.impactComputations[unusedImpact.id] && !validated.work.periodic.impactComputations[unusedImpact.id].provenance);
const replay = await saveFilingImpact(env, { spec, version: validated.version, hash: validated.hash, work: JSON.parse(JSON.stringify(validated.work)) });
check("JSON-restored exact work replays byte-stable immutable sidecar", replay.resultId === impact.resultId && replay.inputFingerprint === impact.inputFingerprint);
check("nested financial arithmetic does not invent event price or a target", impact.priceEffect.eventChange === null && impact.priceEffect.referenceQuote === null && impact.priceEffect.modelVersion === null);
check("no network model or production operations", networkCalls === 0);
const output = resolve(process.argv[2] ?? "docs/acceptance/discovery/results/filing-impact-dependencies.json");
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify({ at: new Date().toISOString(), scope: "Actual local filingLoader/read/compute/record/finish/onShadow and immutable sidecar, synthetic typed material only; cached complete synthetic semantic verdict and render boundary fixture", modelCalls: 0, networkCalls, productionWrites: 0, checks, notCovered: ["No real model or human semantic/financial review", "No production report generation or publication", "No browser rendering; this journey checks the persisted data contract"] }, null, 2) + "\n");
console.log(JSON.stringify({ checks: checks.length, modelCalls: 0, networkCalls, output }));
