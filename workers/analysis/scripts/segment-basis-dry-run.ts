/**
 * Segment-basis dry run (B6): what a re-segmentation changes in the stored revenue histories, read only. No model calls
 * and nothing is written; there is no apply mode.
 *
 * The page reads segment bases at read time (shared/analysis-runtime/segment-basis.ts): a business is compared only
 * with a quarter on the same basis, preferring the year-ago quarter restated in the quarter's own filing, and the
 * revenue history already keeps that restated comparative (the newest filing wins each period). So no stored row needs
 * rewriting; this lists, per company, the rows and comparisons the read-time rule changes:
 *
 * - the history row (`sec:revenue-history:v1:<cik>`) when its quarters span more than one segment basis;
 * - quarters on an earlier basis than the latest split quarter (the trend sets them apart);
 * - business comparisons (year over year and quarter over quarter) between quarters on different bases that a name or
 *   member-id match alone would have made, now left out;
 * - the latest quarter's businesses read against a year-ago quarter restated in the latest filing.
 *
 *   node --experimental-strip-types workers/analysis/scripts/segment-basis-dry-run.ts --tickers MSFT,SPCX
 *   node --experimental-strip-types workers/analysis/scripts/segment-basis-dry-run.ts --source d1
 *
 * `--source api` (default) reads the public company route (`--origin`, default https://businessview.info); `--source d1`
 * runs one SELECT over the analysis D1 through wrangler (`--local` for the local database).
 */
import { execFileSync } from "node:child_process";
import type { RevenueHistory, RevenueHistoryQuarter } from "../../../shared/analysis-contract/revenue-history.ts";
import { basisChangedAt, basisRuns, businessValue, sameBasis, segmentBasis, yearAgoOnBasis } from "../../../shared/analysis-runtime/segment-basis.ts";

const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] ?? null : null; };
const source = option("source") ?? "api";
const origin = option("origin") ?? "https://businessview.info";
if (source !== "api" && source !== "d1") throw new Error("--source is api or d1");

async function histories(): Promise<Array<{ key: string; history: RevenueHistory }>> {
  if (source === "d1") {
    const command = ["wrangler", "d1", "execute", "DB", "--config", "workers/analysis/wrangler.jsonc", "--env=", args.includes("--local") ? "--local" : "--remote", "--json",
      "--command", "SELECT cache_key AS key, payload FROM sec_cache WHERE cache_key >= 'sec:revenue-history:v1:' AND cache_key < 'sec:revenue-history:v1;' ORDER BY cache_key"];
    const out = JSON.parse(execFileSync("npx", command, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })) as Array<{ results: Array<{ key: string; payload: string }> }>;
    return (out[0]?.results ?? []).map(row => ({ key: row.key, history: JSON.parse(row.payload) as RevenueHistory }));
  }
  const listed = option("tickers")?.split(",").map(t => t.trim().toUpperCase()).filter(Boolean)
    ?? ((await (await fetch(`${origin}/api/business/v1/home`)).json()) as { companies: Array<{ ticker: string }> }).companies.map(c => c.ticker);
  const out: Array<{ key: string; history: RevenueHistory }> = [];
  for (const ticker of listed) {
    const body = await (await fetch(`${origin}/api/business/v1/companies/${encodeURIComponent(ticker)}`)).json() as { history?: RevenueHistory | null; flow?: { quarters?: Array<{ sources?: Array<{ id: string; url: string }> }> } };
    if (!body.history?.quarters?.length) { console.log(`${ticker}: no revenue history, skipped`); continue; }
    const cik = body.flow?.quarters?.flatMap(q => q.sources ?? []).map(s => s.url.match(/edgar\/data\/(\d+)\//)?.[1]).find(Boolean) ?? "?";
    out.push({ key: `sec:revenue-history:v1:${cik.padStart(10, "0")} (${ticker})`, history: body.history });
  }
  return out;
}

const sorted = (h: RevenueHistory) => [...h.quarters].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
const DAY = 86_400_000;
const at = (h: RevenueHistory, end: string, days: number) => sorted(h).find(q => Math.abs(Date.parse(q.periodEnd) - (Date.parse(end) - days * DAY)) <= 20 * DAY) ?? null;
const nameMatch = (a: RevenueHistoryQuarter, b: RevenueHistoryQuarter) => a.segments.filter(s => businessValue(b, s) != null).map(s => s.name);

let rows = 0, earlier = 0, suppressed = 0, restated = 0;
for (const { key, history } of await histories()) {
  const quarters = sorted(history);
  const runs = basisRuns(history), starts = runs.filter(r => r.starts);
  if (!starts.length) { console.log(`${history.ticker}: ${quarters.length} quarters, one segment basis`); continue; }
  rows++;
  const latest = [...quarters].reverse().find(q => segmentBasis(q.segments) != null)!;
  const old = quarters.filter(q => segmentBasis(q.segments) != null && !sameBasis(q.segments, latest.segments));
  const crossings: string[] = [];
  for (const q of quarters) for (const [lag, days] of [["YoY", 365], ["QoQ", 91]] as const) {
    const base = at(history, q.periodEnd, days);
    if (!base || segmentBasis(q.segments) == null || segmentBasis(base.segments) == null || sameBasis(q.segments, base.segments)) continue;
    const named = nameMatch(q, base);
    if (named.length) crossings.push(`${q.periodEnd} ${lag} vs ${base.periodEnd}: ${named.join(", ")}`);
  }
  const base = yearAgoOnBasis(history, latest.periodEnd, latest.segments, latest.currency);
  const reads = base?.restatedInFiling ? latest.segments.map(s => { const now = Number(s.value) * latest.scale, before = businessValue(base.quarter, s); return `${s.name} ${before ? `${((now / before - 1) * 100).toFixed(1)}%` : "n/a"}`; }) : [];
  earlier += old.length; suppressed += crossings.length; restated += reads.length;
  console.log(`${history.ticker} (${key}): ${quarters.length} quarters; basis starts ${starts.map(s => s.periodEnd).join(", ")}; latest split ${latest.periodEnd}${basisChangedAt(history, latest.periodEnd) ? " re-based" : ""}`);
  console.log(`  ${old.length} quarters on an earlier basis: ${old.map(q => q.periodEnd).join(", ") || "none"}`);
  console.log(`  ${crossings.length} cross-basis business comparisons left out${crossings.length ? ":" : ""}`);
  for (const c of crossings) console.log(`    ${c}`);
  if (reads.length) console.log(`  latest quarter against the year-ago quarter restated in ${base!.quarter.source.accession} (${base!.quarter.periodEnd}): ${reads.join("; ")}`);
}
console.log(`\n${rows} revenue-history rows span more than one segment basis; ${earlier} quarters on an earlier basis; ${suppressed} cross-basis comparisons left out; ${restated} latest-quarter businesses read against a restated year-ago quarter.`);
console.log("Dry run: read only, nothing written (the rule applies at read time; no stored row needs rewriting).");
