import { AI_MODELS, AI_EFFORTS, type AiModel, type AiEffort } from "../../../../shared/analysis-contract/ai-models-admin.ts";
import type { AnalysisEnv } from "../operations.ts";
import { createAnalysisOperations } from "../operations.ts";
import { filingSessions } from "../durable-runs/binding.ts";
import { getFilingMaterial, readMaterialSnapshot } from "../filing-material/index.ts";
import { freezeCompanyResearch, companyResearchDependencyStatements } from "../public-research/context.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { trackedTickersFor } from "../core.ts";
import { profileFor } from "./profiles.ts";
import { filingOpening } from "./start.ts";
import { filingSummary, type FilingSpec, type FilingWork } from "./recipe.ts";
import type { ResearchUse } from "../company-research/context-tools.ts";
import { artifactId, previewToken, publishStatements, readArtifactVersion, saveWorkState } from "../artifact/store.ts";
import { filingMemoryStatements } from "./memory-source.ts";
import { sha256 } from "../sha256.ts";

const key = (runId: string) => `research-shadow:${runId}`;
type ShadowRun = { runId: string; ticker: string; accession: string; createdAt: string; baseVersion: number | null; callsReserved: number; maxCalls: number; spec: FilingSpec };
type ValidatedShadow = { spec: FilingSpec; version: number; hash: string; text: string; degraded: string[]; validatedAt: string; researchUses: ResearchUse[]; work: FilingWork };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** Called only after the report admin authenticates. Reads never launch research. */
export async function handleFilingShadow(request: Request, env: AnalysisEnv, ticker: string, accession: string, runId?: string, action?: string): Promise<Response> {
  const db = env.DB!;
  const repository = new D1SecRepository(db);
  if (!runId) {
    if (request.method !== "POST") return reply({ error: "Method not allowed" }, 405);
    if (!trackedTickersFor(env).includes(ticker)) return reply({ error: "Company research is not enabled" }, 403);
    const requestId = request.headers.get("idempotency-key") ?? "";
    if (!/^[a-f0-9-]{36}$/.test(requestId)) return reply({ error: "A UUID idempotency-key is required" }, 400);
    const rawBody = await request.text();
    let parsed: unknown;
    try { parsed = rawBody.trim() ? JSON.parse(rawBody) : {}; } catch { return reply({ error: "Invalid shadow options JSON" }, 400); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return reply({ error: "Shadow options must be an object" }, 400);
    const options = parsed as { model?: AiModel; effort?: AiEffort };
    if ((options.model !== undefined && !AI_MODELS.includes(options.model)) || (options.effort !== undefined && !AI_EFFORTS.includes(options.effort))) return reply({ error: "Unknown shadow model or effort" }, 400);
    const id = `shadow-${ticker}-${accession}-${requestId}`;
    const existing = await repository.getCache<ShadowRun>(key(id));
    if (existing) return reply({ status: "accepted", runId: id, replay: true }, 202);
    const filing = await createAnalysisOperations(env, fetch, id).loadFiling!(ticker, accession);
    const profile = filing ? profileFor(filing.form) : null;
    const material = await getFilingMaterial(env, ticker, accession);
    if (!filing || !profile) return reply({ error: "Unsupported or missing filing" }, 404);
    if (material?.status !== "ready") return reply({ error: "Prepared source material is required; shadow start does not collect or regenerate it" }, 409);
    const sessions = filingSessions(env);
    if (!sessions) return reply({ error: "Research sessions unavailable" }, 503);
    const now = new Date().toISOString();
    const snapshot = await readMaterialSnapshot(env, material.ref);
    const publicResearch = await freezeCompanyResearch(env, ticker, now);
    const spec: FilingSpec = { ticker, filing, profile: profile.id, sessionId: id, jobId: id, jobVersion: "shadow.v1", requestedBy: "manual", material: material.ref, mode: "rewrite", shadow: true, shadowModel: options.model, shadowEffort: options.effort, publicResearch };
    const current = await db.prepare("SELECT published_version FROM analysis_artifacts WHERE artifact_id=?").bind(artifactId("filing-report", ticker, accession)).first<{ published_version: number | null }>();
    const run: ShadowRun = { runId: id, ticker, accession, createdAt: now, baseVersion: current?.published_version ?? null, callsReserved: 0, maxCalls: 140, spec };
    const inserted = await db.prepare("INSERT INTO sec_cache(cache_key,payload,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO NOTHING").bind(key(id), JSON.stringify(run), now).run();
    if (!inserted.meta.changes) return reply({ status: "accepted", runId: id, replay: true }, 202);
    try { await sessions.start(id, "filing", spec, filingOpening(filing, snapshot, "rewrite"), `${id}:shadow`); }
    catch (error) { await env.SEC_FILINGS.put(`research-shadow/${id}/failed.json`, JSON.stringify({ status: "failed", reason: "Session dispatch failed", at: now })); throw error; }
    return reply({ status: "accepted", runId: id, baseVersion: run.baseVersion, publicReportUnchanged: true }, 202);
  }
  const run = (await repository.getCache<ShadowRun>(key(runId)))?.payload;
  if (!run || run.ticker !== ticker || run.accession !== accession) return reply({ error: "Shadow run not found" }, 404);
  if (action === "stop" && request.method === "POST") {
    await filingSessions(env)?.stop(runId);
    await env.SEC_FILINGS.put(`research-shadow/${runId}/failed.json`, JSON.stringify({ status: "stopped", reason: "Stopped by administrator", at: new Date().toISOString() }));
    return reply({ status: "stopped", runId });
  }
  const object = await env.SEC_FILINGS.get(`research-shadow/${runId}/validated.json`);
  const validated = object ? JSON.parse(await object.text()) as ValidatedShadow : null;
  if (!action && request.method === "GET") {
    if (!validated) {
      const failure = await env.SEC_FILINGS.get(`research-shadow/${runId}/failed.json`);
      return reply({ runId, status: failure ? "failed" : "running", callsReserved: run.callsReserved, maxCalls: run.maxCalls, failure: failure ? JSON.parse(await failure.text()) : null, session: await filingSessions(env)?.report(runId) });
    }
    const artifact = await readArtifactVersion(env, artifactId("filing-report", ticker, accession), validated.version);
    const token = await previewToken(env, "filing-report", ticker, accession, validated.version);
    const current = await db.prepare("SELECT published_version FROM analysis_artifacts WHERE artifact_id=?").bind(artifactId("filing-report", ticker, accession)).first<{published_version:number|null}>();
    return reply({ runId, status: current?.published_version === validated.version ? "published" : "validated_shadow", version: validated.version, hash: validated.hash, baseVersion: run.baseVersion, validatedAt: validated.validatedAt, callsReserved: run.callsReserved, maxCalls: run.maxCalls, previewToken: token, artifact, investmentChains: validated.work.periodic?.investmentChains ?? [], computations: validated.work.periodic?.impactComputations ?? {}, researchUses: validated.researchUses, publicResearch: validated.spec.publicResearch, publicReportUnchanged: (current?.published_version ?? null) === run.baseVersion });
  }
  if (action !== "promote" || request.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  if (!validated) return reply({ error: "No validated shadow to review" }, 409);
  const stopReceipt = await env.SEC_FILINGS.get(`research-shadow/${runId}/failed.json`);
  if (stopReceipt && (JSON.parse(await stopReceipt.text()) as { status?: string }).status === "stopped") return reply({ error: "This shadow run was stopped and cannot be promoted" }, 409);
  const body = await request.json() as { expectedHash?: string; reviewer?: string; reviewNotes?: string; approvedChainIds?: string[] };
  const chains = validated.work.periodic?.investmentChains ?? [];
  if (body.expectedHash !== validated.hash || !body.reviewer?.trim() || !body.reviewNotes?.trim() || !chains.length || !Array.isArray(body.approvedChainIds) || chains.some(chain => !body.approvedChainIds!.includes(chain.id)) || body.approvedChainIds.some(id => !chains.some(chain => chain.id === id))) return reply({ error: "Review must name the exact hash, reviewer, notes and every supported investment chain" }, 400);
  const id = artifactId("filing-report", ticker, accession);
  const stored = await readArtifactVersion(env, id, validated.version);
  if (!stored || stored.hash !== validated.hash || await sha256(`${stored.html}\n${stored.css}`) !== validated.hash || validated.degraded.length) return reply({ error: "Shadow artifact integrity or review failed" }, 409);
  const current = await db.prepare("SELECT published_version FROM analysis_artifacts WHERE artifact_id=?").bind(id).first<{ published_version: number | null }>();
  if (current?.published_version === validated.version) return reply({ status: "published", version: validated.version, hash: validated.hash, replay: true });
  if ((current?.published_version ?? null) !== run.baseVersion) return reply({ error: "The public report changed after shadow start; review a new shadow" }, 409);
  const dependencies = await companyResearchDependencyStatements(env, { ticker, resultId: `${id}:v${validated.version}`, dependencies: validated.researchUses.filter(use => use.decision === "adopted"), mappingVersions: validated.spec.publicResearch?.mappingVersions ?? [] });
  const now = new Date().toISOString();
  const summary = filingSummary(run.spec.filing, { headline: stored.document.blocks.find(block => block.id === "summary")?.title ?? stored.document.title, text: validated.text }, now);
  const material = await readMaterialSnapshot(env, run.spec.material);
  const memory = run.spec.profile === "periodic" ? await filingMemoryStatements(env, { filing: run.spec.filing, summary, sessionId: runId, readSectionIds: validated.work.read, material }) : [];
  // A deliberate uniqueness guard aborts the whole D1 batch if another publisher won after the read above.
  const guard = db.prepare(`INSERT INTO analysis_artifact_versions(artifact_id,version,status,r2_key,hash,run_id,created_at)
    SELECT artifact_id,version,status,r2_key,hash,run_id,created_at FROM analysis_artifact_versions
    WHERE artifact_id=? AND version=? AND COALESCE((SELECT published_version FROM analysis_artifacts WHERE artifact_id=?),-1)<>?`).bind(id, validated.version, id, run.baseVersion ?? -1);
  await db.batch([guard, ...publishStatements(env, "filing-report", ticker, accession, validated.version, validated.hash, [], now), ...repository.summaryStatements({ ticker, accessionNumber: accession, form: run.spec.filing.form }, summary, memory) as unknown as D1PreparedStatement[], ...dependencies,
    db.prepare("INSERT INTO sec_cache(cache_key,payload,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO NOTHING").bind(`${key(runId)}:review`, JSON.stringify({ hash: validated.hash, reviewer: body.reviewer, notes: body.reviewNotes, approvedChainIds: body.approvedChainIds, reviewedAt: now }), now)]);
  const workSaved = await saveWorkState(env, "filing-report", ticker, accession, validated.work).then(() => true, () => false);
  return reply({ status: "published", version: validated.version, hash: validated.hash, previousVersion: run.baseVersion, workCheckpoint: workSaved ? "saved" : "needs_repair_from_shadow_receipt" });
}
