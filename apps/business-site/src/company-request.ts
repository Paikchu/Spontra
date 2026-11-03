/** Retry-After accepts seconds or an HTTP date. A missing header uses one minute. */
export function retryDelay(value: string | null, now = Date.now()): number {
  if (value != null && /^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value) * 1000;
  const date = value ? Date.parse(value) : NaN;
  return Number.isFinite(date) ? Math.max(0, date - now) : 60_000;
}
const listeners = new Set<(waiting: boolean) => void>();
let waiting = 0;
export function observeRateLimit(listener: (waiting: boolean) => void): () => void {
  listeners.add(listener);
  listener(waiting > 0);
  return () => { listeners.delete(listener); };
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
/** Exactly one automatic retry per read, cancelled when its page leaves. */
export async function companyRequest(url: string, signal: AbortSignal, initial?: Promise<Response>): Promise<Response> {
  const response = await (initial ?? fetch(url, { signal }));
  signal.throwIfAborted();
  if (response.status !== 429 || response.headers.has("x-retry-exhausted")) return response;
  waiting++;
  listeners.forEach(listener => listener(true));
  try {
    await pause(retryDelay(response.headers.get("retry-after")), signal);
    return await fetch(url, { signal });
  } finally {
    waiting--;
    listeners.forEach(listener => listener(waiting > 0));
  }
}
