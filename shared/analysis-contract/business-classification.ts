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

export type BusinessSource = { ref: import("./filing-material.ts").MaterialRef; sourceId: string };
export type BusinessEvidence = { id: string; source: BusinessSource; title: string; path: string[]; text: string; url: string };
export type BusinessLinkReview = { proposed: IndustryCategory | null; reviewed: IndustryCategory | null; reviewedPresent: boolean; droppedSources: string[] };
export type BusinessLinkStatus = "verified" | "disputed" | "confirmed";
export type BusinessLink = {
  ticker: string; businessKey: string; name: string; flowNodeId: string | null; xbrlMembers: string[]; sources: BusinessSource[];
  industryCategory: IndustryCategory | null; status: BusinessLinkStatus; review: BusinessLinkReview | null; proposedBy: string | null; updatedAt: string;
};
export type BusinessLinksView = { links: Array<BusinessLink & { evidence: BusinessEvidence[] }>; categories: typeof INDUSTRY_CATEGORIES };
