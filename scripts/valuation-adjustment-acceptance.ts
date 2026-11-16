import { readValuationResponse } from "../workers/analysis/src/valuation/store.ts";
/** Synthetic reader saves, reopens and isolates a private sensitivity. No model calls or production writes. */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { valuationReport } from "./i18n/fixture.ts";
import { scenarioValue } from "../shared/analysis-runtime/valuation/calculator.ts";
import { calculateValuationAdjustment } from "../shared/analysis-runtime/valuation/adjustment.ts";
import { priceImpactOf } from "../shared/analysis-runtime/price-impact.ts";
import { createValuationAdjustment, readValuationAdjustment } from "../workers/analysis/src/price-impact/adjustments.ts";
import type { PublicResearchEnv } from "../workers/analysis/src/public-research/store.ts";
const sqlite = new DatabaseSync(":memory:");
for (const file of ["0040_valuation.sql", "0060_public_research.sql", "0061_user_valuation_adjustments.sql"]) { const sql = readFileSync(new URL(`../workers/analysis/migrations/${file}`, import.meta.url), "utf8"); sqlite.exec(file === "0040_valuation.sql" ? sql.slice(sql.indexOf("CREATE TABLE valuation_versions")) : sql); }
class Statement { query: string; values: unknown[] = []; constructor(query: string) { this.query = query; } bind(...values: unknown[]) { this.values = values; return this; } async first() { return sqlite.prepare(this.query).get(...this.values as never[]) ?? null; } async all() { return { results: sqlite.prepare(this.query).all(...this.values as never[]) }; } async run() { return sqlite.prepare(this.query).run(...this.values as never[]); } }
const env = { DB: { prepare: (q: string) => new Statement(q) } } as unknown as PublicResearchEnv;
const report = structuredClone(valuationReport); report.versionId = "aabbccdd";
const model = report.model!;
for (const row of Object.values(model.scenarios)) { row.result = scenarioValue(row.drivers, model.discountRate.value, model.shares.economic, model.bridge, { midYear: model.midYear }); if (model.forward) row.result.perShare *= (1 + model.discountRate.value) ** (model.forward.months / 12); }
const original = JSON.stringify(report);
sqlite.exec("CREATE TABLE financial_company_settings(ticker TEXT, enabled INTEGER); CREATE TABLE business_feature_settings(ticker TEXT, feature TEXT, display INTEGER, generate INTEGER)");
sqlite.prepare("INSERT INTO financial_company_settings VALUES(?,1)").run(report.ticker);
for (const feature of ["filings", "findings", "tree", "valuation"]) sqlite.prepare("INSERT INTO business_feature_settings VALUES(?,?,1,1)").run(report.ticker, feature);
sqlite.prepare("INSERT INTO valuation_versions(version_id,ticker,generated_at,research_as_of,report_status,method_version,calculator_version,base_input_fingerprint,evidence_set_hash,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?)").run(report.versionId, report.ticker, report.generatedAt, report.researchAsOf, report.reportStatus, report.methodVersion, report.calculatorVersion, report.baseInputFingerprint, report.evidenceSetHash, original);
const checks: string[] = [];
function check(name: string, pass: boolean) { if (!pass) throw new Error(name); checks.push(name); }
// Read the published valuation before and after a separate quote-cache update.
sqlite.exec("CREATE TABLE sec_cache(cache_key TEXT PRIMARY KEY,payload TEXT,fetched_at TEXT)");
sqlite.prepare("INSERT INTO valuation_current(ticker,version_id,request_generation,updated_at) VALUES(?,?,0,?)").run(report.ticker, report.versionId, report.generatedAt);
const initialRead = await readValuationResponse(env.DB!, report.ticker, { researchEnv: env });
sqlite.prepare("INSERT INTO sec_cache VALUES(?,?,?)").run(`valuation:quote:${report.ticker}`, JSON.stringify({ ...report.quote, price: 90, priceDate: "2026-08-13" }), "2026-08-13T20:00:00Z");
const quoteRead = await readValuationResponse(env.DB!, report.ticker, { researchEnv: env });
check("Separate quote refresh preserves published model and frozen reference", JSON.stringify(initialRead.report) === JSON.stringify(quoteRead.report) && initialRead.priceImpact?.referenceQuote?.price === quoteRead.priceImpact?.referenceQuote?.price && quoteRead.priceImpact?.latestQuote?.price === 90 && quoteRead.priceImpact?.eventChange === null);
const input = { ticker: report.ticker, baseVersionId: report.versionId, factor: "discountRate" as const, delta: 0.01 };
const saved = await createValuationAdjustment(env, "reader-a", input);
check("Reader saves reproducible controlled FCFF sensitivity", saved.status === "available" && saved.result.cases.every(c => c.after < c.before));
if (saved.status !== "available") throw new Error("unreachable");
const reopened = await readValuationAdjustment(env, "reader-a", saved.result.id);
check("Reopened saved result is immutable and same ID", JSON.stringify(saved) === JSON.stringify(reopened));
check("Duplicate identical request reuses exact stored result", JSON.stringify(saved) === JSON.stringify(await createValuationAdjustment(env, "reader-a", input)));
let isolated = false; try { await readValuationAdjustment(env, "reader-b", saved.result.id); } catch { isolated = true; } check("Another reader cannot read private sensitivity", isolated);
for (const factor of ["revenueGrowth", "operatingMargin"] as const) { const result = calculateValuationAdjustment(report, { ...input, factor }); check(`${factor} changes controlled path without mutating report`, result.cases.every(c => Number.isFinite(c.absoluteChange)) && JSON.stringify(report) === original); }
for (const delta of [0, 0.11, NaN]) { let rejected = false; try { calculateValuationAdjustment(report, { ...input, delta }); } catch { rejected = true; } check(`Invalid delta ${delta} rejected`, rejected); }
const mismatched = structuredClone(report); mismatched.model!.scenarios.base.result.perShare += 1;
let rejected = false; try { calculateValuationAdjustment(mismatched, input); } catch { rejected = true; } check("Unreproducible published baseline rejected", rejected);
check("Invalidated research suspends projection", priceImpactOf(report, { dependencyStatus: "review_required" }).quantificationStatus === "unavailable");
check("Original published report remains unchanged", (sqlite.prepare("SELECT payload_json FROM valuation_versions").get() as {payload_json:string}).payload_json === original);
sqlite.prepare("INSERT INTO public_research_dependencies(owner_id,owner_version,source_report_id,source_version,claim_id,ticker,status) VALUES(?,?,?,?,?,?,?)").run("company", `valuation:${report.ticker}:${report.versionId}`, "synthetic-source", "old-version", "claim", report.ticker, "review_required");
const staleRead = await readValuationResponse(env.DB!, report.ticker, { researchEnv: env });
check("Valuation reader keeps source report but suspends invalidated quantitative branch", staleRead.report?.versionId === report.versionId && staleRead.priceImpact?.quantificationStatus === "unavailable" && staleRead.priceImpact.scenarios.length === 0 && staleRead.researchStatus === "review_required");
check("Invalidated dependency suspends saved sensitivity on read", (await readValuationAdjustment(env, "reader-a", saved.result.id)).status === "review_required");
check("Invalidated dependency blocks new sensitivity", (await createValuationAdjustment(env, "reader-a", input)).status === "review_required");
sqlite.prepare("UPDATE financial_company_settings SET enabled=0 WHERE ticker=?").run(report.ticker);
let hidden = false; try { await readValuationAdjustment(env, "reader-a", saved.result.id); } catch { hidden = true; } check("Hidden company blocks saved sensitivity", hidden);
writeFileSync("/tmp/spontra-adjustment-fixture.json", JSON.stringify({ report, saved }));
console.log(JSON.stringify({ fixtureKind: "synthetic", modelCalls: 0, productionWrites: 0, checks }, null, 2));
