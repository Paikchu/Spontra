import { z } from "zod";
import { INDUSTRY_CATEGORIES, type IndustryCategory, type BusinessLinkReview, type BusinessSource } from "./classification-contract.ts";
import { compactName } from "./tree-runtime.ts";

export const BUSINESS_CLASSIFICATION_VERSION = "business-classification.v1";
export const businessSourceKey = (source: BusinessSource) => `${source.ref.ticker}:${source.ref.accession}:${source.ref.version}:${source.sourceId}`;

export type LinkFlowNode = { flowNodeId: string; name: string };
export type LinkDraft = { businessKey: string; name: string; flowNodeId: string | null; xbrlMembers: string[]; sources: BusinessSource[]; industryCategory: IndustryCategory | null };
export type LinkReview = { industryCategory: IndustryCategory | null; sourceIds: string[] };
export type SettledLink = LinkDraft & { status: "verified" | "disputed"; review: BusinessLinkReview };

const proposalSchema = z.object({ links: z.array(z.object({
  name: z.string().min(2).max(80), flowNodeId: z.string().nullable(), sourceIds: z.array(z.string()).max(8), industryCategory: z.string().nullable(),
})).max(12) });
const reviewSchema = z.object({ reviews: z.array(z.object({ key: z.string(), industryCategory: z.string().nullable(), sourceIds: z.array(z.string()) })) });
const isCategory = (value: unknown): value is IndustryCategory => typeof value === "string" && Object.hasOwn(INDUSTRY_CATEGORIES, value);
const slug = (name: string) => name.normalize("NFKC").toLowerCase().replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60);
const businessKeyOf = (ticker: string, name: string) => `${ticker}:${slug(name)}`;
const xbrlMembersOf = (id: string | null) => id && /^[a-z][a-z0-9-]*:[A-Za-z0-9]+Member$/.test(id) ? [id] : [];

export function checkLinks(raw: unknown, ticker: string, flow: LinkFlowNode[], evidence: Map<string, { text: string; source: BusinessSource }>): { links: LinkDraft[]; notes: string[] } {
  const proposal = proposalSchema.parse(raw);
  const notes: string[] = [], links = new Map<string, LinkDraft>();
  const byId = new Map(flow.map(node => [node.flowNodeId, node])), byName = new Map(flow.map(node => [compactName(node.name), node]));
  for (const value of proposal.links) {
    const node = (value.flowNodeId ? byId.get(value.flowNodeId) : undefined) ?? byName.get(compactName(value.name));
    const sourceIds = [...new Set(value.sourceIds.filter(id => evidence.has(id)))];
    if (!node && !sourceIds.some(id => compactName(evidence.get(id)!.text).includes(compactName(value.name)))) { notes.push(`unanchored:${value.name}`); continue; }
    const name = node?.name ?? value.name, key = businessKeyOf(ticker, name);
    links.set(key, { businessKey: key, name, flowNodeId: node?.flowNodeId ?? null, xbrlMembers: xbrlMembersOf(node?.flowNodeId ?? null),
      sources: sourceIds.map(id => evidence.get(id)!.source), industryCategory: isCategory(value.industryCategory) ? value.industryCategory : null });
  }
  for (const node of flow) {
    if ([...links.values()].some(link => link.flowNodeId === node.flowNodeId)) continue;
    const key = businessKeyOf(ticker, node.name);
    links.set(key, { businessKey: key, name: node.name, flowNodeId: node.flowNodeId, xbrlMembers: xbrlMembersOf(node.flowNodeId), sources: [], industryCategory: null });
    notes.push(`unplaced:${node.name}`);
  }
  return { links: [...links.values()], notes };
}

export function readReviews(raw: unknown, drafts: LinkDraft[]): Map<string, LinkReview> {
  const { reviews } = reviewSchema.parse(raw), known = new Set(drafts.map(draft => draft.businessKey));
  return new Map(reviews.filter(review => known.has(review.key)).map(review => [review.key, {
    industryCategory: isCategory(review.industryCategory) ? review.industryCategory : null, sourceIds: review.sourceIds,
  }]));
}

export function settleLinks(drafts: LinkDraft[], reviews: Map<string, LinkReview>): SettledLink[] {
  return drafts.map(draft => {
    const review = reviews.get(draft.businessKey), vouched = new Set(review?.sourceIds ?? []);
    const sources = draft.sources.filter(source => vouched.has(businessSourceKey(source)));
    const agreed = !!review && review.industryCategory === draft.industryCategory;
    return { ...draft, sources, industryCategory: agreed ? draft.industryCategory : null, status: agreed ? "verified" : "disputed",
      review: { proposed: draft.industryCategory, reviewed: review?.industryCategory ?? null, reviewedPresent: !!review,
        droppedSources: draft.sources.map(businessSourceKey).filter(id => !vouched.has(id)) } };
  });
}
