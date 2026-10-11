import { INDUSTRY_CATEGORIES, type IndustryCategory } from "../../analysis-contract/filing-library.ts";
import { compactName } from "../business-tree.ts";

/** Bumping this proposes every company's business links again; confirmed links keep their category. */
export const LIBRARY_LINKS_VERSION = "library-links.v1";
/** Businesses one company can have linked, and sections one business can name. */
export const LINK_LIMITS = { businesses: 12, sections: 8 } as const;

export type LinkFlowNode = { flowNodeId: string; name: string };
export type LinkDraft = { businessKey: string; name: string; flowNodeId: string | null; xbrlMembers: string[]; sectionIds: string[]; industryCategory: IndustryCategory | null };

const slug = (name: string) => name.normalize("NFKC").toLowerCase().replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60);
/** `MSFT:intelligent-cloud`: unique across companies, stable while the business keeps its name. */
export const businessKeyOf = (ticker: string, name: string) => `${ticker}:${slug(name) || "business"}`;
/** A flow node id that is an XBRL member names the member; derived ids (`cloud`, `reported-company-total`) do not. */
export const xbrlMembersOf = (flowNodeId: string | null) => flowNodeId && /^[a-z][a-z0-9-]*:[A-Za-z0-9]+Member$/.test(flowNodeId) ? [flowNodeId] : [];
const isCategory = (value: unknown): value is IndustryCategory => typeof value === "string" && Object.hasOwn(INDUSTRY_CATEGORIES, value);

/**
 * Checks a model's proposed links against what it was shown: every flow node and section it names must be one it
 * was given, a category must be in the taxonomy, and a business that is not one of the map's nodes must be named
 * verbatim in one of its sections. Map businesses the model left out are kept, unlinked, so none goes missing.
 */
export function checkLinks(raw: unknown, ticker: string, flow: LinkFlowNode[], sections: Map<string, string>): { links: LinkDraft[]; notes: string[] } {
  const notes: string[] = [], links = new Map<string, LinkDraft>();
  const flowById = new Map(flow.map(f => [f.flowNodeId, f])), flowByName = new Map(flow.map(f => [compactName(f.name), f]));
  const items = Array.isArray((raw as { links?: unknown } | null)?.links) ? (raw as { links: unknown[] }).links : [];
  for (const item of items) {
    if (links.size >= LINK_LIMITS.businesses) { notes.push("too_many_businesses"); break; }
    const value = item as Record<string, unknown> | null;
    const name = typeof value?.name === "string" ? value.name.trim() : "";
    if ([...name].length < 2 || [...name].length > 80) { notes.push("bad_name"); continue; }
    const sectionIds = [...new Set(Array.isArray(value?.sectionIds) ? value.sectionIds.filter((id): id is string => typeof id === "string" && sections.has(id)) : [])].slice(0, LINK_LIMITS.sections);
    if (Array.isArray(value?.sectionIds) && value.sectionIds.length > sectionIds.length) notes.push(`unknown_sections:${name}`);
    let node = typeof value?.flowNodeId === "string" ? flowById.get(value.flowNodeId) ?? null : null;
    if (typeof value?.flowNodeId === "string" && !node) notes.push(`unknown_flow_node:${name}`);
    node ??= flowByName.get(compactName(name)) ?? null;
    const own = compactName(name);
    if (!node && !sectionIds.some(id => compactName(sections.get(id)!).includes(own))) { notes.push(`unanchored:${name}`); continue; }
    const category = isCategory(value?.industryCategory) ? value.industryCategory : null;
    if (value?.industryCategory != null && !category) notes.push(`unknown_category:${name}`);
    const key = businessKeyOf(ticker, node?.name ?? name);
    if (links.has(key)) continue;
    links.set(key, { businessKey: key, name: node?.name ?? name, flowNodeId: node?.flowNodeId ?? null, xbrlMembers: xbrlMembersOf(node?.flowNodeId ?? null), sectionIds, industryCategory: category });
  }
  for (const node of flow) {
    if ([...links.values()].some(l => l.flowNodeId === node.flowNodeId)) continue;
    notes.push(`unplaced:${node.name}`);
    const key = businessKeyOf(ticker, node.name);
    if (!links.has(key)) links.set(key, { businessKey: key, name: node.name, flowNodeId: node.flowNodeId, xbrlMembers: xbrlMembersOf(node.flowNodeId), sectionIds: [], industryCategory: null });
  }
  return { links: [...links.values()], notes };
}
