import { track } from "./track.ts";

/** The page's main content: the company flow chart or the home table. Lab runs and field reports read the same mark. */
export const CONTENT_MARK = "bv:content";

export type VitalsRoute = "home" | "company";

export type VitalsSample = {
  ttfb?: number;
  fcp?: number;
  lcp?: number;
  /** Largest session window of unexpected layout shifts. */
  cls?: number;
  inp?: number;
  /** Time until the main content was first on screen. */
  content?: number;
};

/** At most six numbers; CLS travels in thousandths so every field is an integer. */
function vitalsProps(sample: VitalsSample): Record<string, number> {
  const out: Record<string, number> = {};
  const put = (key: keyof VitalsSample, scale = 1) => {
    const value = sample[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[key] = Math.round(value * scale);
  };
  put("ttfb"); put("fcp"); put("lcp"); put("cls", 1000); put("inp"); put("content");
  return out;
}

/** CLS: shifts closer than 1 s apart form a window of at most 5 s; the largest window counts. */
function largestShiftWindow(shifts: ReadonlyArray<{ startTime: number; value: number }>): number {
  let best = 0, sum = 0, first = -Infinity, last = -Infinity;
  for (const shift of shifts) {
    if (shift.startTime - last >= 1000 || shift.startTime - first >= 5000) { sum = 0; first = shift.startTime; }
    sum += shift.value;
    last = shift.startTime;
    best = Math.max(best, sum);
  }
  return best;
}

/** INP: the slowest interaction, skipping one for every 50 so a rare outlier on a long visit does not decide it. */
function interactionLatency(durations: ReadonlyMap<number, number>): number | undefined {
  if (durations.size === 0) return undefined;
  const sorted = [...durations.values()].sort((a, b) => b - a);
  return sorted[Math.min(sorted.length - 1, Math.floor(durations.size / 50))];
}

function routeOf(path: string): VitalsRoute | null {
  if (path === "/" || path === "") return "home";
  return /^\/companies\/[^/]+\/?$/.test(path) ? "company" : null;
}

const landing = typeof location === "undefined" ? "" : location.pathname;

/** Marks the main content once, and only for the route the page was loaded on: later in-app moves are not a page load. */
export function markContent(route: VitalsRoute): void {
  try {
    if (routeOf(landing) !== route || routeOf(location.pathname) !== route) return;
    if (performance.getEntriesByName(CONTENT_MARK, "mark").length > 0) return;
    // The mark is set after the frame that shows the content is painted.
    requestAnimationFrame(() => setTimeout(() => {
      if (performance.getEntriesByName(CONTENT_MARK, "mark").length === 0) performance.mark(CONTENT_MARK);
    }, 0));
  } catch { /* Timing is optional. */ }
}

function observe(type: string, callback: (entries: PerformanceEntry[]) => void, options: Record<string, unknown> = {}): void {
  try {
    if (!PerformanceObserver.supportedEntryTypes?.includes(type)) return;
    new PerformanceObserver(list => callback(list.getEntries())).observe({ type, buffered: true, ...options } as PerformanceObserverInit);
  } catch { /* Unsupported entry type. */ }
}

/** Reports one load's Web Vitals when the page is first hidden. A load that started in the background is not reported. */
export function startVitals(): void {
  if (typeof window === "undefined" || typeof PerformanceObserver === "undefined") return;
  const route = routeOf(landing);
  if (!route || document.visibilityState === "hidden") return;
  let hiddenAt = Infinity;
  let lcp: number | undefined;
  let fcp: number | undefined;
  const shifts: Array<{ startTime: number; value: number }> = [];
  const interactions = new Map<number, number>();
  observe("paint", entries => { for (const e of entries) if (e.name === "first-contentful-paint" && e.startTime < hiddenAt) fcp = e.startTime; });
  observe("largest-contentful-paint", entries => { for (const e of entries) if (e.startTime < hiddenAt) lcp = e.startTime; });
  observe("layout-shift", entries => {
    for (const e of entries as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>) if (!e.hadRecentInput) shifts.push({ startTime: e.startTime, value: e.value });
  });
  observe("event", entries => {
    for (const e of entries as Array<PerformanceEntry & { interactionId?: number }>) {
      if (!e.interactionId) continue;
      interactions.set(e.interactionId, Math.max(interactions.get(e.interactionId) ?? 0, e.duration));
    }
  }, { durationThreshold: 40 });
  // A tap on a page that never scrolls or clicks again still counts as one interaction.
  observe("first-input", entries => {
    for (const e of entries as Array<PerformanceEntry & { interactionId?: number }>) if (e.interactionId && !interactions.has(e.interactionId)) interactions.set(e.interactionId, e.duration);
  });
  let sent = false;
  const flush = () => {
    if (sent) return;
    sent = true;
    hiddenAt = Math.min(hiddenAt, performance.now());
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const content = performance.getEntriesByName(CONTENT_MARK, "mark")[0]?.startTime;
    const props = vitalsProps({
      ttfb: nav && nav.responseStart > 0 ? nav.responseStart : undefined,
      fcp, lcp,
      cls: largestShiftWindow(shifts),
      inp: interactionLatency(interactions),
      content: content !== undefined && content < hiddenAt ? content : undefined,
    });
    track("web_vitals", props, landing);
  };
  addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); }, { capture: true });
  addEventListener("pagehide", flush, { capture: true });
}
