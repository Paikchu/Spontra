/**
 * A wait the caller gets out of on time, even if the awaited promise never settles or ignores its abort signal: a
 * promise left pending would have the runtime cancel the whole invocation, skipping its cleanup.
 */
export async function within<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
  const expired = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => { expired.abort(); resolve(null); }, ms); });
  try { return await Promise.race([work(expired.signal), timeout]); }
  catch (error) { if (expired.signal.aborted) return null; throw error; }
  finally { clearTimeout(timer); }
}
