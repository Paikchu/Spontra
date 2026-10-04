export class AdminApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function adminApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/admin/${path}`, {
    ...options, cache: "no-store", credentials: "same-origin",
    headers: { "content-type": "application/json", ...options.headers },
  });
  const payload = await response.json().catch(() => ({ error: "服务暂时不可用。" })) as T & { error?: string };
  if (!response.ok) throw new AdminApiError(payload.error ?? "操作未完成，请重试。", response.status);
  return payload;
}
