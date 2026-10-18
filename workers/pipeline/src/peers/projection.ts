import type { PeerCompany, PeerPair, PeersPublication, PeerUnit } from "../../../../shared/analysis-contract/peers.ts";
import { basisOf } from "../../../../shared/analysis-runtime/business-tags.ts";
import { exposureOf, unitRevenues } from "../business-tags/input.ts";
import { readFindingFundamentals, type FindingData } from "../../../../shared/analysis-runtime/findings.ts";
import { changedPeers, citedPeers, peerQuartersFrom, readPeersPublication, unitTicker } from "../../../../shared/analysis-runtime/peers.ts";
import { requireDb } from "../core.ts";
import { readLinks } from "../filing-library/links.ts";
import { readServedFindings } from "../findings/read.ts";
import { readMapDerived } from "../financial-data/derived.ts";
import { readCompletePublicationForTicker } from "../financial-data/publication.ts";
import { parseFundamentalApiQuery } from "../fundamentals/fundamentals-api.ts";
import { getSecFundamentals } from "../fundamentals/sec-fundamentals.ts";
import type { SecPipelineEnv } from "../operations.ts";
import { outboxStatement } from "../pipeline/outbox.ts";
import { scopeTickers } from "../pipeline/router.ts";
import { PEERS_CACHE_KEY, readPeersResponse } from "./read.ts";

/** Changing what the projection reads or how a figure is computed republishes it once (`task.version_changed`). */
export const PEERS_VERSION = "peers.v2";

/**
 * The same stored projections the findings writer reads (`readInput` in findings/workflow.ts), without the ledger:
 * the publication's quarters, the map snapshot's older quarters and capital structure, and the SEC fundamentals.
 * No SEC fetch, no model call. A company without a publication yields null; a stale snapshot still yields the
 * publication's own quarters, and the snapshot's `map.derived` republishes the rest.
 */
async function readCompanyData(env: SecPipelineEnv, ticker: string): Promise<FindingData | null> {
  const db = requireDb(env);
  const publication = await readCompletePublicationForTicker(db, ticker).catch(() => null);
  const flow = publication?.status === "ready" ? publication.flow : null;
  if (!flow?.quarters.length) return null;
  const snapshot = await readMapDerived(db, flow).catch(() => null);
  const quarters = [...new Map([...(snapshot?.reports?.quarters ?? []), ...flow.quarters].map(q => [q.periodEnd, q])).values()];
  const fundamentals = await getSecFundamentals(db, parseFundamentalApiQuery(ticker, new URLSearchParams({ periodCount: "12" })))
    .then(r => readFindingFundamentals(r, ticker)).catch(() => null);
  return { quarters, history: publication?.history ?? null, capital: snapshot?.capital ?? null, fundamentals, guidance: null };
}

/** The categories a company's verified or confirmed business links name, each once, sorted. */
async function companyCategories(env: SecPipelineEnv, ticker: string): Promise<string[]> {
  const links = await readLinks(requireDb(env), { ticker }).catch(() => []);
  return [...new Set(links.flatMap(l => l.industryCategory && (l.status === "verified" || l.status === "confirmed") ? [l.industryCategory] : []))].sort();
}

/** One company's row of the projection; null when it has no published quarter yet. */
export async function buildPeerCompany(env: SecPipelineEnv, ticker: string): Promise<PeerCompany | null> {
  const data = await readCompanyData(env, ticker);
  if (!data) return null;
  const quarters = peerQuartersFrom(data);
  return { ticker, categories: await companyCategories(env, ticker), newestQuarter: quarters[0]?.periodEnd ?? null, quarters };
}

/**
 * The comparable units of the data companies with their revenue share, and the pairs their business tags made
 * (docs/peer-similarity-design.md), each with the basis it can be compared on. A pair only of shared sector stays in
 * the admin. Empty lists when no company has tags yet.
 */
export async function buildPeerPairs(db: D1Database, tickers: string[]): Promise<{ units: PeerUnit[]; pairs: PeerPair[] }> {
  const rows = (await db.prepare("SELECT unit_key, ticker, flow_node_id, name, sectors FROM sec_business_units WHERE ticker IN (SELECT value FROM json_each(?))").bind(JSON.stringify(tickers))
    .all<{ unit_key: string; ticker: string; flow_node_id: string; name: string; sectors: string }>().catch(() => ({ results: [] }))).results;
  const revenues = new Map<string, Awaited<ReturnType<typeof unitRevenues>>>();
  for (const ticker of new Set(rows.map(r => r.ticker))) revenues.set(ticker, await unitRevenues(db, ticker));
  const units: PeerUnit[] = rows.map(r => {
    const company = revenues.get(r.ticker)!, revenue = company.nodes.get(r.flow_node_id) ?? null;
    return { ticker: r.ticker, unitKey: r.unit_key, name: r.name, flowNodeId: r.flow_node_id, sectors: JSON.parse(r.sectors) as string[], periodEnd: company.periodEnd, revenue, exposure: exposureOf(revenue, company.company) };
  });
  const byKey = new Map(units.map(u => [u.unitKey, u]));
  const pairRows = (await db.prepare("SELECT left_unit, right_unit, sectors, tier, tier_sector FROM sec_peer_pairs WHERE tier IN ('direct','partial','adjacent')").bind()
    .all<{ left_unit: string; right_unit: string; sectors: string; tier: PeerPair["tier"]; tier_sector: string }>().catch(() => ({ results: [] }))).results;
  const pairs: PeerPair[] = [];
  for (const r of pairRows) {
    const left = byKey.get(r.left_unit), right = byKey.get(r.right_unit);
    const facets = (JSON.parse(r.sectors) as Record<string, PeerPair["facets"]>)[r.tier_sector];
    if (!left || !right || !facets) continue;
    pairs.push({ left: r.left_unit, right: r.right_unit, tier: r.tier, sector: r.tier_sector, basis: basisOf(r.tier, left, right), facets });
  }
  return { units: units.sort((a, b) => a.unitKey.localeCompare(b.unitKey)), pairs: pairs.sort((a, b) => `${a.left}~${a.right}`.localeCompare(`${b.left}~${b.right}`)) };
}

/** The projection for every data company, in ticker order; companies without a publication are left out. */
export async function buildPeersPublication(env: SecPipelineEnv, now: Date): Promise<PeersPublication> {
  const companies: PeerCompany[] = [];
  const tickers = await scopeTickers(env, "data");
  for (const ticker of tickers) {
    const company = await buildPeerCompany(env, ticker);
    if (company) companies.push(company);
  }
  const { units, pairs } = await buildPeerPairs(requireDb(env), tickers);
  return { schemaVersion: "peers.v1", generatedAt: now.toISOString(), companies, ...(units.length ? { units, pairs } : {}) };
}

/**
 * Builds and stores the projection under its single key; the publication and its events commit together. One
 * `peers.published` per company whose findings cite a peer whose row changed, so only those pages are told of newer data.
 */
export async function publishPeers(env: SecPipelineEnv, now: Date): Promise<{ companies: number; quarters: number; linked: number; changed: string[]; revised: string[] }> {
  const db = requireDb(env);
  const publication = readPeersPublication(await buildPeersPublication(env, now));
  if (!publication) throw new Error("peers projection does not satisfy its own contract");
  const before = await readPeersResponse(db).then(r => r.peers).catch(() => null);
  const changed = changedPeers(before, publication);
  // A company whose own pairs moved reads different peers on its page, cited or not.
  const pairsOf = (p: PeersPublication | null, ticker: string) => JSON.stringify([(p?.pairs ?? []).filter(x => unitTicker(x.left) === ticker || unitTicker(x.right) === ticker), (p?.units ?? []).filter(u => u.ticker === ticker)]);
  const revised: string[] = [];
  for (const ticker of await scopeTickers(env, "data")) {
    if (pairsOf(before, ticker) !== pairsOf(publication, ticker)) { revised.push(ticker); continue; }
    if (!changed.size) continue;
    const findings = await readServedFindings(db, ticker).catch(() => null);
    if ([...citedPeers(findings)].some(t => changed.has(t))) revised.push(ticker);
  }
  const at = now.toISOString();
  await db.batch([
    db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at")
      .bind(PEERS_CACHE_KEY, JSON.stringify(publication), at),
    ...revised.map(ticker => outboxStatement(db, { type: "peers.published", ticker }, at)),
  ]);
  return { companies: publication.companies.length, quarters: publication.companies.reduce((n, c) => n + c.quarters.length, 0), linked: publication.companies.filter(c => c.categories.length).length,
    changed: [...changed].sort(), revised };
}
