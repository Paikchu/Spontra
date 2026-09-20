import { parseModelJson, SecModelOutputError } from "./model-stream.ts";
import { SEC_MODEL_MAX_CONTENT_BYTES, SEC_MODEL_OUTPUT_TOKENS, SEC_MODEL_RECOVERY_CALLS } from "./retry-policy.ts";

export class SecModelHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number;
  readonly providerCode?: string;
  constructor(status: number, message: string, retryAfterMs = 0, providerCode?: string) { super(message); this.name = "SecModelHttpError"; this.status = status; this.retryAfterMs = retryAfterMs; this.providerCode = providerCode; }
}
export type ModelRequestOptions = {
  model: string;
  maxTokens: number;
  jsonMode: boolean;
  continuation?: string;
  repair?: string;
  checkpoint?: (content: string) => Promise<void>;
  heartbeat?: () => Promise<void>;
  workflowInstanceId?: string;
};
export type ModelCheckpoint = { version: "model-recovery.v1"; content: string; mode: "continue" | "repair"; maxTokens: number };
export type ModelCheckpointStore = { load(): Promise<ModelCheckpoint | null>; save(value: ModelCheckpoint | null): Promise<void> };
export type RecoveryOptions = {
  stage: string; model: string; fallbackModel: string; jsonMode: boolean;
  request(options: ModelRequestOptions): Promise<string>;
  checkpoint?: ModelCheckpointStore;
  heartbeat?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  log?: (event: Record<string, unknown>) => void;
  maxCalls?: number;
};

// Published B.AI capabilities; unknown configured models negotiate a smaller cap on HTTP 400.
export function modelOutputCeiling(model: string): number {
  return model === "hy3" ? 128_000 : /^qwen3\.8-/.test(model) ? 131_072 : SEC_MODEL_OUTPUT_TOKENS;
}

/** Repair format, continue truncated output, or switch a failing model. Never accept incomplete JSON. */
export async function recoverModelJson(options: RecoveryOptions): Promise<Record<string, unknown>> {
  let model = options.model, jsonMode = options.jsonMode;
  let maxTokens = Math.min(SEC_MODEL_OUTPUT_TOKENS, modelOutputCeiling(model));
  let state = await options.checkpoint?.load() ?? null;
  if (state) maxTokens = Math.min(Math.max(maxTokens, state.maxTokens), modelOutputCeiling(model));
  let lastError: unknown;
  const save = async (value: ModelCheckpoint | null) => { state = value; await options.checkpoint?.save(value); };
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < (options.maxCalls ?? SEC_MODEL_RECOVERY_CALLS); attempt++) {
    const prefix = state?.mode === "continue" ? state.content : "";
    const repair = state?.mode === "repair" ? state.content : undefined;
    const combine = (text: string) => prefix && !text.startsWith(prefix) ? prefix + text : text;
    const hold = async (text: string, mode: ModelCheckpoint["mode"]) => {
      if (new TextEncoder().encode(text).byteLength > SEC_MODEL_MAX_CONTENT_BYTES) throw new SecModelOutputError("content_limit", "Model recovery exceeds retained content budget");
      await save(text ? { version: "model-recovery.v1", content: text, mode, maxTokens } : null);
    };
    try {
      await options.heartbeat?.();
      const text = await options.request({ model, maxTokens, jsonMode: jsonMode && !prefix,
        ...(prefix ? { continuation: prefix } : {}), ...(repair ? { repair } : {}),
        checkpoint: (partial) => hold(combine(partial), "continue"),
        heartbeat: options.heartbeat,
      });
      const complete = combine(text);
      try {
        const result = parseModelJson(complete);
        await save(null);
        options.log?.({ event: "sec-model-recovery", stage: options.stage, outcome: "complete", calls: attempt + 1, model, maxTokens });
        return result;
      } catch (error) {
        await hold(complete, "repair");
        throw error;
      }
    } catch (error) {
      lastError = error;
      let action: string;
      if (error instanceof SecModelOutputError) {
        const resumable = ["output_token_limit", "stream_incomplete", "stream_stall", "wire_limit", "reasoning_limit", "frame_limit"].includes(error.code);
        if (resumable) {
          if (error.partialContent) await hold(combine(error.partialContent), "continue");
          maxTokens = Math.min(Math.max(maxTokens * 2, SEC_MODEL_OUTPUT_TOKENS), modelOutputCeiling(model));
          action = state?.content ? "continue" : "switch_model";
          if (!state?.content || error.code === "reasoning_limit") model = model === options.model ? options.fallbackModel : options.model;
        } else if (error.code === "invalid_json") {
          if (!state) await hold(error.partialContent, "repair");
          jsonMode = false;
          if (attempt > 0) model = model === options.model ? options.fallbackModel : options.model;
          action = "repair_json";
        } else if (error.code === "content_limit") {
          // A size safeguard is not permission to publish a shortened or truncated result.
          throw error;
        } else {
          model = model === options.model ? options.fallbackModel : options.model;
          jsonMode = false;
          action = "switch_model";
        }
      } else if (error instanceof SecModelHttpError) {
        if ([401, 403, 404].includes(error.status)) throw error;
        if (error.status === 400 && /max.?tokens|output.{0,20}(limit|tokens)|maximum.{0,30}tokens/i.test(error.message)) {
          const limit = error.message.match(/(?:at most|maximum|max(?:imum)?(?:_tokens)?|limit)[^\d]{0,40}([\d,]{4,7})/i)?.[1];
          const supported = limit ? Number(limit.replaceAll(",", "")) : Math.floor(maxTokens / 2);
          maxTokens = Math.max(1024, Math.min(maxTokens - 1, supported));
          action = "negotiate_token_budget";
        } else if (error.status === 400 && /json|response_format|schema|parameter/i.test(error.message) && jsonMode) {
          jsonMode = false; action = "plain_json_transport";
        } else if (error.status === 408 || error.status === 429 || error.status >= 500) {
          model = model === options.model ? options.fallbackModel : options.model;
          action = "backoff_and_switch_model";
          await sleep(Math.min(300_000, Math.max(error.retryAfterMs, 1000 * 2 ** attempt)));
        } else throw error;
      } else {
        // A durable retry owns execution-budget failures; do not start calls with an expired budget.
        if (/model-timeout:execution-budget|first-response/.test(String(error))) throw error;
        if (!(error instanceof TypeError)) throw error;
        model = model === options.model ? options.fallbackModel : options.model;
        action = "retry_transport";
        await sleep(Math.min(30_000, 1000 * 2 ** attempt));
      }
      maxTokens = Math.min(maxTokens, modelOutputCeiling(model));
      options.log?.({ event: "sec-model-recovery", stage: options.stage, outcome: "recovering", attempt: attempt + 1, action, model,
        failureCode: error instanceof SecModelOutputError ? error.code : error instanceof SecModelHttpError ? `http:${error.status}` : "transport", retainedCharacters: state?.content.length ?? 0, maxTokens });
    }
  }
  throw lastError;
}
