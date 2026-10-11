import { throttledSecReader } from "../financial-data/provider.ts";
import type { SecPipelineEnv } from "../operations.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { knownCik } from "./identity.ts";
import { outboxStatement } from "./outbox.ts";
import { scopeTickers } from "./router.ts";

export const DISCOVERY_HEARTBEAT_KEY = "pipeline:discovery-heartbeat";
const stateKey = (ticker: string) => `sec:discovery:v1:${ticker}`;
/** Forms something downstream reads: periodic reports, current reports and insider transactions, with amendments. */
const ANNOUNCED = /^(?:10-[QK]|20-F|40-F|6-K|8-K|4)(?:\/A)?$/;
const REMEMBERED = 200;

type DiscoveryState = { cik: string; accessions: string[]; checkedAt: string };
type Filing = { accession: string; form: string; items: string; filingDate: string };

function recentFilings(payload: unknown): Filing[] {
  const recent = (payload as { filings?: { recent?: Record<string, unknown[]> } } | null)?.filings?.recent;
  if (!recent || !Array.isArray(recent.accessionNumber)) return [];
  const column = (name: string, i: number) => String((recent[name] as unknown[] | undefined)?.[i] ?? "");
  return recent.accessionNumber.slice(0, REMEMBERED).map((_, i) => ({
    accession: column("accessionNumber", i), form: column("form", i), items: column("items", i), filingDate: column("filingDate", i),
  })).filter(f => /^\d{10}-\d{2}-\d{6}$/.test(f.accession));
}

/**
 * The pipeline's only Cron. EDGAR pushes nothing, so every data company's submission list is read and compared with
 * the accessions seen last time; each new filing becomes a `filing.discovered` event, written in the same batch as
 * the new state. A company seen for the first time only records its baseline. Writes a heartbeat when done, and
 * fails the invocation when no company could be read, so an outage raises the Worker's error notification.
 */
export async function runSecDiscovery(env: SecPipelineEnv, now = new Date(), fetcher: typeof fetch = fetch) {
  const db = env.DB!;
  const repository = new D1SecRepository(db);
  const reader = throttledSecReader(env.SEC_USER_AGENT, fetcher, 200);
  const result = { checked: 0, discovered: [] as string[], baseline: [] as string[], unknown: [] as string[], failed: [] as string[] };
  for (const ticker of await scopeTickers(env, "data")) {
    const cik = await knownCik(db, ticker);
    if (!cik) { result.unknown.push(ticker); continue; }
    try {
      const filings = recentFilings(await (await reader.read(`https://data.sec.gov/submissions/CIK${cik}.json`)).json());
      if (!filings.length) throw new Error("EMPTY_SUBMISSIONS");
      const previous = (await repository.getCache<DiscoveryState>(stateKey(ticker)))?.payload;
      const at = now.toISOString();
      const known = new Set(previous?.accessions ?? []);
      const fresh = previous ? filings.filter(f => !known.has(f.accession) && ANNOUNCED.test(f.form)) : [];
      await db.batch([
        db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at")
          .bind(stateKey(ticker), JSON.stringify({ cik, accessions: filings.map(f => f.accession), checkedAt: at } satisfies DiscoveryState), at),
        // Oldest first, so subscribers that read the newest state see the filings in the order they were made.
        ...fresh.reverse().map(f => outboxStatement(db, { type: "filing.discovered", ticker, cik, detail: { form: f.form, items: f.items, accession: f.accession } }, at)),
      ]);
      if (!previous) result.baseline.push(ticker);
      result.discovered.push(...fresh.map(f => `${ticker}:${f.form}:${f.accession}`));
      result.checked++;
    } catch (error) {
      console.error(JSON.stringify({ event: "sec-discovery", ticker, error: error instanceof Error ? error.message : String(error) }));
      result.failed.push(ticker);
    }
  }
  if (result.checked) await repository.setCache(DISCOVERY_HEARTBEAT_KEY, { checked: result.checked, discovered: result.discovered.length, failed: result.failed }, now.toISOString());
  if (!result.checked && result.failed.length) throw new Error(`SEC discovery read no company (${result.failed.length} failed)`);
  return result;
}
