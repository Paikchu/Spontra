import type { BusinessUnit, PeerTier, TagFacet } from "../../../../shared/analysis-contract/business-tags.ts";
import type { IndustryCategory } from "../../../../shared/analysis-contract/filing-library.ts";
import { PEER_MATCH_VERSION, pairsFromHits, readThresholds, tagEmbeddingText, tagNamespace, type MatchTag, type TagHit } from "../../../../shared/analysis-runtime/business-tags.ts";
import type { AnalysisEnv } from "../operations.ts";
import { outboxStatement } from "../pipeline/outbox.ts";

/** Multilingual, 1024 dimensions; the index `business-tags` is created with the same size and cosine distance. */
export const EMBEDDING_MODEL = "@cf/baai/bge-m3";
/** The most a query returns without metadata; a namespace this large is searched only as far as its nearest tags. */
const EMBED_BATCH = 50, TOP_K = 100;

export const matchingEnabled = (env: AnalysisEnv) => !!env.AI && !!env.TAGS_INDEX;

type TagRow = { tag_id: string; ticker: string; unit_key: string; sector: string; facet: string; label: string; definition: string };
type UnitRow = { unit_key: string; ticker: string; flow_node_id: string; name: string; link_keys: string; sectors: string; section_ids: string };
export const unitOf = (r: UnitRow): BusinessUnit => ({ ticker: r.ticker, unitKey: r.unit_key, flowNodeId: r.flow_node_id, name: r.name, linkKeys: JSON.parse(r.link_keys), sectors: JSON.parse(r.sectors), sectionIds: JSON.parse(r.section_ids) });
const matchTag = (r: TagRow): MatchTag => ({ tagId: r.tag_id, unitKey: r.unit_key, sector: r.sector as IndustryCategory, facet: r.facet as TagFacet });

/** Embeds texts with Workers AI, in batches; every text gets one vector or the call fails. */
export async function embed(env: AnalysisEnv, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const result = await env.AI!.run(EMBEDDING_MODEL, { text: batch }) as { data?: unknown };
    const data = Array.isArray(result?.data) ? result.data as unknown[] : [];
    if (data.length !== batch.length || data.some(v => !Array.isArray(v) || !v.length)) throw new Error(`embedding returned ${data.length} vectors for ${batch.length} texts`);
    out.push(...data as number[][]);
  }
  return out;
}

/** The company's verified tags in the index, under their sector and facet's namespace; tags no longer verified leave it. */
export async function syncVectors(env: AnalysisEnv, ticker: string, removed: string[]): Promise<{ upserted: number; deleted: number }> {
  const db = env.DB!, index = env.TAGS_INDEX!;
  const tags = (await db.prepare("SELECT tag_id, ticker, unit_key, sector, facet, label, definition FROM sec_business_tags WHERE ticker = ? AND status = 'verified'").bind(ticker).all<TagRow>()).results;
  if (removed.length) for (let i = 0; i < removed.length; i += 100) await index.deleteByIds(removed.slice(i, i + 100));
  if (!tags.length) return { upserted: 0, deleted: removed.length };
  const vectors = await embed(env, tags.map(t => tagEmbeddingText(t)));
  for (let i = 0; i < tags.length; i += 100) {
    await index.upsert(tags.slice(i, i + 100).map((t, k) => ({ id: t.tag_id, values: vectors[i + k]!, namespace: tagNamespace(t.sector, t.facet), metadata: { ticker: t.ticker, unitKey: t.unit_key } })));
  }
  return { upserted: tags.length, deleted: removed.length };
}

/**
 * The company's pairs, found again: each of its verified tags is embedded and searched for among the tags of the same
 * sector and facet, and every unit of another company sharing a sector with one of its units is compared through those
 * hits. Rows involving the company are replaced; an admin's tier stays, with the new facets beneath it. The
 * `business.tags.published` event commits with the rows.
 */
export async function matchCompany(env: AnalysisEnv, ticker: string, now = new Date()): Promise<{ pairs: number; hits: number; tiers: Partial<Record<PeerTier, number>> }> {
  const db = env.DB!, thresholds = readThresholds(env.PEER_TAG_THRESHOLDS);
  const ownUnits = (await db.prepare("SELECT * FROM sec_business_units WHERE ticker = ?").bind(ticker).all<UnitRow>()).results.map(unitOf);
  const ownTags = (await db.prepare("SELECT tag_id, ticker, unit_key, sector, facet, label, definition FROM sec_business_tags WHERE ticker = ? AND status = 'verified'").bind(ticker).all<TagRow>()).results;
  const sectors = [...new Set(ownUnits.flatMap(u => u.sectors))];
  const peerUnits = sectors.length ? (await db.prepare(`SELECT * FROM sec_business_units WHERE ticker != ? AND EXISTS (SELECT 1 FROM json_each(sectors) s WHERE s.value IN (SELECT value FROM json_each(?)))`)
    .bind(ticker, JSON.stringify(sectors)).all<UnitRow>()).results.map(unitOf) : [];
  const peerTags = peerUnits.length ? (await db.prepare("SELECT tag_id, ticker, unit_key, sector, facet, label, definition FROM sec_business_tags WHERE ticker != ? AND status = 'verified' AND sector IN (SELECT value FROM json_each(?))")
    .bind(ticker, JSON.stringify(sectors)).all<TagRow>()).results : [];
  const hits: TagHit[] = [], floors = new Map<string, number>();
  if (ownTags.length && peerTags.length && matchingEnabled(env)) {
    const vectors = await embed(env, ownTags.map(t => tagEmbeddingText(t)));
    for (const [i, tag] of ownTags.entries()) {
      const found = await env.TAGS_INDEX!.query(vectors[i]!, { topK: TOP_K, namespace: tagNamespace(tag.sector, tag.facet), returnMetadata: "none" });
      const matches = found.matches ?? [];
      for (const m of matches) hits.push({ own: tag.tag_id, peer: m.id, score: m.score });
      if (matches.length >= TOP_K) floors.set(tag.tag_id, Math.min(...matches.map(m => m.score)));
    }
  }
  const pairs = pairsFromHits(ownUnits, peerUnits, ownTags.map(matchTag), peerTags.map(matchTag), hits, thresholds, floors);
  const existing = new Map((await db.prepare("SELECT pair_key, tier, status FROM sec_peer_pairs WHERE left_ticker = ? OR right_ticker = ?").bind(ticker, ticker).all<{ pair_key: string; tier: string; status: string }>()).results.map(r => [r.pair_key, r]));
  const at = now.toISOString(), statements: D1PreparedStatement[] = [];
  const tiers: Partial<Record<PeerTier, number>> = {};
  for (const p of pairs) {
    const seen = existing.get(p.pairKey), confirmed = seen?.status === "confirmed";
    tiers[p.tier] = (tiers[p.tier] ?? 0) + 1;
    statements.push(db.prepare(`INSERT INTO sec_peer_pairs (pair_key, left_unit, right_unit, left_ticker, right_ticker, sectors, tier, tier_sector, matched_tier, status, version, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(pair_key) DO UPDATE SET sectors = excluded.sectors, tier = excluded.tier, tier_sector = excluded.tier_sector,
      matched_tier = excluded.matched_tier, status = excluded.status, version = excluded.version, updated_at = excluded.updated_at`)
      .bind(p.pairKey, p.left, p.right, p.left.split("|")[0], p.right.split("|")[0], JSON.stringify(p.sectors), confirmed ? seen!.tier : p.tier, p.tierSector, p.tier, confirmed ? "confirmed" : "matched", PEER_MATCH_VERSION, at));
  }
  const gone = [...existing.keys()].filter(k => !pairs.some(p => p.pairKey === k));
  if (gone.length) statements.push(db.prepare("DELETE FROM sec_peer_pairs WHERE pair_key IN (SELECT value FROM json_each(?))").bind(JSON.stringify(gone)));
  statements.push(outboxStatement(db, { type: "business.tags.published", ticker }, at));
  for (let i = 0; i < statements.length; i += 90) await db.batch(statements.slice(i, i + 90));
  return { pairs: pairs.length, hits: hits.length, tiers };
}

export type SimilarBusiness = { ticker: string; unitKey: string; unit: string; sector: string; facet: string; label: string; definition: string; score: number; documentId: string | null; sectionId: string | null };

/**
 * Businesses of tracked companies whose tags are nearest a description, for the analyst's own questions beyond the
 * stored pairs: within one sector and facet when both are given, else across the index, filtered here. One unit once,
 * at its best tag; the company itself is left out.
 */
export async function similarBusinesses(env: AnalysisEnv, request: { query: string; facet?: TagFacet; sector?: IndustryCategory; exclude?: string; limit?: number }): Promise<SimilarBusiness[]> {
  if (!matchingEnabled(env)) return [];
  const [vector] = await embed(env, [request.query]);
  const found = await env.TAGS_INDEX!.query(vector!, { topK: TOP_K, ...(request.sector && request.facet ? { namespace: tagNamespace(request.sector, request.facet) } : {}), returnMetadata: "none" });
  const ids = (found.matches ?? []).map(m => m.id);
  if (!ids.length) return [];
  const rows = (await env.DB!.prepare(`SELECT t.tag_id, t.ticker, t.unit_key, t.sector, t.facet, t.label, t.definition, u.name unit, p.document_id, p.section_id FROM sec_business_tags t
    JOIN sec_business_units u ON u.unit_key = t.unit_key LEFT JOIN sec_passages p ON p.passage_id = json_extract(t.passage_ids, '$[0]')
    WHERE t.tag_id IN (SELECT value FROM json_each(?)) AND t.status = 'verified'`).bind(JSON.stringify(ids))
    .all<{ tag_id: string; ticker: string; unit_key: string; sector: string; facet: string; label: string; definition: string; unit: string; document_id: string | null; section_id: string | null }>()).results;
  const byId = new Map(rows.map(r => [r.tag_id, r]));
  const out: SimilarBusiness[] = [], seen = new Set<string>();
  for (const m of found.matches ?? []) {
    const r = byId.get(m.id);
    if (!r || r.ticker === request.exclude || seen.has(r.unit_key) || (request.facet && r.facet !== request.facet) || (request.sector && r.sector !== request.sector)) continue;
    seen.add(r.unit_key);
    out.push({ ticker: r.ticker, unitKey: r.unit_key, unit: r.unit, sector: r.sector, facet: r.facet, label: r.label, definition: r.definition, score: Math.round(m.score * 1000) / 1000, documentId: r.document_id, sectionId: r.section_id });
    if (out.length >= (request.limit ?? 8)) break;
  }
  return out;
}
