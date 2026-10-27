/** Anonymous product events. The server rejects anything outside this list. */
export const TRACK_NAMES = [
  "page_view", "search_submit", "search_select", "company_tab_view", "finding_expand",
  "source_click", "chart_period_change", "lang_toggle", "theme_toggle", "error_shown",
  "tour_start", "tour_done", "tour_skip",
] as const;

export type TrackName = (typeof TRACK_NAMES)[number];

const SID_KEY = "bv-sid";
const SID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const pageRecent = new Map<string, number>();

export type TrackPrivacy = { doNotTrack?: string | null; globalPrivacyControl?: boolean };

/** 「请勿追踪」or Global Privacy Control: send nothing. */
export function privacyBlocks(nav: TrackPrivacy | null | undefined): boolean {
  return nav?.doNotTrack === "1" || nav?.globalPrivacyControl === true;
}

export type TrackDelivery = {
  beacon: (url: string, body: string) => boolean;
  fetch: (url: string, body: string) => void;
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void } | null;
  privacy: TrackPrivacy | null;
  path: string;
  lang: string;
  theme: string;
  now: number;
  uuid: () => string;
  recent?: Map<string, number>;
};

function sessionId(env: TrackDelivery): string | null {
  const storage = env.storage;
  if (!storage) return null;
  try {
    const saved = storage.getItem(SID_KEY);
    if (saved && SID.test(saved)) return saved;
    const next = env.uuid();
    if (!SID.test(next)) return null;
    storage.setItem(SID_KEY, next);
    return next;
  } catch {
    return null;
  }
}

function cleanProps(props: Record<string, string | number> | undefined): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (!props) return out;
  for (const [key, value] of Object.entries(props)) {
    if (Object.keys(out).length >= 6) break;
    if (typeof value === "string") out[key] = value.slice(0, 40);
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/** Builds and sends one event. Returns the body that left the browser, or null when it was dropped. */
export function sendTrack(env: TrackDelivery, name: TrackName, props?: Record<string, string | number>): string | null {
  try {
    if (privacyBlocks(env.privacy)) return null;
    if (!TRACK_NAMES.includes(name)) return null;
    const recent = env.recent ?? pageRecent;
    const stamp = `${name}:${env.path}`;
    const now = env.now;
    const seen = recent.get(stamp) ?? 0;
    if ((name === "page_view" || name === "tour_start") && now - seen < 800) return null;
    const sid = sessionId(env);
    if (!sid) return null;
    const body = JSON.stringify({
      name, props: cleanProps(props), path: env.path.slice(0, 180), lang: env.lang === "zh-CN" ? "zh-CN" : "en",
      theme: env.theme === "light" ? "light" : "dark", ts: now, sid,
    });
    if (body.length > 900) return null;
    recent.set(stamp, now);
    try {
      if (env.beacon("/api/business/v1/telemetry", body)) return body;
    } catch { /* Fall through to fetch. */ }
    try { env.fetch("/api/business/v1/telemetry", body); } catch { /* Discard. */ }
    return body;
  } catch {
    return null;
  }
}

function browserEnv(): TrackDelivery | null {
  if (typeof window === "undefined") return null;
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  let storage: TrackDelivery["storage"] = null;
  try { storage = window.sessionStorage; } catch { storage = null; }
  return {
    beacon: (url, body) => {
      if (typeof navigator.sendBeacon !== "function") return false;
      return navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
    },
    fetch: (url, body) => { void fetch(url, { method: "POST", body, keepalive: true, headers: { "content-type": "application/json" } }).catch(() => {}); },
    storage,
    privacy: nav,
    path: location.pathname,
    lang: document.documentElement.lang === "zh-CN" ? "zh-CN" : "en",
    theme: document.documentElement.classList.contains("light") ? "light" : "dark",
    now: Date.now(),
    uuid: () => crypto.randomUUID(),
  };
}

/** Fire-and-forget. Failure is discarded and never retried. */
export function track(name: TrackName, props?: Record<string, string | number>): void {
  const env = browserEnv();
  if (env) sendTrack(env, name, props);
}
