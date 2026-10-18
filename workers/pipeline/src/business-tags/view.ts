import type { BusinessTag, BusinessTagsView, PeerPairRecord, PeerTier, SectorTagView, TagFacet } from "../../../../shared/analysis-contract/business-tags.ts";
import type { IndustryCategory } from "../../../../shared/analysis-contract/filing-library.ts";
import { basisOf, BUSINESS_TAGS_VERSION, readThresholds, TIER_ORDER } from "../../../../shared/analysis-runtime/business-tags.ts";
import { readLinks } from "../filing-library/links.ts";
import type { SecPipelineEnv } from "../operations.ts";
import { emit } from "../pipeline/outbox.ts";
import { exposureOf, tagsCacheKey, unitRevenues } from "./input.ts";
import { matchCompany, matchingEnabled, syncVectors, unitOf } from "./match.ts";

type TagRow = { tag_id: string; ticker: string; unit_key: string; sector: string; facet: string; label: string; label_zh: string; definition: string; passage_ids: string; status: string };
const tagOf = (r: TagRow): BusinessTag => ({ tagId: r.tag_id, ticker: r.ticker, unitKey: r.unit_key, sector: r.sector as IndustryCategory, facet: r.facet as TagFacet, label: r.label, labelZh: r.label_zh, definition: r.definition, passageIds: JSON.parse(r.passage_ids), status: r.status as BusinessTag["status"] });
type PairRow = { pair_key: string; left_unit: string; right_unit: string; left_ticker: string; right_ticker: string; sectors: string; tier: PeerTier; tier_sector: string; matched_tier: PeerTier; status: PeerPairRecord["status"]; updated_at: string };
const pairOf = (r: PairRow): PeerPairRecord => ({ pairKey: r.pair_key, left: r.left_unit, right: r.right_unit, leftTicker: r.left_ticker, rightTicker: r.right_ticker, sectors: JSON.parse(r.sectors), tier: r.tier, tierSector: r.tier_sector as IndustryCategory, matchedTier: r.matched_tier, status: r.status, updatedAt: r.updated_at });

const revenueCache = (db: D1Database) => {
  const cache = new Map<string, ReturnType<typeof unitRevenues>>();
  return (ticker: string) => { if (!cache.has(ticker)) cache.set(ticker, unitRevenues(db, ticker)); return cache.get(ticker)!; };
};

/** One company's units with both tag levels, its pairs with the facets that decided them, and the passages they cite. D1 reads only. */
export async function readTagsView(env: SecPipelineEnv, ticker: string): Promise<BusinessTagsView> {
  const db = env.DB!, revenue = revenueCache(db);
  const units = (await db.prepare("SELECT * FROM sec_business_units WHERE ticker = ? ORDER BY unit_key").bind(ticker).all<Parameters<typeof unitOf>[0]>()).results.map(unitOf);
  const tags = (await db.prepare("SELECT * FROM sec_business_tags WHERE ticker = ? ORDER BY sector, facet, label").bind(ticker).all<TagRow>()).results.map(tagOf);
  const own = await revenue(ticker);
  const placed = new Set(units.flatMap(u => u.linkKeys));
  const unplaced = (await readLinks(db, { ticker })).filter(l => !placed.has(l.businessKey)).map(l => ({ businessKey: l.businessKey, name: l.name }));
  const pairRows = (await db.prepare("SELECT * FROM sec_peer_pairs WHERE left_ticker = ? OR right_ticker = ?").bind(ticker, ticker).all<PairRow>()).results.map(pairOf);
  const peerKeys = [...new Set(pairRows.map(p => p.leftTicker === ticker ? p.right : p.left))];
  const peerUnits = new Map((peerKeys.length ? (await db.prepare("SELECT * FROM sec_business_units WHERE unit_key IN (SELECT value FROM json_each(?))").bind(JSON.stringify(peerKeys)).all<Parameters<typeof unitOf>[0]>()).results : []).map(r => [r.unit_key, unitOf(r)]));
  const ownUnits = new Map(units.map(u => [u.unitKey, u]));
  const exposure = async (unit: { ticker: string; flowNodeId: string }) => { const r = await revenue(unit.ticker); const value = r.nodes.get(unit.flowNodeId) ?? null; return { revenue: value, exposure: exposureOf(value, r.company) }; };
  const pairs: BusinessTagsView["pairs"] = [];
  for (const p of pairRows) {
    const ownKey = p.leftTicker === ticker ? p.left : p.right, peerKey = ownKey === p.left ? p.right : p.left;
    const mine = ownUnits.get(ownKey), peer = peerUnits.get(peerKey);
    if (!mine || !peer) continue;
    const a = await exposure(mine), b = await exposure(peer);
    pairs.push({ ...p, own: { unitKey: mine.unitKey, name: mine.name }, peer: { ticker: peer.ticker, unitKey: peer.unitKey, name: peer.name, exposure: b.exposure }, basis: basisOf(p.tier, a, b) });
  }
  pairs.sort((x, y) => TIER_ORDER.indexOf(x.tier) - TIER_ORDER.indexOf(y.tier) || (y.peer.exposure ?? 0) - (x.peer.exposure ?? 0));
  // The tags a pair matched on, both sides, and every passage a shown tag cites.
  const matched = [...new Set(pairs.flatMap(p => Object.values(p.sectors).flatMap(f => Object.values(f!).flatMap(m => [m.leftTag, m.rightTag]))).filter((id): id is string => !!id))];
  const others = matched.length ? (await db.prepare("SELECT * FROM sec_business_tags WHERE tag_id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(matched)).all<TagRow>()).results.map(tagOf) : [];
  const shownTags = [...tags, ...others.filter(t => t.ticker !== ticker)];
  const passageIds = [...new Set(shownTags.flatMap(t => t.passageIds))];
  const passages: BusinessTagsView["passages"] = {};
  for (let i = 0; i < passageIds.length; i += 90) {
    const rows = (await db.prepare("SELECT p.passage_id, p.document_id, p.section_id, p.text, s.path FROM sec_passages p JOIN sec_sections s ON s.section_id = p.section_id WHERE p.passage_id IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(passageIds.slice(i, i + 90))).all<{ passage_id: string; document_id: string; section_id: string; text: string; path: string }>()).results;
    for (const r of rows) passages[r.passage_id] = { passageId: r.passage_id, documentId: r.document_id, sectionId: r.section_id, path: (JSON.parse(r.path) as string[]).join(" › "), text: r.text.slice(0, 1200) };
  }
  const unitViews = [];
  for (const u of units) { const r = own.nodes.get(u.flowNodeId) ?? null; unitViews.push({ ...u, revenue: r, exposure: exposureOf(r, own.company), periodEnd: own.periodEnd, tags: tags.filter(t => t.unitKey === u.unitKey) }); }
  return {
    ticker, version: BUSINESS_TAGS_VERSION, units: unitViews, unplaced, pairs,
    tags: Object.fromEntries(shownTags.map(t => [t.tagId, { tagId: t.tagId, label: t.label, labelZh: t.labelZh, facet: t.facet, passageIds: t.passageIds }])),
    passages, thresholds: readThresholds(env.PEER_TAG_THRESHOLDS), matching: matchingEnabled(env),
  };
}

/** Every unit carrying one sector tag and the offering tags it has under it. */
export async function readSectorView(db: D1Database, sector: IndustryCategory): Promise<SectorTagView> {
  const revenue = revenueCache(db);
  const units = (await db.prepare("SELECT * FROM sec_business_units WHERE EXISTS (SELECT 1 FROM json_each(sectors) s WHERE s.value = ?) ORDER BY ticker, unit_key").bind(sector).all<Parameters<typeof unitOf>[0]>()).results.map(unitOf);
  const tags = (await db.prepare("SELECT * FROM sec_business_tags WHERE sector = ? AND facet = 'offering' AND status = 'verified' ORDER BY label").bind(sector).all<TagRow>()).results.map(tagOf);
  const out: SectorTagView["units"] = [];
  for (const u of units) {
    const r = await revenue(u.ticker);
    out.push({ ticker: u.ticker, unitKey: u.unitKey, name: u.name, exposure: exposureOf(r.nodes.get(u.flowNodeId) ?? null, r.company), offering: tags.filter(t => t.unitKey === u.unitKey).map(t => ({ tagId: t.tagId, label: t.label, labelZh: t.labelZh })) });
  }
  out.sort((a, b) => (b.exposure ?? 0) - (a.exposure ?? 0) || a.ticker.localeCompare(b.ticker));
  return { sector, units: out };
}

/** After an admin's change: the company's vectors and pairs follow its tags at once, or the pairs at least are announced. */
async function rematch(env: SecPipelineEnv, ticker: string, removed: string[]) {
  if (matchingEnabled(env)) { await syncVectors(env, ticker, removed); await matchCompany(env, ticker); }
  else await emit(env, [{ type: "business.tags.published", ticker }]);
}

/** Optional: an admin rejects a tag (later runs keep it rejected) or restores it. */
export async function setTagStatus(env: SecPipelineEnv, ticker: string, tagId: string, status: "verified" | "rejected"): Promise<boolean> {
  const result = await env.DB!.prepare("UPDATE sec_business_tags SET status = ?, updated_at = ? WHERE ticker = ? AND tag_id = ?").bind(status, new Date().toISOString(), ticker, tagId).run();
  if (!(result.meta?.changes ?? 0)) return false;
  await rematch(env, ticker, status === "rejected" ? [tagId] : []);
  return true;
}

/** Optional: an admin sets a pair's tier (later runs keep it), or hands it back to what the matching gave. */
export async function setPairTier(env: SecPipelineEnv, ticker: string, pairKey: string, decision: { tier: PeerTier } | { automatic: true }): Promise<boolean> {
  const db = env.DB!, at = new Date().toISOString();
  const row = await db.prepare("SELECT left_ticker, right_ticker FROM sec_peer_pairs WHERE pair_key = ?").bind(pairKey).first<{ left_ticker: string; right_ticker: string }>();
  if (!row || (row.left_ticker !== ticker && row.right_ticker !== ticker)) return false;
  if ("automatic" in decision) await db.prepare("UPDATE sec_peer_pairs SET tier = matched_tier, status = 'matched', updated_at = ? WHERE pair_key = ?").bind(at, pairKey).run();
  else await db.prepare("UPDATE sec_peer_pairs SET tier = ?, status = 'confirmed', updated_at = ? WHERE pair_key = ?").bind(decision.tier, at, pairKey).run();
  await emit(env, [{ type: "business.tags.published", ticker }]);
  return true;
}

/** A fresh run: forget the input the tags were last written from, then ask the company's tags task to run. */
export async function requestTags(env: SecPipelineEnv, ticker: string): Promise<void> {
  await env.DB!.prepare("DELETE FROM sec_cache WHERE cache_key = ?").bind(tagsCacheKey(ticker)).run();
  await emit(env, [{ type: "business.tags.requested", ticker }]);
}
