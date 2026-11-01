import { z } from "zod";
import type { ManagementTargetSet } from "../../../../shared/analysis-contract/valuation.ts";
import peerMap from "./curated/peer-map.json" with { type: "json" };
import managementTargets from "./curated/management-targets.json" with { type: "json" };

/**
 * Curated valuation inputs kept as data beside the code (docs/valuation-v2-SPEC.md §3a–§3b): the comparable sets the
 * cross-check tries first, and management's public targets with their sources. Both are read through a schema so a
 * typo fails the tests, not a run; neither names a company in code, the ticker is a key the run looks up.
 */
const ticker = z.string().regex(/^[A-Z][A-Z0-9.-]{0,11}$/);
const peerMapSchema = z.object({ companies: z.array(z.object({ ticker, peers: z.array(ticker).min(1).max(12), note: z.string().max(200).optional() })).max(200) });
const source = z.object({ id: z.string().min(3).max(80), title: z.string().min(3).max(300), url: z.string().url(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
const target = z.object({
  metric: z.enum(["revenue", "segment_revenue", "operating_margin", "eps", "capex", "fcf", "rpo"]), segment: z.string().max(80).optional(), fiscalYear: z.number().int().min(2000).max(2100),
  value: z.number().finite(), unit: z.enum(["currency", "ratio", "per_share"]), basis: z.enum(["gaap", "non_gaap"]), kind: z.enum(["target", "floor", "ceiling", "derived"]), sourceIds: z.array(z.string()).min(1).max(6), note: z.string().max(600).optional(),
});
const setSchema = z.object({ ticker, fiscalYearEndMonth: z.number().int().min(1).max(12), asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), sources: z.array(source).min(1).max(20), targets: z.array(target).min(1).max(60) });
const targetsSchema = z.object({ sets: z.array(setSchema).max(200) });

/** The curated peer map, validated; a peer never names its own company and no ticker repeats. */
export function readPeerMap(value: unknown = peerMap): Map<string, string[]> {
  const parsed = peerMapSchema.parse(value);
  const out = new Map<string, string[]>();
  for (const row of parsed.companies) {
    if (out.has(row.ticker)) throw new Error(`peer map lists ${row.ticker} twice`);
    const peers = [...new Set(row.peers)];
    if (peers.includes(row.ticker)) throw new Error(`peer map lists ${row.ticker} as its own peer`);
    out.set(row.ticker, peers);
  }
  return out;
}

/** Every management target set, validated: every target cites a source the set names. */
export function readManagementTargets(value: unknown = managementTargets): Map<string, ManagementTargetSet> {
  const parsed = targetsSchema.parse(value);
  const out = new Map<string, ManagementTargetSet>();
  for (const set of parsed.sets) {
    if (out.has(set.ticker)) throw new Error(`management targets list ${set.ticker} twice`);
    const ids = new Set(set.sources.map(s => s.id));
    if (ids.size !== set.sources.length) throw new Error(`management targets for ${set.ticker} repeat a source id`);
    for (const t of set.targets) for (const id of t.sourceIds) if (!ids.has(id)) throw new Error(`management target ${t.metric} FY${t.fiscalYear} for ${set.ticker} cites unknown source ${id}`);
    out.set(set.ticker, set);
  }
  return out;
}

export const curatedPeersFor = (ticker: string): string[] | null => readPeerMap().get(ticker) ?? null;
export const managementTargetsFor = (ticker: string): ManagementTargetSet | null => readManagementTargets().get(ticker) ?? null;
