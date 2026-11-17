import type { AnalysisEnv } from "../operations.ts";
import { D1SecRepository } from "../sec/d1.ts";
import type { FilingSpec } from "./recipe.ts";
import { SHADOW_RESUME_CALLS, shadowKey, type ShadowRun } from "./shadow-resume.ts";

/** Only continuation recipes opt in; existing parent and normal-report accounting stays unchanged. */
export async function shadowResumeEnvironment(env: AnalysisEnv, spec: FilingSpec): Promise<AnalysisEnv> {
  if (!spec.shadow || spec.mode !== "resume") return env;
  const child = (await new D1SecRepository(env.DB!).getCache<ShadowRun>(shadowKey(spec.sessionId)))?.payload;
  if (!child?.parentRunId || child.maxCalls !== SHADOW_RESUME_CALLS || !spec.checkpointHash || spec.checkpointHash !== child.continuation?.checkpointHash || JSON.stringify(child.spec) !== JSON.stringify(spec)) throw new Error("Unclaimed shadow continuation or changed specification");
  return { ...env, MODEL_REQUEST_GATE: async () => {
    const stopped = await env.SEC_FILINGS.get(`research-shadow/${spec.sessionId}/failed.json`);
    if (stopped && (JSON.parse(await stopped.text()) as { status?: string }).status === "stopped") throw new Error("Shadow continuation was stopped");
    const reserved = await env.DB!.prepare(`UPDATE sec_cache SET payload=json_set(payload,'$.callsReserved',json_extract(payload,'$.callsReserved')+1)
      WHERE cache_key=? AND json_extract(payload,'$.parentRunId')=? AND json_extract(payload,'$.maxCalls')=?
      AND json_extract(payload,'$.callsReserved')<? RETURNING cache_key`)
      .bind(shadowKey(spec.sessionId), child.parentRunId, SHADOW_RESUME_CALLS, SHADOW_RESUME_CALLS).first();
    if (!reserved) throw new Error("Shadow continuation total provider-request allowance exhausted");
  } };
}
