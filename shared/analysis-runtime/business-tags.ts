import type { BusinessUnit, FacetMatch, FacetValue, PeerBasis, PeerTier, TagFacet } from "../analysis-contract/business-tags.ts";
import { TAG_FACETS } from "../analysis-contract/business-tags.ts";
import { INDUSTRY_CATEGORIES, type IndustryCategory, type LibraryBusinessLink } from "../analysis-contract/filing-library.ts";
import { libraryHash } from "./filing-library/parse.ts";

/**
 * Two-level business tags and the peers they lead to (docs/peer-similarity-design.md). Pure: the pipeline reads the
 * links, flow nodes and passages, calls the model and the vector index, and hands the results to these checks.
 */

/** Bumping this writes every company's business tags again. */
export const BUSINESS_TAGS_VERSION = "business-tags.v1";
export const TAG_LIMITS = { perSector: 10, units: 16, sectionsPerUnit: 8, labelWords: [2, 6], labelChars: 60, labelZhChars: 24, definitionChars: 240 } as const;
/**
 * Changing how tags are compared re-matches every company from its stored tags; no model runs. v2: a facet's score is
 * how much of each side's tags the other covers, not its single best tag pair.
 */
export const PEER_MATCH_VERSION = "peer-match.v2";
/**
 * Coverage scores of the embedded tags: at or above `same` a facet is the same business, at or above `near` close to it.
 * Calibrated on the first production tags (2026-10-19): CRWV's offering covers NBIS at 0.78, ORCL's OCI at 0.76, the
 * hyperscalers at 0.71–0.73 and Cloudflare at 0.68; the hyperscalers cover one another at 0.79–0.81.
 */
export const DEFAULT_TAG_THRESHOLDS = { same: 0.77, near: 0.7 } as const;
/** Both units must be at least this much of their companies before company-wide figures stand for the compared business. */
export const COMPANY_BASIS_EXPOSURE = 0.8;
/** The revenue node of a single-segment company. */
export const COMPANY_TOTAL = "reported-company-total";

export const unitKeyOf = (ticker: string, flowNodeId: string) => `${ticker}|${flowNodeId}`;
export const pairKeyOf = (a: string, b: string) => a < b ? `${a}~${b}` : `${b}~${a}`;
export const tagIdOf = (unitKey: string, sector: string, facet: string, label: string) => `t${libraryHash(`${unitKey}|${sector}|${facet}|${label.toLowerCase()}`).slice(0, 24)}`;
/** One vector namespace per sector and facet, so a query only meets tags it may be compared with. */
export const tagNamespace = (sector: string, facet: string) => `${sector}.${facet}`;
const isCategory = (value: unknown): value is IndustryCategory => typeof value === "string" && Object.hasOwn(INDUSTRY_CATEGORIES, value);
const isFacet = (value: unknown): value is TagFacet => typeof value === "string" && (TAG_FACETS as readonly string[]).includes(value);

export type UnitFlowNode = { flowNodeId: string; name: string };
export type UnitLink = Pick<LibraryBusinessLink, "businessKey" | "name" | "flowNodeId" | "sectionIds" | "industryCategory" | "status">;

/**
 * Groups a company's business links into comparable units, one per revenue node. A link keeps its own map node; a
 * link without one takes the node chosen for it (`assignments`, checked against the nodes); a single-segment company,
 * which has no nodes, puts every link under its total. Any other link is left unplaced. Sectors come only from links
 * whose category was verified or set by an admin.
 */
export function buildUnits(ticker: string, links: UnitLink[], nodes: UnitFlowNode[], assignments: Record<string, string> = {}): { units: BusinessUnit[]; unplaced: Array<{ businessKey: string; name: string }> } {
  const byId = new Map(nodes.map(n => [n.flowNodeId, n]));
  const units = new Map<string, BusinessUnit>(), unplaced: Array<{ businessKey: string; name: string }> = [];
  for (const link of links) {
    const nodeId = link.flowNodeId && byId.has(link.flowNodeId) ? link.flowNodeId
      : assignments[link.businessKey] && byId.has(assignments[link.businessKey]!) ? assignments[link.businessKey]!
      : !nodes.length ? COMPANY_TOTAL : null;
    if (!nodeId) { unplaced.push({ businessKey: link.businessKey, name: link.name }); continue; }
    const key = unitKeyOf(ticker, nodeId);
    const unit = units.get(key) ?? { ticker, unitKey: key, flowNodeId: nodeId, name: byId.get(nodeId)?.name ?? "Total company", linkKeys: [], sectors: [], sectionIds: [] };
    unit.linkKeys.push(link.businessKey);
    if (link.industryCategory && (link.status === "verified" || link.status === "confirmed") && !unit.sectors.includes(link.industryCategory)) unit.sectors.push(link.industryCategory);
    for (const id of link.sectionIds) if (!unit.sectionIds.includes(id)) unit.sectionIds.push(id);
    units.set(key, unit);
  }
  return { units: [...units.values()].map(u => ({ ...u, sectors: [...u.sectors].sort() })), unplaced };
}

/** The node chosen for each link that has none, from the model's answer; only nodes it was offered count. */
export function readAssignments(raw: unknown, unplaced: string[], nodes: UnitFlowNode[]): Record<string, string> {
  const ids = new Set(nodes.map(n => n.flowNodeId)), keys = new Set(unplaced), out: Record<string, string> = {};
  const items = Array.isArray((raw as { linkUnits?: unknown } | null)?.linkUnits) ? (raw as { linkUnits: unknown[] }).linkUnits : [];
  for (const item of items) {
    const v = item as { businessKey?: unknown; flowNodeId?: unknown } | null;
    if (typeof v?.businessKey === "string" && keys.has(v.businessKey) && typeof v.flowNodeId === "string" && ids.has(v.flowNodeId)) out[v.businessKey] = v.flowNodeId;
  }
  return out;
}

export type TagDraft = { tagId: string; unitKey: string; sector: IndustryCategory; facet: TagFacet; label: string; labelZh: string; definition: string; passageIds: string[] };
/** What one unit may be tagged with: its sectors and the passages it was shown. */
export type TagScope = { sectors: IndustryCategory[]; passageIds: Set<string> };

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Names a tag may not carry: tickers as whole upper-case words (so "NET" does not catch "network") and company names
 * as whole words in any case. A tag describes a kind of business, never "like" a company.
 */
export function nameGuard(tickers: string[], names: string[]): (text: string) => string | null {
  const patterns = [
    ...tickers.filter(t => t.length >= 2).map(t => ({ name: t, re: new RegExp(`(^|[^A-Za-z0-9])${escape(t)}([^A-Za-z0-9]|$)`) })),
    ...names.map(n => n.trim()).filter(n => n.length >= 3).map(n => ({ name: n, re: new RegExp(`(^|[^\\p{L}\\p{N}])${escape(n)}([^\\p{L}\\p{N}]|$)`, "iu") })),
  ];
  return text => patterns.find(p => p.re.test(text))?.name ?? null;
}

/**
 * Checks a model's tags against what it was shown: the unit and sector must be the unit's, the facet one of the
 * four, every passage one of the unit's, and the words free of digits and of company names. Duplicates within a unit
 * and sector, and tags beyond the limit, are dropped. Every rejection is noted with its reason.
 */
export function checkTags(raw: unknown, scopes: Map<string, TagScope>, named: (text: string) => string | null): { tags: TagDraft[]; notes: string[] } {
  const notes: string[] = [], tags: TagDraft[] = [], seen = new Set<string>(), counts = new Map<string, number>();
  const units = Array.isArray((raw as { units?: unknown } | null)?.units) ? (raw as { units: unknown[] }).units : [];
  for (const entry of units) {
    const unitKey = typeof (entry as { unitKey?: unknown })?.unitKey === "string" ? (entry as { unitKey: string }).unitKey : "";
    const scope = scopes.get(unitKey);
    if (!scope) { notes.push(`unknown_unit:${unitKey.slice(0, 80)}`); continue; }
    const items = Array.isArray((entry as { tags?: unknown }).tags) ? (entry as { tags: unknown[] }).tags : [];
    for (const item of items) {
      const v = item as Record<string, unknown> | null;
      const label = typeof v?.label === "string" ? v.label.trim().replace(/\s+/g, " ") : "";
      const labelZh = typeof v?.labelZh === "string" ? v.labelZh.trim() : "";
      const definition = typeof v?.definition === "string" ? v.definition.trim().replace(/\s+/g, " ") : "";
      const at = `${unitKey}:${label.slice(0, 60)}`;
      if (!isCategory(v?.sector) || !scope.sectors.includes(v.sector)) { notes.push(`sector:${at}`); continue; }
      if (!isFacet(v?.facet)) { notes.push(`facet:${at}`); continue; }
      const words = label.split(" ").filter(Boolean).length;
      if (words < TAG_LIMITS.labelWords[0] || words > TAG_LIMITS.labelWords[1] || label.length > TAG_LIMITS.labelChars || /[^\x20-\x7E]/.test(label)) { notes.push(`label:${at}`); continue; }
      if (!labelZh || [...labelZh].length > TAG_LIMITS.labelZhChars) { notes.push(`label_zh:${at}`); continue; }
      if (!definition || definition.length > TAG_LIMITS.definitionChars) { notes.push(`definition:${at}`); continue; }
      if (/\d/.test(`${label}${labelZh}${definition}`)) { notes.push(`digits:${at}`); continue; }
      const name = named(label) ?? named(labelZh) ?? named(definition);
      if (name) { notes.push(`names_company:${at}:${name}`); continue; }
      const passageIds = [...new Set(Array.isArray(v?.passageIds) ? v.passageIds.filter((id): id is string => typeof id === "string") : [])];
      if (!passageIds.length || passageIds.some(id => !scope.passageIds.has(id))) { notes.push(`passages:${at}`); continue; }
      const tagId = tagIdOf(unitKey, v.sector, v.facet, label);
      if (seen.has(tagId)) continue;
      const bucket = `${unitKey}|${v.sector}`;
      if ((counts.get(bucket) ?? 0) >= TAG_LIMITS.perSector) { notes.push(`too_many:${bucket}`); continue; }
      seen.add(tagId); counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
      tags.push({ tagId, unitKey, sector: v.sector, facet: v.facet, label, labelZh, definition, passageIds: passageIds.slice(0, 4) });
    }
  }
  return { tags, notes };
}

/** The tags an independent review said its passages support; a tag the review did not answer for is not kept. */
export function readTagReview(raw: unknown, ids: string[]): Set<string> {
  const known = new Set(ids), kept = new Set<string>();
  const items = Array.isArray((raw as { reviews?: unknown } | null)?.reviews) ? (raw as { reviews: unknown[] }).reviews : [];
  for (const item of items) {
    const v = item as { id?: unknown; supported?: unknown } | null;
    if (typeof v?.id === "string" && known.has(v.id) && v.supported === true) kept.add(v.id);
  }
  return kept;
}

/* ---------- Matching ---------- */

export type TagThresholds = { same: number; near: number };
export function facetValue(score: number | null, has: boolean, thresholds: TagThresholds): FacetValue {
  if (!has) return "unknown";
  if (score == null) return "different";
  return score >= thresholds.same ? "same" : score >= thresholds.near ? "partial" : "different";
}

/**
 * The tier of two units under one sector, from their four facets: what they sell decides whether they are peers at
 * all, the other three how close. A facet a side has no tag in says nothing either way: direct needs the same offering,
 * no other known facet different and at least half of them the same.
 */
export function tierOf(facets: Record<TagFacet, FacetValue>): PeerTier {
  const others = (["customers", "contract", "cost"] as const).map(f => facets[f]);
  const known = others.filter(v => v !== "unknown");
  if (facets.offering === "same") return known.length && !known.includes("different") && known.filter(v => v === "same").length * 2 >= known.length ? "direct" : "partial";
  if (facets.offering === "partial") return others.some(v => v === "same" || v === "partial") ? "partial" : "adjacent";
  return "sector";
}

export const TIER_ORDER: readonly PeerTier[] = ["direct", "partial", "adjacent", "sector"];

/** One tag as matching reads it. */
export type MatchTag = { tagId: string; unitKey: string; sector: IndustryCategory; facet: TagFacet };
/** One vector-search result: an own tag, a peer tag in the same namespace, and their cosine score. */
export type TagHit = { own: string; peer: string; score: number };
/**
 * For an own tag whose search was cut off at its top-k, the lowest score it returned: a peer tag it did not reach scores
 * no higher. An own tag absent here was answered in full, so a peer tag it did not reach is not yet in the index.
 */
export type HitFloors = Map<string, number>;
export type MatchedPair = { pairKey: string; left: string; right: string; sectors: Partial<Record<IndustryCategory, Record<TagFacet, FacetMatch>>>; tier: PeerTier; tierSector: IndustryCategory };

const mean = (values: number[]) => values.reduce((s, v) => s + v, 0) / values.length;

/**
 * How much two sets of tags describe the same business: each side's tags are matched to their nearest tag on the
 * other side and averaged, and the two averages are combined as a harmonic mean. One shared tag among many does not
 * make a broad business the same as a narrow one; both sides must be covered. Null when no tag pair has a score.
 */
export function coverage(own: string[], peer: string[], score: (own: string, peer: string) => number | null): { score: number; own: string; peer: string } | null {
  const forward = new Map<string, number>(), backward = new Map<string, number>();
  let top: { score: number; own: string; peer: string } | null = null;
  for (const o of own) for (const p of peer) {
    const v = score(o, p);
    if (v == null) continue;
    forward.set(o, Math.max(forward.get(o) ?? -2, v));
    backward.set(p, Math.max(backward.get(p) ?? -2, v));
    if (!top || v > top.score) top = { score: v, own: o, peer: p };
  }
  if (!top || !forward.size || !backward.size) return null;
  const f = mean([...forward.values()]), b = mean([...backward.values()]);
  return { score: f + b > 0 ? (2 * f * b) / (f + b) : 0, own: top.own, peer: top.peer };
}

/**
 * Every pair of one company's units with another company's units that share a sector: per shared sector, each facet's
 * coverage over the search hits (a facet a side has no tag in is unknown), and the best tier any shared sector gives.
 * The facet keeps its closest tag pair for display.
 */
export function pairsFromHits(ownUnits: BusinessUnit[], peerUnits: BusinessUnit[], ownTags: MatchTag[], peerTags: MatchTag[], hits: TagHit[], thresholds: TagThresholds, floors: HitFloors = new Map()): MatchedPair[] {
  const ownById = new Map(ownTags.map(t => [t.tagId, t])), peerById = new Map(peerTags.map(t => [t.tagId, t]));
  const scores = new Map<string, number>();
  for (const hit of hits) {
    const o = ownById.get(hit.own), p = peerById.get(hit.peer);
    if (!o || !p || o.sector !== p.sector || o.facet !== p.facet || o.unitKey.split("|")[0] === p.unitKey.split("|")[0]) continue;
    const key = `${hit.own}~${hit.peer}`;
    if ((scores.get(key) ?? -2) < hit.score) scores.set(key, hit.score);
  }
  const score = (own: string, peer: string) => scores.get(`${own}~${peer}`) ?? floors.get(own) ?? null;
  const tagsOf = (tags: MatchTag[], unitKey: string, sector: string, facet: string) => tags.filter(t => t.unitKey === unitKey && t.sector === sector && t.facet === facet).map(t => t.tagId);
  const pairs: MatchedPair[] = [];
  for (const own of ownUnits) for (const peer of peerUnits) {
    if (own.ticker === peer.ticker) continue;
    const shared = own.sectors.filter(s => peer.sectors.includes(s));
    if (!shared.length) continue;
    const sectors: MatchedPair["sectors"] = {};
    let tier: PeerTier = "sector", tierSector = shared[0]!;
    for (const sector of shared) {
      const facets = {} as Record<TagFacet, FacetMatch>;
      for (const facet of TAG_FACETS) {
        const mine = tagsOf(ownTags, own.unitKey, sector, facet), theirs = tagsOf(peerTags, peer.unitKey, sector, facet);
        const found = mine.length && theirs.length ? coverage(mine, theirs, score) : null;
        facets[facet] = { value: facetValue(found?.score ?? null, mine.length > 0 && theirs.length > 0, thresholds), score: found ? Math.round(found.score * 1000) / 1000 : null, leftTag: found?.own ?? null, rightTag: found?.peer ?? null };
      }
      sectors[sector] = facets;
      const t = tierOf({ offering: facets.offering.value, customers: facets.customers.value, contract: facets.contract.value, cost: facets.cost.value });
      if (TIER_ORDER.indexOf(t) < TIER_ORDER.indexOf(tier)) { tier = t; tierSector = sector; }
    }
    // Stored with the alphabetically first unit on the left, so both companies' runs write the same row.
    const flip = peer.unitKey < own.unitKey;
    const oriented = flip ? Object.fromEntries(Object.entries(sectors).map(([s, f]) => [s, Object.fromEntries(Object.entries(f!).map(([k, m]) => [k, { ...m, leftTag: m.rightTag, rightTag: m.leftTag }]))])) as MatchedPair["sectors"] : sectors;
    pairs.push({ pairKey: pairKeyOf(own.unitKey, peer.unitKey), left: flip ? peer.unitKey : own.unitKey, right: flip ? own.unitKey : peer.unitKey, sectors: oriented, tier, tierSector });
  }
  return pairs;
}

/**
 * How far two compared units can be compared: company-wide figures only when both units are most of their companies,
 * unit figures when both units' revenue is disclosed, otherwise only their filings' words.
 */
export function basisOf(tier: PeerTier, left: { exposure: number | null; revenue: string | null }, right: { exposure: number | null; revenue: string | null }): PeerBasis {
  if (tier !== "direct" && tier !== "partial") return "quote";
  if ((left.exposure ?? 0) >= COMPANY_BASIS_EXPOSURE && (right.exposure ?? 0) >= COMPANY_BASIS_EXPOSURE) return "company";
  return left.revenue != null && right.revenue != null ? "unit" : "quote";
}

/** Thresholds from `PEER_TAG_THRESHOLDS` (JSON such as {"same":0.82,"near":0.7}); anything malformed keeps the defaults. */
export function readThresholds(value: string | undefined): TagThresholds {
  if (!value) return { ...DEFAULT_TAG_THRESHOLDS };
  try {
    const v = JSON.parse(value) as { same?: unknown; near?: unknown };
    const same = typeof v.same === "number" ? v.same : DEFAULT_TAG_THRESHOLDS.same, near = typeof v.near === "number" ? v.near : DEFAULT_TAG_THRESHOLDS.near;
    return same > near && near > 0 && same <= 1 ? { same, near } : { ...DEFAULT_TAG_THRESHOLDS };
  } catch { return { ...DEFAULT_TAG_THRESHOLDS }; }
}

/** The text a tag is embedded as: the facet, the label and its one-sentence definition, so short labels that look alike but mean different things stay apart. */
export const tagEmbeddingText = (tag: { facet: string; label: string; definition: string }) => `${tag.facet}: ${tag.label} — ${tag.definition}`;
