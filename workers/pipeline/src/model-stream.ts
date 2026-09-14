import { SEC_MODEL_MAX_RESPONSE_BYTES, SEC_MODEL_MAX_CONTENT_BYTES, SEC_MODEL_MAX_REASONING_BYTES, SEC_MODEL_MAX_FRAME_BYTES, SEC_MODEL_STALL_MS } from "./retry-policy.ts";

export type ModelFailureCode = "output_token_limit" | "stream_incomplete" | "stream_stall" | "invalid_json" | "invalid_stream" | "wire_limit" | "content_limit" | "reasoning_limit" | "frame_limit";
export class SecModelOutputError extends Error {
  readonly code: ModelFailureCode;
  readonly partialContent: string;
  constructor(code: ModelFailureCode, message: string, partialContent = "") {
    super(message); this.name = "SecModelOutputError"; this.code = code; this.partialContent = partialContent;
  }
}
export type StreamLimits = { wire: number; content: number; reasoning: number; frame: number };
export const MODEL_STREAM_LIMITS: StreamLimits = {
  wire: SEC_MODEL_MAX_RESPONSE_BYTES, content: SEC_MODEL_MAX_CONTENT_BYTES,
  reasoning: SEC_MODEL_MAX_REASONING_BYTES, frame: SEC_MODEL_MAX_FRAME_BYTES,
};
export type StreamOptions = {
  limits?: StreamLimits;
  signal?: AbortSignal;
  checkpoint?: (content: string) => Promise<void>;
  heartbeat?: () => Promise<void>;
};
const meaningful = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const encoder = new TextEncoder();

/** Count wire, reasoning and retained output separately. Never retain reasoning or SSE history. */
export async function readModelContent(response: Response, stage: string, progress: () => void = () => {}, metrics: Record<string, unknown> = {}, idleMs = SEC_MODEL_STALL_MS, options: StreamOptions = {}): Promise<string> {
  const limits = options.limits ?? MODEL_STREAM_LIMITS;
  let content = "", contentBytes = 0, reasoningBytes = 0;
  let finishReason: string | null = null, done = false;
  let lastCheckpointAt = Date.now(), lastCheckpointLength = 0;
  let heartbeatAt = Date.now();
  const checkpoint = async (force = false) => {
    if (options.heartbeat && Date.now() - heartbeatAt >= 30_000) {
      await options.heartbeat(); heartbeatAt = Date.now();
    }
    if (!options.checkpoint || content.length === lastCheckpointLength) return;
    if (!force && content.length - lastCheckpointLength < 32_768 && Date.now() - lastCheckpointAt < 30_000) return;
    await options.checkpoint(content);
    lastCheckpointAt = Date.now(); lastCheckpointLength = content.length;
  };
  try {
    for await (const event of modelEvents(response, idleMs, limits, metrics, options.signal)) {
      if (event === "[DONE]") { done = true; continue; }
      let chunk: Record<string, unknown>;
      try { chunk = JSON.parse(event); }
      catch { throw new SecModelOutputError("invalid_stream", `Model ${stage} returned malformed SSE JSON`); }
      if (chunk.usage) metrics.usage = chunk.usage;
      if (chunk.error) throw new SecModelOutputError("invalid_stream", `Model ${stage} stream error: ${JSON.stringify(chunk.error).slice(0, 300)}`);
      const choice = (chunk.choices as Array<Record<string, unknown>> | undefined)?.[0];
      if (!choice) continue;
      const delta = (choice.delta ?? choice.message) as { content?: unknown; reasoning_content?: unknown } | undefined;
      if (typeof delta?.content === "string") {
        contentBytes += encoder.encode(delta.content).byteLength;
        if (contentBytes > limits.content) throw new SecModelOutputError("content_limit", `Model ${stage} exceeds retained content budget`);
        content += delta.content;
        metrics.outputCharacters = content.length;
        metrics.contentBytes = contentBytes;
        if (meaningful(delta.content)) progress();
      }
      if (typeof delta?.reasoning_content === "string") {
        reasoningBytes += encoder.encode(delta.reasoning_content).byteLength;
        metrics.reasoningBytes = reasoningBytes;
        if (reasoningBytes > limits.reasoning) throw new SecModelOutputError("reasoning_limit", `Model ${stage} exceeds reasoning budget`);
        if (meaningful(delta.reasoning_content)) progress();
      }
      if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
      await checkpoint();
    }
    metrics.finishReason = finishReason;
    if (!done && !finishReason) throw new SecModelOutputError("stream_incomplete", `Model ${stage} stream ended before completion after ${content.length} characters`);
    if (finishReason === "length") throw new SecModelOutputError("output_token_limit", `Model ${stage} stream hit the output token limit after ${content.length} characters`);
    if (finishReason && finishReason !== "stop") throw new SecModelOutputError("invalid_stream", `Model ${stage} ended with ${finishReason}`);
    if (!content) throw new SecModelOutputError("stream_incomplete", `Model ${stage} returned empty content`);
    return content;
  } catch (error) {
    await checkpoint(true);
    if (error instanceof SecModelOutputError) throw new SecModelOutputError(error.code, error.message, content);
    if (options.signal?.aborted) throw error;
    throw new SecModelOutputError("stream_incomplete", `Model ${stage} stream interrupted: ${error instanceof Error ? error.message : "transport error"}`, content);
  }
}

async function* modelEvents(response: Response, idleMs: number, limits: StreamLimits, metrics: Record<string, unknown>, signal?: AbortSignal): AsyncGenerator<string> {
  if (!response.body) throw new SecModelOutputError("stream_incomplete", "Model returned no response body");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "", wireBytes = 0, meaningfulAt = Date.now();
  let streaming = response.headers.get("content-type")?.includes("text/event-stream") ?? false;
  let nonStream = response.headers.get("content-type")?.includes("application/json") ?? false;
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const part = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          const cancel = (error: Error) => { reject(error); void reader.cancel().catch(() => {}); };
          timer = setTimeout(() => cancel(new SecModelOutputError("stream_stall", "model-timeout:stream-stall")), Math.max(1, idleMs - (Date.now() - meaningfulAt)));
          onAbort = () => cancel(new Error("Model execution budget expired"));
          if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
        }),
      ]).finally(() => { clearTimeout(timer); if (onAbort) signal?.removeEventListener("abort", onAbort); });
      if (part.done) break;
      wireBytes += part.value.byteLength;
      metrics.wireBytes = wireBytes;
      if (wireBytes > limits.wire) throw new SecModelOutputError("wire_limit", "Model exceeds streaming wire budget");
      buffer += decoder.decode(part.value, { stream: true });
      streaming ||= buffer.trimStart().startsWith("data:") || buffer.trimStart().startsWith(":");
      nonStream ||= !streaming && buffer.trimStart().startsWith("{");
      if (streaming) {
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trimEnd();
          buffer = buffer.slice(newline + 1);
          if (encoder.encode(line).byteLength > limits.frame) throw new SecModelOutputError("frame_limit", "Model SSE frame exceeds budget");
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          try {
            const delta = JSON.parse(data).choices?.[0]?.delta;
            if (meaningful(delta?.content) || meaningful(delta?.reasoning_content)) meaningfulAt = Date.now();
          } catch { /* DONE and heartbeat frames are not progress. */ }
          yield data;
        }
      }
      if (encoder.encode(buffer).byteLength > (nonStream && !streaming ? limits.content : limits.frame)) {
        throw new SecModelOutputError("frame_limit", "Model pending frame exceeds budget");
      }
    }
    buffer += decoder.decode();
    if (streaming) {
      if (buffer.trim().startsWith("data:")) yield buffer.trim().slice(5).trim();
    } else {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(buffer); } catch { throw new SecModelOutputError("invalid_stream", "Model returned neither an event stream nor JSON"); }
      // Older compatible gateways omit finish_reason on complete, non-streamed HTTP responses.
      const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
      if (choices?.[0] && !choices[0].finish_reason) choices[0].finish_reason = "stop";
      yield JSON.stringify(parsed);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
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
