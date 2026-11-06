/**
 * Lab load timings for the business site: a fresh browser per load, an empty cache, and optionally a slow
 * profile (150 ms round trip, 1.6 Mbps down, 750 Kbps up, 4x CPU). Pages alternate within each round.
 *
 *   npm run perf:lab -- --base https://example.workers.dev --pages /,/companies/NVDA --runs 7 --profile slow,fast --out perf.json
 *
 * "content" is when the main content first appears: the company flow chart, or the home table's first row.
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { chromium, type Browser } from "playwright-core";

const { values } = parseArgs({
  options: {
    base: { type: "string", default: "https://spontra-business-map.max-zhangyuchen.workers.dev" },
    pages: { type: "string", default: "/,/companies/NVDA" },
    runs: { type: "string", default: "7" },
    profile: { type: "string", default: "slow,fast" },
    lang: { type: "string", default: "en-US" },
    channel: { type: "string", default: "chrome" },
    out: { type: "string" },
  },
});

type Profile = { name: string; latency: number; down: number; up: number; cpu: number };
const PROFILES: Record<string, Profile> = {
  slow: { name: "slow", latency: 150, down: 1.6e6 / 8, up: 750e3 / 8, cpu: 4 },
  fast: { name: "fast", latency: 0, down: -1, up: -1, cpu: 1 },
};
const CONTENT = ".fc-svg, .fc-compact-node, .home-table tbody tr:not(.home-ghost)";

type Sample = { ttfb: number; fcp: number | null; lcp: number | null; content: number | null; contentMark: number | null; jsBeforeContentKB: number; jsKB: number; totalKB: number; requests: number };

/** Runs in the page before any of its scripts. */
function observeContent(selector: string) {
  const w = window as unknown as { __content?: number; __lcp?: number };
  new PerformanceObserver(list => { for (const e of list.getEntries()) w.__lcp = e.startTime; }).observe({ type: "largest-contentful-paint", buffered: true });
  const seen = () => {
    if (w.__content !== undefined || !document.querySelector(selector)) return false;
    // The frame after the DOM change is the first one that can show it.
    requestAnimationFrame(() => { w.__content ??= performance.now(); });
    return true;
  };
  const watch = new MutationObserver(() => { if (seen()) watch.disconnect(); });
  document.addEventListener("readystatechange", () => { if (!seen()) watch.observe(document.documentElement, { childList: true, subtree: true }); }, { once: true });
}

async function load(browser: Browser, url: string, profile: Profile): Promise<Sample> {
  const context = await browser.newContext({ locale: values.lang, viewport: { width: 1440, height: 900 } });
  try {
    // Lab loads stay out of the product's own usage numbers.
    await context.route("**/api/business/v1/telemetry", route => route.abort());
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: profile.latency, downloadThroughput: profile.down, uploadThroughput: profile.up });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpu });
    await page.addInitScript(observeContent, CONTENT);
    await page.goto(url, { waitUntil: "load", timeout: 120_000 });
    await page.waitForFunction(() => (window as unknown as { __content?: number }).__content !== undefined, null, { timeout: 120_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    return await page.evaluate(() => {
      const w = window as unknown as { __content?: number; __lcp?: number };
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
      const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
      const content = w.__content ?? null;
      const kb = (list: PerformanceResourceTiming[]) => Math.round(list.reduce((sum, e) => sum + e.transferSize, 0) / 1024);
      const scripts = resources.filter(e => /\.m?js(\?|$)/.test(new URL(e.name).pathname));
      return {
        ttfb: Math.round(nav.responseStart),
        fcp: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null,
        lcp: w.__lcp ?? null,
        content,
        contentMark: performance.getEntriesByName("bv:content", "mark")[0]?.startTime ?? null,
        jsBeforeContentKB: content === null ? kb(scripts) : kb(scripts.filter(e => e.responseEnd <= content)),
        jsKB: kb(scripts),
        totalKB: kb(resources) + Math.round(nav.transferSize / 1024),
        requests: resources.length + 1,
      };
    });
  } finally {
    await context.close();
  }
}

function median(list: Array<number | null>): number | null {
  const sorted = list.filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = sorted.length >> 1;
  return Math.round(sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
}

const pages = values.pages.split(",").map(path => path.trim()).filter(Boolean);
const runs = Math.max(1, Number(values.runs));
const profiles = values.profile.split(",").map(name => PROFILES[name.trim()] ?? (() => { throw new Error(`unknown profile ${name}`); })());
const results: Record<string, Record<string, Sample[]>> = {};
for (const profile of profiles) {
  results[profile.name] = Object.fromEntries(pages.map(path => [path, []]));
  for (let run = 0; run < runs; run++) {
    // Alternate which page goes first so neither always meets a colder edge.
    for (const path of run % 2 ? [...pages].reverse() : pages) {
      const browser = await chromium.launch({ channel: values.channel, headless: true });
      try {
        const sample = await load(browser, new URL(path, values.base).href, profile);
        results[profile.name]![path]!.push(sample);
        process.stderr.write(`${profile.name} ${path} #${run + 1}: content ${sample.content === null ? "—" : Math.round(sample.content)} ms\n`);
      } finally {
        await browser.close();
      }
    }
  }
}

const rows = Object.entries(results).flatMap(([profile, byPage]) => Object.entries(byPage).map(([path, samples]) => ({
  profile, path, runs: samples.length,
  content: median(samples.map(s => s.content)), lcp: median(samples.map(s => s.lcp)), fcp: median(samples.map(s => s.fcp)), ttfb: median(samples.map(s => s.ttfb)),
  jsBeforeContentKB: median(samples.map(s => s.jsBeforeContentKB)), jsKB: median(samples.map(s => s.jsKB)), totalKB: median(samples.map(s => s.totalKB)), requests: median(samples.map(s => s.requests)),
  missingContent: samples.filter(s => s.content === null).length,
})));
console.table(rows);
if (values.out) writeFileSync(values.out, JSON.stringify({ base: values.base, lang: values.lang, at: new Date().toISOString(), profiles, medians: rows, samples: results }, null, 2));
