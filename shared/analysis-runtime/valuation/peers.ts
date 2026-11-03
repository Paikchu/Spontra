import type { PeersPublication } from "../../analysis-contract/peers.ts";
import type { PeerSelectionBasis } from "../../analysis-contract/valuation.ts";
import { comparablePeers } from "../peers.ts";

/**
 * Which companies the forward-multiple cross-check compares against, in priority order:
 * the curated peer map, then whole-company business-tag pairs, then segment-level pairs weighted by how much of each
 * company the compared units are, then companies sharing a category. A source counts only when at least two of its
 * companies are in the projection; the next one follows otherwise. Weights sum to one over the chosen set.
 */
export type PeerSelection = { tickers: string[]; weights: Record<string, number>; basis: PeerSelectionBasis; notes: string[] };
/** How far a pair's tier lets its multiple speak for the company. */
const TIER_WEIGHT: Record<"direct" | "partial" | "adjacent", number> = { direct: 1, partial: 0.5, adjacent: 0 };
const MIN_PEERS = 2;

const normalized = (weights: Record<string, number>): Record<string, number> => {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  return Object.fromEntries(Object.entries(weights).map(([k, v]) => [k, total > 0 ? v / total : 1 / Object.keys(weights).length]));
};
const equal = (tickers: string[]) => Object.fromEntries(tickers.map(t => [t, 1 / tickers.length]));

export function selectPeers(peers: PeersPublication | null | undefined, ticker: string, curated: string[] | null): PeerSelection {
  const notes: string[] = [];
  const known = new Set((peers?.companies ?? []).map(c => c.ticker));
  if (!peers || !known.size) return { tickers: [], weights: {}, basis: "none", notes: ["no peers projection"] };
  // 1. The curated map: only companies the projection carries can answer.
  if (curated?.length) {
    const present = curated.filter(t => t !== ticker && known.has(t));
    const missing = curated.filter(t => t !== ticker && !known.has(t));
    if (missing.length) notes.push(`curated peers not in the projection: ${missing.join(", ")}`);
    if (present.length >= MIN_PEERS) return { tickers: present, weights: equal(present), basis: "curated", notes };
    if (present.length) notes.push(`curated set too small (${present.join(", ")}); falling through`);
  }
  // 2. Business-tag pairs, direct or partial: whole-company pairs at full weight, unit pairs by the exposures of both units.
  const comparable = comparablePeers(peers, ticker);
  if (comparable) {
    const weights: Record<string, number> = {};
    let unitBased = false;
    for (const pair of peers.pairs ?? []) {
      const ownKey = pair.left.startsWith(`${ticker}|`) ? pair.left : pair.right.startsWith(`${ticker}|`) ? pair.right : null;
      if (!ownKey || TIER_WEIGHT[pair.tier] <= 0) continue;
      const peerKey = ownKey === pair.left ? pair.right : pair.left;
      const peer = peers.units?.find(u => u.unitKey === peerKey), own = peers.units?.find(u => u.unitKey === ownKey);
      if (!peer || !own || peer.ticker === ticker || !known.has(peer.ticker)) continue;
      const exposure = pair.basis === "company" ? 1 : Math.min(own.exposure ?? 1, 1) * Math.min(peer.exposure ?? 1, 1);
      if (pair.basis !== "company") unitBased = true;
      weights[peer.ticker] = (weights[peer.ticker] ?? 0) + TIER_WEIGHT[pair.tier] * exposure;
    }
    const tickers = Object.keys(weights).filter(t => weights[t]! > 0).sort((a, b) => weights[b]! - weights[a]! || a.localeCompare(b));
    if (tickers.length >= MIN_PEERS) {
      const chosen = Object.fromEntries(tickers.map(t => [t, weights[t]!]));
      notes.push(`pair weights: ${tickers.map(t => `${t} ${(weights[t]! / tickers.reduce((s, k) => s + weights[k]!, 0) * 100).toFixed(0)}%`).join(", ")}`);
      return { tickers, weights: normalized(chosen), basis: unitBased ? "unit" : "ranking", notes };
    }
    if (tickers.length) notes.push(`only ${tickers.join(", ")} pair directly or partially; falling through`);
  }
  // 3. Companies sharing a category.
  const mine = new Set(peers.companies.find(c => c.ticker === ticker)?.categories ?? []);
  const category = peers.companies.filter(c => c.ticker !== ticker && c.categories.some(cat => mine.has(cat))).map(c => c.ticker).sort();
  if (category.length >= MIN_PEERS) return { tickers: category, weights: equal(category), basis: "category", notes };
  return { tickers: [], weights: {}, basis: "none", notes: [...notes, "no source gives two peers"] };
}

/**
 * Weighted quantile: each value sits at the cumulative weight before it over the total less its own weight (so the
 * positions never decrease), interpolating between neighbours and clamping at the ends. With equal weights it is
 * exactly the linear interpolation `distributionOf` uses, so an equally weighted set reads as before.
 */
export function weightedQuantile(points: Array<{ value: number; weight: number }>, p: number): number {
  const sorted = points.filter(x => Number.isFinite(x.value) && x.weight > 0).sort((a, b) => a.value - b.value);
  if (!sorted.length) return NaN;
  if (sorted.length === 1) return sorted[0]!.value;
  const total = sorted.reduce((s, x) => s + x.weight, 0);
  let before = 0;
  const positions = sorted.map(x => { const span = total - x.weight; const at = span > 0 ? before / span : 1; before += x.weight; return at; });
  if (p <= positions[0]!) return sorted[0]!.value;
  if (p >= positions[positions.length - 1]!) return sorted[sorted.length - 1]!.value;
  for (let i = 1; i < sorted.length; i++) {
    if (p <= positions[i]!) { const width = positions[i]! - positions[i - 1]!; return sorted[i - 1]!.value + (sorted[i]!.value - sorted[i - 1]!.value) * (width > 0 ? (p - positions[i - 1]!) / width : 0); }
  }
  return sorted[sorted.length - 1]!.value;
}
