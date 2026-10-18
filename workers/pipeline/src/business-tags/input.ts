import type { BusinessUnit } from "../../../../shared/analysis-contract/business-tags.ts";
import { BUSINESS_TAGS_VERSION, buildUnits, COMPANY_TOTAL, type UnitFlowNode, type UnitLink } from "../../../../shared/analysis-runtime/business-tags.ts";
import { libraryHash } from "../../../../shared/analysis-runtime/filing-library/parse.ts";
import { readCompletePublicationForTicker } from "../financial-data/publication.ts";
import { flowNodes, readLinks } from "../filing-library/links.ts";

export const tagsCacheKey = (ticker: string) => `business-tags:v1:${ticker}`;

/** What one company's tags are written from: its links, its map's businesses and the units they make before any placement. */
export type TagsPlan = { ticker: string; links: UnitLink[]; nodes: UnitFlowNode[]; units: BusinessUnit[]; unplaced: Array<{ businessKey: string; name: string }>; fingerprint: string };

export async function tagsPlan(db: D1Database, ticker: string): Promise<TagsPlan | null> {
  const links = (await readLinks(db, { ticker })).map(l => ({ businessKey: l.businessKey, name: l.name, flowNodeId: l.flowNodeId, sectionIds: l.sectionIds, industryCategory: l.industryCategory, status: l.status }));
  if (!links.length) return null;
  const nodes = await flowNodes(db, ticker);
  const { units, unplaced } = buildUnits(ticker, links, nodes);
  if (!units.some(u => u.sectors.length) && !unplaced.length) return null;
  const fingerprint = libraryHash(`${BUSINESS_TAGS_VERSION}|${links.map(l => `${l.businessKey}:${l.flowNodeId ?? ""}:${l.status}:${l.industryCategory ?? ""}:${l.sectionIds.join(",")}`).join(";")}|${nodes.map(n => `${n.flowNodeId}=${n.name}`).join(",")}`);
  return { ticker, links, nodes, units, unplaced, fingerprint };
}

export type PassageRow = { passage_id: string; document_id: string; section_id: string; text: string };
/** Each section's passages in order, at most `perSection` of them, for the sections asked; nothing parsed, a D1 read. */
export async function sectionPassages(db: D1Database, sectionIds: string[], perSection = 12): Promise<Map<string, PassageRow[]>> {
  const out = new Map<string, PassageRow[]>();
  for (let i = 0; i < sectionIds.length; i += 90) {
    const rows = (await db.prepare(`SELECT passage_id, document_id, section_id, text FROM sec_passages WHERE section_id IN (SELECT value FROM json_each(?)) AND kind != 'table' ORDER BY section_id, ordinal`)
      .bind(JSON.stringify(sectionIds.slice(i, i + 90))).all<PassageRow>()).results;
    for (const r of rows) { const list = out.get(r.section_id) ?? []; if (list.length < perSection) list.push(r); out.set(r.section_id, list); }
  }
  return out;
}

/** A company's revenue and each map node's at its newest quarter; a single-segment company's total is its own node. */
export async function unitRevenues(db: D1Database, ticker: string): Promise<{ periodEnd: string | null; company: string | null; nodes: Map<string, string> }> {
  const publication = await readCompletePublicationForTicker(db, ticker).catch(() => null);
  const quarter = [...publication?.status === "ready" ? publication.flow?.quarters ?? [] : []].filter(q => q.periodType === "3M").sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
  const nodes = new Map<string, string>();
  if (!quarter) return { periodEnd: null, company: null, nodes };
  const company = quarter.figures.revenue?.value ?? null;
  for (const segment of quarter.segments ?? []) {
    if (segment.revenue?.value) nodes.set(segment.id, segment.revenue.value);
    for (const child of segment.children ?? []) if (child.revenue?.value) nodes.set(child.id, child.revenue.value);
  }
  if (company) nodes.set(COMPANY_TOTAL, company);
  return { periodEnd: quarter.periodEnd, company, nodes };
}

/** Unit revenue over company revenue, rounded to three places; null when either is missing or not positive. */
export function exposureOf(revenue: string | null, company: string | null): number | null {
  const r = Number(revenue), c = Number(company);
  if (revenue == null || company == null || !Number.isFinite(r) || !Number.isFinite(c) || c <= 0 || r < 0) return null;
  return Math.min(1, Math.round((r / c) * 1000) / 1000);
}
