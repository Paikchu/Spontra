import { boundedModelIO } from "./model-io.ts";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";
import { SEC_MODEL_MAX_CONTENT_BYTES, SEC_MODEL_STALL_MS } from "./retry-policy.ts";

export type ModelFailureCode = "output_token_limit" | "stream_incomplete" | "stream_stall" | "invalid_json" | "invalid_stream" | "content_limit";
export class SecModelOutputError extends Error {
  readonly code: ModelFailureCode;
  readonly partialContent: string;
  constructor(code: ModelFailureCode, message: string, partialContent = "") {
    super(message); this.name = "SecModelOutputError"; this.code = code; this.partialContent = partialContent;
  }
}
export type StreamOptions = {
  /** Retained output budget in bytes. */
  contentLimit?: number;
  signal?: AbortSignal;
  /** When the connection last carried bytes, pings included; a stream silent for `idleMs` has stalled. */
  liveAt?: () => number;
  /** Closes the underlying connection once the reader gives up on it. */
  cancel?: () => void;
  checkpoint?: (content: string) => Promise<void>;
  heartbeat?: () => Promise<void>;
  storageTimeoutMs?: number;
};
const meaningful = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const encoder = new TextEncoder();
/** Reads Chat Completions chunks into their visible text. Reasoning is never retained. */
export async function readModelContent(events: AsyncIterable<ChatCompletionChunk>, stage: string, progress: () => void = () => {}, metrics: Record<string, unknown> = {}, idleMs = SEC_MODEL_STALL_MS, options: StreamOptions = {}): Promise<string> {
  const contentLimit = options.contentLimit ?? SEC_MODEL_MAX_CONTENT_BYTES;
  const liveAt = options.liveAt ?? (() => Date.now());
  let content = "", contentBytes = 0;
  let stopReason: ChatCompletionChunk.Choice["finish_reason"] = null;
  let lastCheckpointAt = Date.now(), lastCheckpointLength = 0;
  let heartbeatAt = Date.now();
  const checkpoint = async (force = false) => {
    if (options.heartbeat && Date.now() - heartbeatAt >= 30_000) {
      heartbeatAt = Date.now();
      try { await boundedModelIO(options.heartbeat(), "heartbeat", options.storageTimeoutMs ?? 5000); }
      catch { metrics.heartbeatFailures = Number(metrics.heartbeatFailures ?? 0) + 1; }
    }
    if (!options.checkpoint || content.length === lastCheckpointLength) return;
    if (!force && content.length - lastCheckpointLength < 32_768 && Date.now() - lastCheckpointAt < 30_000) return;
    try { await boundedModelIO(options.checkpoint(content), "checkpoint", options.storageTimeoutMs); }
    catch { metrics.checkpointFailures = Number(metrics.checkpointFailures ?? 0) + 1; }
    lastCheckpointAt = Date.now(); lastCheckpointLength = content.length;
  };
  const append = (text: string) => {
    contentBytes += encoder.encode(text).byteLength;
    if (contentBytes > contentLimit) throw new SecModelOutputError("content_limit", `Model ${stage} exceeds retained content budget`);
    content += text;
    metrics.outputCharacters = content.length;
    metrics.contentBytes = contentBytes;
    if (meaningful(text)) progress();
  };
  const iterator = events[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await nextBeforeStall(iterator, idleMs, liveAt, options);
      if (next.done) break;
      const event = next.value;
      metrics.servedModel = event.model;
      if (event.usage) metrics.usage = event.usage;
      const choice = event.choices[0];
      if (choice) {
        if (choice.delta.content) append(choice.delta.content);
        if ("reasoning_content" in choice.delta && meaningful(choice.delta.reasoning_content)) progress();
        if (choice.delta.refusal) metrics.refusal = choice.delta.refusal;
        if (choice.finish_reason) stopReason = choice.finish_reason;
      }
      await checkpoint();
    }
    metrics.finishReason = stopReason;
    if (!stopReason) throw new SecModelOutputError("stream_incomplete", `Model ${stage} stream ended before completion after ${content.length} characters`);
    if (stopReason === "length") throw new SecModelOutputError("output_token_limit", `Model ${stage} stream hit the output token limit after ${content.length} characters`);
    if (stopReason !== "stop") throw new SecModelOutputError("invalid_stream", `Model ${stage} ended with ${stopReason}`);
    if (!content) throw new SecModelOutputError("stream_incomplete", `Model ${stage} returned empty content`);
    return content;
  } catch (error) {
    options.cancel?.();
    await checkpoint(true);
    if (error instanceof SecModelOutputError) throw new SecModelOutputError(error.code, error.message, content);
    if (options.signal?.aborted) throw error;
    throw new SecModelOutputError("stream_incomplete", `Model ${stage} stream interrupted: ${error instanceof Error ? error.message : "transport error"}`, content);
  }
}

/** The next event, or a stall once the connection has carried no bytes for `idleMs`. */
async function nextBeforeStall<T>(iterator: AsyncIterator<T>, idleMs: number, liveAt: () => number, options: StreamOptions): Promise<IteratorResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        const watch = () => {
          const quiet = Date.now() - liveAt();
          if (quiet >= idleMs) reject(new SecModelOutputError("stream_stall", "model-timeout:stream-stall"));
          else timer = setTimeout(watch, Math.max(1, idleMs - quiet));
        };
        watch();
        onAbort = () => reject(new Error("Model execution budget expired"));
        if (options.signal?.aborted) onAbort(); else options.signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) options.signal?.removeEventListener("abort", onAbort);
  }
}

export function parseModelJson(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  let value: unknown;
  try { value = JSON.parse(fenced?.[1] ?? trimmed); }
  catch { throw new SecModelOutputError("invalid_json", "Model did not return a complete JSON object", content); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SecModelOutputError("invalid_json", "Model did not return a JSON object", content);
  return value as Record<string, unknown>;
}
