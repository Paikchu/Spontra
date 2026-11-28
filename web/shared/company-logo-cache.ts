const CACHE_NAME = "company-logos-v1";
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const loaded = new Map<string, string>();
const pending = new Map<string, Promise<string>>();

export function cachedCompanyLogo(symbol: string): string | undefined {
  return loaded.get(symbol.toUpperCase());
}

export function loadCompanyLogo(symbol: string): Promise<string> {
  const key = symbol.toUpperCase();
  const existing = loaded.get(key);
  if (existing) return Promise.resolve(existing);
  const inflight = pending.get(key);
  if (inflight) return inflight;

  const request = (async () => {
    const url = `https://images.financialmodelingprep.com/symbol/${encodeURIComponent(key)}.png`;
    // Cache Storage is optional (private browsing or quota restrictions can disable it).
    const cache = typeof caches === "undefined" ? undefined : await caches.open(CACHE_NAME).catch(() => undefined);
    const stored = await cache?.match(url).catch(() => undefined);
    const fresh = stored && Date.now() - Number(stored.headers.get("x-logo-cached-at") || 0) < MAX_AGE;
    let response = fresh ? stored : undefined;
    if (!response) {
      try {
        response = await fetch(url, { referrerPolicy: "no-referrer" });
        if (!response.ok || !response.headers.get("content-type")?.startsWith("image/")) {
          throw new Error("Logo unavailable");
        }
        const blob = await response.blob();
        response = new Response(blob, { headers: {
          "content-type": blob.type,
          "x-logo-cached-at": String(Date.now()),
        } });
        await cache?.put(url, response.clone()).catch(() => undefined);
      } catch (error) {
        if (!stored) throw error;
        response = stored;
      }
    }
    // Retain object URLs for the page lifetime so tab remounts reuse decoded images.
    const objectUrl = URL.createObjectURL(await response.blob());
    loaded.set(key, objectUrl);
    return objectUrl;
  })();
  pending.set(key, request);
  void request.then(() => pending.delete(key), () => pending.delete(key));
  return request;
}
