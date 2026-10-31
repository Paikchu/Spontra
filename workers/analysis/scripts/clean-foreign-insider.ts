/**
 * Removes the Form 4s about other issuers from stored event rails (B1): a company that is itself a filer (Berkshire)
 * reports its trades in other companies' stock, and those filings sit in its own submission list. Before the issuer was
 * parsed they were published as the company's insider trades. No model calls; reads EDGAR documents only.
 *
 * Dry run by default: lists what would change and writes nothing. `--apply` writes, and only with `--source d1`.
 *
 *   node --experimental-strip-types workers/analysis/scripts/clean-foreign-insider.ts --tickers BRK.B
 *   node --experimental-strip-types workers/analysis/scripts/clean-foreign-insider.ts --source api --origin https://businessview.info --tickers BRK.B,NVDA,TSM
 *   node --experimental-strip-types workers/analysis/scripts/clean-foreign-insider.ts --tickers BRK.B --apply
 *
 * `--source d1` (default) reads `events:v1:<ticker>` and the company CIK from the analysis D1 through wrangler (`--local`
 * for the local database); `--source api` reads the public events route and the CIK from EDGAR's ticker list, read only.
 * Applying rewrites each affected publication without the foreign filings and records each such accession in the
 * insider cache as `{ otherIssuer }`, the entry the event refresh itself now writes, so it is never read or kept again.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventsPublication } from "../../../shared/analysis-contract/events.ts";
import { readEventsPublication } from "../../../shared/analysis-runtime/events.ts";
import { checkInsiderIssuers, withoutForeign } from "../src/events/foreign-insider.ts";
import { eventsCacheKey, insiderCacheKey } from "../src/events/read.ts";

const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] ?? null : null; };
const apply = args.includes("--apply");
const source = option("source") ?? "d1";
const origin = option("origin") ?? "https://businessview.info";
// EDGAR refuses reads without a contact; use the one the worker is configured with (SEC_USER_AGENT in wrangler.jsonc).
const userAgent = option("user-agent") ?? process.env.SEC_USER_AGENT ?? null;
if (!userAgent) throw new Error("Pass --user-agent or set SEC_USER_AGENT: EDGAR needs a contact user-agent");
const local = args.includes("--local");
if (source !== "d1" && source !== "api") throw new Error("--source is d1 or api");
if (apply && source !== "d1") throw new Error("--apply writes D1 and needs --source d1");

const wrangler = ["wrangler", "d1", "execute", "DB", "--config", "workers/analysis/wrangler.jsonc", "--env=", local ? "--local" : "--remote", "--json"];
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
function d1<T>(sql: string): T[] {
  const out = JSON.parse(execFileSync("npx", [...wrangler, "--command", sql], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })) as Array<{ results: T[] }>;
  return out[0]?.results ?? [];
}

let last = 0;
/** EDGAR's fair-access pace (well under ten requests a second) with its required contact user-agent. */
async function sec(url: string): Promise<Response> {
  const wait = last + 150 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  last = Date.now();
  return fetch(url, { headers: { "user-agent": userAgent, accept: "application/xml,application/json,text/xml" } });
}
const readDocument = async (url: string) => { const r = await sec(url); return r.ok ? r.text() : null; };

async function tickers(): Promise<string[]> {
  const listed = option("tickers");
  if (listed) return listed.split(",").map(t => t.trim().toUpperCase()).filter(Boolean);
  if (source === "api") throw new Error("--source api needs --tickers");
  return d1<{ key: string }>("SELECT cache_key AS key FROM sec_cache WHERE cache_key LIKE 'events:v1:%' ORDER BY cache_key").map(r => r.key.slice("events:v1:".length));
}

let edgarTickers: Record<string, { cik_str: number; ticker: string }> | null = null;
async function companyCik(ticker: string): Promise<string | null> {
  if (source === "d1") {
    const row = d1<{ cik: string | null }>(`SELECT json_extract(payload, '$.company.cik') AS cik FROM sec_cache WHERE cache_key = ${quote(`sec:filings:${ticker}`)}`)[0];
    if (row?.cik) return String(row.cik);
  }
  edgarTickers ??= await (await sec("https://www.sec.gov/files/company_tickers.json")).json() as Record<string, { cik_str: number; ticker: string }>;
  const dashed = ticker.replace(".", "-");
  const hit = Object.values(edgarTickers).find(c => c.ticker.toUpperCase() === ticker || c.ticker.toUpperCase() === dashed);
  return hit ? String(hit.cik_str) : null;
}

async function publication(ticker: string): Promise<EventsPublication | null> {
  if (source === "d1") {
    const row = d1<{ payload: string }>(`SELECT payload FROM sec_cache WHERE cache_key = ${quote(eventsCacheKey(ticker))}`)[0];
    return row ? readEventsPublication(JSON.parse(row.payload), ticker) : null;
  }
  const response = await fetch(`${origin}/api/business/v1/companies/${encodeURIComponent(ticker)}/events`, { headers: { accept: "application/json" } });
  if (!response.ok) return null;
  const body = await response.json() as { events?: unknown };
  return readEventsPublication(body.events, ticker);
}

const statements: string[] = [];
const now = new Date().toISOString();
let affectedEvents = 0, affectedCompanies = 0;
for (const ticker of await tickers()) {
  const stored = await publication(ticker);
  const cik = await companyCik(ticker);
  if (!stored || !cik) { console.log(`${ticker}: ${!stored ? "no events publication" : "no CIK"}, skipped`); continue; }
  const checks = await checkInsiderIssuers(stored, cik, readDocument);
  const foreign = checks.filter(c => c.foreign);
  const unreadable = checks.filter(c => c.via === "unreadable").length;
  console.log(`${ticker} (CIK ${cik}): ${checks.length} insider events, ${foreign.length} about another issuer${unreadable ? `, ${unreadable} unreadable (kept)` : ""}`);
  for (const c of foreign) console.log(`  ${c.event.id}  ${c.event.filedAt}  issuer ${c.issuerCik}${c.issuerTradingSymbol ? ` ${c.issuerTradingSymbol}` : ""}  owner ${c.event.insider?.ownerName}`);
  const cleaned = withoutForeign(stored, checks);
  if (!cleaned) continue;
  affectedEvents += foreign.length; affectedCompanies++;
  statements.push(`UPDATE sec_cache SET payload = ${quote(JSON.stringify(cleaned))}, fetched_at = ${quote(now)} WHERE cache_key = ${quote(eventsCacheKey(ticker))};`);
  for (const c of foreign) statements.push(`INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (${quote(insiderCacheKey(ticker, c.event.id))}, ${quote(JSON.stringify({ otherIssuer: c.issuerCik }))}, ${quote(now)}) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at;`);
}

console.log(`\n${affectedEvents} events about another issuer across ${affectedCompanies} companies; ${statements.length} rows to write (${affectedCompanies} publications, ${affectedEvents} insider cache entries).`);
if (!apply) { console.log("Dry run: nothing written. Re-run with --apply (and --source d1) to write."); process.exit(0); }
if (!statements.length) { console.log("Nothing to write."); process.exit(0); }
const file = join(mkdtempSync(join(tmpdir(), "foreign-insider-")), "clean.sql");
writeFileSync(file, statements.join("\n"));
execFileSync("npx", [...wrangler, "--file", file], { stdio: "inherit" });
console.log(`Applied ${statements.length} statements from ${file}.`);
