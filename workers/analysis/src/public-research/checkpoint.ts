import { z } from "zod";
import { publicResearchDraftSchema, sourceSnapshotSchema } from "../../../../shared/analysis-runtime/public-research-schema.ts";
import type { AnalysisEnv } from "../operations.ts";
import type { StoredPiSession } from "../pi/host.ts";
import { sha256 } from "../sha256.ts";

export const publicResearchStageSchema = z.enum(["research-demand", "research-financing", "synthesis", "review", "repair", "review-repair"]);
export type PublicResearchStage = z.infer<typeof publicResearchStageSchema>;
const notesSchema = z.object({ conclusions: z.array(z.string()), gaps: z.array(z.string()), sources: z.array(sourceSnapshotSchema) });
const reviewSchema = z.object({ approved: z.boolean(), claimChecks: z.array(z.object({ claimId: z.string(), supported: z.boolean(), notes: z.string() })), issues: z.array(z.string()) });
const checkpointSchema = z.object({
  schemaVersion: z.literal("public-research.checkpoint.v1"),
  runId: z.string().regex(/^public-[a-f0-9]{40}$/), reportId: z.string(), inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  stage: publicResearchStageSchema, operationId: z.string(), asOf: z.string(), runStartedAt: z.string(),
  stageSubmitted: z.boolean(), notes: z.array(notesSchema), draft: publicResearchDraftSchema.nullable(), review: reviewSchema.nullable(),
});
export type PublicResearchCheckpoint = z.infer<typeof checkpointSchema>;
type Identity = Pick<PublicResearchCheckpoint, "runId" | "reportId" | "inputFingerprint">;

/** Full structured work only. A checkpoint never constitutes review or a published report. */
export function publicResearchCheckpoint(run: Identity & { asOf: string; startedAt: string }, stage: PublicResearchStage,
  state: { submitted: boolean; notes?: unknown; sources?: unknown[]; draft?: unknown; review?: unknown } | null | undefined,
  input: { notes?: unknown[]; draft?: unknown; review?: unknown } = {}): PublicResearchCheckpoint {
  const output = state ?? { submitted: false };
  const inputDraft = input.draft ? publicResearchDraftSchema.parse(input.draft) : null;
  const checkpoint = checkpointSchema.parse({
    schemaVersion: "public-research.checkpoint.v1", runId: run.runId, reportId: run.reportId, inputFingerprint: run.inputFingerprint,
    stage, operationId: `${run.runId}:${stage}`, asOf: run.asOf, runStartedAt: run.startedAt, stageSubmitted: output.submitted,
    notes: output.notes ? [output.notes] : input.notes ?? (output.sources?.length ? [{ conclusions: [], gaps: ["Stage ended without submitted research conclusions; only registered excerpts are retained."], sources: output.sources }] : []),
    // An enrichment's inherited draft still belongs to its parent; an unsuccessful new synthesis has no new draft.
    draft: output.draft ?? (inputDraft?.authorRunId === run.runId ? inputDraft : null), review: output.review ?? input.review ?? null,
  });
  assertIdentity(checkpoint, run, stage);
  return checkpoint;
}

function assertIdentity(checkpoint: PublicResearchCheckpoint, run: Identity, stage: PublicResearchStage) {
  if (checkpoint.runId !== run.runId || checkpoint.reportId !== run.reportId || checkpoint.inputFingerprint !== run.inputFingerprint || checkpoint.stage !== stage || checkpoint.operationId !== `${run.runId}:${stage}`) throw new Error("Research checkpoint identity mismatch");
  if (checkpoint.draft && (checkpoint.draft.authorRunId !== run.runId || checkpoint.draft.reportId !== run.reportId || checkpoint.draft.inputFingerprint !== run.inputFingerprint)) throw new Error("Research checkpoint draft belongs to another run");
}

/** Content-addressed stage archives do not touch draft indexes, reviews or the public pointer. */
export async function savePublicResearchCheckpoint(env: Pick<AnalysisEnv, "SEC_FILINGS">, checkpoint: PublicResearchCheckpoint) {
  const body = JSON.stringify(checkpoint), contentHash = await sha256(body);
  const key = `public-research/runs/${checkpoint.runId}/checkpoints/${checkpoint.stage}/${contentHash}.json`;
  const saved = await env.SEC_FILINGS.put(key, body, { httpMetadata: { contentType: "application/json" }, onlyIf: { etagDoesNotMatch: "*" } });
  if (!saved) {
    const existing = await env.SEC_FILINGS.get(key);
    if (!existing || await existing.text() !== body) throw new Error("Immutable research checkpoint could not be verified");
  }
  return { key, contentHash };
}

export async function readPublicResearchCheckpoint(env: Pick<AnalysisEnv, "SEC_FILINGS">, run: Identity, stage: PublicResearchStage) {
  const prefix = `public-research/runs/${run.runId}/checkpoints/${stage}/`;
  const listed = await env.SEC_FILINGS.list({ prefix, limit: 2 });
  if (!listed.objects.length) return null;
  if (listed.truncated || listed.objects.length !== 1) throw new Error("Ambiguous research stage checkpoint; refusing to select a different result");
  const key = listed.objects[0]!.key, expectedHash = key.slice(prefix.length).replace(/\.json$/, "");
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error("Invalid research checkpoint archive key");
  const object = await env.SEC_FILINGS.get(key);
  if (!object) throw new Error("Research checkpoint archive unavailable");
  const body = await object.text(), contentHash = await sha256(body);
  if (contentHash !== expectedHash) throw new Error("Research checkpoint archive hash mismatch");
  const checkpoint = checkpointSchema.parse(JSON.parse(body));
  assertIdentity(checkpoint, run, stage);
  return { key, contentHash, checkpoint };
}

/** A stopped legacy run is read through its storage-only RPC, never status()/report() recovery. */
export async function readStoppedPublicResearchCheckpoint(env: Pick<AnalysisEnv, "SEC_FILINGS">, run: Identity, stage: PublicResearchStage,
  runner: { readPublicResearchSession(id: string, stage: string): Promise<{ runId: string; status: "terminated"; session: StoredPiSession } | null> }) {
  const archived = await readPublicResearchCheckpoint(env, run, stage);
  // The RPC checks the runner is terminated and has no active sessions even when an archive exists.
  const stored = await runner.readPublicResearchSession(run.runId, stage);
  if (stored) {
    if (stored.runId !== run.runId || stored.status !== "terminated" || stored.session.active || stored.session.kind !== "public-research" || stored.session.operationId !== `${run.runId}:${stage}`) throw new Error("Stopped research storage identity mismatch");
    const spec = stored.session.spec as { run: Identity & { asOf: string; startedAt: string }; stage: string; notes?: unknown[]; draft?: unknown; review?: unknown };
    if (spec.stage !== stage || spec.run.runId !== run.runId || spec.run.reportId !== run.reportId || spec.run.inputFingerprint !== run.inputFingerprint) throw new Error("Research session specification does not match admitted run");
    if (archived) return archived;
    const checkpoint = publicResearchCheckpoint(spec.run, stage, stored.session.state as Parameters<typeof publicResearchCheckpoint>[2], spec);
    return { key: null, contentHash: await sha256(JSON.stringify(checkpoint)), checkpoint };
  }
  return archived;
}
