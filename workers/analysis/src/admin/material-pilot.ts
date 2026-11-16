import { z } from "zod";
import { createAnalysisOperations, type AnalysisEnv } from "../operations.ts";
import type { runBinding } from "../durable-runs/binding.ts";
import { filingMaterialMeta } from "../filing-material/read.ts";
import { materialPilotKey, materialRecoveryKey, materialStateKey } from "../filing-material/store.ts";
import type { MaterialState } from "../../../../shared/analysis-contract/filing-material.ts";
import { json } from "./http.ts";

const schema = z.object({ requestId: z.string().uuid(), retryFailedSources: z.boolean().default(false) }).strict();
/** Explicit operator chunks only: no normal preparation request or automatic continuation. */
export async function preparePilotMaterial(request: Request, env: AnalysisEnv, ticker: string, accession: string): Promise<Response> {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "A UUID requestId and optional retryFailedSources are required" }, 400);
  const binding = (env as AnalysisEnv & { MATERIAL_PILOT_WORKFLOW?: ReturnType<typeof runBinding> }).MATERIAL_PILOT_WORKFLOW;
  if (!binding) return json({ error: "Pilot task runner unavailable" }, 503);
  const db = env.DB!, key = materialPilotKey(ticker, accession), input = parsed.data;
  const prior = await db.prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(key).first<{payload:string}>();
  if (prior) {
    const saved = JSON.parse(prior.payload);
    if (saved.requestId !== input.requestId || saved.retryFailedSources !== input.retryFailedSources) return json({ error: "Pilot admission already exists; resume with the original requestId and options" }, 409);
  }
  const row = await db.prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(materialStateKey(ticker, accession)).first<{payload:string}>();
  let state: MaterialState | null = row ? JSON.parse(row.payload) : null;
  if (!state) {
    const filing = await createAnalysisOperations(env, fetch).loadFiling?.(ticker, accession);
    if (!filing) return json({ error: "Exact filing not found" }, 404);
    state = { status: "preparing", filing: filingMaterialMeta(filing), progress: "operator-scoped shadow preparation" };
  }
  if (!prior && state.status === "ready") return json({ error: "Material is already ready; use its existing pinned reference" }, 409);
  const at = new Date().toISOString(), payload = JSON.stringify({ ...input, mode: "shadow-pilot", admittedAt: at, chunk: 0, chunkStatus: "preparing" });
  await db.batch([
    db.prepare("INSERT INTO sec_cache(cache_key,payload,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO NOTHING").bind(key,payload,at),
    db.prepare("INSERT INTO sec_cache(cache_key,payload,fetched_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM sec_cache WHERE cache_key=? AND json_extract(payload,'$.requestId')=?) ON CONFLICT(cache_key) DO NOTHING").bind(materialStateKey(ticker,accession),JSON.stringify(state),at,key,input.requestId),
  ]);
  const admitted = await db.prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(key).first<{payload:string}>();
  if (!admitted || (JSON.parse(admitted.payload).requestId !== input.requestId || JSON.parse(admitted.payload).retryFailedSources !== input.retryFailedSources)) return json({ error: "Another pilot request was admitted" }, 409);
  if (input.retryFailedSources) await db.prepare("INSERT INTO sec_cache(cache_key,payload,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO NOTHING")
    .bind(materialRecoveryKey(ticker,accession),JSON.stringify({ requestId: input.requestId, requestedAt: at }),at).run();
  let pilot = JSON.parse(admitted.payload);
  if (state.status === "ready" || ["blocked","errored"].includes(pilot.chunkStatus)) return json({ ...state, pilot, resumeRequired:false },200);
  if (pilot.chunkStatus === "preparing") {
    const chunk = (pilot.chunk ?? 0) + 1, runId = `material-pilot-${ticker}-${accession}-${input.requestId}-${chunk}`;
    await db.prepare("UPDATE sec_cache SET payload=json_set(payload,'$.chunk',?,'$.activeRunId',?,'$.chunkStatus','queued'),fetched_at=? WHERE cache_key=? AND json_extract(payload,'$.requestId')=? AND json_extract(payload,'$.chunkStatus')='preparing' AND COALESCE(json_extract(payload,'$.chunk'),0)=?")
      .bind(chunk,runId,at,key,input.requestId,pilot.chunk??0).run();
    const current = await db.prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(key).first<{payload:string}>();
    pilot = JSON.parse(current!.payload);
  }
  if (["queued","running"].includes(pilot.chunkStatus)) {
    try { await binding.create({ id:pilot.activeRunId,params:{ticker,accession,requestId:input.requestId,runId:pilot.activeRunId,retryFailedSources:input.retryFailedSources} }); }
    catch(error) { if(!/already.exists|duplicate/i.test(String(error))) return json({error:"Pilot start unconfirmed; retry the same request to join it",pilot},503); }
  }
  return json({ ...state, pilot, resumeRequired:false },202);
}
