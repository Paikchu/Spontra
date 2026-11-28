export class SecModelHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number;
  readonly providerCode?: string;
  constructor(status: number, message: string, retryAfterMs = 0, providerCode?: string) { super(message); this.name = "SecModelHttpError"; this.status = status; this.retryAfterMs = retryAfterMs; this.providerCode = providerCode; }
}
export type ModelRequestOptions = {
  model: string;
  maxTokens: number;
  continuation?: string;
  repair?: string;
  checkpoint?: (content: string) => Promise<void>;
  heartbeat?: () => Promise<void>;
  workflowInstanceId?: string;
};
