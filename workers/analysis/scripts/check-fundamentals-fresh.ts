/**
 * Fundamentals freshness check (B9), read only: for every covered company, the latest quarter its SEC fundamentals reach
 * (an income-statement or cash-flow value) against the latest quarter its page shows, and whether the fundamentals are
 * unavailable and why. Exits non-zero when any company's fundamentals are behind its page. No model calls, no writes.
 *
 *   node --experimental-strip-types workers/analysis/scripts/check-fundamentals-fresh.ts [--origin https://businessview.info] [--tickers GOOGL,NBIS]
 */
import { fundamentalsBehind, latestFundamentalsQuarter } from "../../../shared/analysis-runtime/fundamentals-freshness.ts";

const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] ?? null : null; };
const origin = option("origin") ?? "https://businessview.info";
const get = async <T>(path: string) => (await fetch(origin + path, { headers: { accept: "application/json" } })).json() as Promise<T>;

type Home = { companies: Array<{ ticker: string; latestPeriod: { periodEnd: string } | null }> };
type Fundamentals = { status?: string; reason?: string; fundamentals?: { series: Array<{ category: string; points: Array<{ periodEnd: string; valueDecimal: string | null }> }>; unavailable?: { reason: string } } | null };
const home = await get<Home>("/api/business/v1/home");
const only = option("tickers")?.split(",").map(t => t.trim().toUpperCase());
let behind = 0;
for (const company of home.companies.filter(c => !only || only.includes(c.ticker))) {
  const page = company.latestPeriod?.periodEnd ?? null;
  const body = await get<Fundamentals>(`/api/business/v1/companies/${encodeURIComponent(company.ticker)}/fundamentals`);
  const latest = body.fundamentals ? latestFundamentalsQuarter(body.fundamentals.series) : null;
  const unavailable = body.fundamentals?.unavailable?.reason ?? (body.status === "unavailable" ? body.reason ?? "unknown" : null);
  const late = !unavailable && fundamentalsBehind(latest, page);
  if (late) behind++;
  console.log(`${company.ticker.padEnd(6)} page ${page ?? "—"}  fundamentals ${latest ?? "—"}  ${unavailable ? `unavailable (${unavailable})` : late ? "BEHIND" : "ok"}${body.status === "ready" && !latest ? "  ready but empty" : ""}`);
}
console.log(`\n${behind} companies with fundamentals older than their page's latest quarter.`);
process.exit(behind ? 1 : 0);
