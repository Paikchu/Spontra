export const SEC_FALLBACK_MODEL = "hy3";
// Network generation is governed by progress. These are only runaway safeguards;
// leave one minute for validation and persistence before the enclosing step expires.
export const SEC_MODEL_EXECUTION_BUDGET_MS = 29 * 60_000;
export const SEC_WORKFLOW_STEP_TIMEOUT = "30 minutes";
export const SEC_MODEL_FIRST_RESPONSE_MS = 90_000;
export const SEC_MODEL_STALL_MS = 60_000;
export const SEC_MODEL_MAX_RESPONSE_BYTES = 2_000_000;

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
