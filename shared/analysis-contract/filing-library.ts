/**
 * The filing library: every archived SEC document split once, by its own items and headings, into
 * sections and verbatim passages. Agents read it through one tool instead of fetching filings. Section
 * and passage ids derive from content, so a parser upgrade keeps the id of anything whose text did not
 * change. Numbers are not stored here: a passage only points at the XBRL facts it shows.
 */
export const LIBRARY_ROLES = ["core", "signal", "boilerplate"] as const;
export type LibraryRole = typeof LIBRARY_ROLES[number];
export type LibraryChange = "new" | "changed" | "unchanged";
/** How the document was split: by its items, by headings only, or into a flat run of paragraphs. */
export type LibraryStructure = "items" | "outline" | "flat";
export type LibraryDocType = "primary" | "press_release" | "exhibit";
/** The same part of a filing under one name across 10-K, 10-Q and 20-F. */
export const LIBRARY_CANONICALS = [
  "front", "business", "risk_factors", "unresolved_comments", "cybersecurity", "properties", "legal", "mine_safety", "market",
  "reserved", "mdna", "market_risk", "financial_statements", "accountant_changes", "controls", "other_information",
  "foreign_inspection", "governance", "compensation", "ownership", "relationships", "accountant_fees", "exhibits", "summary",
  "event", "press_release", "note", "back", "other",
] as const;
export type LibraryCanonical = typeof LIBRARY_CANONICALS[number];

/**
 * A fact a passage shows: in a paragraph by character range, in a table by cell. `at` is the fact element's
 * offset in the archived HTML; the archive inventory's id for it is `${accession}:${encodeURIComponent(url)}:${at}`.
 */
export type LibraryFactRef = { at: number; concept: string; start?: number; end?: number; row?: number; col?: number };
export type LibraryTableCell = { text: string; value: number | null };
export type LibraryTableRow = { label: string; path: string[]; cells: LibraryTableCell[] };
export type LibraryTable = { unit: string | null; columns: string[]; rows: LibraryTableRow[]; notes: string[]; xbrlBlock: string | null };

export type LibrarySection = {
  sectionId: string; parentId: string | null; ordinal: number; depth: number; isLeaf: boolean;
  canonical: LibraryCanonical; itemKey: string | null; title: string; path: string[]; xbrlBlock: string | null;
  role: LibraryRole; chars: number; textHash: string;
};
export type LibraryPassage = {
  passageId: string; sectionId: string; ordinal: number; kind: "paragraph" | "table";
  /** Paragraphs verbatim; tables as Markdown with their unit and notes. */
  text: string; table: LibraryTable | null; factRefs: LibraryFactRef[]; chars: number; textHash: string;
};
export type ParsedLibraryDocument = {
  structure: LibraryStructure; sections: LibrarySection[]; passages: LibraryPassage[]; issues: string[];
};

/** What the tool and the admin page read. */
export type LibraryDocumentSummary = {
  documentId: string; ticker: string; accessionNumber: string; form: string; docType: LibraryDocType;
  reportDate: string; filedAt: string; documentUrl: string; parserVersion: string; structure: LibraryStructure;
  structureCheck: { status: "ok" | "segments_missing" | "not_applicable"; missing: string[] };
  status: "ready" | "unreadable"; failureReason: string | null; previousDocumentId: string | null;
  chars: number; passages: number; sections: number; preparedAt: string;
};
export type LibrarySectionView = Omit<LibrarySection, "textHash"> & { change: LibraryChange };
export type LibraryPassageView = Omit<LibraryPassage, "textHash"> & { change: LibraryChange };

/** The admin page: how far the library is, and the documents that need a look. */
export type LibraryOverview = {
  enabled: boolean; parserVersion: string; pending: number;
  totals: { documents: number; ready: number; unreadable: number; sections: number; passages: number; cards: number };
  structures: Array<{ structure: LibraryStructure; docType: LibraryDocType; documents: number }>;
  companies: Array<{ ticker: string; documents: number; unreadable: number; segmentsMissing: number; latestFiledAt: string }>;
  problems: Array<Pick<LibraryDocumentSummary, "documentId" | "ticker" | "form" | "docType" | "filedAt" | "status" | "failureReason" | "structure" | "structureCheck">>;
};
export type LibraryCard = {
  sectionId: string; gist: string | null; entities: string[]; topic: string | null; answers: string[]; metrics: string[];
  notes: string[]; model: string; reasoning: string; status: "ready" | "partial" | "failed"; createdAt: string;
};
export type LibraryDocumentDetail = { document: LibraryDocumentSummary; outline: LibrarySectionView[]; cards: LibraryCard[] };
export type LibrarySectionDetail = { section: LibrarySectionView; passages: LibraryPassageView[]; card: LibraryCard | null };

/** The fixed topic taxonomy an index card picks from; only code changes it. */
export const LIBRARY_TOPICS = {
  business: ["overview", "segment", "product_line", "customers", "competition", "go_to_market", "seasonality", "supply_chain", "research", "ip", "human_capital", "regulation"],
  risk: ["macro", "competition", "technology", "supply", "regulatory", "legal", "financial", "operational", "cyber", "other"],
  mdna: ["overview", "segment_results", "revenue", "costs", "opex", "tax", "liquidity", "capital_return", "obligations", "critical_estimates", "outlook", "market_risk"],
  note: ["revenue", "segment", "concentration", "leases", "debt", "goodwill", "tax", "equity", "commitments", "investments", "property", "acquisitions", "policies", "statements", "other"],
  release: ["results", "guidance", "commentary", "other"],
} as const;
export type LibraryTopicFamily = keyof typeof LIBRARY_TOPICS;

/**
 * Cross-company categories a business link picks from, so "cloud" means the same thing at every company. Only code
 * changes the list; a link's category counts for cross-company reads once an admin confirms it.
 */
export const INDUSTRY_CATEGORIES = {
  cloud_infrastructure: "云基础设施：IaaS / PaaS、AI 算力云、GPU 云",
  ai_compute: "AI 与数据中心计算硬件：GPU、加速器、数据中心系统",
  semiconductors: "其他半导体：图形、PC、汽车、通信芯片",
  networking_edge: "网络与边缘：网络设备、CDN、边缘计算、网络服务",
  security: "网络安全产品与服务",
  enterprise_software: "企业应用与数据库软件、SaaS、许可与支持",
  productivity_software: "办公协作与生产力软件",
  design_software: "设计、工程、建筑、制造、媒体创作软件",
  developer_tools: "开发者工具与平台",
  consumer_devices: "消费电子硬件：手机、电脑、平板、可穿戴、游戏主机",
  consumer_services: "面向消费者的订阅与数字服务：应用商店、内容、云存储",
  advertising: "数字广告与搜索",
  gaming: "游戏内容与平台",
  hardware_systems: "企业硬件：服务器、存储、工程系统",
  it_services: "IT 服务、咨询与教育培训",
  consumer_banking: "零售与社区银行、信用卡",
  commercial_banking: "公司与商业银行、投资银行、交易与市场",
  asset_management: "资产与财富管理",
  insurance: "保险与再保险",
  transportation: "铁路、物流与运输",
  energy_utilities: "能源与公用事业",
  industrial_manufacturing: "工业制造与建筑材料",
  retail_distribution: "零售、分销与消费品",
  mobility_autonomy: "自动驾驶、机器人与出行",
  other: "其他",
} as const;
export type IndustryCategory = keyof typeof INDUSTRY_CATEGORIES;

/** One business of a company joined across its disclosures: the map's node, its XBRL members and the sections that describe it. */
export type LibraryBusinessLink = {
  ticker: string; businessKey: string; name: string; flowNodeId: string | null; xbrlMembers: string[]; sectionIds: string[];
  industryCategory: IndustryCategory | null; status: "proposed" | "confirmed"; proposedBy: string | null; updatedAt: string;
};
export type LibraryLinkSection = { sectionId: string; documentId: string; path: string[]; gist: string | null };
export type LibraryLinksView = { links: Array<LibraryBusinessLink & { sections: LibraryLinkSection[] }>; categories: typeof INDUSTRY_CATEGORIES };

/** A section a cross-company search found; the text is read from D1 by its id, never from the recall layer. */
export type LibraryFoundSection = {
  ticker: string; documentId: string; form: string; filedAt: string; sectionId: string; path: string[]; canonical: string;
  topic: string | null; gist: string | null; entities: string[]; score: number; via: "index" | "recall";
};
export type LibraryFindResult = { found: LibraryFoundSection[]; recall: "ok" | "off" | "empty" | "error"; recallError?: string };
/** One validated number, the same as the business map draws. */
export type LibraryFactRow = { ticker: string; business: string; flowNodeId: string | null; metric: string; periodEnd: string; value: string; unit: string; source: string };

/** A derived company page: the library's own cards, verbatim excerpts and validated numbers, with no model writing. */
export type LibraryWikiEntry = {
  sectionId: string; documentId: string; form: string; filedAt: string; path: string[]; gist: string | null; entities: string[]; change: LibraryChange;
  excerpts: Array<{ passageId: string; text: string }>;
};
export type LibraryWikiBusiness = {
  businessKey: string | null; name: string; industryCategory: IndustryCategory | null; status: "proposed" | "confirmed" | "unlinked";
  facts: LibraryFactRow[]; sections: LibraryWikiEntry[];
};
export type LibraryWikiPage = {
  ticker: string; generatedAt: string;
  documents: Array<{ documentId: string; form: string; docType: LibraryDocType; filedAt: string; reportDate: string; url: string }>;
  businesses: LibraryWikiBusiness[]; changes: LibraryWikiEntry[]; risks: LibraryWikiEntry[]; markdown: string;
};
