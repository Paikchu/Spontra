export const SEC_FALLBACK_MODEL = "deepseek-flash";
// Network generation is governed by progress. These are only runaway safeguards;
// leave one minute for validation and persistence before the enclosing step expires.
export const SEC_MODEL_EXECUTION_BUDGET_MS = 59 * 60_000;
export const SEC_WORKFLOW_STEP_TIMEOUT = "60 minutes";
export const SEC_MODEL_FIRST_RESPONSE_MS = 90_000;
export const SEC_MODEL_STALL_MS = 60_000;
// Wire bytes include repeated SSE envelopes. Only bounded content is retained in memory.
export const SEC_MODEL_MAX_RESPONSE_BYTES = 256 * 1024 * 1024;
export const SEC_MODEL_MAX_CONTENT_BYTES = 8 * 1024 * 1024;
export const SEC_MODEL_MAX_REASONING_BYTES = 64 * 1024 * 1024;
export const SEC_MODEL_MAX_FRAME_BYTES = 1024 * 1024;
export const SEC_MODEL_OUTPUT_TOKENS = 65_536;
export const SEC_MODEL_RECOVERY_CALLS = 6;
// Covers one model attempt, maximum retry backoff, and commit overhead.
export const SEC_MEMORY_MODEL_LEASE_MS = SEC_MODEL_EXECUTION_BUDGET_MS + 6 * 60_000;

export type SecModelExecution = {
  attempt: number;
  model?: string;
  finalAttempt: boolean;
};

const RETRY_DELAYS_MS = [30_000, 90_000, 180_000] as const;
const JITTER_RATIO = 0.2;

export function modelExecutionForAttempt(attempt: number): SecModelExecution {
  const normalizedAttempt = Math.max(1, Math.floor(attempt));
  return {
    attempt: normalizedAttempt,
    ...(normalizedAttempt > 1 ? { model: SEC_FALLBACK_MODEL } : {}),
    finalAttempt: normalizedAttempt >= RETRY_DELAYS_MS.length + 1,
  };
}

export function retryDelayForAttempt(attempt: number, random: () => number = Math.random): number {
  const index = Math.min(Math.max(1, Math.floor(attempt)), RETRY_DELAYS_MS.length) - 1;
  const baseDelay = RETRY_DELAYS_MS[index];
  const randomValue = Math.min(1, Math.max(0, random()));
  return Math.round(baseDelay * (1 - JITTER_RATIO + randomValue * JITTER_RATIO * 2));
}
