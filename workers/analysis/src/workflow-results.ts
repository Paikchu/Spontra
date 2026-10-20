type ResultBucket = {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, value: string, options?: { httpMetadata: { contentType: string } }): Promise<unknown>;
};
type StoredResult = { __secStoredStepResult: "v1"; key: string; sha256: string };
export const INLINE_WORKFLOW_RESULT_BYTES = 512 * 1024;
async function sha256(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Workflows limit non-stream step results to 1 MiB. Persist large results externally, not less analysis. */
export async function storeWorkflowResult<T>(bucket: ResultBucket, instanceId: string, stepName: string, value: T): Promise<T | StoredResult> {
  const json = JSON.stringify(value);
  if (json === undefined || new TextEncoder().encode(json).byteLength <= INLINE_WORKFLOW_RESULT_BYTES) return value;
  const digest = await sha256(json);
  const key = `workflow-results/v1/${encodeURIComponent(instanceId)}/${await sha256(stepName)}/${digest}.json`;
  await bucket.put(key, json, { httpMetadata: { contentType: "application/json" } });
  return { __secStoredStepResult: "v1", key, sha256: digest };
}

export async function loadWorkflowResult<T>(bucket: ResultBucket, value: T | StoredResult): Promise<T> {
  if (!value || typeof value !== "object" || !("__secStoredStepResult" in value) || value.__secStoredStepResult !== "v1") return value as T;
  const reference = value as StoredResult;
  if (!reference.key.startsWith("workflow-results/v1/") || !/^[a-f0-9]{64}$/.test(reference.sha256)) throw new Error("Invalid stored Workflow result reference");
  const object = await bucket.get(reference.key);
  if (!object) throw new Error("Stored Workflow result is missing");
  const json = await object.text();
  if (await sha256(json) !== reference.sha256) throw new Error("Stored Workflow result integrity check failed");
  return JSON.parse(json) as T;
}
