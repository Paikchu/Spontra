import type { CompanyAnalysisOverview } from "@/shared/analysis-contract/company-analysis";
import type { BusinessSegment, FlowSource } from "@/shared/analysis-contract/business-flow";
export type CompanyBusinessContent = { basisLabel: string; groups: BusinessSegment[]; sources: FlowSource[] };
const source = (id: string, title: string, url: string): FlowSource => ({ id, title, url });
const group = (id: string, name: string, description: string, products: string[], customers: string, monetization: string, disclosure: string, sourceId: string): BusinessSegment => ({ id, name, description, products, customers, monetization, disclosure, revenue: null, sourceIds: [sourceId] });
/** Curated public disclosures, independent of quarterly financial amounts. Never used as a ticker default. */
const disclosures: Record<string, CompanyBusinessContent> = {
 ORCL: { basisLabel: "FY2026 官方披露 · 2026-06-10；定性业务类别，非所选季度分部金额", sources: [source("orcl-fy26", "Oracle FY2026 官方业绩披露", "https://investor.oracle.com/investor-news/news-details/2026/Oracle-Announces-Record-Q4-and-FY-2026-Results-Driven-by-Cloud-Infrastructure--Cloud-Applications/default.aspx")], groups: [
 group("cloud", "云服务", "提供云基础设施及云应用。", ["云计算基础设施", "云应用"], "官方资料提及云服务客户；客户细分未在此归属资料中拆分。", "提供收费云服务；当前资料未拆分计费方式。", "只引用官方披露的业务类别，当前季度金额未知。", "orcl-fy26"),
 group("software", "软件", "数据库与应用软件业务。", ["数据库", "企业应用"], "数据库与应用软件用户；详细客户分类未披露。", "软件相关收入；许可与支持拆分未接入。", "不把云内软件与软件类别重复计入营收。", "orcl-fy26"),
 group("hardware", "硬件", "官方业绩披露中的硬件收入类别。", ["硬件产品"], "当前引用资料未拆分客户分类。", "硬件产品收入。", "产品映射、季度金额与成本分配未接入。", "orcl-fy26"),
 group("services", "服务", "官方业绩披露中的服务收入类别。", ["服务业务"], "当前引用资料未拆分客户分类。", "提供收费服务。", "具体服务产品、季度金额与成本分配未接入。", "orcl-fy26") ] },
 NVDA: { basisLabel: "FY2026 年报 · 截至 2026-01-25；定性归属，不代表当前季度分部金额", sources: [source("nvda-10k", "NVIDIA FY2026 SEC 年报", "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000021/nvda-20260125.htm")], groups: [
 group("compute", "计算与网络", "面向数据中心的加速计算、网络与 AI 平台，以及汽车计算平台。", ["数据中心 GPU 与 AI 软件", "高速互连与数据中心网络", "汽车计算与驾驶平台"], "云服务商、AI 开发商、企业及设备制造商；部分经由渠道采购。", "销售计算与网络产品，并提供软件、支持及相关服务。", "年度业务归属；产品未单独披露本季收入，不分配线宽或企业总成本。", "nvda-10k"),
 group("graphics", "图形", "游戏与个人电脑图形，以及企业工作站专业可视化。", ["游戏显卡", "专业工作站图形产品"], "玩家、专业创作者、企业；经设备制造商、板卡商及分销渠道销售。", "销售图形处理产品及相关平台。", "年度业务归属；当前季度分部收入尚未接入。", "nvda-10k") ] },
 MSFT: { basisLabel: "FY2025 年报历史归属 · 截至 2025-06-30；非 FY2027 重列口径", sources: [source("msft-ar25", "Microsoft FY2025 年报", "https://www.microsoft.com/investor/reports/ar25/index.html")], groups: [
 group("productivity", "生产力与业务流程", "办公协作与业务应用。", ["办公订阅", "企业业务应用", "职业社交平台"], "企业、个人、招聘者与广告主。", "订阅、软件许可与广告服务。", "历史定性归属；不能作为最新分部收入或重列季度比较。", "msft-ar25"),
 group("cloud", "智能云", "云计算、服务器产品及企业服务。", ["云平台", "服务器软件", "企业服务"], "企业与开发者。", "云使用费、软件许可与服务收入。", "历史定性归属；未分配当季营收或成本。", "msft-ar25"),
 group("personal", "更多个人计算", "个人电脑、游戏及搜索广告。", ["操作系统与设备", "游戏与订阅", "搜索广告"], "设备制造商、消费者、玩家及广告主。", "软件许可、硬件、游戏、订阅及广告。", "历史定性归属；非 FY2027 重列口径。", "msft-ar25") ] }
};
export function resolveCompanyBusiness(ticker: string, overview?: CompanyAnalysisOverview | null): CompanyBusinessContent | null {
 const report = overview?.deepDive;
 if (report) {
  const sources = report.sources.filter(s => /^https?:\/\//.test(s.url));
  const valid = new Set(sources.map(s => s.id));
  const paragraphs = (key: string) => report.sections.filter(s => s.key === key).flatMap(s => s.paragraphs).filter(p => p.sourceIds.some(id => valid.has(id)));
  const business = paragraphs("business");
  if (business.length) {
   const related = ["business", "mechanics", "customers", "revenue"].flatMap(paragraphs);
   return { basisLabel: "已发布业务分析 · 原文来源见展开详情；独立于所选季度", sources, groups: [{ id: "published-business", name: "公司业务与产品", revenue: null, description: business.map(p => p.text).join("\n"), products: paragraphs("mechanics").map(p => p.text), customers: paragraphs("customers").map(p => p.text).join("\n") || null, monetization: paragraphs("revenue").map(p => p.text).join("\n") || null, disclosure: report.limitations.join("；") || "定性业务说明，不推定产品营收比例或分部成本。", sourceIds: [...new Set(related.flatMap(p => p.sourceIds).filter(id => valid.has(id)))] }] };
  }
 }
 return disclosures[ticker.toUpperCase()] ?? null;
}
