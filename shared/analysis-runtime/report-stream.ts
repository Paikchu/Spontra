import { z } from "zod";
import { SEC_READER_ASSET_SCHEMA, SEC_READER_CONTENT_BLOCK_SCHEMA, type SecReaderAsset, type SecReaderContentBlock } from "./sec-reader-schema.ts";

/** Application events; provider SSE and model-written JSON are never this protocol. */
const envelope = {
  schemaVersion: z.literal("report-stream.v1"),
  reportId: z.string().min(1).max(200),
  runId: z.string().min(1).max(200),
  seq: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
};
const blockId = z.string().min(1).max(160);
const status = z.enum(["generating", "reviewing", "failed", "cancelled", "published"]);
export const REPORT_STREAM_EVENT_SCHEMA = z.discriminatedUnion("type", [
  z.object({ ...envelope, type: z.literal("snapshot"), blocks: z.array(SEC_READER_CONTENT_BLOCK_SCHEMA).max(512),
    assets: z.array(SEC_READER_ASSET_SCHEMA).max(128), completedBlockIds: z.array(blockId).max(512), status,
    publishedVersion: z.string().max(300).optional() }),
  z.object({ ...envelope, type: z.literal("block.upsert"), block: SEC_READER_CONTENT_BLOCK_SCHEMA }),
  z.object({ ...envelope, type: z.literal("text.delta"), blockId, delta: z.string().max(16_384) }),
  z.object({ ...envelope, type: z.literal("block.completed"), blockId }),
  z.object({ ...envelope, type: z.literal("asset.updated"), asset: SEC_READER_ASSET_SCHEMA }),
  z.object({ ...envelope, type: z.literal("run.status"), status: z.enum(["generating", "reviewing"]) }),
  z.object({ ...envelope, type: z.literal("run.failed"), message: z.string().min(1).max(500) }),
  z.object({ ...envelope, type: z.literal("run.cancelled") }),
  z.object({ ...envelope, type: z.literal("report.published"), reportVersion: z.string().min(1).max(300) }),
]);
export type ReportStreamEvent = z.infer<typeof REPORT_STREAM_EVENT_SCHEMA>;

export type ReportStreamState = {
  reportId: string;
  runId: string;
  revision: number;
  seq: number;
  blocks: SecReaderContentBlock[];
  assets: SecReaderAsset[];
  completedBlockIds: string[];
  status: z.infer<typeof status>;
  /** A gap or revision change needs a server snapshot, never guessed content. */
  needsSnapshot: boolean;
  publishedVersion?: string;
  error?: string;
};

/** The caller explicitly selects a run; an unrelated late event cannot switch it. */
export function createReportStreamState(reportId: string, runId: string, publishedVersion?: string): ReportStreamState {
  return { reportId, runId, revision: 0, seq: -1, blocks: [], assets: [], completedBlockIds: [],
    status: "generating", needsSnapshot: true, ...(publishedVersion ? { publishedVersion } : {}) };
}

/** Shared by a future SSE subscriber and saved-message replay. No network or model access. */
export function reduceReportStream(state: ReportStreamState, input: unknown): ReportStreamState {
  const result = REPORT_STREAM_EVENT_SCHEMA.safeParse(input);
  if (!result.success) return { ...state, needsSnapshot: true };
  const event = result.data;
  if (event.reportId !== state.reportId || event.runId !== state.runId || event.seq <= state.seq) return state;
  if (event.revision < state.revision) return state;
  if (event.type === "snapshot") {
    const ids = event.blocks.map((block) => block.blockId);
    if (new Set(ids).size !== ids.length || event.completedBlockIds.some((id) => !ids.includes(id))
      || new Set(event.assets.map((asset) => asset.assetId)).size !== event.assets.length
      || event.status === "published" && (!event.publishedVersion || !ids.length || ids.some((id) => !event.completedBlockIds.includes(id)))) return { ...state, needsSnapshot: true };
    return { ...state, revision: event.revision, seq: event.seq, blocks: event.blocks, assets: event.assets,
      completedBlockIds: [...new Set(event.completedBlockIds)], status: event.status, needsSnapshot: false,
      publishedVersion: event.publishedVersion ?? state.publishedVersion, error: undefined };
  }
  if (state.needsSnapshot || event.seq !== state.seq + 1 || event.revision !== state.revision) {
    return { ...state, needsSnapshot: true };
  }
  if (["published", "failed", "cancelled"].includes(state.status)) return state;
  const next = { ...state, seq: event.seq };
  switch (event.type) {
    case "block.upsert": {
      const index = state.blocks.findIndex((block) => block.blockId === event.block.blockId);
      // Completed analysis changes through a new revision snapshot, never a silent token update.
      if (state.completedBlockIds.includes(event.block.blockId)) return { ...state, needsSnapshot: true };
      if (index < 0 && state.blocks.length >= 512) return { ...state, needsSnapshot: true };
      const blocks = [...state.blocks];
      if (index < 0) blocks.push(event.block); else blocks[index] = event.block;
      return { ...next, blocks };
    }
    case "text.delta": {
      const index = state.blocks.findIndex((block) => block.blockId === event.blockId);
      const block = state.blocks[index];
      if (!block || block.type !== "markdown" || state.completedBlockIds.includes(event.blockId)) return { ...state, needsSnapshot: true };
      const candidate = SEC_READER_CONTENT_BLOCK_SCHEMA.safeParse({ ...block, markdown: block.markdown + event.delta });
      if (!candidate.success) return { ...state, needsSnapshot: true };
      const blocks = [...state.blocks];
      blocks[index] = candidate.data;
      return { ...next, blocks };
    }
    case "block.completed":
      if (!state.blocks.some((block) => block.blockId === event.blockId)) return { ...state, needsSnapshot: true };
      return { ...next, completedBlockIds: [...new Set([...state.completedBlockIds, event.blockId])] };
    case "asset.updated": {
      const assets = state.assets.filter((asset) => asset.assetId !== event.asset.assetId);
      if (assets.length >= 128) return { ...state, needsSnapshot: true };
      return { ...next, assets: [...assets, event.asset] };
    }
    case "run.status": return { ...next, status: event.status };
    case "run.failed": return { ...next, status: "failed", error: event.message };
    case "run.cancelled": return { ...next, status: "cancelled" };
    case "report.published":
      if (!state.blocks.length || state.blocks.some((block) => !state.completedBlockIds.includes(block.blockId))) {
        return { ...state, needsSnapshot: true };
      }
      return { ...next, status: "published", publishedVersion: event.reportVersion };
  }
}
