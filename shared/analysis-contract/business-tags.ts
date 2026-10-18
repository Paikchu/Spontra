import type { IndustryCategory } from "./filing-library.ts";

/**
 * Two-level business tags (docs/peer-similarity-design.md). A comparable unit is one disclosed revenue node of a
 * company; its sector tags (level one) are the categories of its verified business links, its business tags (level
 * two) are written by a model under one sector, each tied to the filing passages that support it. Peers are chosen
 * by a shared sector first, then by how close their business tags are.
 */

export const TAG_FACETS = ["offering", "customers", "contract", "cost"] as const;
export type TagFacet = (typeof TAG_FACETS)[number];
export const TAG_FACET_LABELS: Record<TagFacet, string> = { offering: "卖什么", customers: "卖给谁", contract: "怎么收费", cost: "成本结构" };

/** The sector tags as the admin shows them: the industry categories under short names. */
export const SECTOR_LABELS: Record<IndustryCategory, string> = {
  cloud_infrastructure: "云服务", ai_compute: "AI 算力硬件", semiconductors: "半导体", networking_edge: "网络与边缘", security: "网络安全",
  enterprise_software: "企业软件", productivity_software: "办公软件", design_software: "设计软件", developer_tools: "开发者工具",
  consumer_devices: "消费电子", consumer_services: "消费者服务", advertising: "数字广告", gaming: "游戏", hardware_systems: "企业硬件",
  it_services: "IT 服务", consumer_banking: "零售银行", commercial_banking: "商业与投资银行", asset_management: "资产管理", insurance: "保险",
  transportation: "运输物流", energy_utilities: "能源与公用事业", industrial_manufacturing: "工业制造", retail_distribution: "零售与分销",
  mobility_autonomy: "自动驾驶与出行", other: "其他",
};

/** One revenue node of a company and the business links that fall under it. */
export type BusinessUnit = {
  ticker: string;
  /** `${ticker}|${flowNodeId}`. */
  unitKey: string;
  flowNodeId: string;
  name: string;
  /** Business keys of the links in the unit. */
  linkKeys: string[];
  /** Level one: categories of the unit's verified or confirmed links, sorted. */
  sectors: IndustryCategory[];
  /** Filing sections of the unit's links, in link order. */
  sectionIds: string[];
};

export type TagStatus = "verified" | "rejected";
/** Level two: one business or operating-logic tag under one of the unit's sectors. */
export type BusinessTag = {
  tagId: string;
  ticker: string;
  unitKey: string;
  sector: IndustryCategory;
  facet: TagFacet;
  /** Two to six English words, no digits, no company names; this is what is embedded. */
  label: string;
  /** A short Chinese name for the admin; never matched. */
  labelZh: string;
  definition: string;
  passageIds: string[];
  status: TagStatus;
};

export type FacetValue = "same" | "partial" | "different" | "unknown";
/** How one facet of two units compares under one sector: the best pair of tags and its cosine score. */
export type FacetMatch = { value: FacetValue; score: number | null; leftTag: string | null; rightTag: string | null };
/** `sector`: the units share a sector tag but not what they sell; shown in the admin only. */
export type PeerTier = "direct" | "partial" | "adjacent" | "sector";
export type PeerBasis = "company" | "unit" | "quote";
export type PairStatus = "matched" | "confirmed";

/** Two units compared: per shared sector, the four facets; the tier is the best a sector gives. */
export type PeerPairRecord = {
  pairKey: string;
  left: string;
  right: string;
  leftTicker: string;
  rightTicker: string;
  sectors: Partial<Record<IndustryCategory, Record<TagFacet, FacetMatch>>>;
  tier: PeerTier;
  tierSector: IndustryCategory;
  /** The tier the matching gave, kept under an admin's choice so it can be restored. */
  matchedTier: PeerTier;
  status: PairStatus;
  updatedAt: string;
};

/** The admin's view of one company: its units with both levels of tags, and every pair it is part of. */
export type BusinessTagsView = {
  ticker: string;
  version: string;
  units: Array<BusinessUnit & { revenue: string | null; exposure: number | null; periodEnd: string | null; tags: BusinessTag[] }>;
  /** Links no unit holds: no map node of their own and none chosen for them. */
  unplaced: Array<{ businessKey: string; name: string }>;
  pairs: Array<PeerPairRecord & { peer: { ticker: string; unitKey: string; name: string; exposure: number | null }; own: { unitKey: string; name: string }; basis: PeerBasis }>;
  tags: Record<string, Pick<BusinessTag, "tagId" | "label" | "labelZh" | "facet" | "passageIds">>;
  passages: Record<string, { passageId: string; documentId: string; sectionId: string; path: string; text: string }>;
  thresholds: { same: number; near: number };
  matching: boolean;
};

/** Companies that have comparable units, for the admin's company list in the tags view. */
export type BusinessTagCompanies = { companies: Array<{ ticker: string; units: number; tags: number }> };

/** The admin's view of one sector tag: every unit carrying it and what each sells. */
export type SectorTagView = {
  sector: IndustryCategory;
  units: Array<{ ticker: string; unitKey: string; name: string; exposure: number | null; offering: Array<Pick<BusinessTag, "tagId" | "label" | "labelZh">> }>;
};
