import type { PeerCompany, PeersPublication } from "../../../../shared/analysis-contract/peers.ts";
import { readFindingFundamentals, type FindingData } from "../../../../shared/analysis-runtime/findings.ts";
import { changedPeers, citedPeers, peerQuartersFrom, readPeersPublication } from "../../../../shared/analysis-runtime/peers.ts";
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
export const PEERS_VERSION = "peers.v1";

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

/** The projection for every data company, in ticker order; companies without a publication are left out. */
export async function buildPeersPublication(env: SecPipelineEnv, now: Date): Promise<PeersPublication> {
  const companies: PeerCompany[] = [];
  for (const ticker of await scopeTickers(env, "data")) {
    const company = await buildPeerCompany(env, ticker);
    if (company) companies.push(company);
  }
  return { schemaVersion: "peers.v1", generatedAt: now.toISOString(), companies };
}

/**
 * Builds and stores the projection under its single key; the publication and its events commit together. One
 * `peers.published` per company whose findings cite a peer whose row changed, so only those pages are told of newer data.
 */
export async function publishPeers(env: SecPipelineEnv, now: Date): Promise<{ companies: number; quarters: number; linked: number; changed: string[]; revised: string[] }> {
  const db = requireDb(env);
  const publication = readPeersPublication(await buildPeersPublication(env, now));
  if (!publication) throw new Error("peers projection does not satisfy its own contract");
  const changed = changedPeers(await readPeersResponse(db).then(r => r.peers).catch(() => null), publication);
  const revised: string[] = [];
  if (changed.size) for (const ticker of await scopeTickers(env, "data")) {
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
