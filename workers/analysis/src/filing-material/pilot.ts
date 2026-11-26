import type { AnalysisEnv } from "../operations.ts";
import type { MaterialState } from "../../../../shared/analysis-contract/filing-material.ts";
import { materialPilotKey, materialStateKey } from "./store.ts";
import { prepareFilingMaterial } from "./prepare.ts";

export type MaterialPilotChunk = { ticker: string; accession: string; requestId: string; runId: string; retryFailedSources: boolean; repairSource?: string; repairRequestId?: string };
export async function executeMaterialPilotChunk(env: AnalysisEnv, input: MaterialPilotChunk): Promise<MaterialState> {
  const db = env.DB!, key = materialPilotKey(input.ticker, input.accession), at = new Date().toISOString();
  // Persist before any paid work. A lost invocation must never repeat this chunk automatically.
  const claimed = await db.prepare("UPDATE sec_cache SET payload=json_set(payload,'$.chunkStatus','running'),fetched_at=? WHERE cache_key=? AND json_extract(payload,'$.activeRunId')=? AND json_extract(payload,'$.chunkStatus')='queued'")
    .bind(at,key,input.runId).run();
  if (!claimed.meta.changes) throw new Error("Pilot chunk already executed or interrupted; operator review required");
  const row = await db.prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(materialStateKey(input.ticker,input.accession)).first<{payload:string}>();
  if (!row) throw new Error("Pilot material state missing");
  const state: MaterialState = JSON.parse(row.payload);
  const result = await prepareFilingMaterial(env,state.filing,{maxDocuments:1,...(input.retryFailedSources?{recoveryRequestId:input.requestId}:{}),...(input.repairSource && input.repairRequestId ? { recoverySources:{[input.repairSource]:input.repairRequestId} } : {})});
  await db.prepare("UPDATE sec_cache SET payload=json_set(payload,'$.chunkStatus',?,'$.completedAt',?),fetched_at=? WHERE cache_key=? AND json_extract(payload,'$.activeRunId')=? AND json_extract(payload,'$.chunkStatus')='running'")
    .bind(result.status,new Date().toISOString(),new Date().toISOString(),key,input.runId).run();
  return result;
}
export async function failMaterialPilotChunk(env: AnalysisEnv, input: MaterialPilotChunk, error: unknown): Promise<void> {
  await env.DB!.prepare("UPDATE sec_cache SET payload=json_set(payload,'$.chunkStatus','errored','$.error',?),fetched_at=? WHERE cache_key=? AND json_extract(payload,'$.activeRunId')=? AND json_extract(payload,'$.chunkStatus') IN ('running','queued')")
    .bind(error instanceof Error?error.message.slice(0,1000):String(error).slice(0,1000),new Date().toISOString(),materialPilotKey(input.ticker,input.accession),input.runId).run();
}

/** The durable engine journals one operator chunk; neither failures nor completion schedule another. */
export async function runMaterialPilotChunk(env: AnalysisEnv, step: import("../durable-runs/engine.ts").RunStep, input: MaterialPilotChunk): Promise<MaterialState> {
  try { return await step.do("operator-material-chunk", { retries: { limit: 0, delay: 0 }, timeout: "13 minutes" }, () => executeMaterialPilotChunk(env, input)); }
  catch (error) { await failMaterialPilotChunk(env, input, error); throw error; }
}
